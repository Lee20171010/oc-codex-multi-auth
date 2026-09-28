/**
 * Mutation-survivor boundary pins — promoted from the round-2 audit.
 *
 * Every test here targets an exact threshold, comparison direction, or
 * truncation edge where a one-token mutant (`>` vs `>=`, `trunc` vs `round`,
 * `<=` vs `<`, dropped early-return) produces different observable output.
 * Expected values are absolute literals — never derived from the constant
 * under test — so a mutated constant fails the suite rather than redefining
 * the expectation.
 *
 * Covered sites:
 *   - lib/request/retry-budget.ts   — unit size, profile tables, consumeWait
 *     carry boundary and exhaustion, normalizeRetryBudgetValue.
 *   - lib/config.ts                 — resolveIntegerSetting truncation of
 *     fractional values that bypass file validation (Math.trunc, not round).
 *   - lib/storage/normalize.ts      — rawActiveIndex is computed on the RAW
 *     array before dedup, mapped back by identity, and safe on empty dedup.
 *   - lib/quota-windows.ts          — 30-day reset horizon: exact equality is
 *     accepted, +1ms is rejected; exhausted-window latest-reset selection.
 *   - lib/accounts/rotation.ts      — monotonic rate-limit/quota stamps:
 *     existing >= resetAt must not rewrite; resetAt <= now rejected.
 *   - lib/accounts/rate-limits.ts   — expiry comparisons at exact equality.
 *   - lib/storage/credential-snapshots.ts — prune keeps newest, maxCount<=0
 *     keeps all, exact-count is a no-op, non-snapshot files never pruned.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	RETRY_WAIT_BUDGET_UNIT_MS,
	RetryBudgetTracker,
	normalizeRetryBudgetValue,
	resolveRetryBudgetLimits,
	type RetryBudgetLimits,
} from "../lib/request/retry-budget.js";
import {
	getEmptyResponseMaxRetries,
	getFastSessionMaxInputItems,
	getParallelProbingMaxConcurrency,
	getRetryAllAccountsMaxRetries,
} from "../lib/config.js";
import { normalizeAccountStorage } from "../lib/storage/normalize.js";
import {
	parseQuotaResetAtMs,
	getQuotaExhaustedResetAtMs,
	isQuotaWindowDisabled,
	isQuotaWindowExhausted,
} from "../lib/quota-windows.js";
import { AccountRotation } from "../lib/accounts/rotation.js";
import { AccountState, type ManagedAccount } from "../lib/accounts/state.js";
import {
	clampNonNegativeInt,
	clearExpiredQuotaExhaustion,
	clearExpiredRateLimits,
	isQuotaExhausted,
	isRateLimitedForQuotaKey,
} from "../lib/accounts/rate-limits.js";
import {
	isCredentialSnapshotFileName,
	pruneCredentialSnapshots,
} from "../lib/storage/credential-snapshots.js";

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0, 0);

/* 30 days in ms — the quota-reset horizon. Literal on purpose: the pin must
 * survive a mutated constant. */
const QUOTA_HORIZON_MS = 2_592_000_000;

const envKeys = [
	"CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES",
	"CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY",
	"CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS",
	"CODEX_AUTH_RETRY_ALL_MAX_RETRIES",
] as const;

afterEach(() => {
	for (const key of envKeys) delete process.env[key];
	vi.useRealTimers();
});

/* =========================================================================
 * retry-budget: absolute constants + consumeWait carry boundaries
 * ========================================================================= */

describe("retry-budget constants (absolute)", () => {
	it("one budget unit buys exactly 5s of blocking wait", () => {
		expect(RETRY_WAIT_BUDGET_UNIT_MS).toBe(5_000);
	});

	it("profile tables are exact, not just ordered", () => {
		expect(resolveRetryBudgetLimits("conservative")).toEqual({
			authRefresh: 2,
			network: 2,
			server: 2,
			rateLimitShort: 2,
			rateLimitGlobal: 1,
			emptyResponse: 1,
		});
		expect(resolveRetryBudgetLimits("balanced")).toEqual({
			authRefresh: 4,
			network: 4,
			server: 4,
			rateLimitShort: 4,
			rateLimitGlobal: 3,
			emptyResponse: 2,
		});
		expect(resolveRetryBudgetLimits("aggressive")).toEqual({
			authRefresh: 8,
			network: 8,
			server: 8,
			rateLimitShort: 8,
			rateLimitGlobal: 10,
			emptyResponse: 4,
		});
	});
});

describe("normalizeRetryBudgetValue", () => {
	it("rejects non-numbers, non-finite, and negatives", () => {
		for (const bad of ["3", NaN, Infinity, -Infinity, -1, -0.5, null, undefined]) {
			expect(normalizeRetryBudgetValue(bad)).toBeUndefined();
		}
	});

	it("floors fractional values (floor, not round)", () => {
		expect(normalizeRetryBudgetValue(0)).toBe(0);
		expect(normalizeRetryBudgetValue(2.9)).toBe(2);
		expect(normalizeRetryBudgetValue(2.5)).toBe(2);
		expect(normalizeRetryBudgetValue(5)).toBe(5);
	});
});

describe("consumeWait exact unit boundary", () => {
	const limits: RetryBudgetLimits = {
		authRefresh: 1,
		network: 1,
		server: 1,
		rateLimitShort: 1,
		rateLimitGlobal: 1,
		emptyResponse: 1,
	};

	it("4_999ms is free; the next 1ms tips the carry to a full unit", () => {
		const tracker = new RetryBudgetTracker(limits);
		expect(tracker.consumeWait("rateLimitGlobal", 4_999)).toBe(true);
		expect(tracker.getUsage().rateLimitGlobal).toBe(0);
		// carry 4_999 + 1 === 5_000 → exact boundary charges a unit
		expect(tracker.consumeWait("rateLimitGlobal", 1)).toBe(true);
		expect(tracker.getUsage().rateLimitGlobal).toBe(1);
	});

	it("5_000ms charges a full unit immediately; the bucket is then exhausted", () => {
		const tracker = new RetryBudgetTracker(limits);
		expect(tracker.consumeWait("rateLimitGlobal", 5_000)).toBe(true);
		expect(tracker.getUsage().rateLimitGlobal).toBe(1);
		expect(tracker.getRemaining("rateLimitGlobal")).toBe(0);
		// exhausted bucket refuses even a zero wait
		expect(tracker.consumeWait("rateLimitGlobal", 0)).toBe(false);
	});

	it("a non-finite limit never exhausts", () => {
		const tracker = new RetryBudgetTracker({
			...limits,
			rateLimitGlobal: Number.POSITIVE_INFINITY,
		});
		for (let i = 0; i < 10; i++) {
			expect(tracker.consume("rateLimitGlobal")).toBe(true);
		}
		expect(tracker.getRemaining("rateLimitGlobal")).toBe(Number.POSITIVE_INFINITY);
	});
});

/* =========================================================================
 * config: resolveIntegerSetting must TRUNCATE fractional config values
 * ========================================================================= */

describe("resolveIntegerSetting truncation (Math.trunc, not Math.round)", () => {
	// The file schema rejects non-integers at parse time, but a config object
	// built programmatically bypasses that validation — the resolver is the
	// last line of defence and must truncate toward zero.

	it("emptyResponseMaxRetries truncates 2.9 to 2", () => {
		expect(getEmptyResponseMaxRetries({ emptyResponseMaxRetries: 2.9 })).toBe(2);
	});

	it("emptyResponseMaxRetries truncates 0.9 to 0", () => {
		expect(getEmptyResponseMaxRetries({ emptyResponseMaxRetries: 0.9 })).toBe(0);
	});

	it("parallelProbingMaxConcurrency truncates 4.9 to 4 (round would clamp-hit 5)", () => {
		expect(getParallelProbingMaxConcurrency({ parallelProbingMaxConcurrency: 4.9 })).toBe(4);
	});

	it("fastSessionMaxInputItems truncates 199.9 to 199 (round would hit the 200 ceiling)", () => {
		expect(getFastSessionMaxInputItems({ fastSessionMaxInputItems: 199.9 })).toBe(199);
	});

	it("retryAllAccountsMaxRetries truncates 3.9 to 3", () => {
		expect(getRetryAllAccountsMaxRetries({ retryAllAccountsMaxRetries: 3.9 })).toBe(3);
	});

	it("a valid integer env override still wins over a fractional config value", () => {
		process.env.CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES = "3";
		expect(getEmptyResponseMaxRetries({ emptyResponseMaxRetries: 2.9 })).toBe(3);
	});
});

/* =========================================================================
 * storage normalize: rawActiveIndex across dedup + empty-dedup safety
 * ========================================================================= */

describe("normalizeAccountStorage rawActiveIndex across dedup", () => {
	it("empty dedup (all records invalid) yields a safe zeroed store, not a throw", () => {
		const result = normalizeAccountStorage({
			version: 3,
			activeIndex: 9,
			accounts: [
				{ refreshToken: 5 },
				{ refreshToken: "   " },
				"not-a-record",
				null,
			],
		});
		expect(result).not.toBeNull();
		expect(result?.accounts).toEqual([]);
		expect(result?.activeIndex).toBe(0);
	});

	it("active index follows the RAW record's identity into the deduped array", () => {
		// raw[1] is account B. Dedup merges the rt-A pair into the NEWEST record
		// (raw[2]) at position 1, so the deduped array is [B, A-merged] and the
		// correct active index is 0 — a naive clampIndex(rawActiveIndex, 2)
		// would return 1 and silently activate the wrong account.
		const result = normalizeAccountStorage({
			version: 3,
			activeIndex: 1,
			accounts: [
				{ refreshToken: "rt-A", addedAt: 1, lastUsed: 5 },
				{ refreshToken: "rt-B", addedAt: 2, lastUsed: 9 },
				{ refreshToken: "rt-A", addedAt: 3, lastUsed: 10 },
			],
		});
		expect(result?.accounts.length).toBe(2);
		expect(result?.activeIndex).toBe(0);
		expect(result?.accounts[0]?.refreshToken).toBe("rt-B");
	});

	it("an active index pointing at an invalid raw record clamps in-range", () => {
		const result = normalizeAccountStorage({
			version: 3,
			activeIndex: 1,
			accounts: [
				{ refreshToken: "rt-A", addedAt: 1, lastUsed: 1 },
				{ refreshToken: 42 }, // invalid: no identity keys extractable
				{ refreshToken: "rt-B", addedAt: 3, lastUsed: 3 },
			],
		});
		expect(result?.accounts.length).toBe(2);
		// raw[1] carries no identity → fall back to clamping raw index 1
		expect(result?.activeIndex).toBe(1);
		expect(result?.accounts[1]?.refreshToken).toBe("rt-B");
	});
});

/* =========================================================================
 * quota-windows: exact 30-day horizon + exhausted-window selection
 * ========================================================================= */

describe("quota reset horizon boundaries", () => {
	it("the horizon is exactly 30 days", () => {
		expect(QUOTA_HORIZON_MS).toBe(30 * 24 * 60 * 60 * 1000);
	});

	it("reset-after-seconds at exactly the horizon is accepted", () => {
		const headers = new Headers({
			"x-codex-primary-reset-after-seconds": "2592000", // exactly 30d
		});
		expect(parseQuotaResetAtMs(headers, "x-codex-primary", T0)).toBe(
			T0 + 2_592_000_000,
		);
	});

	it("reset-after-seconds one second past the horizon is rejected", () => {
		const headers = new Headers({
			"x-codex-primary-reset-after-seconds": "2592001",
		});
		expect(parseQuotaResetAtMs(headers, "x-codex-primary", T0)).toBeUndefined();
	});

	it("reset-at epoch-ms at exactly the horizon is accepted; +1ms rejected", () => {
		const at = new Headers({
			"x-codex-primary-reset-at": String(T0 + 2_592_000_000),
		});
		expect(parseQuotaResetAtMs(at, "x-codex-primary", T0)).toBe(T0 + 2_592_000_000);

		const over = new Headers({
			"x-codex-primary-reset-at": String(T0 + 2_592_000_001),
		});
		expect(parseQuotaResetAtMs(over, "x-codex-primary", T0)).toBeUndefined();
	});

	it("reset-at epoch-seconds and ISO forms pass through the same horizon", () => {
		const seconds = new Headers({
			"x-codex-primary-reset-at": String(Math.floor(T0 / 1000) + 2_592_000),
		});
		expect(parseQuotaResetAtMs(seconds, "x-codex-primary", T0)).toBe(
			Math.floor(T0 / 1000) * 1000 + 2_592_000_000,
		);

		const iso = new Headers({
			"x-codex-primary-reset-at": new Date(T0 + 2_592_000_000).toISOString(),
		});
		expect(parseQuotaResetAtMs(iso, "x-codex-primary", T0)).toBe(T0 + 2_592_000_000);
	});

	it("a past reset-at parses (horizon only bounds the future) but is not a usable exhaustion", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "100",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": String(T0 - 1_000),
		});
		expect(parseQuotaResetAtMs(headers, "x-codex-primary", T0)).toBe(T0 - 1_000);
		expect(getQuotaExhaustedResetAtMs(headers, T0)).toBeUndefined();
	});
});

describe("quota window exhaustion boundaries", () => {
	it("usedPercent >= 100 exhausts; 99.99 does not; windowMinutes 0 disables", () => {
		expect(isQuotaWindowExhausted({ windowMinutes: 300, usedPercent: 99.99 })).toBe(false);
		expect(isQuotaWindowExhausted({ windowMinutes: 300, usedPercent: 100 })).toBe(true);
		expect(isQuotaWindowExhausted({ windowMinutes: 300, usedPercent: 150 })).toBe(true);
		expect(isQuotaWindowDisabled({ windowMinutes: 0 })).toBe(true);
		// a disabled window can still report 100% — it is not an exhaustion
		expect(isQuotaWindowExhausted({ windowMinutes: 0, usedPercent: 100 })).toBe(false);
	});

	it("the latest exhausted reset wins (max, not min — issue #218)", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "100",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-after-seconds": "60",
			"x-codex-secondary-used-percent": "100",
			"x-codex-secondary-window-minutes": "10080",
			"x-codex-secondary-reset-after-seconds": "120",
		});
		expect(getQuotaExhaustedResetAtMs(headers, T0)).toBe(T0 + 120_000);
	});

	it("a disabled window at 100% contributes no reset", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "100",
			"x-codex-primary-window-minutes": "0",
			"x-codex-primary-reset-after-seconds": "60",
		});
		expect(getQuotaExhaustedResetAtMs(headers, T0)).toBeUndefined();
	});
});

/* =========================================================================
 * rotation + rate-limit helpers: monotonic stamps and expiry equality
 * ========================================================================= */

function mkAccount(): ManagedAccount {
	return {
		index: 0,
		refreshToken: "rt-mut",
		addedAt: 0,
		lastUsed: 0,
		rateLimitResetTimes: {},
	};
}

describe("AccountRotation quota-exhaustion boundaries", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: T0 });
	});

	it("a reset exactly at the 30-day horizon is accepted; +1ms is rejected", () => {
		const rotation = new AccountRotation(new AccountState());
		const account = mkAccount();
		expect(rotation.markQuotaExhausted(account, T0 + QUOTA_HORIZON_MS, "codex")).toBe(true);
		expect(account.quotaExhaustedUntil).toBe(T0 + QUOTA_HORIZON_MS);

		const second = mkAccount();
		expect(rotation.markQuotaExhausted(second, T0 + QUOTA_HORIZON_MS + 1, "codex")).toBe(false);
		expect(second.quotaExhaustedUntil).toBeUndefined();
	});

	it("resetAt <= now is rejected — a stamp can never be written in the past", () => {
		const rotation = new AccountRotation(new AccountState());
		const account = mkAccount();
		expect(rotation.markQuotaExhausted(account, T0, "codex")).toBe(false);
		expect(rotation.markQuotaExhausted(account, T0 - 1, "codex")).toBe(false);
		expect(account.quotaExhaustedUntil).toBeUndefined();
		expect(rotation.markQuotaExhausted(account, T0 + 1, "codex")).toBe(true);
	});

	it("existing >= resetAt is not rewritten — and the doctor-clear tombstone survives", () => {
		const rotation = new AccountRotation(new AccountState());
		const account = mkAccount();
		const until = T0 + 60_000;
		expect(rotation.markQuotaExhausted(account, until, "codex")).toBe(true);
		expect(account.quotaExhaustedStampAt).toBe(T0);

		// A doctor-clear tombstone marks the stamp as deliberately cleared; a
		// same-value re-write would resurrect it, so equality must refuse AND
		// leave the tombstone in place (kills the `>` mutant).
		account.quotaExhaustedClearedAt = T0;
		expect(rotation.markQuotaExhausted(account, until, "codex")).toBe(false);
		expect(account.quotaExhaustedUntil).toBe(until);
		expect(account.quotaExhaustedClearedAt).toBe(T0);
		expect(account.quotaExhaustedStampAt).toBe(T0);

		// An earlier reset loses; a strictly later one wins and re-dates.
		expect(rotation.markQuotaExhausted(account, until - 1, "codex")).toBe(false);
		vi.setSystemTime(T0 + 1_000);
		expect(rotation.markQuotaExhausted(account, until + 1, "codex")).toBe(true);
		expect(account.quotaExhaustedUntil).toBe(until + 1);
		expect(account.quotaExhaustedStampAt).toBe(T0 + 1_000);
	});

	it("non-finite resets are rejected", () => {
		const rotation = new AccountRotation(new AccountState());
		const account = mkAccount();
		expect(rotation.markQuotaExhausted(account, Number.NaN, "codex")).toBe(false);
		expect(rotation.markQuotaExhausted(account, Number.POSITIVE_INFINITY, "codex")).toBe(false);
		expect(account.quotaExhaustedUntil).toBeUndefined();
	});
});

describe("AccountRotation rate-limit stamp boundaries", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: T0 });
	});

	it("a later shorter block never shortens the existing reset; equal is kept", () => {
		const rotation = new AccountRotation(new AccountState());
		const account = mkAccount();
		rotation.markRateLimitedWithReason(account, 30_000, "codex", "quota");
		expect(account.rateLimitResetTimes.codex).toBe(T0 + 30_000);
		// shorter retry-after must not pull the block forward
		rotation.markRateLimitedWithReason(account, 10_000, "codex", "quota");
		expect(account.rateLimitResetTimes.codex).toBe(T0 + 30_000);
		// longer wins
		rotation.markRateLimitedWithReason(account, 40_000, "codex", "quota");
		expect(account.rateLimitResetTimes.codex).toBe(T0 + 40_000);
	});

	it("retryAfterMs of 0 clears the block instead of writing now()", () => {
		const rotation = new AccountRotation(new AccountState());
		const account = mkAccount();
		rotation.markRateLimitedWithReason(account, 30_000, "codex", "quota");
		expect(account.rateLimitResetTimes.codex).toBe(T0 + 30_000);
		rotation.markRateLimitedWithReason(account, 0, "codex", "quota");
		expect(account.rateLimitResetTimes.codex).toBeUndefined();
	});
});

describe("rate-limit helpers: exact-expiry comparisons", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: T0 });
	});

	it("isQuotaExhausted: strictly future — equality means expired", () => {
		const entity = { quotaExhaustedUntil: T0 + 1_000 };
		expect(isQuotaExhausted(entity, T0 + 999)).toBe(true);
		expect(isQuotaExhausted(entity, T0 + 1_000)).toBe(false);
		expect(isQuotaExhausted(entity, T0 + 1_001)).toBe(false);
	});

	it("clearExpiredQuotaExhaustion clears at exact equality (now >= until)", () => {
		const entity = {
			quotaExhaustedUntil: T0 + 1_000,
			quotaExhaustedStampAt: T0,
		};
		clearExpiredQuotaExhaustion(entity, T0 + 999);
		expect(entity.quotaExhaustedUntil).toBe(T0 + 1_000);
		clearExpiredQuotaExhaustion(entity, T0 + 1_000);
		expect(entity.quotaExhaustedUntil).toBeUndefined();
		expect(entity.quotaExhaustedStampAt).toBeUndefined();
	});

	it("clearExpiredRateLimits deletes a stamp at exact equality", () => {
		const entity = { rateLimitResetTimes: { codex: T0 + 1_000 } };
		clearExpiredRateLimits(entity);
		expect(entity.rateLimitResetTimes.codex).toBe(T0 + 1_000);
		vi.setSystemTime(T0 + 1_000);
		clearExpiredRateLimits(entity);
		expect(entity.rateLimitResetTimes.codex).toBeUndefined();
	});

	it("isRateLimitedForQuotaKey is strictly-future (now < resetTime)", () => {
		const entity = { rateLimitResetTimes: { codex: T0 + 1_000 } };
		expect(isRateLimitedForQuotaKey(entity, "codex")).toBe(true);
		vi.setSystemTime(T0 + 1_000);
		expect(isRateLimitedForQuotaKey(entity, "codex")).toBe(false);
	});

	it("clampNonNegativeInt floors positives and clamps negatives to 0", () => {
		expect(clampNonNegativeInt(2.9, 7)).toBe(2);
		expect(clampNonNegativeInt(-1, 7)).toBe(0);
		expect(clampNonNegativeInt("x", 7)).toBe(7);
		expect(clampNonNegativeInt(Number.NaN, 7)).toBe(7);
	});
});

/* =========================================================================
 * credential snapshots: retention prune boundaries
 * ========================================================================= */

describe("pruneCredentialSnapshots boundaries", () => {
	let scratch: string;
	const snap = (name: string) => join(scratch, name);

	beforeEach(async () => {
		scratch = await fs.mkdtemp(join(tmpdir(), "mut-boundary-snaps-"));
	});

	afterEach(async () => {
		try { await fs.rm(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
	});

	async function seed(names: string[], mtimeMs?: number): Promise<void> {
		for (const name of names) {
			const p = snap(name);
			await fs.writeFile(p, "{}");
			if (mtimeMs !== undefined) {
				const t = new Date(mtimeMs);
				await fs.utimes(p, t, t);
			}
		}
	}

	async function remaining(): Promise<string[]> {
		return (await fs.readdir(scratch)).sort();
	}

	it("maxCount <= 0 keeps every snapshot (feature disabled)", async () => {
		await seed([
			"codex-credential-snapshot-1.json",
			"codex-credential-snapshot-2.json",
			"codex-credential-snapshot-3.json",
		]);
		await pruneCredentialSnapshots(scratch, 0);
		expect((await remaining()).length).toBe(3);
		await pruneCredentialSnapshots(scratch, -5);
		expect((await remaining()).length).toBe(3);
	});

	it("exactly maxCount snapshots is a no-op (<= boundary, not <)", async () => {
		const t = T0;
		await seed(
			[
				"codex-credential-snapshot-1.json",
				"codex-credential-snapshot-2.json",
				"codex-credential-snapshot-3.json",
			],
			t,
		);
		await pruneCredentialSnapshots(scratch, 3);
		expect((await remaining()).length).toBe(3);
	});

	it("one over maxCount prunes exactly the oldest by mtime", async () => {
		await seed(["codex-credential-snapshot-oldest.json"], T0 - 2_000);
		await seed(["codex-credential-snapshot-middle.json"], T0 - 1_000);
		await seed(["codex-credential-snapshot-newest.json"], T0);
		await pruneCredentialSnapshots(scratch, 2);
		expect(await remaining()).toEqual([
			"codex-credential-snapshot-middle.json",
			"codex-credential-snapshot-newest.json",
		]);
	});

	it("equal mtimes fall back to the filename timestamp — later name survives", async () => {
		await seed(
			[
				"codex-credential-snapshot-2026-01-01T00-00-00-000Z.json",
				"codex-credential-snapshot-2026-01-01T00-00-01-000Z.json",
			],
			T0,
		);
		await pruneCredentialSnapshots(scratch, 1);
		expect(await remaining()).toEqual([
			"codex-credential-snapshot-2026-01-01T00-00-01-000Z.json",
		]);
	});

	it("non-snapshot files in the directory are never pruned", async () => {
		await seed(
			[
				"codex-credential-snapshot-1.json",
				"codex-credential-snapshot-2.json",
				"codex-pre-import-backup-1.json",
				"accounts.json.migrated-to-keychain.1",
				"random.txt",
			],
			T0,
		);
		await pruneCredentialSnapshots(scratch, 1);
		expect(await remaining()).toEqual([
			"accounts.json.migrated-to-keychain.1",
			"codex-credential-snapshot-2.json",
			"codex-pre-import-backup-1.json",
			"random.txt",
		]);
	});

	it("isCredentialSnapshotFileName is prefix-AND-suffix strict", () => {
		expect(isCredentialSnapshotFileName("codex-credential-snapshot-x.json")).toBe(true);
		expect(isCredentialSnapshotFileName("codex-credential-snapshot-x.txt")).toBe(false);
		expect(isCredentialSnapshotFileName("codex-pre-import-backup-x.json")).toBe(false);
		expect(isCredentialSnapshotFileName("codex-credential-snapshot.json")).toBe(false);
	});
});
