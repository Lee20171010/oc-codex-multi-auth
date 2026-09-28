/**
 * Env-boundary hardening for lib/config.ts + lib/schemas.ts:
 *
 * - `CODEX_AUTH_ACCOUNT_ID` is routed through `AccountIdOverrideSchema`
 *   (trimmed, non-empty, length-bounded) everywhere, including
 *   `resolveAccountSelection` in lib/auth/login-runner.ts.
 * - Millisecond-duration env overrides carry a 24h ceiling
 *   (`MAX_CONFIG_DURATION_MS`) so a typo like `1e15` cannot spell an
 *   infinite wait; the documented `0` = unlimited semantic of
 *   `retryAllAccountsMaxWaitMs` is preserved.
 * - Integer-semantic env overrides reject fractional input and fall back to
 *   the config file / default instead of silently truncating, and the file
 *   schema rejects fractional values for integer fields.
 */
import { describe, expect, it, afterEach } from "vitest";
import {
	MAX_CONFIG_DURATION_MS,
	PluginConfigSchema,
} from "../lib/schemas.js";
import {
	getEmptyResponseMaxRetries,
	getFastSessionMaxInputItems,
	getFetchTimeoutMs,
	getParallelProbingMaxConcurrency,
	getQuotaNotifications,
	getQuotaStatus,
	getRetryAllAccountsMaxRetries,
	getRetryAllAccountsMaxWaitMs,
	getStreamStallTimeoutMs,
	getMaxStreamDurationMs,
	getTokenRefreshSkewMs,
	resolveAccountIdOverride,
} from "../lib/config.js";
import { resolveAccountSelection } from "../lib/auth/login-runner.js";

const envKeys = [
	"CODEX_AUTH_ACCOUNT_ID",
	"CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS",
	"CODEX_AUTH_RETRY_ALL_MAX_RETRIES",
	"CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS",
	"CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY",
	"CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES",
	"CODEX_AUTH_FETCH_TIMEOUT_MS",
	"CODEX_AUTH_STREAM_STALL_TIMEOUT_MS",
	"CODEX_AUTH_MAX_STREAM_DURATION_MS",
	"CODEX_AUTH_TOKEN_REFRESH_SKEW_MS",
	"CODEX_AUTH_QUOTA_NOTIFICATIONS_INTERVAL_MS",
] as const;

afterEach(() => {
	for (const key of envKeys) delete process.env[key];
});

const base64url = (value: unknown): string =>
	Buffer.from(JSON.stringify(value)).toString("base64url");

const accessTokenWithAccountId = (accountId: string): string =>
	`${base64url({ typ: "JWT" })}.${base64url({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	})}.signature`;

describe("resolveAccountIdOverride (CODEX_AUTH_ACCOUNT_ID)", () => {
	it("returns the trimmed env value", () => {
		process.env.CODEX_AUTH_ACCOUNT_ID = "  acct_42  ";
		expect(resolveAccountIdOverride()).toBe("acct_42");
	});

	it("returns undefined when unset, blank, or over the 256-char bound", () => {
		delete process.env.CODEX_AUTH_ACCOUNT_ID;
		expect(resolveAccountIdOverride()).toBeUndefined();

		process.env.CODEX_AUTH_ACCOUNT_ID = "   ";
		expect(resolveAccountIdOverride()).toBeUndefined();

		process.env.CODEX_AUTH_ACCOUNT_ID = "a".repeat(257);
		expect(resolveAccountIdOverride()).toBeUndefined();

		process.env.CODEX_AUTH_ACCOUNT_ID = "a".repeat(256);
		expect(resolveAccountIdOverride()).toBe("a".repeat(256));
	});
});

describe("resolveAccountSelection env wiring", () => {
	it("honours the trimmed CODEX_AUTH_ACCOUNT_ID override", () => {
		process.env.CODEX_AUTH_ACCOUNT_ID = "  acct-env  ";
		const selection = resolveAccountSelection({
			type: "success",
			access: accessTokenWithAccountId("acct-from-token"),
			refresh: "refresh",
			expires: Date.now() + 60_000,
		});
		expect(selection.primary.accountIdOverride).toBe("acct-env");
		expect(selection.primary.accountIdSource).toBe("manual");
	});

	it("ignores an over-bound env override instead of honouring it raw", () => {
		process.env.CODEX_AUTH_ACCOUNT_ID = `  ${"a".repeat(257)}  `;
		const selection = resolveAccountSelection({
			type: "success",
			access: accessTokenWithAccountId("acct-from-token"),
			refresh: "refresh",
			expires: Date.now() + 60_000,
		});
		expect(selection.primary.accountIdOverride).toBe("acct-from-token");
		expect(selection.primary.accountIdSource).not.toBe("manual");
	});
});

describe("env duration ceiling (MAX_CONFIG_DURATION_MS)", () => {
	it("caps absurdly large duration env values at 24h", () => {
		process.env.CODEX_AUTH_FETCH_TIMEOUT_MS = "1000000000000000";
		expect(getFetchTimeoutMs({})).toBe(MAX_CONFIG_DURATION_MS);

		process.env.CODEX_AUTH_STREAM_STALL_TIMEOUT_MS = "1e12";
		expect(getStreamStallTimeoutMs({})).toBe(MAX_CONFIG_DURATION_MS);

		process.env.CODEX_AUTH_MAX_STREAM_DURATION_MS = "1e12";
		expect(getMaxStreamDurationMs({})).toBe(MAX_CONFIG_DURATION_MS);

		// The floor applies too: a sub-1s env value clamps up to 1s.
		process.env.CODEX_AUTH_MAX_STREAM_DURATION_MS = "5";
		expect(getMaxStreamDurationMs({})).toBe(1_000);
		delete process.env.CODEX_AUTH_MAX_STREAM_DURATION_MS;
		expect(getMaxStreamDurationMs({})).toBe(300_000);

		process.env.CODEX_AUTH_TOKEN_REFRESH_SKEW_MS = "99999999999";
		expect(getTokenRefreshSkewMs({})).toBe(MAX_CONFIG_DURATION_MS);
	});

	it("caps the quota-notification poll interval too", () => {
		process.env.CODEX_AUTH_QUOTA_NOTIFICATIONS_INTERVAL_MS = "1e15";
		expect(getQuotaNotifications({}).intervalMs).toBe(MAX_CONFIG_DURATION_MS);
	});

	it("keeps the documented 0 = unlimited semantic for retryAllAccountsMaxWaitMs", () => {
		process.env.CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS = "0";
		expect(getRetryAllAccountsMaxWaitMs({})).toBe(0);
		// ...and large values are honoured literally, because unbounded is the
		// field's documented contract rather than an accident.
		process.env.CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS = "1000000000000000";
		expect(getRetryAllAccountsMaxWaitMs({})).toBe(1_000_000_000_000_000);
	});

	it("still applies the lower floor under the new ceiling", () => {
		process.env.CODEX_AUTH_FETCH_TIMEOUT_MS = "5";
		expect(getFetchTimeoutMs({})).toBe(1_000);
	});
});

describe("integer env fields reject fractional input", () => {
	it("falls back to config file / default on a fractional env value", () => {
		process.env.CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES = "2.5";
		expect(getEmptyResponseMaxRetries({ emptyResponseMaxRetries: 7 })).toBe(7);
		expect(getEmptyResponseMaxRetries({})).toBe(2);

		process.env.CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY = "3.5";
		expect(getParallelProbingMaxConcurrency({})).toBe(2);

		process.env.CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS = "12.9";
		expect(getFastSessionMaxInputItems({ fastSessionMaxInputItems: 40 })).toBe(40);
	});

	it("still clamps in-range integer env values", () => {
		process.env.CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY = "9";
		expect(getParallelProbingMaxConcurrency({})).toBe(5);
		process.env.CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY = "0";
		expect(getParallelProbingMaxConcurrency({})).toBe(1);

		process.env.CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS = "2";
		expect(getFastSessionMaxInputItems({})).toBe(8);

		process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES = "4";
		expect(getRetryAllAccountsMaxRetries({})).toBe(4);
	});
});

describe("file-side schema bounds", () => {
	it("rejects fractional values for integer-semantic fields", () => {
		for (const candidate of [
			{ fastSessionMaxInputItems: 18.5 },
			{ retryAllAccountsMaxRetries: 1.5 },
			{ parallelProbingMaxConcurrency: 2.5 },
			{ emptyResponseMaxRetries: 0.5 },
		]) {
			expect(PluginConfigSchema.safeParse(candidate).success).toBe(false);
		}
	});

	it("accepts integer values for integer-semantic fields", () => {
		expect(
			PluginConfigSchema.safeParse({
				fastSessionMaxInputItems: 18,
				retryAllAccountsMaxRetries: 1,
				parallelProbingMaxConcurrency: 3,
				emptyResponseMaxRetries: 0,
			}).success,
		).toBe(true);
	});

	it("rejects durations beyond the 24h ceiling", () => {
		for (const candidate of [
			{ fetchTimeoutMs: MAX_CONFIG_DURATION_MS + 1 },
			{ streamStallTimeoutMs: MAX_CONFIG_DURATION_MS + 1 },
			{ maxStreamDurationMs: MAX_CONFIG_DURATION_MS + 1 },
			{ toastDurationMs: MAX_CONFIG_DURATION_MS + 1 },
			{ tokenRefreshSkewMs: MAX_CONFIG_DURATION_MS + 1 },
			{ rateLimitToastDebounceMs: MAX_CONFIG_DURATION_MS + 1 },
			{ emptyResponseRetryDelayMs: MAX_CONFIG_DURATION_MS + 1 },
			{ quotaNotifications: { intervalMs: MAX_CONFIG_DURATION_MS + 1 } },
			{ quotaStatus: { rotateMs: MAX_CONFIG_DURATION_MS + 1 } },
		]) {
			expect(PluginConfigSchema.safeParse(candidate).success).toBe(false);
		}
	});

	it("keeps retryAllAccountsMaxWaitMs unbounded above zero", () => {
		expect(
			PluginConfigSchema.safeParse({ retryAllAccountsMaxWaitMs: 1e15 }).success,
		).toBe(true);
	});
});

describe("non-finite values in an unvalidated PluginConfig", () => {
	// The getters also serve callers holding a PluginConfig that never went
	// through loadPluginConfig's schema pass. A NaN field used to sail through
	// Math.max/Math.min and reach setTimeout as ~0 — a silent hot re-poll.
	it("falls back to the default on NaN duration fields", () => {
		expect(getFetchTimeoutMs({ fetchTimeoutMs: Number.NaN })).toBe(60_000);
		expect(getStreamStallTimeoutMs({ streamStallTimeoutMs: Number.NaN })).toBe(45_000);
		expect(getTokenRefreshSkewMs({ tokenRefreshSkewMs: Number.NaN })).toBe(60_000);
	});

	it("falls back to the default on NaN nested duration fields", () => {
		expect(
			getQuotaNotifications({ quotaNotifications: { intervalMs: Number.NaN } })
				.intervalMs,
		).toBe(1_800_000);
	});

	it("falls back to the default on NaN / Infinity integer fields", () => {
		expect(getEmptyResponseMaxRetries({ emptyResponseMaxRetries: Number.NaN })).toBe(2);
		expect(
			getParallelProbingMaxConcurrency({
				parallelProbingMaxConcurrency: Number.NaN,
			}),
		).toBe(2);
		expect(
			getFastSessionMaxInputItems({
				fastSessionMaxInputItems: Number.POSITIVE_INFINITY,
			}),
		).toBe(30);
	});

	it("still honours the deliberate Infinity default for retryAllAccountsMaxRetries", () => {
		expect(getRetryAllAccountsMaxRetries({})).toBe(Number.POSITIVE_INFINITY);
		expect(
			getRetryAllAccountsMaxRetries({
				retryAllAccountsMaxRetries: Number.NaN,
			}),
		).toBe(Number.POSITIVE_INFINITY);
	});

	it("clamps quotaStatus.resetsMinUsedPercent and defaults non-finite input", () => {
		expect(
			getQuotaStatus({ quotaStatus: { resetsMinUsedPercent: Number.NaN } })
				.resetsMinUsedPercent,
		).toBe(100);
		expect(
			getQuotaStatus({ quotaStatus: { resetsMinUsedPercent: 250 } })
				.resetsMinUsedPercent,
		).toBe(100);
		expect(
			getQuotaStatus({ quotaStatus: { resetsMinUsedPercent: -5 } })
				.resetsMinUsedPercent,
		).toBe(0);
		expect(
			getQuotaStatus({ quotaStatus: { resetsMinUsedPercent: 80 } })
				.resetsMinUsedPercent,
		).toBe(80);
	});
});
