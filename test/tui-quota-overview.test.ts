import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../lib/codex-usage.js", async (importActual) => {
	const actual = await importActual<typeof import("../lib/codex-usage.js")>();
	return {
		...actual,
		ensureCodexUsageAccessToken: vi.fn(),
		fetchCodexUsage: vi.fn(),
	};
});

import {
	createUsageAccountFingerprint,
	ensureCodexUsageAccessToken,
	fetchCodexUsage,
} from "../lib/codex-usage.js";
import { isPoolFullySpent } from "../lib/quota-overview.js";
import {
	getTuiQuotaOverviewCachePath,
	isFreshTuiQuotaSnapshot,
	isTuiQuotaOverviewSnapshot,
	readTuiQuotaOverviewSnapshot,
	sanitizeTuiQuotaOverviewSnapshot,
	writeTuiQuotaOverviewSnapshot,
	TUI_QUOTA_CACHE_VERSION,
	TUI_QUOTA_OVERVIEW_CACHE_FILE,
	type TuiQuotaOverviewSnapshot,
	type TuiQuotaSnapshot,
} from "../lib/tui-quota-cache.js";
import {
	fetchTuiQuotaOverview,
	mergeOverviewWithLatestAccount,
	toOverviewAccount,
	toQuotaOverviewAccounts,
} from "../lib/tui-quota-overview.js";

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);

function snapshot(
	overrides: Partial<TuiQuotaOverviewSnapshot> = {},
): TuiQuotaOverviewSnapshot {
	return {
		version: TUI_QUOTA_CACHE_VERSION,
		fetchedAt: NOW,
		accounts: [
			{
				fingerprint: "aaaa",
				index: 1,
				planType: "pro",
				resetCredits: 1,
				limits: [
					{ label: "weekly", leftPercent: 0, usedPercent: 100, windowMinutes: 10080, resetAtMs: NOW + 86_400_000 },
				],
			},
			{
				fingerprint: "bbbb",
				index: 2,
				planType: "team",
				limits: [{ label: "5h", leftPercent: 60, usedPercent: 40, windowMinutes: 300 }],
			},
		],
		...overrides,
	};
}

describe("getTuiQuotaOverviewCachePath", () => {
	it("sits beside the single-account cache in the same state dir", () => {
		expect(getTuiQuotaOverviewCachePath("/state")).toBe(
			join("/state", TUI_QUOTA_OVERVIEW_CACHE_FILE),
		);
	});
});

describe("isTuiQuotaOverviewSnapshot", () => {
	it("accepts a snapshot this build wrote", () => {
		expect(isTuiQuotaOverviewSnapshot(snapshot())).toBe(true);
	});

	it("rejects a document from another version or shape", () => {
		expect(isTuiQuotaOverviewSnapshot(snapshot({ version: 2 as never }))).toBe(false);
		expect(isTuiQuotaOverviewSnapshot({ ...snapshot(), accounts: "no" })).toBe(false);
		expect(isTuiQuotaOverviewSnapshot(null)).toBe(false);
		expect(isTuiQuotaOverviewSnapshot(undefined)).toBe(false);
	});

	it("rejects an account with no fingerprint to attribute it to", () => {
		const invalid = snapshot();
		invalid.accounts[0]!.fingerprint = "  ";
		expect(isTuiQuotaOverviewSnapshot(invalid)).toBe(false);
	});
});

describe("sanitizeTuiQuotaOverviewSnapshot", () => {
	it("drops a window the plan has switched off", () => {
		const withDisabled = snapshot();
		withDisabled.accounts[1]!.limits.push({
			label: "quota",
			leftPercent: 100,
			usedPercent: 0,
			windowMinutes: 0,
		});
		expect(
			sanitizeTuiQuotaOverviewSnapshot(withDisabled).accounts[1]!.limits,
		).toHaveLength(1);
	});
});

describe("overview cache round trip", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "oc-overview-"));
		vi.mocked(ensureCodexUsageAccessToken).mockReset();
		vi.mocked(fetchCodexUsage).mockReset();
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("reads back what it wrote", async () => {
		const path = join(dir, TUI_QUOTA_OVERVIEW_CACHE_FILE);
		await writeTuiQuotaOverviewSnapshot(snapshot(), path);
		expect(await readTuiQuotaOverviewSnapshot(path)).toEqual(snapshot());
	});

	it("treats a missing or corrupt cache as absent rather than throwing", async () => {
		const path = join(dir, TUI_QUOTA_OVERVIEW_CACHE_FILE);
		expect(await readTuiQuotaOverviewSnapshot(path)).toBeUndefined();
		await writeFile(path, "{ not json");
		expect(await readTuiQuotaOverviewSnapshot(path)).toBeUndefined();
	});

	it("serves a fresh cache without touching storage or the network", async () => {
		const path = join(dir, TUI_QUOTA_OVERVIEW_CACHE_FILE);
		await writeTuiQuotaOverviewSnapshot(snapshot(), path);
		const result = await fetchTuiQuotaOverview({
			cachePath: path,
			now: NOW + 1000,
			loadStorage: async () => {
				throw new Error("storage must not be read while the cache is fresh");
			},
		});
		expect(result?.accounts).toHaveLength(2);
	});

	it("keeps the last known pool when every account fails to report", async () => {
		const path = join(dir, TUI_QUOTA_OVERVIEW_CACHE_FILE);
		await writeTuiQuotaOverviewSnapshot(snapshot(), path);
		const stale = await fetchTuiQuotaOverview({
			cachePath: path,
			// Well past the freshness window, so the cache cannot short-circuit.
			now: NOW + 60 * 60 * 1000,
			loadStorage: async () => ({
				version: 3,
				accounts: [{ refreshToken: "r", enabled: true }],
				activeIndex: 0,
			}) as never,
		});
		expect(stale?.fetchedAt).toBe(NOW);
	});

	it("reports nothing when there are no accounts at all", async () => {
		expect(
			await fetchTuiQuotaOverview({
				cachePath: join(dir, TUI_QUOTA_OVERVIEW_CACHE_FILE),
				now: NOW,
				loadStorage: async () => null,
			}),
		).toBeUndefined();
	});

	it("keeps a failed account's last reading and ages the merged snapshot", async () => {
		const path = join(dir, TUI_QUOTA_OVERVIEW_CACHE_FILE);
		const accountA = {
			refreshToken: "refresh-a",
			accountId: "account-a",
			enabled: true,
		};
		const accountB = {
			refreshToken: "refresh-b",
			accountId: "account-b",
			enabled: true,
		};
		// The previous poll read account B at 90% headroom: dropping it would
		// judge the pool on the spent account alone and report it fully spent.
		const previous = snapshot({
			accounts: [
				{
					fingerprint: createUsageAccountFingerprint(accountA as never),
					index: 1,
					planType: "plus",
					limits: [
						{
							label: "weekly",
							leftPercent: 0,
							usedPercent: 100,
							windowMinutes: 10080,
							resetAtMs: NOW + 86_400_000,
						},
					],
				},
				{
					fingerprint: createUsageAccountFingerprint(accountB as never),
					index: 2,
					planType: "plus",
					limits: [
						{
							label: "weekly",
							leftPercent: 90,
							usedPercent: 10,
							windowMinutes: 10080,
							resetAtMs: NOW + 86_400_000,
						},
					],
				},
			],
		});
		await writeTuiQuotaOverviewSnapshot(previous, path);

		vi.mocked(ensureCodexUsageAccessToken).mockResolvedValue({
			accessToken: "access-token",
			refreshed: false,
			persisted: false,
		});
		vi.mocked(fetchCodexUsage).mockImplementation(async (params) => {
			if (params.accountId === "account-b") throw new Error("transient");
			return {
				rate_limit: {
					primary_window: {
						used_percent: 50,
						limit_window_seconds: 18_000,
					},
				},
			};
		});

		const later = NOW + 60 * 60 * 1000;
		const result = await fetchTuiQuotaOverview({
			cachePath: path,
			now: later,
			loadStorage: async () =>
				({
					version: 3,
					accounts: [accountA, accountB],
					activeIndex: 0,
				}) as never,
		});

		expect(result?.accounts).toHaveLength(2);
		expect(result?.accounts[1]?.index).toBe(2);
		expect(result?.accounts[1]?.limits[0]?.leftPercent).toBe(90);
		expect(result && isPoolFullySpent(toQuotaOverviewAccounts(result))).toBe(
			false,
		);
		// The carried-over reading keeps the older fetch time, so the line is
		// rendered stale rather than passing it off as current.
		expect(result?.fetchedAt).toBe(NOW);
		expect(result && isFreshTuiQuotaSnapshot(result, later)).toBe(false);
		// Each account keeps its own time, so the fresh one is not aged with it.
		expect(result?.accounts.map((account) => account.fetchedAt)).toEqual([later, NOW]);
	});
});

describe("toOverviewAccount", () => {
	it("keeps only the windows that govern ordinary model requests", () => {
		const account = toOverviewAccount({
			fingerprint: "aaaa",
			index: 3,
			usage: {
				planType: "pro",
				credits: null,
				resetCredits: { available: 2, applicableNow: 1 },
				primary: { usedPercent: 40, windowMinutes: 300 },
				secondary: { usedPercent: 10, windowMinutes: 10080 },
				codeReview: { usedPercent: 100, windowMinutes: 300 },
				additionalLimits: [],
				limits: [],
			},
		});
		expect(account.limits.map((limit) => limit.label)).toEqual(["5h", "weekly"]);
		expect(account.limits[0]!.leftPercent).toBe(60);
		expect(account.index).toBe(3);
		expect(account.resetCredits).toBe(1);
	});

	it("falls back to the banked count when the applicable count is unreadable", () => {
		const account = toOverviewAccount({
			fingerprint: "aaaa",
			index: 1,
			usage: {
				planType: null,
				credits: null,
				resetCredits: { available: 3, applicableNow: null },
				primary: { usedPercent: 0, windowMinutes: 300 },
				secondary: {},
				codeReview: {},
				additionalLimits: [],
				limits: [],
			},
		});
		expect(account.resetCredits).toBe(3);
	});

	it("carries the names the status line can call an account by", () => {
		const account = toOverviewAccount({
			fingerprint: "aaaa",
			index: 1,
			email: " damian@nowaker.net ",
			label: " work ",
			usage: {
				planType: null,
				credits: null,
				resetCredits: null,
				primary: { usedPercent: 0, windowMinutes: 300 },
				secondary: {},
				codeReview: {},
				additionalLimits: [],
				limits: [],
			},
		});
		expect(account.email).toBe("damian@nowaker.net");
		expect(account.label).toBe("work");
	});

	it("leaves a nameless account nameless rather than inventing one", () => {
		const account = toOverviewAccount({
			fingerprint: "aaaa",
			index: 1,
			label: "   ",
			usage: {
				planType: null,
				credits: null,
				resetCredits: null,
				primary: { usedPercent: 0, windowMinutes: 300 },
				secondary: {},
				codeReview: {},
				additionalLimits: [],
				limits: [],
			},
		});
		expect(account.email).toBeUndefined();
		expect(account.label).toBeUndefined();
	});
});

describe("mergeOverviewWithLatestAccount", () => {
	const latest: TuiQuotaSnapshot = {
		version: TUI_QUOTA_CACHE_VERSION,
		fingerprint: "bbbb",
		fetchedAt: NOW + 60_000,
		source: "headers",
		limits: [{ label: "5h", leftPercent: 12, usedPercent: 88, windowMinutes: 300 }],
	};

	it("takes the request path's newer reading of the serving account", () => {
		const merged = mergeOverviewWithLatestAccount(snapshot(), latest);
		expect(merged.accounts[1]!.limits[0]!.leftPercent).toBe(12);
		expect(merged.accounts[1]!.fetchedAt).toBe(NOW + 60_000);
		expect(merged.accounts[0]!.limits[0]!.leftPercent).toBe(0);
	});

	it("ignores a reading older than that account's own reading", () => {
		const base = snapshot();
		const fresher = {
			...base,
			accounts: base.accounts.map((account, position) =>
				position === 1 ? { ...account, fetchedAt: NOW + 120_000 } : account,
			),
		};
		const merged = mergeOverviewWithLatestAccount(fresher, latest);
		expect(merged.accounts[1]!.limits[0]!.leftPercent).toBe(60);
	});

	it("ignores a reading older than the poll", () => {
		const merged = mergeOverviewWithLatestAccount(snapshot(), {
			...latest,
			fetchedAt: NOW - 60_000,
		});
		expect(merged.accounts[1]!.limits[0]!.leftPercent).toBe(60);
	});

	it("ignores an account the pool does not contain", () => {
		const merged = mergeOverviewWithLatestAccount(snapshot(), {
			...latest,
			fingerprint: "zzzz",
		});
		expect(merged).toEqual(snapshot());
	});

	it("ignores an empty reading rather than blanking the account", () => {
		const merged = mergeOverviewWithLatestAccount(snapshot(), {
			...latest,
			limits: [],
		});
		expect(merged.accounts[1]!.limits).toHaveLength(1);
	});

	it("is a no-op with nothing to merge", () => {
		expect(mergeOverviewWithLatestAccount(snapshot(), undefined)).toEqual(snapshot());
	});

	it("learns an email the pool poll did not have", () => {
		const merged = mergeOverviewWithLatestAccount(snapshot(), {
			...latest,
			accountEmail: "damian@nowaker.net",
		});
		expect(merged.accounts[1]!.email).toBe("damian@nowaker.net");
	});
});

describe("toQuotaOverviewAccounts", () => {
	it("hands the formatter percentages and resets, not labels", () => {
		expect(toQuotaOverviewAccounts(snapshot())).toEqual([
			{
				index: 1,
				planType: "pro",
				resetCredits: 1,
				windows: [{ leftPercent: 0, exactLeftPercent: 0, resetAtMs: NOW + 86_400_000 }],
			},
			{
				index: 2,
				planType: "team",
				resetCredits: undefined,
				windows: [{ leftPercent: 60, exactLeftPercent: 60, resetAtMs: undefined }],
			},
		]);
	});

	it("passes an unreadable percentage through as absent", () => {
		const unreadable = snapshot();
		unreadable.accounts[0]!.limits[0]!.leftPercent = null;
		expect(toQuotaOverviewAccounts(unreadable)[0]!.windows[0]!.leftPercent).toBeUndefined();
	});
});
