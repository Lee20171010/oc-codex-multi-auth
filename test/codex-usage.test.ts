import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	deduplicateUsageAccountIndices,
	fetchCodexUsage,
	formatResetCredits,
	formatUsageCountdown,
	formatUsageLimitSummary,
	formatUsagePoolSummary,
	mapUsageWindow,
	formatUsageReset,
	formatUsageWindowLabel,
	getUsageQuotaExhaustedResetAtMs,
	getUsageLeftPercent,
	hasUsageWindow,
	parseCodexUsagePayload,
	persistUsageQuotaExhaustion,
	persistUsageQuotaRecovery,
	isUsageQuotaRecovered,
	resolveCodexUsageActiveAccount,
	summarizeUsagePool,
	type UsagePayload,
	type UsagePoolMember,
} from "../lib/codex-usage.js";
import { loadAccounts, saveAccounts, type AccountStorageV3 } from "../lib/storage.js";
import { setStoragePathDirect } from "../lib/storage/state.js";
import { formatQuotaDetailsText, type CompactQuotaStatus } from "../lib/tui-status.js";

describe("usage renewal", () => {
	it.each([
		[(6 * 1440 + 21 * 60 + 5) * 60_000, "6d 21h"],
		[(1440 + 30) * 60_000, "1d 30m"],
		[2 * 1440 * 60_000, "2d"],
		[(4 * 60 + 12) * 60_000, "4h 12m"],
		[35 * 60_000, "35m"],
		[20_000, "1m"],
	])("counts %i ms down as %s", (ms, expected) => {
		expect(formatUsageCountdown(ms)).toBe(expected);
	});

	it("carries no reset for a window nobody has drawn from", () => {
		const window = mapUsageWindow({
			used_percent: 0,
			limit_window_seconds: 604_800,
			reset_after_seconds: 604_800,
			reset_at: Math.floor(Date.now() / 1000) + 604_800,
		});
		expect(window).toEqual({ usedPercent: 0, windowMinutes: 10_080, notStarted: true });
		expect(formatUsageLimitSummary(window)).toBe("100% left");
	});
});

describe("codex usage helpers", () => {
	it.each([
		{ windows: [{}, {}], recovered: false },
		{ windows: [{ windowMinutes: 300, resetAtMs: 1234 }, {}], recovered: false },
		{ windows: [{ usedPercent: 5 }, { windowMinutes: 10080 }], recovered: false },
		{ windows: [{ windowMinutes: 0, usedPercent: 0 }, {}], recovered: false },
		{ windows: [{ windowMinutes: 300, usedPercent: 10 }, {}], recovered: false },
		{ windows: [{ windowMinutes: 300, usedPercent: 10 }, { windowMinutes: 0 }], recovered: true },
		{ windows: [{ usedPercent: 10 }, { usedPercent: 100, resetAtMs: Number.MAX_SAFE_INTEGER }], recovered: false },
	])("recognizes recovered quota only from usable windows: $recovered", ({ windows, recovered }) => {
		expect(isUsageQuotaRecovered(windows)).toBe(recovered);
	});
	it("distinguishes an omitted window from an explicitly absent window in a single-window plan", () => {
		const missing = parseCodexUsagePayload({ rate_limit: {
			primary_window: { used_percent: 1, limit_window_seconds: 604800 },
		} });
		const disabled = parseCodexUsagePayload({ rate_limit: {
			primary_window: { used_percent: 1, limit_window_seconds: 604800 }, secondary_window: null,
		} });
		expect(isUsageQuotaRecovered([missing.primary, missing.secondary])).toBe(false);
		expect(isUsageQuotaRecovered([disabled.primary, disabled.secondary])).toBe(true);
	});

	it.each([true, false])("clears matching quota stamps without changing enabled=%s or model rate limits", async (enabled) => {
		const directory = await mkdtemp(join(tmpdir(), "usage-quota-recovery-"));
		try {
			setStoragePathDirect(join(directory, "accounts.json"));
			const account = { refreshToken: "recovery", accountId: "recovered", addedAt: 0, lastUsed: 0,
				quotaExhaustedUntil: 1234, rateLimitResetTimes: { codex: 5678 } };
			await saveAccounts({ version: 3, activeIndex: 0, accounts: [{ ...account, enabled }] });
			expect(await persistUsageQuotaRecovery(account)).toBe(true);
			const stored = await loadAccounts();
			expect(stored?.accounts[0]?.quotaExhaustedUntil).toBeUndefined();
			expect(stored?.accounts[0]?.enabled).toBe(enabled);
			expect(stored?.accounts[0]?.rateLimitResetTimes).toEqual({ codex: 5678 });
			expect(await persistUsageQuotaRecovery(account)).toBe(false);
		} finally {
			setStoragePathDirect(null);
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("formats same-day reset times on a locale-independent 24-hour clock", () => {
		// Pinned well clear of midnight: a real clock would cross into the next
		// day inside the 60s offset and take the "on <date>" branch instead.
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
		const formatTime = vi
			.spyOn(Date.prototype, "toLocaleTimeString")
			.mockReturnValue("22:30");

		try {
			expect(formatUsageReset(Date.now() + 60_000)).toBe("22:30");
			expect(formatTime).toHaveBeenCalledWith(undefined, {
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			});
		} finally {
			formatTime.mockRestore();
			vi.useRealTimers();
		}
	});

	it("reads a non-object usage document as an empty one instead of throwing", () => {
		// `fetchCodexUsage` casts `response.json()` straight to UsagePayload, so a
		// 200 whose body is `null` reaches the parser as null.
		for (const payload of [null, undefined, "ok", 5, true] as unknown[]) {
			const usage = parseCodexUsagePayload(payload as UsagePayload);
			expect(usage.limits, `payload=${String(payload)}`).toEqual([]);
			expect(usage.primary, `payload=${String(payload)}`).toEqual({});
			expect(usage.secondary, `payload=${String(payload)}`).toEqual({});
			expect(usage.planType, `payload=${String(payload)}`).toBeNull();
			expect(usage.credits, `payload=${String(payload)}`).toBeNull();
			expect(usage.additionalLimits, `payload=${String(payload)}`).toEqual([]);
			expect(formatUsageLimitSummary(usage.primary)).toBe("unavailable");
		}
	});

	it("parses usage payloads using remaining-percent semantics", () => {
		const payload: UsagePayload = {
			plan_type: "team",
			rate_limit: {
				primary_window: {
					used_percent: 13,
					limit_window_seconds: 18000,
				},
				secondary_window: {
					used_percent: 36,
					limit_window_seconds: 604800,
				},
			},
			code_review_rate_limit: {
				primary_window: {
					used_percent: 0,
					limit_window_seconds: 604800,
				},
			},
			additional_rate_limits: [
				{
					limit_name: "batch_jobs",
					rate_limit: {
						primary_window: {
							used_percent: 25,
							limit_window_seconds: 3600,
						},
					},
				},
			],
			credits: { unlimited: true },
		};

		const usage = parseCodexUsagePayload(payload);

		expect(usage.planType).toBe("team");
		expect(usage.credits).toBe("unlimited");
		expect(usage.limits).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "5h limit",
					leftPercent: 87,
					summary: "87% left",
				}),
				expect.objectContaining({
					name: "Weekly limit",
					leftPercent: 64,
					summary: "64% left",
				}),
				expect.objectContaining({
					name: "Code review",
					leftPercent: 100,
				}),
				expect.objectContaining({
					name: "Batch Jobs",
					leftPercent: 75,
				}),
			]),
		);
	});

	it("finds the latest valid reset for an exhausted ordinary usage window", () => {
		const now = Date.now();
		expect(
			getUsageQuotaExhaustedResetAtMs(
				[
					{ usedPercent: 100, windowMinutes: 300, resetAtMs: now + 60_000 },
					{ usedPercent: 100, windowMinutes: 10080, resetAtMs: now + 86_400_000 },
				],
				now,
			),
		).toBe(now + 86_400_000);
		expect(
			getUsageQuotaExhaustedResetAtMs(
				[{ usedPercent: 100, windowMinutes: 0, resetAtMs: now + 60_000 }],
				now,
			),
		).toBeUndefined();
	});

	it("persists an account-wide quota-exhaustion stamp without stamping per-family rate limits", async () => {
		const directory = await mkdtemp(join(tmpdir(), "usage-quota-persist-"));
		try {
			setStoragePathDirect(join(directory, "accounts.json"));
			const account = {
				refreshToken: "refresh-1",
				accountId: "account-1",
				addedAt: 0,
				lastUsed: 0,
			};
			await saveAccounts({ version: 3, accounts: [account], activeIndex: 0 });
			const resetAtMs = Date.now() + 86_400_000;

			expect(await persistUsageQuotaExhaustion(account, resetAtMs)).toBe(true);
			expect(await persistUsageQuotaExhaustion(account, resetAtMs - 60_000)).toBe(false);

			const persisted = await loadAccounts();
			// The account-wide subscription-quota fact lands on its own field, kept
			// at the monotonic maximum reset stamp.
			expect(persisted?.accounts[0]?.quotaExhaustedUntil).toBe(resetAtMs);
			// It no longer forges a per-family rate-limit block for every model.
			expect(persisted?.accounts[0]?.rateLimitResetTimes ?? {}).toEqual({});
			// The stamp is dated so cross-process saves can compare it against a
			// doctor-clear tombstone.
			expect(persisted?.accounts[0]?.quotaExhaustedStampAt).toEqual(expect.any(Number));
		} finally {
			setStoragePathDirect(null);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("displaces a doctor-clear tombstone when the poller re-stamps the account", async () => {
		const directory = await mkdtemp(join(tmpdir(), "usage-quota-persist-"));
		try {
			setStoragePathDirect(join(directory, "accounts.json"));
			// Doctor cleared an active stamp; the record carries the tombstone.
			const clearedAt = Date.now() - 60_000;
			const account = {
				refreshToken: "refresh-1",
				accountId: "account-1",
				addedAt: 0,
				lastUsed: 0,
				quotaExhaustedClearedAt: clearedAt,
			};
			await saveAccounts({ version: 3, accounts: [account], activeIndex: 0 });
			const resetAtMs = Date.now() + 86_400_000;

			expect(await persistUsageQuotaExhaustion(account, resetAtMs)).toBe(true);

			const persisted = await loadAccounts();
			// The poller's authoritative evidence is newer than the clear, so the
			// stamp lands and the tombstone goes — otherwise the next save from
			// any process would drop the freshly recorded block.
			expect(persisted?.accounts[0]?.quotaExhaustedUntil).toBe(resetAtMs);
			expect(persisted?.accounts[0]?.quotaExhaustedStampAt).toEqual(expect.any(Number));
			expect(persisted?.accounts[0]?.quotaExhaustedClearedAt).toBeUndefined();
		} finally {
			setStoragePathDirect(null);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("clamps remaining percent and preserves active codex account selection", () => {
		expect(getUsageLeftPercent(-10)).toBe(100);
		expect(getUsageLeftPercent(110)).toBe(0);
		expect(getUsageLeftPercent(12.4)).toBe(88);

		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 2 },
			accounts: [
				{ refreshToken: "r1", addedAt: 0, lastUsed: 0 },
				{ refreshToken: "r1", addedAt: 0, lastUsed: 0 },
				{ refreshToken: "r2", accountId: "acc-2", addedAt: 0, lastUsed: 0 },
			],
		};

		expect(deduplicateUsageAccountIndices(storage)).toEqual([1, 2]);
		expect(resolveCodexUsageActiveAccount(storage)).toMatchObject({
			index: 2,
			account: { accountId: "acc-2" },
		});
	});

	it("keeps same-token workspace entries distinct, skips disabled, and prefers the freshest duplicate", () => {
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{ refreshToken: "r1", accountId: "acc-1", organizationId: "org-1", addedAt: 0, lastUsed: 0 },
				{ refreshToken: "r1", accountId: "acc-2", organizationId: "org-2", addedAt: 0, lastUsed: 0 },
				{ refreshToken: "r2", accountId: "acc-3", enabled: false, addedAt: 0, lastUsed: 50 },
				{ refreshToken: "r3", accountId: "acc-1", organizationId: "org-1", addedAt: 0, lastUsed: 0 },
			],
		};

		// org-1 (key W) appears at index 0 and again at index 3 (re-added with a
		// fresh token r3); org-2 (key X) at index 1; index 2 disabled. Display
		// order follows first appearance (W then X), but W resolves to its
		// freshest occurrence (index 3, token r3), not the stale index 0.
		expect(deduplicateUsageAccountIndices(storage)).toEqual([3, 1]);
		expect(resolveCodexUsageActiveAccount(storage)).toMatchObject({
			index: 0,
			account: { accountId: "acc-1" },
		});
	});

	it("keeps Business members with the same workspace id as separate quota pools", () => {
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "owner-refresh",
					accountId: "business-account",
					accountUserId: "member-owner",
					organizationId: "org-business",
					addedAt: 0,
					lastUsed: 0,
				},
				{
					refreshToken: "invited-refresh",
					accountId: "business-account",
					accountUserId: "member-invited",
					organizationId: "org-business",
					addedAt: 0,
					lastUsed: 0,
				},
			],
		};

		expect(deduplicateUsageAccountIndices(storage)).toEqual([0, 1]);
	});

	it("keeps separate rows for one member across distinct workspaces", () => {
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "shared-refresh",
					accountId: "business-account",
					accountUserId: "member-owner",
					organizationId: "org-one",
					addedAt: 0,
					lastUsed: 0,
				},
				{
					refreshToken: "shared-refresh",
					accountId: "business-account",
					accountUserId: "member-owner",
					organizationId: "org-two",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		};

		expect(deduplicateUsageAccountIndices(storage)).toEqual([0, 1]);
	});

	it("collapses duplicate rows for the same Business member credential", () => {
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "shared-refresh",
					accountId: "business-account",
					accountUserId: "member-owner",
					organizationId: "org-one",
					addedAt: 0,
					lastUsed: 0,
				},
				{
					refreshToken: "other-refresh",
					accountId: "business-account",
					accountUserId: "member-owner",
					organizationId: "org-one",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		};

		expect(deduplicateUsageAccountIndices(storage)).toEqual([1]);
	});

	it("keeps separate rows for distinct members of one Business workspace", () => {
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "owner-refresh",
					accountId: "business-account",
					accountUserId: "member-owner",
					organizationId: "org-one",
					addedAt: 0,
					lastUsed: 0,
				},
				{
					refreshToken: "invitee-refresh",
					accountId: "business-account",
					accountUserId: "member-invitee",
					organizationId: "org-one",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		};

		expect(deduplicateUsageAccountIndices(storage)).toEqual([0, 1]);
	});

	it("deduplicates workspace identities without delimiter collisions", () => {
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{ refreshToken: "r1", accountId: "acc:1", organizationId: "org", addedAt: 0, lastUsed: 0 },
				{ refreshToken: "r2", accountId: "acc", organizationId: "1:org", addedAt: 0, lastUsed: 0 },
			],
		};

		expect(deduplicateUsageAccountIndices(storage)).toEqual([0, 1]);
	});

	it("handles sparse/undefined account slots without throwing", () => {
		const storage = {
			version: 3,
			activeIndex: 5,
			accounts: [
				undefined,
				{ refreshToken: "r1", accountId: "acc-1", organizationId: "org-1", addedAt: 0, lastUsed: 10 },
			],
		} as unknown as AccountStorageV3;

		expect(() => resolveCodexUsageActiveAccount(storage)).not.toThrow();
		expect(resolveCodexUsageActiveAccount(storage)).toMatchObject({
			index: 1,
			account: { accountId: "acc-1" },
		});
	});

	it("returns null when every account slot is empty or disabled", () => {
		const storage = {
			version: 3,
			activeIndex: 0,
			accounts: [
				undefined,
				{ refreshToken: "r2", accountId: "acc-2", enabled: false, addedAt: 0, lastUsed: 0 },
			],
		} as unknown as AccountStorageV3;

		expect(resolveCodexUsageActiveAccount(storage)).toBeNull();
	});

	it("keeps the active account when its lastUsed is missing", () => {
		const storage = {
			version: 3,
			activeIndex: 1,
			accounts: [
				{ refreshToken: "r1", accountId: "acc-1", organizationId: "org-1", addedAt: 0, lastUsed: 0 },
				{ refreshToken: "r2", accountId: "acc-2", organizationId: "org-2", addedAt: 0 },
			],
		} as unknown as AccountStorageV3;

		// The active account (index 1) has no lastUsed. It must not lose the
		// marker to index 0's lastUsed:0 via a 0 > -1 comparison.
		expect(resolveCodexUsageActiveAccount(storage)).toMatchObject({
			index: 1,
			account: { accountId: "acc-2" },
		});
	});

	it("drops accounts that have no workspace identity and no refresh token", () => {
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{ addedAt: 0, lastUsed: 0 },
				{ refreshToken: "r1", accountId: "acc-1", organizationId: "org-1", addedAt: 0, lastUsed: 0 },
			],
		};

		// The identity-less entry (index 0) yields no dedupe key and is excluded.
		expect(deduplicateUsageAccountIndices(storage)).toEqual([1]);
	});

	it("uses the most recently persisted request account for usage display", () => {
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{ refreshToken: "r1", accountId: "acc-1", addedAt: 0, lastUsed: 10 },
				{ refreshToken: "r2", accountId: "acc-2", addedAt: 0, lastUsed: 20 },
			],
		};

		expect(resolveCodexUsageActiveAccount(storage)).toMatchObject({
			index: 1,
			account: { accountId: "acc-2" },
		});
	});
});

describe("disabled usage windows (issue #194)", () => {
	it("drops a window the server reports with a zero-second length", () => {
		const payload: UsagePayload = {
			plan_type: "team",
			rate_limit: {
				primary_window: {
					used_percent: 23,
					limit_window_seconds: 10080 * 60,
				},
				secondary_window: {
					used_percent: 0,
					limit_window_seconds: 0,
					reset_after_seconds: 0,
				},
			},
		};

		const usage = parseCodexUsagePayload(payload);

		// A zero-length window is switched off, not a one-minute window.
		expect(usage.secondary.windowMinutes).toBe(0);
		expect(hasUsageWindow(usage.secondary)).toBe(false);
		expect(usage.limits).toHaveLength(1);
		expect(usage.limits[0]).toMatchObject({
			name: "Weekly limit",
			leftPercent: 77,
		});
	});

	it("keeps a window whose length the server omits", () => {
		const usage = parseCodexUsagePayload({
			rate_limit: { primary_window: { used_percent: 10 } },
		});

		expect(hasUsageWindow(usage.primary)).toBe(true);
		expect(usage.limits[0]).toMatchObject({ name: "quota limit", leftPercent: 90 });
	});

	it("reports the banked resets the usage response already carries", () => {
		const usage = parseCodexUsagePayload({
			plan_type: "pro",
			rate_limit: {
				primary_window: { used_percent: 100, limit_window_seconds: 604800 },
			},
			rate_limit_reset_credits: {
				available_count: 2,
				applicable_available_count: 2,
			},
		});

		expect(usage.resetCredits).toEqual({ available: 2, applicableNow: 2 });
	});

	it("separates banked resets from a spent purchase balance", () => {
		// The two are different currencies and the account below holds both
		// readings at once: no purchase balance, two redeemable resets. Reporting
		// only `credits` reads as "you have nothing" while a reset is waiting.
		const usage = parseCodexUsagePayload({
			credits: { has_credits: false, balance: "0" },
			rate_limit_reset_credits: { available_count: 2, applicable_available_count: 2 },
		});

		expect(usage.credits).toBe("0");
		expect(usage.resetCredits).toEqual({ available: 2, applicableNow: 2 });
	});

	it("distinguishes a banked reset that does not apply yet", () => {
		// An account inside its quota reports the credit as banked but not
		// applicable, because there is no exhausted window for it to clear.
		const usage = parseCodexUsagePayload({
			rate_limit_reset_credits: { available_count: 1, applicable_available_count: 0 },
		});

		expect(usage.resetCredits).toEqual({ available: 1, applicableNow: 0 });
	});

	it("treats absent or malformed reset-credit data as unknown", () => {
		expect(parseCodexUsagePayload({}).resetCredits).toBeNull();
		expect(parseCodexUsagePayload({ rate_limit_reset_credits: null }).resetCredits).toBeNull();
		expect(
			parseCodexUsagePayload({
				rate_limit_reset_credits: "two" as unknown as never,
			}).resetCredits,
		).toBeNull();
		expect(
			parseCodexUsagePayload({
				rate_limit_reset_credits: { available_count: -1 },
			}).resetCredits,
		).toBeNull();
	});

	it("defaults an omitted applicable count to the banked count", () => {
		// Older responses carry only `available_count`. Treating the missing
		// field as zero would report every banked reset as unusable.
		const usage = parseCodexUsagePayload({
			rate_limit_reset_credits: { available_count: 3 },
		});

		expect(usage.resetCredits).toEqual({ available: 3, applicableNow: 3 });
	});

	it("reads a null applicable count as the omission it is", () => {
		// JSON's way of saying "not provided", and this endpoint does send it -
		// `secondary_window` arrives as a literal null on single-window plans.
		// A fix that defaults only on `undefined` would treat it as a stated
		// value, find it unreadable, and hide three real banked resets.
		const usage = parseCodexUsagePayload({
			rate_limit_reset_credits: {
				available_count: 3,
				applicable_available_count: null,
			},
		});

		expect(usage.resetCredits).toEqual({ available: 3, applicableNow: 3 });
	});

	it("keeps the banked count when the applicable count cannot be true", () => {
		// The two counts are separate fields. An unreadable applicable count
		// says nothing about the banked total that arrived beside it, and
		// dropping both would print "Credits: 0" over two real resets while
		// `codex-reset` reports them from the list endpoint.
		const unreadable = (applicable: unknown) =>
			parseCodexUsagePayload({
				rate_limit_reset_credits: {
					available_count: 2,
					applicable_available_count: applicable as number,
				},
			}).resetCredits;

		expect(unreadable(-1)).toEqual({ available: 2, applicableNow: null });
		expect(unreadable(Number.NaN)).toEqual({ available: 2, applicableNow: null });
		expect(unreadable("1")).toEqual({ available: 2, applicableNow: null });
		// A subset cannot outnumber the set it is drawn from.
		expect(unreadable(3)).toEqual({ available: 2, applicableNow: null });
		// A count is a whole number of resets: truncating 1.9 to 1 would hide
		// a malformed payload behind a plausible-looking answer.
		expect(unreadable(1.9)).toEqual({ available: 2, applicableNow: null });
	});

	it("rejects a fractional banked count outright", () => {
		// No second field to fall back on here, so an unreadable banked count
		// makes the whole reading unknown rather than a truncated guess.
		expect(
			parseCodexUsagePayload({
				rate_limit_reset_credits: { available_count: 0.9 },
			}).resetCredits,
		).toBeNull();
	});

	it("says which banked resets can be redeemed right now", () => {
		expect(formatResetCredits({ available: 2, applicableNow: 2 })).toBe("2 banked");
		expect(formatResetCredits({ available: 2, applicableNow: 1 })).toBe(
			"2 banked (1 applicable now)",
		);
		expect(formatResetCredits({ available: 2, applicableNow: null })).toBe(
			"2 banked (applicable now unknown)",
		);
	});
});

describe("Codex usage endpoint", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("fetches free-plan quotas without selecting a model", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ plan_type: "free", rate_limit: null }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(fetchCodexUsage({
			accountId: "account-free",
			accessToken: "access-free",
			organizationId: undefined,
			timeoutMs: 1_000,
		})).resolves.toMatchObject({ plan_type: "free" });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/wham/usage");
		expect(init.method).toBe("GET");
		expect(init.body).toBeUndefined();
	});

	it("normalizes usage endpoint workspace and token failures", async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ detail: { code: "deactivated_workspace" } }), {
					status: 402,
				}),
			)
			.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
		vi.stubGlobal("fetch", fetchMock);

		const request = {
			accountId: "account-1",
			accessToken: "access-1",
			organizationId: undefined,
			timeoutMs: 1_000,
			normalizeAccountErrors: true,
		};
		await expect(fetchCodexUsage(request)).rejects.toThrow("deactivated_workspace");
		await expect(fetchCodexUsage(request)).rejects.toThrow("authentication token has been invalidated");
	});
});

function makeAccount(overrides: Record<string, unknown> = {}): AccountStorageV3["accounts"][number] {
	return {
		refreshToken: `token-${Math.random().toString(36).slice(2)}`,
		email: `user${Math.floor(Math.random() * 1000)}@example.com`,
		addedAt: Date.now(),
		lastUsed: 0,
		...overrides,
	};
}

describe("usage formatter hostile inputs", () => {
	it("getUsageLeftPercent clamps out-of-range percents and rejects non-finite", () => {
		expect(getUsageLeftPercent(-50)).toBe(100);
		expect(getUsageLeftPercent(150)).toBe(0);
		expect(getUsageLeftPercent(Number.NaN)).toBeUndefined();
		expect(getUsageLeftPercent(Number.POSITIVE_INFINITY)).toBeUndefined();
		expect(getUsageLeftPercent(-1e309)).toBeUndefined();
	});

	it("formatUsageWindowLabel rejects non-finite and non-positive windows", () => {
		expect(formatUsageWindowLabel(0)).toBe("quota");
		expect(formatUsageWindowLabel(-10)).toBe("quota");
		expect(formatUsageWindowLabel(Number.NaN)).toBe("quota");
		expect(formatUsageWindowLabel(Number.POSITIVE_INFINITY)).toBe("quota");
	});

	it("formatUsageReset rejects pre-epoch and non-finite resets without NaN", () => {
		expect(formatUsageReset(Number.NaN)).toBeUndefined();
		expect(formatUsageReset(Number.POSITIVE_INFINITY)).toBeUndefined();
		expect(formatUsageReset(0)).toBeUndefined();
		expect(formatUsageReset(-1000)).toBeUndefined();
		expect(formatUsageReset(1)).toMatch(/^\d{2}:\d{2}/);
	});

	it("far-future finite reset stamps render as unavailable, not Invalid Date", () => {
		const status: CompactQuotaStatus = {
			type: "ready",
			stale: false,
			limits: [{ label: "5h limit", leftPercent: 40, resetAtMs: 1e300 }],
		};
		const text = formatQuotaDetailsText(status);
		expect(text).not.toMatch(/Invalid Date|NaN|Infinity/);
	});

	it("parseCodexUsagePayload survives a null payload and null windows", () => {
		const summary = parseCodexUsagePayload(null);
		expect(summary.limits).toEqual([]);
		expect(summary.credits).toBeNull();
		const weird = parseCodexUsagePayload({
			rate_limit: { primary_window: null, secondary_window: null },
			additional_rate_limits: null,
			rate_limit_reset_credits: null,
		});
		expect(weird.limits).toEqual([]);
	});
});

describe("usage account resolution hostile storage", () => {
	it("resolveCodexUsageActiveAccount tolerates empty and all-disabled pools", async () => {
		const { resolveCodexUsageActiveAccount } = await import("../lib/codex-usage.js");
		expect(
			resolveCodexUsageActiveAccount({ version: 3, accounts: [], activeIndex: 0 }),
		).toBeNull();
		expect(
			resolveCodexUsageActiveAccount({
				version: 3,
				accounts: [makeAccount({ enabled: false })],
				activeIndex: 0,
			}),
		).toBeNull();
	});

	it("deduplicateUsageAccountIndices skips disabled and identity-less entries", async () => {
		const { deduplicateUsageAccountIndices } = await import("../lib/codex-usage.js");
		const indices = deduplicateUsageAccountIndices({
			version: 3,
			accounts: [
				makeAccount({ refreshToken: "r1" }),
				makeAccount({ refreshToken: "r2", enabled: false }),
				makeAccount({ refreshToken: "r3" }),
			],
			activeIndex: 0,
		});
		expect(indices).toEqual([0, 2]);
	});
});

describe("summarizeUsagePool", () => {
	const WEEK = 10080;
	const FIVE_HOURS = 300;

	function member(
		planType: string | null,
		usedPercent: number | undefined,
		overrides: Partial<UsagePoolMember> = {},
	): UsagePoolMember {
		return {
			planType,
			primary: { usedPercent, windowMinutes: WEEK },
			secondary: {},
			...overrides,
		};
	}

	it("weighs each seat by its plan rather than averaging them as equals", () => {
		// One spent Pro seat and one untouched Plus seat. The plain mean says
		// the pool is half full; weighting says a 20x seat being empty costs
		// far more than a 1x seat being full.
		const pool = summarizeUsagePool([
			member("pro", 100),
			member("plus", 0),
		]);
		expect(pool).toEqual({ leftPercent: 5, allotment: 21, countedAccounts: 2 });
	});

	it("sums the allotment over exactly the seats the mean divides by", () => {
		// Two Pro seats, eight Business Premium seats and one Free seat: the
		// real shape of an eleven-account pool.
		const pool = summarizeUsagePool([
			member("pro", 100),
			member("self_serve_business_prolite", 79),
			...Array.from({ length: 7 }, () =>
				member("self_serve_business_prolite", 100),
			),
			member("pro", 100),
			member("free", 100),
		]);
		expect(pool?.allotment).toBe(81);
		expect(pool?.countedAccounts).toBe(11);
	});

	it("weighs a plan that publishes no ratio as one baseline seat", () => {
		expect(summarizeUsagePool([member("free", 0)])?.allotment).toBe(1);
		expect(summarizeUsagePool([member("enterprise", 0)])?.allotment).toBe(1);
	});

	it("describes an account by the window with the least headroom left", () => {
		// The weekly window is what would stop a request, so a fresh 5-hour
		// window must not report this account as nearly full.
		const pool = summarizeUsagePool([
			{
				planType: "plus",
				primary: { usedPercent: 10, windowMinutes: FIVE_HOURS },
				secondary: { usedPercent: 90, windowMinutes: WEEK },
			},
		]);
		expect(pool?.leftPercent).toBe(10);
	});

	it("leaves an unreadable account out of both figures", () => {
		const pool = summarizeUsagePool([
			member("plus", 40),
			member("pro", undefined, { primary: {}, secondary: {} }),
		]);
		expect(pool).toEqual({ leftPercent: 60, allotment: 1, countedAccounts: 1 });
	});

	it("ignores a window the plan has switched off rather than counting it full", () => {
		// A disabled window still reports `used_percent: 0`, so counting it
		// would credit this account with a full quota it does not have.
		const pool = summarizeUsagePool([
			{
				planType: "plus",
				primary: { usedPercent: 0, windowMinutes: 0 },
				secondary: { usedPercent: 100, windowMinutes: WEEK },
			},
		]);
		expect(pool?.leftPercent).toBe(0);
		expect(pool?.countedAccounts).toBe(1);
	});

	it("reports nothing rather than 0% when no account could be read", () => {
		expect(summarizeUsagePool([])).toBeUndefined();
		expect(
			summarizeUsagePool([member("pro", undefined, { primary: {}, secondary: {} })]),
		).toBeUndefined();
	});
});

describe("formatUsagePoolSummary", () => {
	const pool = { leftPercent: 7, allotment: 81, countedAccounts: 11 };

	it("words the percentage the way the rest of the surfaces do", () => {
		expect(formatUsagePoolSummary(pool, "used")).toBe(
			"93% used of 81x across 11 accounts",
		);
		expect(formatUsagePoolSummary(pool, "free")).toBe(
			"7% left of 81x across 11 accounts",
		);
	});

	it("defaults to headroom, matching how Codex reports a quota", () => {
		expect(formatUsagePoolSummary(pool)).toBe(
			"7% left of 81x across 11 accounts",
		);
	});

	it("says `1 account` rather than `1 accounts`", () => {
		expect(
			formatUsagePoolSummary({ leftPercent: 50, allotment: 20, countedAccounts: 1 }),
		).toBe("50% left of 20x across 1 account");
	});
});
