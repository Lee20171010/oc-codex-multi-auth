import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountStorageV3 } from "../lib/storage.js";

const ensureCodexUsageAccessToken = vi.fn();
const fetchCodexUsage = vi.fn();
const persistUsageQuotaExhaustion = vi.fn();
const persistUsageQuotaRecovery = vi.fn();

// Only the two network/credential seams are stubbed. Everything else in
// `codex-usage.js` stays real so this exercises the default `fetchSummary`
// wiring rather than a reimplementation of it.
vi.mock("../lib/codex-usage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/codex-usage.js")>();
	return {
		...actual,
		persistUsageQuotaRecovery: (...args: unknown[]) => persistUsageQuotaRecovery(...args),
		ensureCodexUsageAccessToken: (...args: unknown[]) =>
			ensureCodexUsageAccessToken(...args) as unknown,
		fetchCodexUsage: (...args: unknown[]) => fetchCodexUsage(...args) as unknown,
		persistUsageQuotaExhaustion: (...args: unknown[]) =>
			persistUsageQuotaExhaustion(...args) as unknown,
	};
});

const { createQuotaMonitor } = await import("../lib/quota-notifications.js");
const { setStoragePathDirect } = await import("../lib/storage/state.js");

const storage: AccountStorageV3 = {
	version: 3,
	accounts: [{ refreshToken: "refresh-1", accountId: "account-1", addedAt: 0, lastUsed: 0 }],
	activeIndex: 0,
};

function monitorWith(overrides: Record<string, unknown> = {}) {
	return createQuotaMonitor({
		loadConfig: () => ({
			enabled: true,
			intervalMs: 1_000,
			notifyEveryCheck: true,
			thresholds: [25, 10, 0],
			autoProtectCredits: true,
		}),
		loadStorage: async () => storage,
		notificationsSupported: () => true,
		...overrides,
	});
}

describe("default quota fetch path", () => {
	const directories: string[] = [];

	beforeEach(async () => {
		vi.stubEnv("CODEX_AUTH_QUOTA_DISPLAY", "free");
		vi.clearAllMocks();
		persistUsageQuotaExhaustion.mockResolvedValue(false);
		persistUsageQuotaRecovery.mockResolvedValue(false);
		const directory = await mkdtemp(join(tmpdir(), "quota-fetch-"));
		directories.push(directory);
		setStoragePathDirect(join(directory, "accounts.json"));
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		setStoragePathDirect(null);
		await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
	});

	it("invalidates the account cache as soon as a refresh persists, before the usage call", async () => {
		const order: string[] = [];
		ensureCodexUsageAccessToken.mockImplementation(() => {
			order.push("refresh");
			return { accessToken: "access-1", refreshed: true, persisted: true };
		});
		fetchCodexUsage.mockImplementation(() => {
			order.push("usage");
			return {
				rate_limit: {
					primary_window: { used_percent: 50, limit_window_seconds: 18_000 },
					secondary_window: { used_percent: 50, limit_window_seconds: 604_800 },
				},
			};
		});
		const onCredentialsPersisted = vi.fn(() => order.push("invalidate"));

		await monitorWith({ onCredentialsPersisted, notify: vi.fn().mockResolvedValue(true) }).runNow();

		expect(onCredentialsPersisted).toHaveBeenCalledTimes(1);
		expect(order).toEqual(["refresh", "invalidate", "usage"]);
	});

	it("still invalidates the cache when the usage call fails after a rotation", async () => {
		ensureCodexUsageAccessToken.mockResolvedValue({
			accessToken: "access-1",
			refreshed: true,
			persisted: true,
		});
		fetchCodexUsage.mockRejectedValue(new Error("429 from the usage endpoint"));
		const onCredentialsPersisted = vi.fn();
		const notify = vi.fn().mockResolvedValue(true);

		await monitorWith({ onCredentialsPersisted, notify }).runNow();

		// The rotation is durable on disk, so the stale cached AccountManager
		// must be dropped even though this account produced no usage.
		expect(onCredentialsPersisted).toHaveBeenCalledOnce();
		expect(notify).not.toHaveBeenCalled();
	});

	it("invalidates recovered quota even when the token was still valid", async () => {
		persistUsageQuotaRecovery.mockResolvedValue(true);
		ensureCodexUsageAccessToken.mockResolvedValue({
			accessToken: "access-1",
			refreshed: false,
			persisted: false,
		});
		fetchCodexUsage.mockResolvedValue({
			rate_limit: {
				primary_window: { used_percent: 90, limit_window_seconds: 18_000 },
				secondary_window: { used_percent: 10, limit_window_seconds: 604_800 },
			},
		});
		const onCredentialsPersisted = vi.fn();
		const notify = vi.fn().mockResolvedValue(true);

		// Delivery is the scheduled poll's job; a forced check only probes.
		const monitor = monitorWith({ onCredentialsPersisted, notify, initialDelayMs: 0 });
		monitor.start();
		try {
			await vi.waitFor(() => {
				expect(notify).toHaveBeenCalledWith(
					"Codex quota status",
					"5h: 10% left | resets unavailable\nWeekly: 90% left | resets unavailable",
				);
			});
		} finally {
			monitor.dispose();
		}
		expect(onCredentialsPersisted).toHaveBeenCalledOnce();
	});

	it("persists an exhausted subscription quota and invalidates cached routing", async () => {
		persistUsageQuotaRecovery.mockResolvedValue(false);
		ensureCodexUsageAccessToken.mockResolvedValue({
			accessToken: "access-1",
			refreshed: false,
			persisted: false,
		});
		const weeklyResetAt = Math.floor(Date.now() / 1000) + 86_400;
		fetchCodexUsage.mockResolvedValue({
			rate_limit: {
				primary_window: { used_percent: 10, limit_window_seconds: 18_000 },
				secondary_window: {
					used_percent: 100,
					limit_window_seconds: 604_800,
					reset_at: weeklyResetAt,
				},
			},
		});
		persistUsageQuotaExhaustion.mockResolvedValue(true);
		const onCredentialsPersisted = vi.fn();

		await monitorWith({ onCredentialsPersisted, notify: vi.fn().mockResolvedValue(true) }).runNow();

		expect(persistUsageQuotaExhaustion).toHaveBeenCalledWith(
			expect.objectContaining({ accountId: "account-1" }),
			weeklyResetAt * 1000,
		);
		expect(onCredentialsPersisted).toHaveBeenCalledOnce();
	});

	it("invalidates cached routing when another process already persisted the block", async () => {
		ensureCodexUsageAccessToken.mockResolvedValue({
			accessToken: "access-1",
			refreshed: false,
			persisted: false,
		});
		fetchCodexUsage.mockResolvedValue({
			rate_limit: {
				secondary_window: {
					used_percent: 100,
					limit_window_seconds: 604_800,
					reset_at: Math.floor(Date.now() / 1000) + 86_400,
				},
			},
		});
		persistUsageQuotaExhaustion.mockResolvedValue(false);
		const onCredentialsPersisted = vi.fn();

		await monitorWith({ onCredentialsPersisted, notify: vi.fn().mockResolvedValue(true) }).runNow();

		expect(onCredentialsPersisted).toHaveBeenCalledOnce();
	});

	it("does not persist exhaustion when automatic credit protection is disabled", async () => {
		ensureCodexUsageAccessToken.mockResolvedValue({
			accessToken: "access-1",
			refreshed: false,
			persisted: false,
		});
		fetchCodexUsage.mockResolvedValue({
			rate_limit: {
				secondary_window: {
					used_percent: 100,
					limit_window_seconds: 604_800,
					reset_at: Math.floor(Date.now() / 1000) + 86_400,
				},
			},
		});

		await monitorWith({
			loadConfig: () => ({
				enabled: true,
				autoProtectCredits: false,
				intervalMs: 1_000,
				notifyEveryCheck: true,
				thresholds: [25, 10, 0],
			}),
			notify: vi.fn().mockResolvedValue(true),
		}).runNow();

		expect(persistUsageQuotaExhaustion).not.toHaveBeenCalled();
	});

	it("does not block an account when the usage endpoint is rate-limited", async () => {
		ensureCodexUsageAccessToken.mockResolvedValue({
			accessToken: "access-1",
			refreshed: false,
			persisted: false,
		});
		fetchCodexUsage.mockRejectedValue(new Error("429 from the usage endpoint"));

		await monitorWith({ notify: vi.fn().mockResolvedValue(true) }).runNow();

		expect(persistUsageQuotaExhaustion).not.toHaveBeenCalled();
	});

	it("spends a banked reset and re-reads usage when auto-redeem is on", async () => {
		ensureCodexUsageAccessToken.mockResolvedValue({ accessToken: "access-1", persisted: false });
		const spent = {
			rate_limit: {
				primary_window: { used_percent: 10, limit_window_seconds: 18_000 },
				secondary_window: {
					used_percent: 100,
					limit_window_seconds: 604_800,
					reset_at: Math.floor(Date.now() / 1000) + 86_400,
				},
			},
			rate_limit_reset_credits: { available_count: 1, applicable_available_count: 1 },
		};
		const refreshed = {
			rate_limit: {
				primary_window: { used_percent: 0, limit_window_seconds: 18_000 },
				secondary_window: { used_percent: 0, limit_window_seconds: 604_800 },
			},
		};
		fetchCodexUsage.mockResolvedValueOnce(spent).mockResolvedValue(refreshed);
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
			init?.method === "POST"
				? new Response(JSON.stringify({ code: "reset" }), { status: 200 })
				: new Response(
						JSON.stringify({ available_count: 1, credits: [{ id: "c1", status: "available" }] }),
						{ status: 200 },
					),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			await monitorWith({
				loadConfig: () => ({
					enabled: true,
					autoProtectCredits: true,
					autoRedeemResets: true,
					autoRedeemResetsBelowPercent: 10,
					intervalMs: 1_000,
					notifyEveryCheck: true,
					thresholds: [25, 10, 0],
				}),
				notify: vi.fn().mockResolvedValue(true),
			}).runNow();
		} finally {
			vi.unstubAllGlobals();
		}
		expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
		expect(fetchCodexUsage).toHaveBeenCalledTimes(2);
		// The refreshed windows are healthy, so nothing is blocked afterwards.
		expect(persistUsageQuotaExhaustion).not.toHaveBeenCalled();
	});

	it("never spends a reset when auto-redeem is off", async () => {
		ensureCodexUsageAccessToken.mockResolvedValue({ accessToken: "access-1", persisted: false });
		fetchCodexUsage.mockResolvedValue({
			rate_limit: {
				secondary_window: {
					used_percent: 100,
					limit_window_seconds: 604_800,
					reset_at: Math.floor(Date.now() / 1000) + 86_400,
				},
			},
			rate_limit_reset_credits: { available_count: 1, applicable_available_count: 1 },
		});
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		try {
			await monitorWith({ notify: vi.fn().mockResolvedValue(true) }).runNow();
		} finally {
			vi.unstubAllGlobals();
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("clears recovered quota and invalidates cached routing", async () => {
		ensureCodexUsageAccessToken.mockResolvedValue({ accessToken: "access-1", persisted: false });
		fetchCodexUsage.mockResolvedValue({ rate_limit: {
			primary_window: { used_percent: 10, limit_window_seconds: 18_000 },
			secondary_window: { used_percent: 20, limit_window_seconds: 604_800 },
		} });
		persistUsageQuotaRecovery.mockResolvedValue(true);
		const onCredentialsPersisted = vi.fn();
		await monitorWith({ onCredentialsPersisted, notify: vi.fn().mockResolvedValue(true) }).runNow();
		expect(persistUsageQuotaRecovery).toHaveBeenCalledWith(storage.accounts[0]);
		expect(onCredentialsPersisted).toHaveBeenCalledOnce();
	});

	// Setting and clearing a block are not symmetric. `autoProtectCredits`
	// opts out of BLOCKING rotation, but the request path still stamps a block
	// from 429 headers regardless of it, so gating the clear on it too left
	// those accounts blocked with nothing able to release them.
	it("clears recovered quota even with credit protection switched off", async () => {
		ensureCodexUsageAccessToken.mockResolvedValue({ accessToken: "access-1", persisted: false });
		fetchCodexUsage.mockResolvedValue({ rate_limit: {
			primary_window: { used_percent: 10, limit_window_seconds: 18_000 },
			secondary_window: { used_percent: 20, limit_window_seconds: 604_800 },
		} });
		persistUsageQuotaRecovery.mockResolvedValue(true);
		await monitorWith({
			loadConfig: () => ({
				enabled: true,
				autoProtectCredits: false,
				intervalMs: 1_000,
				notifyEveryCheck: true,
				thresholds: [25, 10, 0],
			}),
			notify: vi.fn().mockResolvedValue(true),
		}).runNow();
		expect(persistUsageQuotaRecovery).toHaveBeenCalledWith(storage.accounts[0]);
	});

	it.each([
		{},
		{ rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 0 } } },
		{ rate_limit: { primary_window: { used_percent: 10 }, secondary_window: { used_percent: 100, reset_at: Number.MAX_SAFE_INTEGER } } },
	])("does not clear quota without recovery evidence", async (payload) => {
		ensureCodexUsageAccessToken.mockResolvedValue({ accessToken: "access-1", persisted: false });
		fetchCodexUsage.mockResolvedValue(payload);
		await monitorWith({ notify: vi.fn().mockResolvedValue(true) }).runNow();
		expect(persistUsageQuotaRecovery).not.toHaveBeenCalled();
	});

	it("skips an account whose access token carries no resolvable account id", async () => {
		const anonymous: AccountStorageV3 = {
			version: 3,
			accounts: [{ refreshToken: "refresh-2", addedAt: 0, lastUsed: 0 }],
			activeIndex: 0,
		};
		ensureCodexUsageAccessToken.mockResolvedValue({
			accessToken: "not-a-jwt",
			refreshed: false,
			persisted: false,
		});
		const notify = vi.fn().mockResolvedValue(true);

		await monitorWith({ loadStorage: async () => anonymous, notify }).runNow();

		expect(fetchCodexUsage).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});

	it("swallows a refresh failure for one account without aborting the check", async () => {
		const twoAccounts: AccountStorageV3 = {
			version: 3,
			accounts: [
				{ refreshToken: "refresh-a", accountId: "account-a", addedAt: 0, lastUsed: 0 },
				{ refreshToken: "refresh-b", accountId: "account-b", addedAt: 0, lastUsed: 0 },
			],
			activeIndex: 0,
		};
		ensureCodexUsageAccessToken.mockImplementation((params: { account: { accountId?: string } }) => {
			if (params.account.accountId === "account-a") {
				throw new Error("Cannot refresh: account has no refresh token");
			}
			return { accessToken: "access-b", refreshed: false, persisted: false };
		});
		fetchCodexUsage.mockResolvedValue({
			rate_limit: {
				primary_window: { used_percent: 20, limit_window_seconds: 18_000 },
				secondary_window: { used_percent: 20, limit_window_seconds: 604_800 },
			},
		});
		const notify = vi.fn().mockResolvedValue(true);

		// Delivery is the scheduled poll's job; a forced check only probes.
		const monitor = monitorWith({ loadStorage: async () => twoAccounts, notify, initialDelayMs: 0 });
		monitor.start();
		try {
			await vi.waitFor(() => {
				expect(notify).toHaveBeenCalledWith(
					"Codex quota status",
					"5h: 80% left | resets unavailable\nWeekly: 80% left | resets unavailable",
				);
			});
		} finally {
			monitor.dispose();
		}
		expect(fetchCodexUsage).toHaveBeenCalledOnce();
	});
});
