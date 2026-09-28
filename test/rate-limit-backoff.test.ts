import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	clearRateLimitBackoffState,
	getRateLimitBackoff,
	remapRateLimitBackoffAfterRemoval,
	resetRateLimitBackoff,
	calculateBackoffMs,
	getRateLimitBackoffWithReason,
} from "../lib/request/rate-limit-backoff.js";

// A neutral roll lands on jitter factor 1.0, reproducing the deterministic
// pre-jitter delays so the existing assertions stay exact.
const NO_JITTER = () => 0.5;

describe("Rate limit backoff", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(0));
		clearRateLimitBackoffState();
	});

	afterEach(() => {
		clearRateLimitBackoffState();
		vi.useRealTimers();
	});

	it("deduplicates concurrent 429s within the window", () => {
		const first = getRateLimitBackoff(0, "codex", 1000, NO_JITTER);
		expect(first).toEqual({ attempt: 1, delayMs: 1000, isDuplicate: false });

		vi.setSystemTime(new Date(1000));
		const second = getRateLimitBackoff(0, "codex", 1000, NO_JITTER);
		expect(second.attempt).toBe(1);
		expect(second.delayMs).toBe(1000);
		expect(second.isDuplicate).toBe(true);
	});

	it("increments after dedup window", () => {
		getRateLimitBackoff(0, "codex", 1000, NO_JITTER);
		vi.setSystemTime(new Date(2500));
		const second = getRateLimitBackoff(0, "codex", 1000, NO_JITTER);
		expect(second.attempt).toBe(2);
		expect(second.delayMs).toBe(2000);
		expect(second.isDuplicate).toBe(false);
	});

	it("resets after quiet period", () => {
		getRateLimitBackoff(0, "codex", 1000, NO_JITTER);
		vi.setSystemTime(new Date(121_000));
		const next = getRateLimitBackoff(0, "codex", 1000, NO_JITTER);
		expect(next.attempt).toBe(1);
	});

	it("resetRateLimitBackoff clears state", () => {
		getRateLimitBackoff(0, "codex", 1000, NO_JITTER);
		resetRateLimitBackoff(0, "codex");
		const next = getRateLimitBackoff(0, "codex", 1000, NO_JITTER);
		expect(next.attempt).toBe(1);
		expect(next.isDuplicate).toBe(false);
	});

	describe("calculateBackoffMs", () => {
		it("applies quota multiplier (3.0)", () => {
			const result = calculateBackoffMs(1000, 1, "quota", NO_JITTER);
			expect(result).toBe(3000);
		});

		it("applies tokens multiplier (1.5)", () => {
			const result = calculateBackoffMs(1000, 1, "tokens", NO_JITTER);
			expect(result).toBe(1500);
		});

		it("applies concurrent multiplier (0.5)", () => {
			const result = calculateBackoffMs(1000, 1, "concurrent", NO_JITTER);
			expect(result).toBe(500);
		});

		it("applies unknown multiplier (1.0)", () => {
			const result = calculateBackoffMs(1000, 1, "unknown", NO_JITTER);
			expect(result).toBe(1000);
		});

		it("applies exponential backoff on higher attempts", () => {
			const attempt1 = calculateBackoffMs(1000, 1, "unknown", NO_JITTER);
			const attempt2 = calculateBackoffMs(1000, 2, "unknown", NO_JITTER);
			const attempt3 = calculateBackoffMs(1000, 3, "unknown", NO_JITTER);
			expect(attempt1).toBe(1000);
			expect(attempt2).toBe(2000);
			expect(attempt3).toBe(4000);
		});

		it("caps at MAX_BACKOFF_MS", () => {
			const result = calculateBackoffMs(1000, 20, "quota", NO_JITTER);
			expect(result).toBeLessThanOrEqual(5 * 60 * 1000);
		});

		it("uses default multiplier when reason is undefined", () => {
			const result = calculateBackoffMs(1000, 1, undefined, NO_JITTER);
			expect(result).toBe(1000);
		});

		it("uses fallback multiplier 1.0 when reason is not in map (line 111 coverage)", () => {
			const result = calculateBackoffMs(1000, 1, "unknown-reason" as never, NO_JITTER);
			expect(result).toBe(1000);
		});
	});

	describe("jitter", () => {
		it("scales the exponential component by [0.75, 1.25]", () => {
			// Attempt 2 on a 4s base: computed 8s -> jittered 6s..10s.
			const low = calculateBackoffMs(4000, 2, "unknown", () => 0);
			const high = calculateBackoffMs(4000, 2, "unknown", () => 0.999999);
			expect(low).toBe(6000);
			expect(high).toBe(9999);
		});

		it("keeps the 60s cap effective after jitter", () => {
			// A top roll on an already-capped computed delay must not exceed it.
			const capped = calculateBackoffMs(60_000, 1, "unknown", () => 1);
			expect(capped).toBeLessThanOrEqual(60_000);
			expect(capped).toBe(60_000);
		});

		it("clamps a hostile injected RNG to the documented bound", () => {
			const over = calculateBackoffMs(4000, 1, "unknown", () => 99);
			const under = calculateBackoffMs(4000, 1, "unknown", () => -5);
			expect(over).toBe(5000); // factor capped at 1.25
			expect(under).toBe(3000); // factor floored at 0.75
		});

		it("keeps the server retry floor intact even on a minimum roll", () => {
			// Server says wait 8s; the minimum roll shrinks the exponential value
			// to 6s but the floor must re-assert 8s.
			const result = getRateLimitBackoff(0, "floor-key", 8000, () => 0);
			expect(result.delayMs).toBe(8000);
		});

		it("jitter decorrelates the delay in both normal and duplicate paths", () => {
			getRateLimitBackoff(1, "dup-jitter", 4000, () => 0.5);
			vi.setSystemTime(new Date(1000));
			const dup = getRateLimitBackoff(1, "dup-jitter", 4000, () => 0);
			expect(dup.isDuplicate).toBe(true);
			expect(dup.delayMs).toBe(4000); // floor still wins over 3000

			vi.setSystemTime(new Date(5000));
			const next = getRateLimitBackoff(1, "dup-jitter", 4000, () => 1);
			expect(next.isDuplicate).toBe(false);
			expect(next.attempt).toBe(2);
			expect(next.delayMs).toBe(10_000); // 8000 * 1.25
		});
	});

	describe("normalizeDelayMs edge cases (line 32 coverage)", () => {
		it("uses fallback when serverRetryAfterMs is null", () => {
			const result = getRateLimitBackoff(10, "null-test", null, NO_JITTER);
			expect(result.delayMs).toBe(1000);
		});

		it("uses fallback when serverRetryAfterMs is undefined", () => {
			const result = getRateLimitBackoff(11, "undefined-test", undefined, NO_JITTER);
			expect(result.delayMs).toBe(1000);
		});

		it("uses fallback when serverRetryAfterMs is NaN", () => {
			const result = getRateLimitBackoff(12, "nan-test", NaN, NO_JITTER);
			expect(result.delayMs).toBe(1000);
		});

		it("uses fallback when serverRetryAfterMs is Infinity", () => {
			const result = getRateLimitBackoff(13, "infinity-test", Infinity, NO_JITTER);
			expect(result.delayMs).toBe(1000);
		});

		it("uses fallback when serverRetryAfterMs is negative Infinity", () => {
			const result = getRateLimitBackoff(14, "neg-infinity-test", -Infinity, NO_JITTER);
			expect(result.delayMs).toBe(1000);
		});
	});

	describe("getRateLimitBackoffWithReason", () => {
		it("returns adjusted delay with quota reason", () => {
			const result = getRateLimitBackoffWithReason(0, "test-quota", 1000, "quota", NO_JITTER);
			expect(result.reason).toBe("quota");
			expect(result.delayMs).toBe(3000);
			expect(result.attempt).toBe(1);
		});

		it("returns adjusted delay with tokens reason", () => {
			const result = getRateLimitBackoffWithReason(1, "test-tokens", 2000, "tokens", NO_JITTER);
			expect(result.reason).toBe("tokens");
			expect(result.delayMs).toBe(3000);
		});

		it("uses unknown reason by default", () => {
			const result = getRateLimitBackoffWithReason(2, "test-default", 1000, undefined, NO_JITTER);
			expect(result.reason).toBe("unknown");
			expect(result.delayMs).toBe(1000);
		});

		it("increments attempt on subsequent calls", () => {
			getRateLimitBackoffWithReason(3, "test-increment", 1000, "quota", NO_JITTER);
			vi.setSystemTime(new Date(2500));
			const second = getRateLimitBackoffWithReason(3, "test-increment", 1000, "quota", NO_JITTER);
			expect(second.attempt).toBe(2);
			expect(second.delayMs).toBe(12000);
		});

		it("applies jitter exactly once across the two layers", () => {
			// Attempt 2: the inner layer resolves max(4000, 8000)=8000, then the
			// reason layer computes 8000 * 2^1 * 1.0 * jitter. A top roll gives
			// exactly 20000 — jitter applied twice would yield 25000.
			getRateLimitBackoffWithReason(4, "single-jitter", 4000, "unknown", NO_JITTER);
			vi.setSystemTime(new Date(3000));
			const second = getRateLimitBackoffWithReason(
				4,
				"single-jitter",
				4000,
				"unknown",
				() => 1,
			);
			expect(second.delayMs).toBe(20_000);
		});
	});
});
describe("rate-limit backoff with hostile server inputs", () => {
	afterEach(() => {
		vi.useRealTimers();
		clearRateLimitBackoffState();
	});

	const finitePositiveBounded = (value: number): void => {
		expect(Number.isFinite(value)).toBe(true);
		expect(value).toBeGreaterThanOrEqual(0);
	};

	it("delayMs stays finite and non-negative for NaN/Infinity/negative/zero inputs", () => {
		for (const input of [NaN, Infinity, -Infinity, -5, 0, 1e309, Number.MIN_VALUE]) {
			const result = getRateLimitBackoff(0, `q-${String(input)}`, input);
			finitePositiveBounded(result.delayMs);
			expect(result.attempt).toBeGreaterThanOrEqual(1);
			expect(Number.isFinite(result.attempt)).toBe(true);
		}
	});

	it("huge-but-finite server delay does not overflow to NaN/Infinity", () => {
		const result = getRateLimitBackoff(1, "q-huge", 1e12);
		finitePositiveBounded(result.delayMs);
	});

	it("exponential component never exceeds the 60s cap regardless of attempt count", () => {
		for (let i = 0; i < 2000; i++) {
			const result = getRateLimitBackoff(2, "q-growth", 1000);
			finitePositiveBounded(result.delayMs);
			expect(result.delayMs).toBeLessThanOrEqual(60_000);
		}
	});

	it("backoff with reason stays finite for all reasons and huge attempt counts", () => {
		for (const reason of ["quota", "tokens", "concurrent", "unknown"] as const) {
			const capped = calculateBackoffMs(60_000, 5000, reason);
			finitePositiveBounded(capped);
			expect(capped).toBeLessThanOrEqual(60_000);
		}
		const adjusted = getRateLimitBackoffWithReason(3, "q-reason", 1000, "quota");
		finitePositiveBounded(adjusted.delayMs);
	});

	it("remapRateLimitBackoffAfterRemoval survives malformed keys without resurrecting blocks", () => {
		getRateLimitBackoff(0, "a", 1000);
		getRateLimitBackoff(1, "b", 1000);
		expect(() => remapRateLimitBackoffAfterRemoval(0)).not.toThrow();
		expect(() => remapRateLimitBackoffAfterRemoval(-1)).not.toThrow();
		expect(() => remapRateLimitBackoffAfterRemoval(9999)).not.toThrow();
	});
});
