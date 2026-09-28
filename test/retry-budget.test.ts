import { describe, it, expect } from "vitest";
import {
	RetryBudgetTracker,
	resolveRetryBudgetLimits,
	RETRY_WAIT_BUDGET_UNIT_MS,
	type RetryBudgetLimits,
} from "../lib/request/retry-budget.js";

describe("retry-budget", () => {
	it("resolves profile defaults", () => {
		const conservative = resolveRetryBudgetLimits("conservative");
		const aggressive = resolveRetryBudgetLimits("aggressive");

		expect(conservative.rateLimitGlobal).toBe(1);
		expect(aggressive.rateLimitGlobal).toBeGreaterThan(conservative.rateLimitGlobal);
	});

	it("falls back to the balanced profile for an unknown profile name", () => {
		// Without the `?? PROFILE_LIMITS.balanced` fallback an unknown profile
		// yields all-undefined limits — and `consume()` treats a non-finite
		// limit as unbounded, i.e. infinite retries.
		const limits = resolveRetryBudgetLimits("bogus-profile" as never);
		expect(limits).toEqual({
			authRefresh: 4,
			network: 4,
			server: 4,
			rateLimitShort: 4,
			rateLimitGlobal: 3,
			emptyResponse: 2,
		});
		const tracker = new RetryBudgetTracker(limits);
		for (let i = 0; i < 3; i++) {
			expect(tracker.consume("rateLimitGlobal")).toBe(true);
		}
		expect(tracker.consume("rateLimitGlobal")).toBe(false);
	});

	it("pins every profile table to its exact values", () => {
		// Self-referential or weakened profile constants (e.g. one bucket
		// referencing another) only survive assertion-free suites.
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

	it("applies normalized overrides", () => {
		const limits = resolveRetryBudgetLimits("balanced", {
			network: 2.9,
			server: -1,
			emptyResponse: 0,
		});

		expect(limits.network).toBe(2);
		expect(limits.server).toBe(4);
		expect(limits.emptyResponse).toBe(0);
	});

	it("tracks usage and remaining budget", () => {
		const limits: RetryBudgetLimits = {
			authRefresh: 1,
			network: 1,
			server: 1,
			rateLimitShort: 1,
			rateLimitGlobal: 1,
			emptyResponse: 1,
		};
		const tracker = new RetryBudgetTracker(limits);

		expect(tracker.consume("network")).toBe(true);
		expect(tracker.consume("network")).toBe(false);
		expect(tracker.getRemaining("network")).toBe(0);
		expect(tracker.getUsage().network).toBe(1);
	});

	it("verifies budget consumption semantics across error stages", () => {
		const limits: RetryBudgetLimits = {
			authRefresh: 2,
			network: 2,
			server: 2,
			rateLimitShort: 2,
			rateLimitGlobal: 1,
			emptyResponse: 1,
		};
		const tracker = new RetryBudgetTracker(limits);

		// An initial long-delay rate limit rotates without consuming rateLimitGlobal
		expect(tracker.getUsage().rateLimitGlobal).toBe(0);
		expect(tracker.getRemaining("rateLimitGlobal")).toBe(1);

		// An invalidated 401 response triggers account rotation/cooldown without consuming authRefresh directly
		expect(tracker.getUsage().authRefresh).toBe(0);
		expect(tracker.getRemaining("authRefresh")).toBe(2);

		// Global all-accounts blocked wait consumes rateLimitGlobal
		expect(tracker.consume("rateLimitGlobal")).toBe(true);
		expect(tracker.getRemaining("rateLimitGlobal")).toBe(0);
		expect(tracker.consume("rateLimitGlobal")).toBe(false);

		// Token refresh attempts consume authRefresh
		expect(tracker.consume("authRefresh")).toBe(true);
		expect(tracker.getUsage().authRefresh).toBe(1);
	});

	describe("consumeWait", () => {
		const balanced = () => new RetryBudgetTracker(resolveRetryBudgetLimits("balanced"));

		it("does not charge the budget for a burst of sub-second waits", () => {
			const tracker = balanced();

			// The production regression: three consecutive 400ms waits spent the
			// whole default budget and hard-failed the request.
			for (let i = 0; i < 3; i++) {
				expect(tracker.consumeWait("rateLimitGlobal", 400)).toBe(true);
			}
			expect(tracker.getUsage().rateLimitGlobal).toBe(0);
			expect(tracker.getRemaining("rateLimitGlobal")).toBe(3);

			for (let i = 0; i < 27; i++) {
				expect(tracker.consumeWait("rateLimitGlobal", 400)).toBe(true);
			}
		});

		it("charges a full unit for a wait that cannot be proportioned", () => {
			const tracker = balanced();

			// Infinity, NaN, and negative waits have no proportion to charge.
			// Each must cost a unit - as zero they would accumulate nothing and
			// an unbounded retry path would never terminate.
			expect(tracker.consumeWait("rateLimitGlobal", Number.POSITIVE_INFINITY)).toBe(true);
			expect(tracker.consumeWait("rateLimitGlobal", Number.NaN)).toBe(true);
			expect(tracker.consumeWait("rateLimitGlobal", -1)).toBe(true);
			expect(tracker.getUsage().rateLimitGlobal).toBe(3);

			expect(tracker.consumeWait("rateLimitGlobal", Number.POSITIVE_INFINITY)).toBe(false);
		});

		it("charges a full unit for a wait at or above the unit length", () => {
			const tracker = balanced();

			expect(tracker.consumeWait("rateLimitGlobal", RETRY_WAIT_BUDGET_UNIT_MS)).toBe(true);
			expect(tracker.getUsage().rateLimitGlobal).toBe(1);

			expect(tracker.consumeWait("rateLimitGlobal", 6 * 60 * 60 * 1000)).toBe(true);
			expect(tracker.consumeWait("rateLimitGlobal", 6 * 60 * 60 * 1000)).toBe(true);
			expect(tracker.getUsage().rateLimitGlobal).toBe(3);

			// A long wait stays governed: the fourth exceeds the balanced budget.
			expect(tracker.consumeWait("rateLimitGlobal", 6 * 60 * 60 * 1000)).toBe(false);
		});

		it("a zero wait is still free — it carries nothing, not a full unit", () => {
			const tracker = balanced();
			// `waitMs <= 0` would charge a full unit for a wait of zero; only
			// `waitMs < 0` is the unproportioned case.
			expect(tracker.consumeWait("rateLimitGlobal", 0)).toBe(true);
			expect(tracker.getUsage().rateLimitGlobal).toBe(0);
		});

		it("accumulates short waits into whole units", () => {
			const tracker = balanced();
			const waitMs = RETRY_WAIT_BUDGET_UNIT_MS / 10;

			for (let i = 0; i < 10; i++) {
				expect(tracker.consumeWait("rateLimitGlobal", waitMs)).toBe(true);
			}
			expect(tracker.getUsage().rateLimitGlobal).toBe(1);
		});

		it("refuses free short waits once the bucket is exhausted", () => {
			const tracker = balanced();

			for (let i = 0; i < 3; i++) {
				expect(tracker.consumeWait("rateLimitGlobal", RETRY_WAIT_BUDGET_UNIT_MS)).toBe(true);
			}

			// Without this the carry would grant sub-unit waits forever and the
			// retry loop could never terminate.
			expect(tracker.consumeWait("rateLimitGlobal", 1)).toBe(false);
			expect(tracker.consumeWait("rateLimitGlobal", 0)).toBe(false);
		});

		it("keeps per-bucket carries independent", () => {
			const tracker = balanced();
			const waitMs = RETRY_WAIT_BUDGET_UNIT_MS / 2;

			expect(tracker.consumeWait("rateLimitGlobal", waitMs)).toBe(true);
			expect(tracker.consumeWait("rateLimitShort", waitMs)).toBe(true);
			expect(tracker.getUsage().rateLimitGlobal).toBe(0);
			expect(tracker.getUsage().rateLimitShort).toBe(0);

			expect(tracker.consumeWait("rateLimitGlobal", waitMs)).toBe(true);
			expect(tracker.getUsage().rateLimitGlobal).toBe(1);
			expect(tracker.getUsage().rateLimitShort).toBe(0);
		});

		it("treats a zero-limit bucket as immediately exhausted", () => {
			const tracker = new RetryBudgetTracker(
				resolveRetryBudgetLimits("balanced", { rateLimitGlobal: 0 }),
			);
			expect(tracker.consumeWait("rateLimitGlobal", 1)).toBe(false);
		});
	});

	it("clones constructor limits to avoid external mutation", () => {
		const limits: RetryBudgetLimits = {
			authRefresh: 1,
			network: 2,
			server: 3,
			rateLimitShort: 4,
			rateLimitGlobal: 5,
			emptyResponse: 6,
		};
		const tracker = new RetryBudgetTracker(limits);
		limits.network = 0;
		expect(tracker.getLimits().network).toBe(2);
	});
});
describe("retry budget tracker", () => {
	it("usage counters never go negative and consumption is monotonic", () => {
		const tracker = new RetryBudgetTracker({
			authRefresh: 1,
			network: 1,
			server: 1,
			rateLimitShort: 1,
			rateLimitGlobal: 1,
			emptyResponse: 1,
		});
		for (const bucket of [
			"authRefresh",
			"network",
			"server",
			"rateLimitShort",
			"rateLimitGlobal",
			"emptyResponse",
		] as const) {
			expect(tracker.consume(bucket)).toBe(true);
			expect(tracker.consume(bucket)).toBe(false);
			expect(tracker.consume(bucket)).toBe(false);
			const usage = tracker.getUsage()[bucket];
			expect(usage).toBe(1);
			expect(tracker.getRemaining(bucket)).toBe(0);
		}
	});

	it("zero-limit buckets block immediately; remaining never negative", () => {
		const tracker = new RetryBudgetTracker({
			authRefresh: 0,
			network: 0,
			server: 0,
			rateLimitShort: 0,
			rateLimitGlobal: 0,
			emptyResponse: 0,
		});
		for (const bucket of [
			"authRefresh",
			"network",
			"server",
			"rateLimitShort",
			"rateLimitGlobal",
			"emptyResponse",
		] as const) {
			expect(tracker.consume(bucket)).toBe(false);
			expect(tracker.getRemaining(bucket)).toBe(0);
		}
	});
});
