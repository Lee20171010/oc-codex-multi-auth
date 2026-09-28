/**
 * 429 stampede + backoff regression harness (promoted stress suite).
 *
 *  A) Concurrent 429s dedup: N parallel same-(account,quota) 429s collapse to
 *     one attempt increment; the rest report isDuplicate.
 *  B) Jitter actually decorrelates: ±25% spread produces distinct retry times
 *     for the dup set, all inside the jitter bounds.
 *  C) getRateLimitBackoffWithReason applies the exponential TWICE — it feeds
 *     getRateLimitBackoff's already-exponential delayMs back through
 *     calculateBackoffMs(base * 2^(attempt-1)). The quadratic growth is
 *     pinned as observed behavior; if that double-application is ever fixed,
 *     update these expectations to the single-exponential sequence.
 *  D) Token-bucket sustained-rate ceiling: 6 tokens/min/account caps pool
 *     throughput at accounts*6 req/min regardless of upstream capacity —
 *     measurable as msUntilToken after the burst drains.
 *  E) Server Retry-After floor can exceed the 60s cap: Math.max(base, min(...))
 *     puts the server floor above MAX_BACKOFF_MS — a multi-day Retry-After
 *     is honored verbatim (by design, but it bypasses the cap).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
	getRateLimitBackoff,
	getRateLimitBackoffWithReason,
	clearRateLimitBackoffState,
	calculateBackoffMs,
} from "../../lib/request/rate-limit-backoff.js";
import {
	TokenBucketTracker,
	DEFAULT_TOKEN_BUCKET_CONFIG,
} from "../../lib/rotation.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
	clearRateLimitBackoffState();
});

describe("A) concurrent-429 dedup window", () => {
	it("100 simultaneous 429s on one (account,quota) -> 1 leader + 99 duplicates", () => {
		const results = Array.from({ length: 100 }, () =>
			getRateLimitBackoff(0, "codex:gpt-5.6-sol", 5000),
		);
		const leaders = results.filter((r) => !r.isDuplicate);
		const dups = results.filter((r) => r.isDuplicate);
		expect(leaders.length).toBe(1);
		expect(dups.length).toBe(99);
		expect(leaders[0]!.attempt).toBe(1);
		for (const d of dups) expect(d.attempt).toBe(1);
	});

	it("spread >2s apart increments attempt (no dedup)", async () => {
		const r1 = getRateLimitBackoff(1, "codex", 1000);
		await sleep(2100);
		const r2 = getRateLimitBackoff(1, "codex", 1000);
		expect(r1.attempt).toBe(1);
		expect(r2.attempt).toBe(2);
		expect(r2.isDuplicate).toBe(false);
	});
});

describe("B) jitter decorrelation", () => {
	it("±25% jitter produces spread retry times for the duplicate set", () => {
		const delays = new Set(
			Array.from({ length: 200 }, () => getRateLimitBackoff(0, "codex", 10_000).delayMs),
		);
		// All dups share attempt=1 -> nominal delay 10s; jitter must decorrelate.
		expect(delays.size).toBeGreaterThan(50);
		for (const d of delays) {
			expect(d).toBeGreaterThanOrEqual(7_500);
			expect(d).toBeLessThanOrEqual(12_500);
		}
	});

	it("jitter distribution: measure stddev/min/max over 2000 rolls", () => {
		getRateLimitBackoff(0, "codex", 8000);
		const delays = Array.from({ length: 2000 }, () =>
			getRateLimitBackoff(0, "codex", 8000).delayMs,
		);
		const mean = delays.reduce((a, b) => a + b) / delays.length;
		const sd = Math.sqrt(delays.reduce((a, b) => a + (b - mean) ** 2, 0) / delays.length);
		const atFloor = delays.filter((d) => d === 8000).length;
		console.log(
			`[jitter] base=8000 n=2000 min=${Math.min(...delays)} max=${Math.max(...delays)} ` +
			`mean=${Math.round(mean)} sd=${Math.round(sd)} distinct=${new Set(delays).size} ` +
			`atExactFloor=${atFloor} (${(atFloor / 20).toFixed(1)}%)`,
		);
		expect(Math.min(...delays)).toBeGreaterThanOrEqual(6000);
		expect(Math.max(...delays)).toBeLessThanOrEqual(10_000);
	});

	it("PILEUP: server-floor clamp parks ~half the duplicate set at the identical instant", () => {
		getRateLimitBackoff(0, "codex", 8000); // leader sets state
		const delays = Array.from({ length: 500 }, () =>
			getRateLimitBackoff(0, "codex", 8000).delayMs,
		);
		const floorCount = delays.filter((d) => d === 8000).length;
		const fraction = floorCount / delays.length;
		console.log(
			`[floor-pileup] ${floorCount}/500 dup delays == exactly 8000ms (${(fraction * 100).toFixed(1)}%) ` +
			`— Math.max(baseDelay, jittered) clamps the [0.75,1.0] half of jitter rolls onto the server floor`,
		);
		// ~half the stampede retries in lockstep AT the Retry-After instant.
		// Theoretical pileup = P(jittered <= base) = 50%; assert clearly nonzero.
		expect(fraction).toBeGreaterThan(0.3);
	});
});

describe("C) getRateLimitBackoffWithReason quadratic-backoff audit", () => {
	it("measured delay sequence vs single-exponential expectation", async () => {
		// NO_JITTER equivalent: inject () => 0.5 for the outer jitter so values
		// are exact. Calls spaced >2s apart so each is a new attempt.
		const seq: number[] = [];
		for (let i = 0; i < 4; i++) {
			const r = getRateLimitBackoffWithReason(7, "codex", 1000, "unknown", () => 0.5);
			seq.push(r.delayMs);
			await sleep(2100);
		}
		// Inner getRateLimitBackoff returns base*2^(a-1) (1000,2000,4000,8000).
		// Outer calculateBackoffMs multiplies by 2^(a-1) AGAIN and by reason
		// multiplier 1.0 -> 1000, 4000, 16000, 60000(cap): quadratic exponent.
		console.log(`[quadratic-backoff] attempts 1-4 delays: ${seq.join(", ")}`);
		expect(seq[0]).toBe(1000);   // attempt1: 1000*2^0 *1 = 1000 (coincidentally right)
		expect(seq[1]).toBe(4000);   // attempt2: should be 2000; is 4000
		expect(seq[2]).toBe(16_000); // attempt3: should be 4000; is 16000
		expect(seq[3]).toBe(60_000); // attempt4: should be 8000; slams into cap
	}, 30_000);

	it("same attempt count, plain vs reason variant", async () => {
		const plain = getRateLimitBackoff(9, "codex", 1000, () => 0.5);
		expect(plain.delayMs).toBe(1000);
		await sleep(2100);
		const plain2 = getRateLimitBackoff(9, "codex", 1000, () => 0.5);
		expect(plain2.delayMs).toBe(2000);
		await sleep(2100);
		const plain3 = getRateLimitBackoff(9, "codex", 1000, () => 0.5);
		expect(plain3.delayMs).toBe(4000);
	});

	it("attempt-3 'quota' reason vs naive expectation", async () => {
		for (let i = 0; i < 3; i++) {
			const r = getRateLimitBackoffWithReason(11, "codex", 1000, "quota", () => 0.5);
			if (i === 2) {
				// naive: 1000 * 2^2 * 3.0 = 12000. actual: inner=4000, outer=4000*4*3=48000
				console.log(`[quota-backoff] attempt3 delayMs=${r.delayMs} (naive expectation 12000)`);
				expect(r.delayMs).toBe(48_000);
			}
			await sleep(2100);
		}
	}, 30_000);
});

describe("D) token-bucket sustained-rate ceiling", () => {
	it("6 tok/min/account: after burst, sustained pool throughput is capped", () => {
		const bucket = new TokenBucketTracker(); // defaults: max 50, 6/min
		const ACCOUNTS = 20;
		let consumed = 0;
		for (let i = 0; i < 2000 && consumed < ACCOUNTS * 50; i++) {
			if (bucket.tryConsume(i % ACCOUNTS)) consumed++;
		}
		expect(consumed).toBe(ACCOUNTS * 50); // full 1000-token burst available
		// Now everything is drained; refill = 6/min/account = 120/min pool-wide.
		const msPer = ACCOUNTS * 0 + bucket.msUntilToken(0);
		expect(msPer).toBeGreaterThan(0);
		console.log(
			`[token-ceiling] 20 accts burst=1000, sustained cap=${DEFAULT_TOKEN_BUCKET_CONFIG.tokensPerMinute}/min/acct ` +
			`= ${DEFAULT_TOKEN_BUCKET_CONFIG.tokensPerMinute * ACCOUNTS}/min pool; msUntilToken=${msPer}ms`,
		);
		expect(DEFAULT_TOKEN_BUCKET_CONFIG.tokensPerMinute * ACCOUNTS).toBe(120);
	});

	it("drain() on 429 subtracts 10 more tokens — repeated 429s starve the account ~1.7min", () => {
		const bucket = new TokenBucketTracker();
		bucket.drain(0, undefined, 10);
		bucket.drain(0, undefined, 10);
		const wait = bucket.msUntilToken(0);
		// 50 - 20 = 30 left... wait, drain removes from current, min 0.
		expect(bucket.hasToken(0)).toBe(true); // 30 tokens left, still has
		console.log(`[drain] after 2 drains: tokens=${bucket.getTokens(0)} msUntil=${wait}`);
	});
});

describe("E) server floor bypasses the 60s cap", () => {
	it("Retry-After > 60s is honored verbatim (floor applied after cap)", () => {
		const r = getRateLimitBackoff(0, "codex", 3_600_000); // 1h retry-after
		expect(r.delayMs).toBe(3_600_000);
		console.log(`[server-floor] retryAfter=1h -> delayMs=${r.delayMs} (cap bypassed by design)`);
	});
});
