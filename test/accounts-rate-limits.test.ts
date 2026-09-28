import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { getTokenTracker, resetTrackers } from "../lib/rotation.js";
import {
	clearExpiredQuotaExhaustion,
	clearExpiredRateLimits,
	isQuotaExhausted,
} from "../lib/accounts/rate-limits.js";
import { MAX_QUOTA_RESET_HORIZON_MS } from "../lib/quota-windows.js";
import type { AccountStorageV3 } from "../lib/storage.js";
import type { ManagedAccount } from "../lib/accounts.js";

// Storage writes are irrelevant to these in-memory rotation/eligibility
// checks; stub the persistence surface so no real accounts file is touched.
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

const T0 = new Date("2026-02-01T12:00:00Z").getTime();

function storageWith(
	accounts: Partial<AccountStorageV3["accounts"][number]>[],
): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		accounts: accounts.map((account, index) => ({
			refreshToken: `rt-${index}`,
			accountId: `acct-${index}`,
			email: `user${index}@example.com`,
			addedAt: T0,
			lastUsed: T0,
			...account,
		})),
	};
}

/**
 * The LIVE managed account (snapshots are copies — mutating one would not
 * exercise the manager's own state). `getCurrentAccount` resolves the account
 * pinned at `activeIndex` 0, which is the only account in these fixtures.
 */
function onlyAccount(manager: AccountManager): ManagedAccount {
	const account = manager.getCurrentAccount();
	expect(account).not.toBeNull();
	return account as ManagedAccount;
}

describe("markRateLimitedWithReason monotonic blocks (issue #218)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		resetTrackers();
	});

	afterEach(() => {
		vi.useRealTimers();
		resetTrackers();
	});

	it("a later SHORTER 429 must not shorten an existing longer block", () => {
		const manager = new AccountManager(undefined, storageWith([{}]));
		const account = onlyAccount(manager);
		const weeklyMs = 6 * 24 * 60 * 60 * 1000;

		manager.markRateLimitedWithReason(account, weeklyMs, "codex", "quota");
		const weeklyResetAt = account.rateLimitResetTimes["codex"];
		expect(weeklyResetAt).toBe(T0 + weeklyMs);

		// A concurrent in-flight request lands a plain 30s retry-after; it must
		// lose to the week-long block already on the account.
		manager.markRateLimitedWithReason(account, 30_000, "codex", "tokens");
		expect(account.rateLimitResetTimes["codex"]).toBe(weeklyResetAt);
		// …but the reason still records the most recent 429.
		expect(account.lastRateLimitReason).toBe("tokens");
	});

	it("a later LONGER 429 still extends the block", () => {
		const manager = new AccountManager(undefined, storageWith([{}]));
		const account = onlyAccount(manager);

		manager.markRateLimitedWithReason(account, 30_000, "codex", "tokens");
		manager.markRateLimitedWithReason(account, 120_000, "codex", "tokens");
		expect(account.rateLimitResetTimes["codex"]).toBe(T0 + 120_000);
	});

	it("covers both the family and model-scoped quota keys monotonically", () => {
		const manager = new AccountManager(undefined, storageWith([{}]));
		const account = onlyAccount(manager);
		const weeklyMs = 6 * 24 * 60 * 60 * 1000;

		manager.markRateLimitedWithReason(account, weeklyMs, "codex", "quota", "gpt-5.6-sol");
		const familyReset = account.rateLimitResetTimes["codex"];
		const modelReset = account.rateLimitResetTimes["codex:gpt-5.6-sol"];
		expect(modelReset).toBe(T0 + weeklyMs);

		manager.markRateLimitedWithReason(account, 30_000, "codex", "tokens", "gpt-5.6-sol");
		expect(account.rateLimitResetTimes["codex"]).toBe(familyReset);
		expect(account.rateLimitResetTimes["codex:gpt-5.6-sol"]).toBe(modelReset);
	});

	it("a zero retryAfter clears the block (caller-declared elapsed window)", () => {
		const manager = new AccountManager(undefined, storageWith([{}]));
		const account = onlyAccount(manager);

		manager.markRateLimitedWithReason(account, 60_000, "codex", "tokens");
		expect(account.rateLimitResetTimes["codex"]).toBeDefined();

		manager.markRateLimitedWithReason(account, 0, "codex", "tokens");
		expect(account.rateLimitResetTimes["codex"]).toBeUndefined();
	});
});

describe("markRateLimitedWithReason non-finite and unbounded input", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		resetTrackers();
	});

	afterEach(() => {
		vi.useRealTimers();
		resetTrackers();
	});

	it("NaN retryAfterMs writes no stamp at all", () => {
		const manager = new AccountManager(undefined, storageWith([{}]));
		const account = onlyAccount(manager);

		manager.markRateLimitedWithReason(account, Number.NaN, "codex", "unknown");

		// A NaN stamp never matches `< now` and never expires — a permanent ghost.
		expect(account.rateLimitResetTimes).toEqual({});
		// The reason for the most recent 429 is still recorded.
		expect(account.lastRateLimitReason).toBe("unknown");
		expect(manager.getCurrentOrNextForFamily("codex")?.index).toBe(0);
	});

	it("Infinity retryAfterMs writes no stamp and preserves an existing block", () => {
		const manager = new AccountManager(undefined, storageWith([{}]));
		const account = onlyAccount(manager);

		manager.markRateLimitedWithReason(account, 60_000, "codex", "tokens");
		const existing = account.rateLimitResetTimes["codex"];

		manager.markRateLimitedWithReason(
			account,
			Number.POSITIVE_INFINITY,
			"codex",
			"tokens",
		);

		// Non-finite input carries no timing information: it must neither write
		// an Infinity stamp nor clear the real block the way a 0 would.
		expect(account.rateLimitResetTimes["codex"]).toBe(existing);
	});

	it("caps an absurd finite retryAfterMs at the quota-reset horizon", () => {
		const manager = new AccountManager(undefined, storageWith([{}]));
		const account = onlyAccount(manager);

		// ~127 years — the parsed `-reset-after-seconds: 4000000000` case.
		manager.markRateLimitedWithReason(account, 400_000_000_000, "codex", "quota");

		expect(account.rateLimitResetTimes["codex"]).toBe(
			T0 + MAX_QUOTA_RESET_HORIZON_MS,
		);
	});
});

describe("markQuotaExhausted boundaries", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		resetTrackers();
	});

	afterEach(() => {
		vi.useRealTimers();
		resetTrackers();
	});

	it("rejects a reset at exactly now (<= boundary)", () => {
		const manager = new AccountManager(undefined, storageWith([{}]));
		const account = onlyAccount(manager);

		expect(manager.markQuotaExhausted(account, T0, "codex")).toBe(false);
		expect(account.quotaExhaustedUntil).toBeUndefined();
	});

	it("accepts a reset one millisecond in the future", () => {
		const manager = new AccountManager(undefined, storageWith([{}]));
		const account = onlyAccount(manager);

		expect(manager.markQuotaExhausted(account, T0 + 1, "codex")).toBe(true);
		expect(account.quotaExhaustedUntil).toBe(T0 + 1);
	});

	it("accepts a reset at exactly the 30d horizon but not one past it", () => {
		const manager = new AccountManager(undefined, storageWith([{}]));
		const account = onlyAccount(manager);

		expect(
			manager.markQuotaExhausted(
				account,
				T0 + MAX_QUOTA_RESET_HORIZON_MS + 1,
				"codex",
			),
		).toBe(false);
		expect(account.quotaExhaustedUntil).toBeUndefined();

		expect(
			manager.markQuotaExhausted(
				account,
				T0 + MAX_QUOTA_RESET_HORIZON_MS,
				"codex",
			),
		).toBe(true);
		expect(account.quotaExhaustedUntil).toBe(T0 + MAX_QUOTA_RESET_HORIZON_MS);
	});

	it("rejects non-finite reset stamps", () => {
		const manager = new AccountManager(undefined, storageWith([{}]));
		const account = onlyAccount(manager);

		expect(
			manager.markQuotaExhausted(account, Number.NaN, "codex"),
		).toBe(false);
		expect(
			manager.markQuotaExhausted(account, Number.POSITIVE_INFINITY, "codex"),
		).toBe(false);
		expect(account.quotaExhaustedUntil).toBeUndefined();
	});

	it("keeps the LONGER existing block (monotonic)", () => {
		const manager = new AccountManager(undefined, storageWith([{}]));
		const account = onlyAccount(manager);

		expect(manager.markQuotaExhausted(account, T0 + 86_400_000, "codex")).toBe(true);
		expect(manager.markQuotaExhausted(account, T0 + 3_600_000, "codex")).toBe(false);
		expect(account.quotaExhaustedUntil).toBe(T0 + 86_400_000);
	});
});

describe("markAccountCoolingDown non-finite input", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		resetTrackers();
	});

	afterEach(() => {
		vi.useRealTimers();
		resetTrackers();
	});

	it("NaN produces an immediately-expired stamp, not a permanent cooldown", () => {
		const manager = new AccountManager(undefined, storageWith([{}]));
		const account = onlyAccount(manager);

		manager.markAccountCoolingDown(account, Number.NaN, "network-error");

		// Unclamped, coolingDownUntil becomes NaN, which `nowMs() >= until` never
		// satisfies — the account would cool down forever.
		expect(Number.isFinite(account.coolingDownUntil)).toBe(true);
		expect(manager.isAccountCoolingDown(account)).toBe(false);
		expect(account.coolingDownUntil).toBeUndefined();
		expect(manager.getCurrentOrNextForFamily("codex")?.index).toBe(0);
	});

	it("Infinity is folded to a zero-length cooldown", () => {
		const manager = new AccountManager(undefined, storageWith([{}]));
		const account = onlyAccount(manager);

		manager.markAccountCoolingDown(account, Number.POSITIVE_INFINITY, "auth-failure");
		expect(manager.isAccountCoolingDown(account)).toBe(false);
	});

	it("a real cooldown still blocks selection until it elapses", () => {
		const manager = new AccountManager(undefined, storageWith([{}]));
		const account = onlyAccount(manager);

		manager.markAccountCoolingDown(account, 60_000, "network-error");
		expect(manager.isAccountCoolingDown(account)).toBe(true);
		expect(manager.getCurrentOrNextForFamily("codex")).toBeNull();

		vi.advanceTimersByTime(60_000);
		expect(manager.isAccountCoolingDown(account)).toBe(false);
		expect(manager.getCurrentOrNextForFamily("codex")?.index).toBe(0);
	});
});

describe("isSelectable token-bucket gate", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		resetTrackers();
	});

	afterEach(() => {
		vi.useRealTimers();
		resetTrackers();
	});

	it("a fully drained account is skipped for selection", () => {
		const manager = new AccountManager(undefined, storageWith([{}, {}]));

		getTokenTracker().drain(0, "codex", 1000);

		// Round-robin and sticky hard-fail on an unselectable account…
		expect(manager.getCurrentOrNextForFamily("codex")?.index).toBe(1);
		expect(manager.getCurrentOrNextForFamilySticky("codex")?.index).toBe(1);

		const explain = manager.getSelectionExplainability("codex", null, T0);
		expect(explain[0]?.eligible).toBe(false);
		expect(explain[0]?.reasons).toContain("token-bucket-empty");
		expect(explain[1]?.eligible).toBe(true);
	});

	it("an all-drained pool selects nothing and reports a positive wait", () => {
		const manager = new AccountManager(undefined, storageWith([{}, {}]));

		getTokenTracker().drain(0, "codex", 1000);
		getTokenTracker().drain(1, "codex", 1000);

		expect(manager.getCurrentOrNextForFamily("codex")).toBeNull();
		expect(manager.getCurrentOrNextForFamilySticky("codex")).toBeNull();

		// The wait reflects the bucket refill, not 0 (503).
		const wait = manager.getMinWaitTimeForFamily("codex");
		expect(wait).toBeGreaterThan(0);
		expect(Number.isFinite(wait)).toBe(true);
	});

	it("a drained account becomes selectable again once one token refills", () => {
		const manager = new AccountManager(undefined, storageWith([{}]));

		getTokenTracker().drain(0, "codex", 1000);
		expect(manager.getCurrentOrNextForFamily("codex")).toBeNull();

		// 6 tokens/minute: exactly one token after 10s — boundary case.
		vi.advanceTimersByTime(10_000);
		expect(manager.getCurrentOrNextForFamily("codex")?.index).toBe(0);
	});
});

describe("rate-limit state helpers at exact boundaries", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("clearExpiredRateLimits drops a stamp equal to now", () => {
		const entity = { rateLimitResetTimes: { codex: T0, future: T0 + 1 } };
		clearExpiredRateLimits(entity);
		// `now >= resetTime`: a <=/>= mutant here leaves a stale stamp behind.
		expect(entity.rateLimitResetTimes).toEqual({ future: T0 + 1 });
	});

	it("isQuotaExhausted is false at exactly the reset instant", () => {
		expect(isQuotaExhausted({ quotaExhaustedUntil: T0 }, T0)).toBe(false);
		expect(isQuotaExhausted({ quotaExhaustedUntil: T0 + 1 }, T0)).toBe(true);
		expect(isQuotaExhausted({ quotaExhaustedUntil: T0 - 1 }, T0)).toBe(false);
	});

	it("isQuotaExhausted treats non-finite stamps as not exhausted", () => {
		// Infinity would otherwise read as a permanent block and NaN as a ghost
		// entry nothing can clear.
		expect(isQuotaExhausted({ quotaExhaustedUntil: Number.POSITIVE_INFINITY }, T0)).toBe(false);
		expect(isQuotaExhausted({ quotaExhaustedUntil: Number.NaN }, T0)).toBe(false);
	});

	it("clearExpiredQuotaExhaustion drops elapsed and non-finite stamps", () => {
		const entity = {
			quotaExhaustedUntil: Number.NaN,
			quotaExhaustedStampAt: T0 - 1,
		};
		clearExpiredQuotaExhaustion(entity, T0);
		expect(entity.quotaExhaustedUntil).toBeUndefined();
		expect(entity.quotaExhaustedStampAt).toBeUndefined();
	});
});
