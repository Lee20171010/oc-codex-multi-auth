import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	HealthScoreTracker,
	TokenBucketTracker,
	resetTrackers,
	selectHybridAccount,
	exponentialBackoff,
	DEFAULT_TOKEN_BUCKET_CONFIG,
	type AccountWithMetrics,
} from "../lib/rotation.js";

const T0 = new Date("2026-02-01T12:00:00Z").getTime();

describe("TokenBucketTracker clock rollback", () => {
	let tracker: TokenBucketTracker;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		tracker = new TokenBucketTracker();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not drain the bucket below its post-consume level on a 10-minute rollback", () => {
		expect(tracker.tryConsume(0)).toBe(true);
		const afterConsume = tracker.getTokens(0);
		expect(afterConsume).toBe(DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens - 1);

		vi.setSystemTime(T0 - 10 * 60 * 1000);

		// Unclamped, minutesSinceRefill goes to -10 and refill becomes a drain:
		// 49 + (-10 * 6/min) = -11, leaving the account unselectable until wall
		// time catches back up. Clamped, the bucket simply does not refill.
		expect(tracker.getTokens(0)).toBe(afterConsume);
		expect(tracker.hasToken(0)).toBe(true);
	});

	it("keeps a drained bucket at zero rather than negative on rollback", () => {
		tracker.drain(0, undefined, DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens);
		expect(tracker.getTokens(0)).toBe(0);

		vi.setSystemTime(T0 - 60 * 60 * 1000);

		expect(tracker.getTokens(0)).toBe(0);
		expect(tracker.hasToken(0)).toBe(false);
	});

	it("still refills normally once the clock moves forward again", () => {
		tracker.drain(0, undefined, 12);
		const afterDrain = tracker.getTokens(0);

		vi.setSystemTime(T0 - 10 * 60 * 1000);
		expect(tracker.getTokens(0)).toBe(afterDrain);

		vi.setSystemTime(T0 + 60 * 1000);
		expect(tracker.getTokens(0)).toBeCloseTo(
			afterDrain + DEFAULT_TOKEN_BUCKET_CONFIG.tokensPerMinute,
			5,
		);
	});
});

describe("TokenBucketTracker exact-token boundary", () => {
	let tracker: TokenBucketTracker;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		tracker = new TokenBucketTracker();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("hasToken is false just below one token and true at exactly one", () => {
		tracker.drain(0, undefined, DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens);
		expect(tracker.getTokens(0)).toBe(0);
		expect(tracker.hasToken(0)).toBe(false);

		// 6 tokens/minute: 9_999ms lands just under one token, 10_000ms exactly one.
		vi.advanceTimersByTime(9_999);
		expect(tracker.getTokens(0)).toBeLessThan(1);
		expect(tracker.hasToken(0)).toBe(false);

		vi.advanceTimersByTime(1);
		expect(tracker.getTokens(0)).toBe(1);
		expect(tracker.hasToken(0)).toBe(true);
	});

	it("tryConsume succeeds at exactly one token and fails right after", () => {
		tracker.drain(0, undefined, DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens);
		vi.advanceTimersByTime(10_000); // exactly one token

		expect(tracker.tryConsume(0)).toBe(true);
		expect(tracker.getTokens(0)).toBe(0);
		expect(tracker.tryConsume(0)).toBe(false);
	});

	it("msUntilToken is 0 at exactly one token and positive just below", () => {
		tracker.drain(0, undefined, DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens);
		vi.advanceTimersByTime(10_000);
		expect(tracker.msUntilToken(0)).toBe(0);

		tracker.tryConsume(0); // back to 0
		vi.advanceTimersByTime(9_999);
		expect(tracker.getTokens(0)).toBeLessThan(1);
		expect(tracker.msUntilToken(0)).toBeGreaterThan(0);
	});
});

describe("selectHybridAccount determinism", () => {
	let healthTracker: HealthScoreTracker;
	let tokenTracker: TokenBucketTracker;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		healthTracker = new HealthScoreTracker();
		tokenTracker = new TokenBucketTracker();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("picks the first account in iteration order on an exact score tie", () => {
		// Identical health, tokens and lastUsed: every term in the hybrid score
		// is equal, so the tie must resolve to the FIRST candidate iterated —
		// a >= comparator would silently pick the last one instead.
		const accounts: AccountWithMetrics[] = [
			{ index: 0, isAvailable: true, lastUsed: T0 - 60_000 },
			{ index: 1, isAvailable: true, lastUsed: T0 - 60_000 },
			{ index: 2, isAvailable: true, lastUsed: T0 - 60_000 },
		];

		const result = selectHybridAccount(accounts, healthTracker, tokenTracker);
		expect(result?.index).toBe(0);
	});

	it("is stable across repeated calls on unchanged state", () => {
		const accounts: AccountWithMetrics[] = [
			{ index: 0, isAvailable: true, lastUsed: T0 - 60_000 },
			{ index: 1, isAvailable: true, lastUsed: T0 - 60_000 },
		];

		const first = selectHybridAccount(accounts, healthTracker, tokenTracker);
		const second = selectHybridAccount(accounts, healthTracker, tokenTracker);
		expect(second?.index).toBe(first?.index);
	});
});

describe("exponentialBackoff absolute delays", () => {
	it("returns exactly baseMs for the first attempt with zero jitter", () => {
		// The exponent is attempt - 1; an `attempt` mutant doubles every delay
		// and these absolute assertions catch what ratio-only checks cannot.
		expect(exponentialBackoff(1, 1000, 60_000, 0)).toBe(1000);
		expect(exponentialBackoff(2, 1000, 60_000, 0)).toBe(2000);
		expect(exponentialBackoff(3, 1000, 60_000, 0)).toBe(4000);
	});

	it("returns exactly baseMs for the first attempt with default args at mid-jitter", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		try {
			expect(exponentialBackoff(1, 1000)).toBe(1000);
		} finally {
			vi.restoreAllMocks();
		}
	});
});
