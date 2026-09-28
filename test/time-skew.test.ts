/**
 * Time-domain regression suite (promoted from the round-2 clock audit).
 *
 * Every wall-clock assertion runs against `vi.setSystemTime` or an injected
 * `now` — no real-clock waits, per test/AGENTS.md.
 *
 * Labels:
 *   - `PROVEN`        — a boundary the code already handles correctly.
 *   - `AUDIT BUG`     — characterization test: asserts *observed* deficient
 *     behaviour so the failure mode stays pinned (file:line in the name). A
 *     fix that corrects the behaviour should flip the expectation to the
 *     corrected contract in the same commit — the label marks that intent.
 *   - `AUDIT QUIRK` / `AUDIT FINDING` — semantics worth recording; severity is
 *     contextual, the pin guards against silent drift.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import {
	shouldRefreshToken,
	handleErrorResponse,
} from "../lib/request/fetch-helpers.js";
import {
	exchangeAuthorizationCode,
	refreshAccessToken,
} from "../lib/auth/auth.js";
import { safeParseOAuthTokenResponse } from "../lib/schemas.js";
import {
	shouldRefreshProactively,
	getTimeUntilExpiry,
	MIN_PROACTIVE_BUFFER_MS,
} from "../lib/proactive-refresh.js";
import type { ManagedAccount } from "../lib/accounts.js";
import {
	MAX_QUOTA_RESET_HORIZON_MS,
	getQuotaExhaustedResetAtMs,
	parseCodexQuotaWindows,
	parseQuotaResetAtMs,
	isQuotaWindowExhausted,
} from "../lib/quota-windows.js";
import {
	getRateLimitBackoff,
	clearRateLimitBackoffState,
} from "../lib/request/rate-limit-backoff.js";
import {
	RetryBudgetTracker,
	resolveRetryBudgetLimits,
	RETRY_WAIT_BUDGET_UNIT_MS,
} from "../lib/request/retry-budget.js";
import {
	HealthScoreTracker,
	TokenBucketTracker,
	addJitter,
	resetTrackers,
} from "../lib/rotation.js";
import { getAccountHealth } from "../lib/health.js";
import { CircuitBreaker } from "../lib/circuit-breaker.js";
import { AccountManager } from "../lib/accounts.js";
import {
	clearExpiredRateLimits,
	isQuotaExhausted,
	formatWaitTime,
} from "../lib/accounts/rate-limits.js";
import { normalizeAccountStorage } from "../lib/storage/normalize.js";
import {
	acquireOrDetectLock,
	releaseLock,
	__resetWorktreeLockForTests,
} from "../lib/storage/worktree-lock.js";
import {
	transitionQuotaState,
	aggregateQuotaUsage,
	createQuotaMonitor,
} from "../lib/quota-notifications.js";
import {
	updateQuotaNotificationState,
	readQuotaNotificationState,
} from "../lib/quota-notification-state.js";
import { setStoragePathDirect } from "../lib/storage.js";
import {
	withRefreshLease,
	withStorageTransaction,
	getRefreshLeasePath,
	getStorageTransactionLockPath,
} from "../lib/storage/transaction-lock.js";
import { StorageTransactionContentionError } from "../lib/errors.js";
import {
	formatCompactDuration,
	formatQuotaResetsCandidates,
	formatQuotaOverviewText,
} from "../lib/quota-overview.js";
import {
	resolveNextQuotaRecovery,
	resolveQuotaRecoveryEvents,
} from "../lib/quota-recovery.js";
import {
	mapUsageWindow,
	isUsageWindowNotStarted,
	getUsageQuotaExhaustedResetAtMs,
	isUsageQuotaRecovered,
	formatUsageReset,
	formatUsageCountdown,
	formatUsageResetTimestamp,
	type CodexUsageSummary,
} from "../lib/codex-usage.js";
import { isFreshTuiQuotaSnapshot } from "../lib/tui-quota-cache.js";
import { formatQuotaDetailsText } from "../lib/tui-status.js";
import { getQuotaNotifications } from "../lib/config.js";
import type { Auth } from "../lib/types.js";
import type { QuotaNotificationsConfig } from "../lib/config.js";

// ---------------------------------------------------------------------------
// fetch-helpers transitively pulls the storage barrel; stub the disk surface.
// ---------------------------------------------------------------------------
vi.mock("../lib/storage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/storage.js")>();
	const saveAccounts = vi.fn().mockResolvedValue(undefined);
	return {
		...actual,
		saveAccounts,
		loadAccounts: vi.fn().mockResolvedValue(null),
		withAccountStorageTransaction: vi.fn(
			async (
				handler: (
					current: null,
					persist: (storage: unknown) => Promise<void>,
				) => Promise<unknown>,
			) => handler(null, saveAccounts as (storage: unknown) => Promise<void>),
		),
	};
});

const T0 = Date.UTC(2026, 1, 15, 12, 0, 0); // 2026-02-15T12:00:00Z

function oauthAuth(expires: number, access = "access-token"): Auth {
	return {
		type: "oauth",
		access,
		refresh: "refresh-token",
		expires,
	};
}

function makeAccount(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
	return {
		index: 0,
		refreshToken: "refresh-token",
		access: "access-token",
		enabled: true,
		rateLimitResetTimes: {},
		...overrides,
	} as ManagedAccount;
}

function makeStorage(accounts: Array<Record<string, unknown>>) {
	return {
		version: 3 as const,
		activeIndex: 0,
		accounts,
	};
}

function makeManager(accounts: Array<Record<string, unknown>>): AccountManager {
	return new AccountManager(undefined, makeStorage(accounts) as never);
}

function makeUsageSummary(
	primary: CodexUsageSummary["primary"],
	secondary: CodexUsageSummary["secondary"],
): CodexUsageSummary {
	return {
		planType: null,
		credits: null,
		resetCredits: null,
		primary,
		secondary,
		codeReview: {},
		additionalLimits: [],
		limits: [],
	};
}

describe("clock audit", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		resetTrackers();
		clearRateLimitBackoffState();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		resetTrackers();
		clearRateLimitBackoffState();
		__resetWorktreeLockForTests();
		setStoragePathDirect(null);
	});

	// ======================================================================
	// 1. Token expiry boundaries
	// ======================================================================
	describe("token expiry (shouldRefreshToken / proactive)", () => {
		it("PROVEN: expires == now triggers refresh (<= boundary)", () => {
			expect(shouldRefreshToken(oauthAuth(T0))).toBe(true);
		});

		it("PROVEN: expires == now+1 does not refresh with zero skew", () => {
			expect(shouldRefreshToken(oauthAuth(T0 + 1))).toBe(false);
		});

		it("PROVEN: expires == now+1 refreshes with 1ms skew", () => {
			expect(shouldRefreshToken(oauthAuth(T0 + 1), 1)).toBe(true);
		});

		it("PROVEN: already-expired token refreshes", () => {
			expect(shouldRefreshToken(oauthAuth(T0 - 1))).toBe(true);
		});

		it("PROVEN: fractional skew floors down (0.9 -> 0)", () => {
			expect(shouldRefreshToken(oauthAuth(T0 + 1), 0.9)).toBe(false);
		});

		it("AUDIT BUG: NaN skew silently disables refresh — Math.max(0, NaN)=NaN and expires <= NaN is false (fetch-helpers.ts:807-808)", () => {
			// An expired token with a NaN skew never refreshes; the dead token is
			// sent upstream until a 401 rotates the account out. Not reachable
			// through the config schema (zod + JSON cannot express NaN), but the
			// function is a shared primitive — the "safe" clamp is not safe.
			expect(shouldRefreshToken(oauthAuth(T0 - 60_000), Number.NaN)).toBe(false);
		});

		it("AUDIT BUG: Infinity skew makes every call refresh (fetch-helpers.ts:807-808)", () => {
			expect(shouldRefreshToken(oauthAuth(T0 + 10_000_000), Infinity)).toBe(true);
		});

		it("AUDIT BUG: non-finite `expires` never refreshes — NaN or +Inf both compare false (fetch-helpers.ts:808)", () => {
			// Reachable: `expires_in: 1e300` overflows `expires` to +Infinity
			// (auth.ts:220/293). The token is then served until upstream 401s.
			expect(shouldRefreshToken(oauthAuth(Number.POSITIVE_INFINITY))).toBe(false);
			expect(shouldRefreshToken(oauthAuth(Number.NaN))).toBe(false);
		});

		it("schema accepts expires_in values that poison the expiry clock", () => {
			// OAuthTokenResponseSchema is bare `z.number()` — no finite/range
			// guard (schemas.ts:422-429).
			expect(safeParseOAuthTokenResponse({ access_token: "a", expires_in: 0 })?.expires_in).toBe(0);
			expect(safeParseOAuthTokenResponse({ access_token: "a", expires_in: -60 })?.expires_in).toBe(-60);
			expect(safeParseOAuthTokenResponse({ access_token: "a", expires_in: 1e300 })?.expires_in).toBe(1e300);
			// Absent is the only bad value that is rejected.
			expect(safeParseOAuthTokenResponse({ access_token: "a" })).toBeNull();
		});

		it("PROVEN: expires_in = 0 produces an already-expired token (correctly refreshes)", async () => {
			vi.stubGlobal("fetch", vi.fn(async () =>
				new Response(JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_in: 0 }), { status: 200 }),
			));
			const result = await exchangeAuthorizationCode("code", "verifier");
			expect(result.type).toBe("success");
			if (result.type === "success") {
				expect(result.expires).toBe(T0);
				expect(shouldRefreshToken({ type: "oauth", access: result.access, refresh: result.refresh, expires: result.expires })).toBe(true);
			}
		});

		it("expires_in = -60 yields a token 60s in the past — refreshes on EVERY request (refresh storm)", async () => {
			vi.stubGlobal("fetch", vi.fn(async () =>
				new Response(JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_in: -60 }), { status: 200 }),
			));
			const result = await refreshAccessToken("r0");
			expect(result.type).toBe("success");
			if (result.type === "success") {
				expect(result.expires).toBe(T0 - 60_000);
				expect(shouldRefreshToken({ type: "oauth", access: result.access, refresh: result.refresh, expires: result.expires })).toBe(true);
			}
		});

		it("AUDIT BUG: huge expires_in produces a token that never refreshes — 1e306 overflows to +Infinity (auth.ts:293)", async () => {
			vi.stubGlobal("fetch", vi.fn(async () =>
				new Response(JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_in: 1e306 }), { status: 200 }),
			));
			const result = await refreshAccessToken("r0");
			expect(result.type).toBe("success");
			if (result.type === "success") {
				expect(result.expires).toBe(Number.POSITIVE_INFINITY);
				expect(shouldRefreshToken({ type: "oauth", access: result.access, refresh: result.refresh, expires: result.expires })).toBe(false);
			}
		});

		it("AUDIT BUG: expires_in = 1e290 stays finite but is ~1e285 years out — same never-refresh verdict (auth.ts:293)", async () => {
			vi.stubGlobal("fetch", vi.fn(async () =>
				new Response(JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_in: 1e290 }), { status: 200 }),
			));
			const result = await refreshAccessToken("r0");
			expect(result.type).toBe("success");
			if (result.type === "success") {
				expect(Number.isFinite(result.expires)).toBe(true);
				expect(result.expires).toBeGreaterThan(1e290);
				expect(shouldRefreshToken({ type: "oauth", access: result.access, refresh: result.refresh, expires: result.expires })).toBe(false);
			}
		});

		it("PROVEN: shouldRefreshProactively fires exactly at expiry-minus-buffer threshold", () => {
			expect(shouldRefreshProactively(makeAccount({ expires: T0 + MIN_PROACTIVE_BUFFER_MS }), 0)).toBe(true);
			expect(shouldRefreshProactively(makeAccount({ expires: T0 + MIN_PROACTIVE_BUFFER_MS + 1 }), 0)).toBe(false);
		});

		it("PROVEN: missing expiry with access token is NOT proactively refreshed; missing access always is", () => {
			expect(shouldRefreshProactively(makeAccount({ expires: undefined }))).toBe(false);
			expect(shouldRefreshProactively(makeAccount({ access: undefined, expires: T0 + 10 ** 12 }))).toBe(true);
		});

		it("AUDIT BUG: NaN/Infinity proactive buffer is not finite-guarded (proactive-refresh.ts:60-67)", () => {
			const account = makeAccount({ expires: T0 + 60_000 });
			// NaN buffer -> threshold NaN -> now >= NaN is false -> never proactive.
			expect(shouldRefreshProactively(account, Number.NaN)).toBe(false);
			// +Inf buffer -> threshold -Inf -> proactive on every call.
			expect(shouldRefreshProactively(account, Number.POSITIVE_INFINITY)).toBe(true);
			// -Inf -> Math.max(MIN, -Inf) = MIN -> behaves as the minimum buffer.
			expect(shouldRefreshProactively(makeAccount({ expires: T0 + MIN_PROACTIVE_BUFFER_MS }), Number.NEGATIVE_INFINITY)).toBe(true);
		});

		it("AUDIT QUIRK: getTimeUntilExpiry propagates NaN for non-finite expires (proactive-refresh.ts:76-81)", () => {
			expect(getTimeUntilExpiry(makeAccount({ expires: Number.NaN }))).toBeNaN();
			expect(getTimeUntilExpiry(makeAccount({ expires: undefined }))).toBe(Infinity);
			expect(getTimeUntilExpiry(makeAccount({ expires: T0 - 5 }))).toBe(0);
		});

		it("PROVEN: expiry verdict tracks the absolute stamp across both jump directions", () => {
			// A token stamped to expire at T0 is legitimately valid at T0-1 and
			// expired at T0 — absolute comparison is the correct semantics here;
			// a rollback that crosses the boundary simply restores validity.
			vi.setSystemTime(T0 - 1);
			expect(shouldRefreshToken(oauthAuth(T0))).toBe(false);
			vi.setSystemTime(T0);
			expect(shouldRefreshToken(oauthAuth(T0))).toBe(true);
			vi.setSystemTime(T0 - 3_600_000); // rollback: stamp expired before the rollback stays expired
			expect(shouldRefreshToken(oauthAuth(T0 - 7_200_000))).toBe(true);
		});
	});

	// ======================================================================
	// 2. Quota-window reset parsing boundaries
	// ======================================================================
	describe("quota-windows reset parsing", () => {
		const P = "x-codex-primary";
		const headers = (o: Record<string, string>) => new Headers(o);

		it("PROVEN: reset-after-seconds = 0 is ignored (falls through to reset-at)", () => {
			expect(parseQuotaResetAtMs(headers({ [`${P}-reset-after-seconds`]: "0" }), P, T0)).toBeUndefined();
		});

		it("PROVEN: reset-after-seconds = 1 -> now+1000", () => {
			expect(parseQuotaResetAtMs(headers({ [`${P}-reset-after-seconds`]: "1" }), P, T0)).toBe(T0 + 1000);
		});

		it("PROVEN: exact 30-day horizon is accepted", () => {
			const secs = MAX_QUOTA_RESET_HORIZON_MS / 1000;
			expect(parseQuotaResetAtMs(headers({ [`${P}-reset-after-seconds`]: String(secs) }), P, T0)).toBe(T0 + MAX_QUOTA_RESET_HORIZON_MS);
		});

		it("PROVEN: one second past the 30-day horizon is rejected", () => {
			const secs = MAX_QUOTA_RESET_HORIZON_MS / 1000 + 1;
			expect(parseQuotaResetAtMs(headers({ [`${P}-reset-after-seconds`]: String(secs) }), P, T0)).toBeUndefined();
		});

		it("PROVEN: the 4e9 incident value is rejected", () => {
			expect(parseQuotaResetAtMs(headers({ [`${P}-reset-after-seconds`]: "4000000000" }), P, T0)).toBeUndefined();
		});

		it("PROVEN: reset-after-seconds = -5 is ignored", () => {
			expect(parseQuotaResetAtMs(headers({ [`${P}-reset-after-seconds`]: "-5" }), P, T0)).toBeUndefined();
		});

		it("AUDIT QUIRK: 'reset-after-seconds: 1e6' parses as 1 via Number.parseInt prefix (quota-windows.ts:89-94)", () => {
			expect(parseQuotaResetAtMs(headers({ [`${P}-reset-after-seconds`]: "1e6" }), P, T0)).toBe(T0 + 1000);
		});

		it("AUDIT QUIRK: 'reset-after-seconds: 30abc' parses as 30 (quota-windows.ts:89-94)", () => {
			expect(parseQuotaResetAtMs(headers({ [`${P}-reset-after-seconds`]: "30abc" }), P, T0)).toBe(T0 + 30_000);
		});

		it("PROVEN: reset-after-seconds beats reset-at when both are present", () => {
			const h = headers({
				[`${P}-reset-after-seconds`]: "10",
				[`${P}-reset-at`]: String(Math.floor(T0 / 1000) + 999),
			});
			expect(parseQuotaResetAtMs(h, P, T0)).toBe(T0 + 10_000);
		});

		it("PROVEN: numeric reset-at epoch seconds are scaled by the 1e10 ceiling", () => {
			const epochSec = Math.floor(T0 / 1000) + 60;
			expect(parseQuotaResetAtMs(headers({ [`${P}-reset-at`]: String(epochSec) }), P, T0)).toBe(epochSec * 1000);
		});

		it("PROVEN: epoch-ms reset-at values are taken verbatim", () => {
			expect(parseQuotaResetAtMs(headers({ [`${P}-reset-at`]: String(T0 + 5000) }), P, T0)).toBe(T0 + 5000);
		});

		it("PROVEN: past reset-at parses at the low level but is dropped by the exhausted-window consumer", () => {
			const past = Math.floor(T0 / 1000) - 3600;
			const h = headers({
				[`${P}-used-percent`]: "100",
				[`${P}-window-minutes`]: "300",
				[`${P}-reset-at`]: String(past),
			});
			expect(parseQuotaResetAtMs(h, P, T0)).toBe(past * 1000);
			expect(getQuotaExhaustedResetAtMs(h, T0)).toBeUndefined();
		});

		it("PROVEN: ISO reset-at parses; garbage returns undefined", () => {
			expect(parseQuotaResetAtMs(headers({ [`${P}-reset-at`]: "2026-02-15T12:10:00Z" }), P, T0)).toBe(Date.parse("2026-02-15T12:10:00Z"));
			expect(parseQuotaResetAtMs(headers({ [`${P}-reset-at`]: "soon" }), P, T0)).toBeUndefined();
			expect(parseQuotaResetAtMs(headers({ [`${P}-reset-at`]: "NaN" }), P, T0)).toBeUndefined();
			expect(parseQuotaResetAtMs(headers({ [`${P}-reset-at`]: "Infinity" }), P, T0)).toBeUndefined();
		});

		it("PROVEN: reset-at adjacent to 2^53 ms is horizon-rejected", () => {
			expect(parseQuotaResetAtMs(headers({ [`${P}-reset-at`]: "9007199254740991" }), P, T0)).toBeUndefined();
		});

		it("PROVEN: max-representable Date ISO string is horizon-rejected", () => {
			expect(parseQuotaResetAtMs(headers({ [`${P}-reset-at`]: "+275760-09-13T00:00:00.000Z" }), P, T0)).toBeUndefined();
		});

		it("PROVEN: zero reset-at is rejected", () => {
			expect(parseQuotaResetAtMs(headers({ [`${P}-reset-at`]: "0" }), P, T0)).toBeUndefined();
		});

		it("AUDIT QUIRK: 'reset-at: -1' survives the \\d+ gate and Date.parse reads it as Jan 1 2001 (quota-windows.ts:135-138)", () => {
			// The numeric branch rejects "-1" (not all digits), so it falls into
			// Date.parse — which leniently parses "-1" as a year/month fragment
			// landing at 978278400000 (2001-01-01T00:00:00Z). Returned as a PAST
			// stamp, then dropped by every future-gated consumer — harmless but
			// surprising: a malformed header yields a 25-year-old "reset".
			expect(parseQuotaResetAtMs(headers({ [`${P}-reset-at`]: "-1" }), P, T0)).toBe(978278400000);
			const h = headers({
				[`${P}-used-percent`]: "100",
				[`${P}-window-minutes`]: "300",
				[`${P}-reset-at`]: "-1",
			});
			expect(getQuotaExhaustedResetAtMs(h, T0)).toBeUndefined(); // past -> ignored
		});

		it("PROVEN: window-minutes = 0 disables the window — never counts as exhausted", () => {
			const window = parseCodexQuotaWindows(
				headers({
					[`${P}-used-percent`]: "100",
					[`${P}-window-minutes`]: "0",
					[`${P}-reset-after-seconds`]: "300",
				}),
				T0,
			)[0];
			expect(window).toBeDefined();
			expect(isQuotaWindowExhausted(window!)).toBe(false);
		});

		it("PROVEN: month/year rollover — 7d window across Dec 31 -> Jan 7 stays absolute", () => {
			const dec31 = Date.UTC(2026, 11, 31, 12, 0, 0);
			const secs = 7 * 24 * 3600;
			expect(parseQuotaResetAtMs(headers({ [`${P}-reset-after-seconds`]: String(secs) }), P, dec31)).toBe(dec31 + secs * 1000);
		});

		it("PROVEN: leap day — reset landing on 2028-02-29 parses", () => {
			const feb23 = Date.UTC(2028, 1, 23, 0, 0, 0);
			const secs = 6 * 24 * 3600;
			expect(parseQuotaResetAtMs(headers({ [`${P}-reset-after-seconds`]: String(secs) }), P, feb23)).toBe(Date.UTC(2028, 1, 29, 0, 0, 0));
		});

		it("PROVEN: DST spring-forward — epoch arithmetic ignores the missing hour (TZ=America/New_York)", () => {
			vi.stubEnv("TZ", "America/New_York");
			const pre = Date.UTC(2026, 2, 7, 17, 0, 0); // Mar 7 12:00 EST
			const result = parseQuotaResetAtMs(headers({ [`${P}-reset-after-seconds`]: "172800" }), P, pre);
			expect(result).toBe(pre + 172_800_000); // Mar 9 13:00 EDT — absolute
			expect(formatUsageReset(result)).toBeTruthy();
		});

		it("PROVEN: DST fall-back — a 25-hour day does not shift the reset instant", () => {
			vi.stubEnv("TZ", "America/New_York");
			const pre = Date.UTC(2026, 10, 1, 4, 0, 0); // midnight EDT, Nov 1 2026
			const result = parseQuotaResetAtMs(headers({ [`${P}-reset-after-seconds`]: "86400" }), P, pre);
			expect(result).toBe(pre + 86_400_000);
		});

		it("PROVEN: exhausted windows pick the LATER of primary/secondary resets", () => {
			const h = headers({
				"x-codex-primary-used-percent": "100",
				"x-codex-primary-window-minutes": "300",
				"x-codex-primary-reset-after-seconds": "3600",
				"x-codex-secondary-used-percent": "100",
				"x-codex-secondary-window-minutes": "10080",
				"x-codex-secondary-reset-after-seconds": "86400",
			});
			expect(getQuotaExhaustedResetAtMs(h, T0)).toBe(T0 + 86_400_000);
		});
	});

	// ======================================================================
	// 3. Retry-After / retry timing
	// ======================================================================
	describe("retry-after parsing via handleErrorResponse", () => {
		const rateLimited = (hdrs: Record<string, string>, body = "") =>
			new Response(body, { status: 429, headers: hdrs });

		it("PROVEN: past HTTP-date Retry-After falls through to the 60s default", async () => {
			const past = new Date(T0 - 60_000).toUTCString();
			const { rateLimit } = await handleErrorResponse(rateLimited({ "retry-after": past }));
			expect(rateLimit?.retryAfterMs).toBe(60_000);
		});

		it("PROVEN: HTTP-date Retry-After 120s out is honored (within the 5min cap)", async () => {
			const future = new Date(T0 + 120_000).toUTCString();
			const { rateLimit } = await handleErrorResponse(rateLimited({ "retry-after": future }));
			// toUTCString truncates to seconds; allow a 1s tolerance band.
			expect(rateLimit?.retryAfterMs).toBeGreaterThan(119_000);
			expect(rateLimit?.retryAfterMs).toBeLessThanOrEqual(120_000);
		});

		it("PROVEN: far-future HTTP-date Retry-After is capped at 5 minutes", async () => {
			const far = new Date(T0 + 365 * 86_400_000).toUTCString();
			const { rateLimit } = await handleErrorResponse(rateLimited({ "retry-after": far }));
			expect(rateLimit?.retryAfterMs).toBe(300_000);
		});

		it("PROVEN: numeric Retry-After 0 and negative values fall through", async () => {
			for (const value of ["0", "-5"]) {
				const { rateLimit } = await handleErrorResponse(rateLimited({ "retry-after": value }));
				expect(rateLimit?.retryAfterMs).toBe(60_000);
			}
		});

		it("PROVEN: unparseable Retry-After falls through", async () => {
			const { rateLimit } = await handleErrorResponse(rateLimited({ "retry-after": "tomorrow-ish" }));
			expect(rateLimit?.retryAfterMs).toBe(60_000);
		});

		it("PROVEN: Retry-After only fires on a genuine 429 — a 400 with a future date is not a rate limit", async () => {
			const far = new Date(T0 + 120_000).toUTCString();
			const { rateLimit } = await handleErrorResponse(
				new Response("", { status: 400, headers: { "retry-after": far } }),
			);
			expect(rateLimit).toBeUndefined();
		});

		it("AUDIT QUIRK: 429 + x-ratelimit-reset far-future yields an UNCAPPED multi-year retryAfterMs — produced, but every consumer clamps (fetch-helpers.ts:1690-1701)", async () => {
			// 9999999999 epoch-seconds == year 2286. The x-codex-* headers are
			// horizon-guarded at 30d; this generic header is not. The unbounded
			// value is real and observable, but today every consumer clamps it:
			// getRateLimitBackoff caps at 60s (index.ts:3644) before
			// markRateLimitedWithReason ever sees it, and the raw-value consumer
			// (index.ts:3602) only runs under retryAsServerError, which forces
			// quotaHeadersAuthoritative=false — the uncapped branch can't produce
			// a value there. Latent trap for the next consumer, not a live bug.
			const { rateLimit } = await handleErrorResponse(
				rateLimited({ "x-ratelimit-reset": "9999999999" }),
			);
			expect(rateLimit?.retryAfterMs).toBe(9_999_999_999_000 - T0);
		});

		it("AUDIT QUIRK: 429 body resets_at far-future is likewise uncapped — same latent-trap status (fetch-helpers.ts:1703-1710)", async () => {
			const body = JSON.stringify({ error: { message: "rate limited", resets_at: 9_999_999_999 } });
			const { rateLimit } = await handleErrorResponse(rateLimited({}, body));
			expect(rateLimit?.retryAfterMs).toBe(9_999_999_999_000 - T0);
		});

		it("PROVEN: exhausted Codex window reset is authoritative and horizon-guarded", async () => {
			const { rateLimit } = await handleErrorResponse(
				rateLimited({
					"x-codex-primary-used-percent": "100",
					"x-codex-primary-window-minutes": "300",
					"x-codex-primary-reset-after-seconds": "4000000000",
				}),
			);
			expect(rateLimit?.retryAfterMs).toBe(60_000);
		});

		it("PROVEN: same exhausted headers on a non-429 status are NOT authoritative", async () => {
			const { rateLimit, quotaHeadersAuthoritative } = await handleErrorResponse(
				new Response(JSON.stringify({ error: { message: "rate_limit_exceeded" } }), {
					status: 500,
					headers: {
						"x-codex-primary-used-percent": "100",
						"x-codex-primary-window-minutes": "300",
						"x-codex-primary-reset-after-seconds": "7200",
					},
				}),
			);
			expect(rateLimit?.retryAfterMs).toBe(60_000);
			expect(quotaHeadersAuthoritative).toBe(false);
		});
	});

	describe("rate-limit backoff clock jumps", () => {
		it("PROVEN: consecutive 429s within the reset window escalate", () => {
			vi.setSystemTime(T0);
			expect(getRateLimitBackoff(0, "codex", 1000, () => 0.5).attempt).toBe(1);
			vi.setSystemTime(T0 + 3_000);
			expect(getRateLimitBackoff(0, "codex", 1000, () => 0.5).attempt).toBe(2);
		});

		it("AUDIT BUG: backward jump turns a new 429 into a 'duplicate' (rate-limit-backoff.ts:87)", () => {
			vi.setSystemTime(T0);
			getRateLimitBackoff(0, "codex", 1000, () => 0.5); // attempt 1 at T0
			vi.setSystemTime(T0 - 1_000); // clock rolls back 1s
			const result = getRateLimitBackoff(0, "codex", 1000, () => 0.5);
			// now - lastAt = -1000 < 2000 -> reported as a duplicate, so the
			// second distinct 429 never increments the counter.
			expect(result.isDuplicate).toBe(true);
			expect(result.attempt).toBe(1);
		});

		it("AUDIT BUG: any backward jump freezes the attempt counter — every subsequent 429 reports as a duplicate (rate-limit-backoff.ts:87)", () => {
			vi.setSystemTime(T0);
			getRateLimitBackoff(0, "codex", 1000, () => 0.5); // attempt 1
			vi.setSystemTime(T0 + 3_000);
			getRateLimitBackoff(0, "codex", 1000, () => 0.5); // attempt 2, lastAt = T0+3000
			vi.setSystemTime(T0 - 121_000); // rollback > 120s reset window
			// now - lastAt = -124s: negative, so the 120s staleness prune can never
			// fire, AND any negative diff satisfies `< 2000` -> the dedup branch
			// runs first and the distinct 429 never escalates the counter.
			const result = getRateLimitBackoff(0, "codex", 1000, () => 0.5);
			expect(result.isDuplicate).toBe(true);
			expect(result.attempt).toBe(2);
			// Still deduped an hour deeper into the rollback — the freeze lasts
			// until wall clock returns past the stamp.
			vi.setSystemTime(T0 - 3_600_000);
			const deep = getRateLimitBackoff(0, "codex", 1000, () => 0.5);
			expect(deep.isDuplicate).toBe(true);
			expect(deep.attempt).toBe(2);
		});

		it("PROVEN: forward jump past 120s resets backoff state", () => {
			vi.setSystemTime(T0);
			getRateLimitBackoff(0, "codex", 1000, () => 0.5);
			vi.setSystemTime(T0 + 121_000);
			expect(getRateLimitBackoff(0, "codex", 1000, () => 0.5).attempt).toBe(1);
		});

		it("PROVEN: non-finite/negative server retry-after is normalized away", () => {
			expect(getRateLimitBackoff(0, "gpt52", Number.NaN, () => 0.5).delayMs).toBe(1000);
			expect(getRateLimitBackoff(0, "gpt52", -50, () => 0.5).delayMs).toBe(0);
			expect(getRateLimitBackoff(0, "gpt52", Infinity, () => 0.5).delayMs).toBe(1000);
		});

		it("PROVEN: addJitter clamps the output at zero and floors", () => {
			const rand = vi.spyOn(Math, "random");
			rand.mockReturnValue(0); // worst-case negative jitter
			expect(addJitter(10_000, 0.1)).toBe(9_000);
			// An over-large factor can only push the result down to 0, never below.
			expect(addJitter(1_000, 5)).toBe(0);
			rand.mockReturnValue(0.999999); // near-positive bound
			expect(addJitter(10_000, 0.1)).toBe(10_999);
		});
	});

	describe("retry-budget wait accounting", () => {
		const limits = resolveRetryBudgetLimits("balanced");

		it("PROVEN: NaN, Infinity, and negative waits each cost a full unit", () => {
			const tracker = new RetryBudgetTracker(limits);
			tracker.consumeWait("network", Number.NaN);
			tracker.consumeWait("network", Number.POSITIVE_INFINITY);
			tracker.consumeWait("network", -1);
			expect(tracker.getUsage().network).toBe(3);
		});

		it("PROVEN: sub-unit waits accumulate on a carry before charging", () => {
			const tracker = new RetryBudgetTracker(limits);
			// Four 100ms waits never reach the 5s unit: no charge.
			for (let i = 0; i < 4; i += 1) {
				expect(tracker.consumeWait("network", 100)).toBe(true);
			}
			expect(tracker.getUsage().network).toBe(0);
			// Crossing the 5s carry threshold charges exactly one unit.
			tracker.consumeWait("network", RETRY_WAIT_BUDGET_UNIT_MS - 200);
			expect(tracker.getUsage().network).toBe(1);
		});

		it("PROVEN: an exhausted bucket refuses even a zero wait", () => {
			const tracker = new RetryBudgetTracker({ ...limits, network: 0 });
			expect(tracker.consumeWait("network", 0)).toBe(false);
		});
	});

	// ======================================================================
	// 4. Rotation / cooldown / selection clocks
	// ======================================================================
	describe("account rotation clocks", () => {
		it("PROVEN: cooldown expires exactly at coolingDownUntil", () => {
			const manager = makeManager([{ refreshToken: "tok" }]);
			const live = manager.getCurrentAccount()!;
			manager.markAccountCoolingDown(live, 30_000, "auth-failure");
			vi.setSystemTime(T0 + 29_999);
			expect(manager.isAccountCoolingDown(live)).toBe(true);
			vi.setSystemTime(T0 + 30_000);
			expect(manager.isAccountCoolingDown(live)).toBe(false);
		});

		it("AUDIT BUG: NaN cooldown stamps coolingDownUntil = NaN — isAccountCoolingDown() reports cooling-down forever in-memory (accounts/rotation.ts:498-499, accounts/state.ts:858)", () => {
			// Not reachable through the request path (callers pass the 30s
			// constant), but the write path is not finite-guarded: Math.max(0,
			// Math.floor(NaN)) = NaN. `now >= NaN` is false, so the expired-clear
			// never fires; the account stays cooling until process restart.
			const manager = makeManager([{ refreshToken: "tok" }]);
			const live = manager.getCurrentAccount()!;
			manager.markAccountCoolingDown(live, Number.NaN, "auth-failure");
			expect(live.coolingDownUntil).toBeNaN();
			expect(manager.isAccountCoolingDown(live)).toBe(true);
			vi.setSystemTime(T0 + 10 * 86_400_000);
			expect(manager.isAccountCoolingDown(live)).toBe(true);
		});

		it("AUDIT BUG: Infinity cooldown stamps coolingDownUntil = +Inf — a permanent in-memory cooldown (accounts/rotation.ts:498-499)", () => {
			const manager = makeManager([{ refreshToken: "tok" }]);
			const live = manager.getCurrentAccount()!;
			manager.markAccountCoolingDown(live, Number.POSITIVE_INFINITY, "auth-failure");
			expect(live.coolingDownUntil).toBe(Infinity);
			vi.setSystemTime(T0 + 365 * 86_400_000);
			expect(manager.isAccountCoolingDown(live)).toBe(true);
		});

		it("PROVEN: markQuotaExhausted rejects past, >30d, and non-finite resets", () => {
			const manager = makeManager([{ refreshToken: "tok" }]);
			const live = manager.getCurrentAccount()!;
			expect(manager.markQuotaExhausted(live, T0 - 1, "codex")).toBe(false);
			expect(manager.markQuotaExhausted(live, T0, "codex")).toBe(false);
			expect(manager.markQuotaExhausted(live, T0 + MAX_QUOTA_RESET_HORIZON_MS + 1, "codex")).toBe(false);
			expect(manager.markQuotaExhausted(live, Number.NaN, "codex")).toBe(false);
			expect(manager.markQuotaExhausted(live, T0 + 3_600_000, "codex")).toBe(true);
		});

		it("PROVEN: quota-exhaustion block releases exactly at the stamp", () => {
			const manager = makeManager([{ refreshToken: "tok" }]);
			const live = manager.getCurrentAccount()!;
			manager.markQuotaExhausted(live, T0 + 60_000, "codex");
			vi.setSystemTime(T0 + 59_999);
			expect(isQuotaExhausted(live)).toBe(true);
			vi.setSystemTime(T0 + 60_000);
			expect(isQuotaExhausted(live)).toBe(false);
		});

		it("PROVEN: rate-limit reset in the future is honored; expiry boundary clears it", () => {
			const manager = makeManager([{ refreshToken: "tok" }]);
			const live = manager.getCurrentAccount()!;
			manager.markRateLimitedWithReason(live, 30_000, "codex", "quota");
			vi.setSystemTime(T0 + 29_999);
			expect(manager.getMinWaitTimeForFamily("codex")).toBeGreaterThan(0);
			vi.setSystemTime(T0 + 30_000);
			expect(manager.getMinWaitTimeForFamily("codex")).toBe(0);
		});

		it("PROVEN: a shorter block cannot shorten an existing longer one", () => {
			const manager = makeManager([{ refreshToken: "tok" }]);
			const live = manager.getCurrentAccount()!;
			manager.markRateLimitedWithReason(live, 300_000, "codex", "quota");
			manager.markRateLimitedWithReason(live, 30_000, "codex", "unknown");
			vi.setSystemTime(T0 + 120_000);
			expect(manager.getMinWaitTimeForFamily("codex")).toBeGreaterThan(0);
			vi.setSystemTime(T0 + 300_000);
			expect(manager.getMinWaitTimeForFamily("codex")).toBe(0);
		});

		it("AUDIT BUG: markRateLimitedWithReason accepts an uncapped retryAfterMs — a 311-year in-memory block (accounts/rotation.ts:422-446)", () => {
			// Paired with the uncapped x-ratelimit-reset/resets_at read:
			// getMinWaitTimeForFamily then reports the same ~1.15e8-day wait and
			// the toast format confirms it reaches users verbatim.
			const manager = makeManager([{ refreshToken: "tok" }]);
			const live = manager.getCurrentAccount()!;
			const year2286Delta = 9_999_999_999_000 - T0;
			manager.markRateLimitedWithReason(live, year2286Delta, "codex", "quota");
			expect(manager.getMinWaitTimeForFamily("codex")).toBe(year2286Delta);
			const days = Number(formatWaitTime(year2286Delta).split("d")[0]);
			// ~95,241 days ≈ 261 years — the "try again in" text reaches users.
			expect(days).toBeGreaterThan(90_000);
		});

		it("AUDIT BUG: markRateLimitedWithReason(NaN/Infinity) writes a non-finite reset — Infinity blocks forever in-memory and clobbers a valid shorter block (accounts/rotation.ts:429-441,404-418)", () => {
			const manager = makeManager([{ refreshToken: "tok" }]);
			const live = manager.getCurrentAccount()!;

			// Seed a legitimate 5s block, then overwrite it with NaN:
			// extendRateLimitReset's only guard is `existing >= resetAt` —
			// `finite >= NaN` is false, so the valid stamp is replaced.
			manager.markRateLimitedWithReason(live, 5_000, "codex", "quota");
			expect(live.rateLimitResetTimes?.codex).toBeGreaterThan(T0);
			manager.markRateLimitedWithReason(live, Number.NaN, "codex", "quota");
			expect(live.rateLimitResetTimes?.codex).toBeNaN();
			// NaN is a ghost: not blocked (`now < NaN` false) but never cleared
			// (`now >= NaN` false) — survives until a storage write heals it.
			vi.setSystemTime(T0 + 86_400_000);
			expect(live.rateLimitResetTimes?.codex).toBeNaN();

			// Infinity is worse: `now < Infinity` — a permanent in-memory block
			// that also overwrites any shorter legitimate stamp.
			live.rateLimitResetTimes = { codex: T0 + 5_000 };
			vi.setSystemTime(T0);
			manager.markRateLimitedWithReason(live, Number.POSITIVE_INFINITY, "codex", "quota");
			expect(live.rateLimitResetTimes?.codex).toBe(Number.POSITIVE_INFINITY);
			expect(manager.getMinWaitTimeForFamily("codex")).toBe(Number.POSITIVE_INFINITY);
		});

		it("AUDIT BUG: token-bucket refill lacks the negative-elapsed clamp — clock rollback yields negative tokens (rotation.ts:219-224)", () => {
			// Contrast the sibling HealthScoreTracker which clamps elapsed at 0
			// (rotation.ts:104, comment cites a measured -17440 regression).
			vi.setSystemTime(T0);
			const bucket = new TokenBucketTracker();
			bucket.tryConsume(0, "codex"); // lastRefill = T0, tokens 49/50
			vi.setSystemTime(T0 - 10 * 60_000);
			// minutesSinceRefill = -10 -> tokensToAdd = -60 -> 49 - 60 = -11.
			expect(bucket.getTokens(0, "codex")).toBe(-11);
			expect(bucket.hasToken(0, "codex")).toBe(false);
			expect(bucket.msUntilToken(0, "codex")).toBe(120_000);
			expect(bucket.tryConsume(0, "codex")).toBe(false);
		});

		it("PROVEN: health-score passive recovery clamps negative elapsed at zero", () => {
			vi.setSystemTime(T0);
			const health = new HealthScoreTracker();
			health.recordFailure(0, "codex");
			expect(health.getScore(0, "codex")).toBe(80);
			vi.setSystemTime(T0 - 3_600_000);
			expect(health.getScore(0, "codex")).toBe(80);
		});

		it("PROVEN: health-score forward jump applies passive recovery hours", () => {
			vi.setSystemTime(T0);
			const health = new HealthScoreTracker();
			health.recordFailure(0, "codex");
			vi.setSystemTime(T0 + 10 * 3_600_000); // +10h -> +20, clamped to 100
			expect(health.getScore(0, "codex")).toBe(100);
		});

		it("AUDIT FINDING: clock rollback keeps a rate-limit block valid proportionally longer in wall time (accounts/rate-limits.ts:50)", () => {
			// clearExpiredRateLimits compares absolute stamps: a 30s block written
			// pre-rollback survives 30s + the rollback distance in wall time.
			// This is the conservative direction — over-blocking, never under.
			const entity = { rateLimitResetTimes: { codex: T0 + 30_000 } };
			vi.setSystemTime(T0 - 60_000);
			clearExpiredRateLimits(entity);
			expect(entity.rateLimitResetTimes.codex).toBe(T0 + 30_000);
		});
	});

	// ======================================================================
	// 5. Health surface
	// ======================================================================
	describe("health.ts boundary behavior", () => {
		const account = (overrides: Record<string, unknown> = {}) => ({
			index: 0,
			health: 80,
			...overrides,
		});

		it("PROVEN: rateLimitedUntil == now is NOT rate-limited; now+1 is", () => {
			expect(getAccountHealth([account({ rateLimitedUntil: T0 })], T0).accounts[0]!.isRateLimited).toBe(false);
			expect(getAccountHealth([account({ rateLimitedUntil: T0 + 1 })], T0).accounts[0]!.isRateLimited).toBe(true);
		});

		it("PROVEN: cooldownUntil == now is NOT cooling down; now+1 is", () => {
			expect(getAccountHealth([account({ cooldownUntil: T0 })], T0).accounts[0]!.isCoolingDown).toBe(false);
			expect(getAccountHealth([account({ cooldownUntil: T0 + 1 })], T0).accounts[0]!.isCoolingDown).toBe(true);
		});

		it("AUDIT QUIRK: NaN timestamps read as healthy, not poisoned (health.ts:47-48)", () => {
			const health = getAccountHealth([account({ rateLimitedUntil: Number.NaN, cooldownUntil: Number.NaN })], T0);
			expect(health.accounts[0]!.isRateLimited).toBe(false);
			expect(health.accounts[0]!.isCoolingDown).toBe(false);
		});

		it("PROVEN: a far-future timestamp still reports limited — the health surface is honest", () => {
			const health = getAccountHealth([account({ rateLimitedUntil: T0 + 10 ** 15 })], T0);
			expect(health.accounts[0]!.isRateLimited).toBe(true);
		});
	});

	// ======================================================================
	// 6. Persistence normalization and locks under skew
	// ======================================================================
	describe("storage normalization", () => {
		it("PROVEN: non-finite and >30d timing fields are dropped on load", () => {
			const storage = normalizeAccountStorage(
				makeStorage([
					{
						refreshToken: "tok",
						expiresAt: Number.POSITIVE_INFINITY,
						coolingDownUntil: 9e15,
						quotaExhaustedUntil: T0 + MAX_QUOTA_RESET_HORIZON_MS + 1,
						rateLimitResetTimes: { codex: 1e300, gpt52: T0 + 60_000 },
					},
				]),
			);
			const account = storage!.accounts[0]!;
			expect(account.expiresAt).toBeUndefined();
			expect(account.coolingDownUntil).toBeUndefined();
			expect(account.quotaExhaustedUntil).toBeUndefined();
			expect(account.rateLimitResetTimes).toEqual({ gpt52: T0 + 60_000 });
		});

		it("PROVEN: past expiresAt is KEPT — expired tokens still refresh normally", () => {
			const storage = normalizeAccountStorage(
				makeStorage([{ refreshToken: "tok", expiresAt: T0 - 86_400_000 }]),
			);
			expect(storage!.accounts[0]!.expiresAt).toBe(T0 - 86_400_000);
		});

		it("PROVEN: a fully-poisoned rateLimitResetTimes map is dropped entirely", () => {
			const storage = normalizeAccountStorage(
				makeStorage([
					{ refreshToken: "tok", rateLimitResetTimes: { codex: Number.NaN } },
				]),
			);
			expect(storage!.accounts[0]!.rateLimitResetTimes).toBeUndefined();
		});
	});

	describe("worktree-lock stale detection", () => {
		let dir: string;
		let storagePath: string;
		let lockPath: string;

		beforeEach(async () => {
			// Date-only faking: proper-lockfile and fs timestamps must keep real
			// timers/real mtimes while Date.now() is skewable.
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(T0);
			dir = await fs.mkdtemp(join(tmpdir(), "wt-lock-"));
			storagePath = join(dir, "accounts.json");
			lockPath = `${storagePath}.lock`;
			await fs.writeFile(storagePath, "{}", "utf-8");
		});

		afterEach(async () => {
			await releaseLock(storagePath).catch(() => undefined);
			await fs.rm(dir, { recursive: true, force: true });
		});

		const writeForeignLock = (lastActive: Date, host = "other-host") =>
			fs.writeFile(
				lockPath,
				JSON.stringify({
					pid: 999_999_999, // dead/unreachable pid
					hostname: host,
					cwd: "/some/other/worktree",
					startedAt: new Date(T0 - 10_000).toISOString(),
					lastActive: lastActive.toISOString(),
				}),
				"utf-8",
			);

		it("PROVEN: foreign-host lock older than 1h is reclaimed", async () => {
			await writeForeignLock(new Date(T0 - 3_700_000));
			const result = await acquireOrDetectLock(storagePath);
			expect(result.acquired).toBe(true);
		});

		it("AUDIT BUG: foreign-host lock with future lastActive is never stale — blocks takeover indefinitely (worktree-lock.ts:233-236)", async () => {
			// A lock file synced from a host with a fast clock (or corrupted to a
			// future stamp) yields a negative age, which never exceeds the 1h
			// stale threshold. Cross-host there is no PID probe to rescue the
			// check, so the lock reports held until wall clock overtakes the
			// bogus stamp — for a year-2027 stamp, effectively forever.
			await writeForeignLock(new Date(T0 + 365 * 86_400_000));
			const result = await acquireOrDetectLock(storagePath);
			expect(result.acquired).toBe(false);
		});

		it("PROVEN: same-host dead-PID lock is reclaimed regardless of timestamp", async () => {
			await writeForeignLock(new Date(T0 + 86_400_000), hostname());
			const result = await acquireOrDetectLock(storagePath);
			expect(result.acquired).toBe(true);
		});

		it("PROVEN: clock rollback makes a fresh foreign lock conservative, not stale", async () => {
			await writeForeignLock(new Date(T0 - 1000), "other-host");
			vi.setSystemTime(T0 - 3_700_000); // roll back an hour
			const result = await acquireOrDetectLock(storagePath);
			// Age computes negative -> not stale -> foreign lock respected.
			expect(result.acquired).toBe(false);
		});

		it("AUDIT FINDING: mtime-based locks treat a far-forward host clock as licence to steal a live lock (quota-notification-state.ts:100-103 via proper-lockfile)", async () => {
			// proper-lockfile's stale check compares the lock dir's fs mtime
			// (real wall clock) against Date.now() (skewable). A clock far ahead
			// sees every foreign lock as stale and steals it.
			const statePath = join(dir, "quota-notifications.json");
			await fs.mkdir(`${statePath}.lock`); // simulate a foreign, live lock
			vi.setSystemTime(T0 + 400 * 86_400_000); // a year+ ahead of real mtime
			await expect(
				updateQuotaNotificationState(statePath, (state) => ({
					state: state ?? { fiveHour: {}, weekly: {}, updatedAt: Date.now() },
					result: true,
				})),
			).resolves.toBe(true);
		});
	});

	// ======================================================================
	// 6b. Storage lease TTLs — transaction lock (10s stale) and the refresh
	// lease (60s stale) that serializes the single-use refresh-token exchange
	// ======================================================================
	describe("storage lease TTLs (transaction lock + refresh lease)", () => {
		let dir: string;

		beforeEach(async () => {
			// setTimeout faked so proper-lockfile retry delays are ours to drive;
			// setImmediate/fs stay real so stat/mkdir/utimes complete.
			vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
			vi.setSystemTime(T0);
			dir = await fs.mkdtemp(join(tmpdir(), "tlock-"));
		});

		afterEach(async () => {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		});

		// proper-lockfile's retry loop is timer-driven, but every retry performs
		// REAL async fs work. Pump: advance fake timers ONLY while a retry timer
		// is actually pending (so fake-now moves at the retry schedule's pace —
		// advancing unconditionally would let fake time drift past the stale
		// threshold before the ~15 retries have fired). Between advances, yield
		// the real event loop so fs callbacks resolve. `heartbeatDir`, when
		// given, re-stamps the lock dir to the current fake time each iteration —
		// simulating the live holder's `update: 5000` mtime refresh (without it
		// a static stamp legitimately ages into "stale" as we pump).
		async function pumpUntilSettled(
			isSettled: () => boolean,
			maxIterations = 400,
			heartbeatDir?: string,
		): Promise<void> {
			for (let i = 0; i < maxIterations && !isSettled(); i += 1) {
				if (heartbeatDir) {
					await fs.utimes(heartbeatDir, Date.now() / 1000, Date.now() / 1000);
				}
				if (vi.getTimerCount() > 0) {
					await vi.advanceTimersByTimeAsync(250);
				}
				await new Promise((resolve) => setImmediate(resolve));
			}
		}

		async function stampLockDir(lockDir: string, atMs: number): Promise<void> {
			await fs.mkdir(lockDir, { recursive: true });
			await fs.utimes(lockDir, atMs / 1000, atMs / 1000);
		}

		it("PROVEN: refresh lease older than the 60s stale window is reclaimed", async () => {
			const storagePath = join(dir, "accounts.json");
			const lockDir = getRefreshLeasePath(storagePath);
			await stampLockDir(lockDir, T0 - 61_000); // stale by 1s vs REFRESH_LEASE_STALE_MS

			const result = await withRefreshLease(storagePath, async (lease) => {
				lease.assertValid();
				return "exchange-ran";
			});
			expect(result).toBe("exchange-ran");
			// Lease released cleanly -> dir removed.
			await expect(fs.stat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("PROVEN: live refresh lease under a steady clock blocks the contender — retries exhaust to contention error", async () => {
			const storagePath = join(dir, "accounts.json");
			const lockDir = getRefreshLeasePath(storagePath);
			// A live holder acquired 30s ago — its 5s heartbeat keeps mtime fresh;
			// at a steady clock this lease is nowhere near the 60s stale window.
			await stampLockDir(lockDir, T0 - 30_000);

			let acquired = false;
			let settled = false;
			let outcome: unknown;
			const pending = withRefreshLease(storagePath, async () => {
				acquired = true;
				return "exchange-ran";
			}).then((v) => { outcome = v; settled = true; })
				.catch((e) => { outcome = e; settled = true; });

			await pumpUntilSettled(() => settled, 400, lockDir);
			expect(settled).toBe(true);
			expect(acquired).toBe(false);
			expect(outcome).toBeInstanceOf(StorageTransactionContentionError);
			await pending;
		});

		it("AUDIT BUG: same live lease — jump the clock forward 61s mid-retry and the contender steals it (transaction-lock.ts:48)", async () => {
			const storagePath = join(dir, "accounts.json");
			const lockDir = getRefreshLeasePath(storagePath);
			await stampLockDir(lockDir, T0 - 30_000);

			let acquired = false;
			let settled = false;
			let outcome: unknown;
			const pending = withRefreshLease(storagePath, async () => {
				acquired = true; // ran while the "holder" never released
				return "exchange-ran";
			}).then((v) => { outcome = v; settled = true; })
				.catch((e) => { outcome = e; settled = true; });

			// A few retries on the steady clock, holder heartbeat live — still
			// fresh, still waiting.
			for (let i = 0; i < 5; i++) {
				await fs.utimes(lockDir, Date.now() / 1000, Date.now() / 1000);
				await vi.advanceTimersByTimeAsync(1_000);
				await new Promise((resolve) => setImmediate(resolve));
			}
			expect(acquired).toBe(false);

			// Contender's wall clock jumps forward past the 60s stale window.
			// The mtime stamped before the jump is a filesystem wall-clock stamp —
			// to the contender it is instantly >60s old. The holder's next
			// heartbeat (every `update`=5s, monotonic) hasn't fired yet, so the
			// next contender retry wins the race: rmdir the live lockdir and
			// acquire. Mutual exclusion is broken for a <=5s window after any
			// >60s forward jump — and BOTH processes then hold what each
			// believes is an exclusive single-use-refresh-token lease.
			vi.setSystemTime(T0 + 61_000);
			await pumpUntilSettled(() => settled); // no heartbeat — holder's next tick hasn't landed
			expect(settled).toBe(true);
			expect(acquired).toBe(true);
			expect(outcome).toBe("exchange-ran");
			await pending;
		});

		it("AUDIT FINDING: a contender on a rolled-back clock can never see the lease as stale — retries exhaust to contention error (transaction-lock.ts:152-163)", async () => {
			const storagePath = join(dir, "accounts.json");
			const lockDir = getRefreshLeasePath(storagePath);
			// Holder acquired 61s ago relative to T0 — stale to anyone at T0.
			await stampLockDir(lockDir, T0 - 61_000);
			// But this contender's clock sits 2 minutes in the past.
			vi.setSystemTime(T0 - 120_000);

			let settled = false;
			let outcome: unknown;
			const pending = withRefreshLease(storagePath, async () => "exchange-ran")
				.then((v) => { outcome = v; settled = true; })
				.catch((e) => { outcome = e; settled = true; });

			await pumpUntilSettled(() => settled);
			expect(settled).toBe(true);
			// mtime(T0-61000) <= (T0-120000)-60000 = T0-180000? Never -> ELOCKED.
			expect(outcome).toBeInstanceOf(StorageTransactionContentionError);
			await pending;
		});

		it("PROVEN: transaction lock older than the 10s stale window is reclaimed", async () => {
			const storagePath = join(dir, "accounts.json");
			const lockDir = getStorageTransactionLockPath(storagePath);
			await stampLockDir(lockDir, T0 - 11_000);

			const result = await withStorageTransaction({
				storagePath,
				load: async () => ({ count: 1 }),
				handler: async (current, _persist) => current.count + 1,
			});
			expect(result).toBe(2);
		});
	});

	// ======================================================================
	// 7. Quota-notification state and the 30-minute poller
	// ======================================================================
	describe("quota notifications", () => {
		it("PROVEN: transitionQuotaState fires a crossing once and re-arms after recovery", () => {
			const usage = {
				fiveHour: { remainingPercent: 20, resetAtMs: T0 + 3_600_000 },
				weekly: { remainingPercent: 80, resetAtMs: T0 + 86_400_000 },
			};
			const first = transitionQuotaState(undefined, usage, [50, 25], T0);
			expect(first.crossings.map((c) => c.threshold)).toEqual([25]); // most severe wins
			const again = transitionQuotaState(first.state, usage, [50, 25], T0 + 60_000);
			expect(again.crossings).toHaveLength(0); // no re-fire at the same level
			const recovered = transitionQuotaState(again.state, {
				fiveHour: { remainingPercent: 90 },
				weekly: { remainingPercent: 80 },
			}, [50, 25], T0 + 120_000);
			expect(recovered.crossings).toHaveLength(0);
			const reDrop = transitionQuotaState(recovered.state, usage, [50, 25], T0 + 180_000);
			expect(reDrop.crossings).toHaveLength(1); // re-armed after recovery
		});

		it("PROVEN: persisted state with future lastDeliveredAt validates as usable — no temporal guard (quota-notification-state.ts:56-62)", async () => {
			const dir = await fs.mkdtemp(join(tmpdir(), "qns-"));
			const statePath = join(dir, "quota-notifications.json");
			await fs.writeFile(statePath, JSON.stringify({
				fiveHour: { lastPercent: 50 },
				weekly: { lastPercent: 50 },
				lastDeliveredAt: T0 + 10 * 86_400_000, // 10 days in the future
				updatedAt: T0,
			}));
			expect((await readQuotaNotificationState(statePath))?.lastDeliveredAt).toBe(T0 + 10 * 86_400_000);
			await fs.rm(dir, { recursive: true, force: true });
		});

		it("PROVEN: state files with out-of-range lastPercent are rejected", async () => {
			const dir = await fs.mkdtemp(join(tmpdir(), "qns-"));
			const statePath = join(dir, "quota-notifications.json");
			await fs.writeFile(statePath, JSON.stringify({
				fiveHour: { lastPercent: 150 },
				weekly: { lastPercent: 50 },
				updatedAt: T0,
			}));
			expect(await readQuotaNotificationState(statePath)).toBeUndefined();
			await fs.rm(dir, { recursive: true, force: true });
		});

		describe("poller delivery dedup under clock jumps", () => {
			let dir: string;
			let statePath: string;
			let monitorNow: number;
			let notifyCalls: number;
			const monitors: Array<{ dispose(): void }> = [];

			const buildMonitor = () => {
				const monitor = createQuotaMonitor({
					now: () => monitorNow,
					initialDelayMs: 100,
					loadConfig: (): QuotaNotificationsConfig => ({
						enabled: true,
						autoProtectCredits: false,
						intervalMs: 1_800_000,
						notifyEveryCheck: true,
						thresholds: [],
					}),
					loadStorage: async () =>
						makeStorage([{ refreshToken: "tok", accountId: "acct" }]) as never,
					fetchSummary: async () => ({
						usage: makeUsageSummary(
							{ usedPercent: 50, windowMinutes: 300, resetAtMs: monitorNow + 3_600_000 },
							{ usedPercent: 20, windowMinutes: 10080, resetAtMs: monitorNow + 86_400_000 },
						),
					}),
					notify: async () => {
						notifyCalls += 1;
						return true;
					},
					notificationsSupported: () => true,
				});
				monitors.push(monitor);
				return monitor;
			};

			beforeEach(async () => {
				// Only poll scheduling (setTimeout) and Date are faked — fs and
				// setImmediate stay real so lock + atomic-write chains complete.
				vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
				vi.setSystemTime(T0);
				dir = await fs.mkdtemp(join(tmpdir(), "qmon-"));
				setStoragePathDirect(join(dir, "accounts.json"));
				statePath = join(dir, "oc-codex-multi-auth-quota-notifications.json");
				monitorNow = T0;
				notifyCalls = 0;
			});

			afterEach(async () => {
				for (const monitor of monitors.splice(0)) monitor.dispose();
				setStoragePathDirect(null);
				await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
			});

			it("PROVEN: notifyEveryCheck delivers once per interval under a steady clock", async () => {
				const monitor = buildMonitor();
				monitor.start();
				await vi.advanceTimersByTimeAsync(150); // initial check
				await vi.waitFor(() => expect(notifyCalls).toBe(1));
				monitorNow = T0 + 1_800_000; // one interval later, per the injected clock
				await vi.advanceTimersByTimeAsync(1_800_100);
				await vi.waitFor(() => expect(notifyCalls).toBe(2));
			});

			it("AUDIT BUG: clock rollback suppresses notifyEveryCheck until wall time catches up (quota-notifications.ts:430-432)", async () => {
				const monitor = buildMonitor();
				monitor.start();
				await vi.advanceTimersByTimeAsync(150);
				await vi.waitFor(() => expect(notifyCalls).toBe(1)); // claimed; lastDeliveredAt = T0

				// Clock rolls back 30 minutes before the next scheduled poll.
				monitorNow = T0 - 1_800_000;
				const monitor2 = buildMonitor();
				monitor2.start();
				await vi.advanceTimersByTimeAsync(150);
				// Deterministic "check ran" witness: the poller always writes
				// updatedAt = its injected now, even when nothing is delivered.
				await vi.waitFor(async () =>
					expect((await readQuotaNotificationState(statePath))?.updatedAt).toBe(T0 - 1_800_000));
				// now - lastDeliveredAt = -30min < intervalMs -> not due -> skipped.
				expect(notifyCalls).toBe(1);
			});

			it("PROVEN: forward jump past intervalMs delivers immediately on the next poll", async () => {
				const monitor = buildMonitor();
				monitor.start();
				await vi.advanceTimersByTimeAsync(150);
				await vi.waitFor(() => expect(notifyCalls).toBe(1));
				// Clock jumps forward 4 hours; at the next scheduled poll the
				// delta now - lastDeliveredAt is a huge positive >= intervalMs
				// -> due immediately (no catch-up suppression on this side).
				monitorNow = T0 + 4 * 3_600_000;
				await vi.advanceTimersByTimeAsync(1_800_100);
				await vi.waitFor(() => expect(notifyCalls).toBe(2));
			});

			it("AUDIT BUG: persisted future lastDeliveredAt suppresses everyCheck delivery until the stamp arrives (quota-notifications.ts:427-434)", async () => {
				// Simulate a state file written under a clock 2h fast.
				await fs.writeFile(statePath, JSON.stringify({
					fiveHour: { lastPercent: 50 },
					weekly: { lastPercent: 50 },
					lastDeliveredAt: T0 + 7_200_000,
					updatedAt: T0,
				}));
				const monitor = buildMonitor();
				monitor.start();
				await vi.advanceTimersByTimeAsync(150);
				await vi.waitFor(async () =>
					expect((await readQuotaNotificationState(statePath))?.updatedAt).toBe(T0));
				// now - lastDeliveredAt is negative -> not due -> suppressed.
				expect(notifyCalls).toBe(0);
			});
		});

		it("PROVEN: aggregateQuotaUsage drops reset times at-or-before now", () => {
			const usage = aggregateQuotaUsage([
				{
					usage: makeUsageSummary(
						{ usedPercent: 50, windowMinutes: 300, resetAtMs: T0 },
						{ usedPercent: 20, windowMinutes: 10080, resetAtMs: T0 - 1 },
					),
				},
			], T0);
			expect(usage.fiveHour.resetAtMs).toBeUndefined();
			expect(usage.weekly.resetAtMs).toBeUndefined();
		});
	});

	// ======================================================================
	// 8. TUI quota display at rollover boundaries
	// ======================================================================
	describe("TUI quota display boundaries", () => {
		const overviewAccount = (resetAtMs: number | undefined, leftPercent = 10) => ({
			index: 1,
			email: "a@example.com",
			windows: [{ leftPercent, resetAtMs }],
		});

		it("PROVEN: a reset exactly at now renders no countdown (<= 0 guard)", () => {
			expect(formatCompactDuration(0)).toBeUndefined();
			expect(formatCompactDuration(-1)).toBeUndefined();
			expect(formatCompactDuration(Number.NaN)).toBeUndefined();
			expect(formatCompactDuration(Infinity)).toBeUndefined();
		});

		it("PROVEN: 1ms-to-go reads '1m', never '0m'", () => {
			expect(formatCompactDuration(1)).toBe("1m");
			expect(formatCompactDuration(59_999)).toBe("1m");
			expect(formatCompactDuration(60_000)).toBe("1m");
		});

		it("PROVEN: overview line at the exact rollover second omits the countdown", () => {
			const text = formatQuotaOverviewText([overviewAccount(T0)], {
				mode: "used",
				layout: "accounts",
				names: "number",
				order: "number",
				multipliers: false,
				allotment: false,
				resetTimes: "always",
				resetCredits: false,
				recovery: false,
				now: T0,
			});
			expect(text).not.toContain("0m");
			expect(text).not.toMatch(/\d+[dhms]\b/); // no stale countdown survives
		});

		it("PROVEN: recovery events at exact rollover produce no future event", () => {
			expect(resolveNextQuotaRecovery([overviewAccount(T0, 10)], T0)).toBeUndefined();
			expect(resolveQuotaRecoveryEvents([overviewAccount(T0, 10)], T0)).toEqual([]);
			const future = resolveQuotaRecoveryEvents([overviewAccount(T0 + 60_000, 10)], T0);
			expect(future).toHaveLength(1);
			expect(future[0]!.atMs).toBe(T0 + 60_000);
		});

		it("PROVEN: reset-credit line at rollover drops the stale duration", () => {
			const candidates = formatQuotaResetsCandidates(
				[{ ...overviewAccount(T0, 0), resetCredits: 2, resetCreditsApplicable: 2 }],
				{ now: T0 },
			);
			for (const c of candidates) expect(c).not.toContain("0m");
		});

		it("AUDIT QUIRK: formatQuotaDetailsText mixes clocks — injected now drives Updated-age while describeReset reads real new Date() (tui-status.ts:697)", () => {
			// Callers that inject a `now` get updated-age from one epoch and
			// reset-day classification from another: `new Date()` inside
			// describeReset is the real wall clock, not the parameter. Production
			// impact is nil (one process has one wall clock); the gap is that the
			// `now` parameter does not fully control the output — tests and any
			// future caller replaying a snapshot see a hybrid render.
			vi.stubEnv("TZ", "UTC");
			const quota = {
				type: "ready" as const,
				fetchedAt: T0 - 3_600_000,
				source: "headers" as const,
				limits: [
					// Feb 15 14:00 UTC — sameDay against the real (faked) clock at
					// T0, but 30 days in the PAST relative to the injected now.
					{ label: "5h", leftPercent: 10, resetAtMs: T0 + 2 * 3_600_000 },
				],
			};
			const text = formatQuotaDetailsText(quota as never, T0 + 30 * 86_400_000);
			// Injected now: 30d+1h ago -> "30d ago" — proves Updated honors `now`.
			expect(text).toContain("Updated: 30d ago");
			// Real clock: sameDay -> bare time. If describeReset had honored the
			// injected now, this would read "resets 14:00 on Feb 15".
			expect(text).toContain("resets 14:00");
			expect(text).not.toContain("on Feb 15");
		});

		it("PROVEN: updated-age clamps a future fetchedAt to 'just now' (tui-status.ts:765)", () => {
			const text = formatQuotaDetailsText(
				{
					type: "ready",
					source: "headers",
					fetchedAt: T0 + 3_600_000, // written under a fast clock
					limits: [],
					stale: false,
				},
				T0,
			);
			expect(text).toContain("Updated: just now");
		});

		it("PROVEN: snapshot freshness treats future fetchedAt as fresh (documented skew tolerance)", () => {
			expect(isFreshTuiQuotaSnapshot({ fetchedAt: T0 + 3_600_000 }, T0)).toBe(true);
		});

		it("PROVEN: formatUsageReset rejects non-finite / non-positive input", () => {
			expect(formatUsageReset(Number.NaN)).toBeUndefined();
			expect(formatUsageReset(0)).toBeUndefined();
			expect(formatUsageReset(-5)).toBeUndefined();
		});

		it("PROVEN: formatUsageResetTimestamp truncates sub-second precision", () => {
			vi.stubEnv("TZ", "UTC");
			vi.setSystemTime(T0);
			const reset = Date.UTC(2026, 1, 15, 14, 30, 45, 500);
			expect(formatUsageResetTimestamp(reset)).toBe("2026-02-15 14:30");
			expect(formatUsageResetTimestamp(Date.UTC(2026, 1, 15, 14, 30, 45))).toBe("2026-02-15 14:30:45");
		});
	});

	// ======================================================================
	// 9. Usage-payload window mapping
	// ======================================================================
	describe("codex-usage window mapping", () => {
		it("PROVEN: reset_after_seconds produces an absolute reset from now", () => {
			const window = mapUsageWindow({
				used_percent: 50,
				limit_window_seconds: 300,
				reset_after_seconds: 60,
			});
			expect(window.resetAtMs).toBe(T0 + 60_000);
		});

		it("PROVEN: reset_after_seconds = 0 and negative are ignored", () => {
			for (const value of [0, -60]) {
				const window = mapUsageWindow({
					used_percent: 50,
					limit_window_seconds: 300,
					reset_after_seconds: value,
				});
				expect(window.resetAtMs).toBeUndefined();
			}
		});

		it("AUDIT QUIRK: huge reset_after_seconds rides into display without a horizon check (codex-usage.ts:246-252)", () => {
			// getUsageQuotaExhaustedResetAtMs guards the routing path at 30d; the
			// mapped window carries the raw value, so the TUI can render a
			// 126-millennia countdown off a garbled payload.
			const window = mapUsageWindow({
				used_percent: 50,
				limit_window_seconds: 300,
				reset_after_seconds: 4_000_000_000,
			});
			expect(window.resetAtMs).toBe(T0 + 4_000_000_000_000);
			expect(formatUsageCountdown(window.resetAtMs! - T0)).toBeTruthy();
		});

		it("PROVEN: untouched rolling window reports notStarted and drops the moving reset", () => {
			const window = mapUsageWindow({
				used_percent: 0,
				limit_window_seconds: 300,
				reset_after_seconds: 300,
			});
			expect(window.notStarted).toBe(true);
			expect(window.resetAtMs).toBeUndefined();
		});

		it("PROVEN: isUsageWindowNotStarted boundary — remaining >= length-1", () => {
			const base = { used_percent: 0, limit_window_seconds: 300 };
			expect(isUsageWindowNotStarted({ ...base, reset_after_seconds: 300 }, T0)).toBe(true);
			expect(isUsageWindowNotStarted({ ...base, reset_after_seconds: 299 }, T0)).toBe(true);
			expect(isUsageWindowNotStarted({ ...base, reset_after_seconds: 298 }, T0)).toBe(false);
			expect(isUsageWindowNotStarted({ ...base, reset_at: (T0 + 300_000) / 1000 }, T0)).toBe(true);
		});

		it("PROVEN: usage-exhausted reset ignores past / >30d / non-finite values", () => {
			expect(getUsageQuotaExhaustedResetAtMs([
				{ usedPercent: 100, windowMinutes: 300, resetAtMs: T0 - 1 },
			], T0)).toBeUndefined();
			expect(getUsageQuotaExhaustedResetAtMs([
				{ usedPercent: 100, windowMinutes: 300, resetAtMs: T0 + MAX_QUOTA_RESET_HORIZON_MS + 1 },
			], T0)).toBeUndefined();
			expect(getUsageQuotaExhaustedResetAtMs([
				{ usedPercent: 100, windowMinutes: 300, resetAtMs: T0 + 60_000 },
			], T0)).toBe(T0 + 60_000);
		});

		it("PROVEN: recovery requires every active window below 100%", () => {
			expect(isUsageQuotaRecovered([
				{ usedPercent: 40, windowMinutes: 300 },
				{ usedPercent: 10, windowMinutes: 10080 },
			])).toBe(true);
			expect(isUsageQuotaRecovered([
				{ usedPercent: 100, windowMinutes: 300 },
				{ usedPercent: 10, windowMinutes: 10080 },
			])).toBe(false);
		});
	});

	// ======================================================================
	// 10. Circuit breaker clock jumps
	// ======================================================================
	describe("circuit breaker under skew", () => {
		it("PROVEN: forward jump past resetTimeoutMs auto half-opens the circuit", () => {
			const cb = new CircuitBreaker({ resetTimeoutMs: 30_000 });
			vi.setSystemTime(T0);
			cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
			expect(cb.getState()).toBe("open");
			vi.setSystemTime(T0 + 30_001);
			expect(cb.canAttempt().allowed).toBe(true);
			expect(cb.getState()).toBe("half-open");
		});

		it("AUDIT FINDING: backward jump extends the open window — stays open until wall clock re-crosses the stamp (circuit-breaker.ts:75)", () => {
			const cb = new CircuitBreaker({ resetTimeoutMs: 30_000 });
			vi.setSystemTime(T0);
			cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
			vi.setSystemTime(T0 - 60_000);
			// now - lastStateChange = -60s < 30s -> still open.
			expect(cb.canAttempt().allowed).toBe(false);
			// Failures during the rollback re-stamp to the EARLIER time, so the
			// outage stretches by the full rollback distance.
			vi.setSystemTime(T0 + 30_001); // real timeout position
			expect(cb.canAttempt().allowed).toBe(true);
		});

		it("PROVEN: getTimeUntilReset clamps at zero", () => {
			const cb = new CircuitBreaker({ resetTimeoutMs: 30_000 });
			cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
			vi.setSystemTime(T0 + 60_000);
			expect(cb.getTimeUntilReset()).toBe(0);
		});
	});

	// ======================================================================
	// 11. Config duration clamps
	// ======================================================================
	describe("config duration clamps", () => {
		it("PROVEN: quota-notification interval clamps to the 30s minimum and 24h ceiling", () => {
			expect(getQuotaNotifications({ quotaNotifications: { intervalMs: 5 } } as never).intervalMs).toBe(30_000);
			expect(getQuotaNotifications({ quotaNotifications: { intervalMs: 10 ** 10 } } as never).intervalMs).toBe(86_400_000);
		});

		it("AUDIT QUIRK: NaN through an unvalidated config object propagates through clamping (config.ts:699-706)", () => {
			// File input cannot express NaN and the schema rejects it, so this is
			// only reachable by a caller that hands getQuotaNotifications an
			// unvalidated PluginConfig. Math.max(min, NaN) = NaN -> interval NaN.
			const config = getQuotaNotifications({ quotaNotifications: { intervalMs: Number.NaN } } as never);
			expect(config.intervalMs).toBeNaN();
		});
	});
});
