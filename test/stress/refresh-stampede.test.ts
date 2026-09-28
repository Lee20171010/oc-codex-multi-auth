/**
 * Refresh-queue coalescing proofs under concurrency (promoted stress harness).
 *
 * Covers:
 *  A) N concurrent queuedRefresh(sameToken) -> exactly 1 upstream call.
 *  B) Stale eviction (>maxEntryAgeMs) lets a SECOND upstream exchange start for
 *     the same single-use token while the first is still in flight
 *     (characterization: this is a real dedup breach the queue permits).
 *  C) The initiator's `finally { pending.delete(token) }` deletes by KEY, not
 *     by entry identity — an evicted-and-replaced entry is deleted when the
 *     ORIGINAL refresh resolves, enabling a THIRD concurrent exchange
 *     (characterization of a known hole: `isRefreshing` lies while the
 *     replacement exchange is in flight).
 *  D) Settled-rotation reuse caps late arrivals at the recorded result.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RefreshQueue, resetRefreshQueue } from "../../lib/refresh-queue.js";
import * as authModule from "../../lib/auth/auth.js";
import type { TokenResult } from "../../lib/types.js";

vi.mock("../../lib/auth/auth.js", () => ({
	refreshAccessToken: vi.fn(),
}));

vi.mock("../../lib/logger.js", () => ({
	createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
	logInfo: vi.fn(),
	logWarn: vi.fn(),
	logDebug: vi.fn(),
}));

const success = (refresh: string): TokenResult => ({
	type: "success",
	access: `access-for-${refresh}`,
	refresh,
	expires: Date.now() + 3_600_000,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Upstream mock: latency ms, rotates token to `${token}-rotated-N`. */
function mockUpstream(latencyMs: number | (() => number)) {
	let calls = 0;
	const startedAt: number[] = [];
	const endedAt: number[] = [];
	vi.mocked(authModule.refreshAccessToken).mockImplementation(async (token: string) => {
		calls += 1;
		const n = calls;
		startedAt.push(Date.now());
		const ms = typeof latencyMs === "function" ? latencyMs() : latencyMs;
		await sleep(ms);
		endedAt.push(Date.now());
		return success(`${token}-rotated-${n}`);
	});
	return {
		get calls() { return calls; },
		startedAt,
		endedAt,
		/** Max simultaneous in-flight upstream exchanges observed. */
		maxInFlight(): number {
			let max = 0;
			for (let i = 0; i < startedAt.length; i++) {
				let inflight = 1;
				for (let j = 0; j < startedAt.length; j++) {
					if (i === j) continue;
					if (startedAt[j]! < endedAt[i]! && endedAt[j]! > startedAt[i]!) inflight++;
				}
				max = Math.max(max, inflight);
			}
			return max;
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	resetRefreshQueue();
});

describe("A) request stampede coalescing — N concurrent refreshers, 1 upstream call", () => {
	for (const n of [50, 500]) {
		it(`N=${n} concurrent queuedRefresh(same token) -> 1 upstream exchange`, async () => {
			const up = mockUpstream(() => 10 + Math.random() * 190);
			const queue = new RefreshQueue();
			const results = await Promise.all(
				Array.from({ length: n }, () => queue.refresh("shared-token")),
			);
			expect(up.calls).toBe(1);
			// All callers get the SAME settled result object (rotation recorded).
			for (const r of results) expect(r).toBe(results[0]);
			expect(queue.getMetricsSnapshot().deduplicated).toBe(n - 1);
		});
	}

	it("staggered arrivals within in-flight window still coalesce", async () => {
		const up = mockUpstream(120);
		const queue = new RefreshQueue();
		const first = queue.refresh("t");
		await sleep(60); // still in flight
		const later = await Promise.all(
			Array.from({ length: 100 }, () => queue.refresh("t")),
		);
		await first;
		expect(up.calls).toBe(1);
		for (const r of later) expect(r.type).toBe("success");
	});
});

describe("B) stale eviction (>maxEntryAgeMs) re-issues the SAME single-use token", () => {
	it("a slow upstream (>maxEntryAgeMs) lets a second exchange start concurrently", async () => {
		const up = mockUpstream(150);
		const queue = new RefreshQueue(40); // 40ms stale window

		const p1 = queue.refresh("burn-me");         // t=0, exchange #1 in flight
		await sleep(80);                              // t=80: entry now stale (40ms)
		const p2 = queue.refresh("burn-me");         // eviction -> exchange #2 starts
		const [r1, r2] = await Promise.all([p1, p2]);

		// DEDUP BREACH: two upstream exchanges of the same single-use token ran
		// CONCURRENTLY. With real OAuth semantics, whichever lands second gets
		// refresh_token_reused; this mock can't lose, so both "succeed" — but the
		// two callers hold DIFFERENT rotated tokens.
		expect(up.calls).toBe(2);
		expect(up.maxInFlight()).toBe(2);
		expect(r1.type).toBe("success");
		expect(r2.type).toBe("success");
		if (r1.type === "success" && r2.type === "success") {
			expect(r1.refresh).not.toBe(r2.refresh); // divergent token state
		}
	});
});

describe("C) pending.delete(token) deletes by key — evicts a NEWER live entry", () => {
	it("isRefreshing() lies while the replacement exchange is in flight", async () => {
		let exchangeN = 0;
		const resolvers: Array<() => void> = [];
		vi.mocked(authModule.refreshAccessToken).mockImplementation(async (token: string) => {
			exchangeN += 1;
			const n = exchangeN;
			await new Promise<void>((resolve) => resolvers.push(resolve));
			return success(`${token}-r${n}`);
		});

		const queue = new RefreshQueue(40);
		const p1 = queue.refresh("tok");   // exchange #1 (controlled resolver)
		await sleep(60);                    // #1's entry goes stale
		const p2 = queue.refresh("tok");   // evicts #1; exchange #2 starts
		await sleep(1);
		expect(exchangeN).toBe(2);
		expect(queue.isRefreshing("tok")).toBe(true); // #2 tracked

		resolvers[0]!();
		await p1;                           // #1's finally: pending.delete("tok") — by KEY
		await sleep(1);
		// BUG: exchange #2 is still in flight but the map no longer tracks it.
		expect(queue.isRefreshing("tok")).toBe(false);
		expect(queue.pendingCount).toBe(0);

		// A caller arriving after the settled-rotation TTL also escapes dedup:
		// recentRotations aged out (same maxEntryAgeMs window), pending entry
		// was wrongly deleted -> exchange #3 while #2 is STILL in flight.
		await sleep(45);                    // past #1's settledAt+40ms TTL
		const p3 = queue.refresh("tok");
		await sleep(1);
		expect(exchangeN).toBe(3);

		resolvers.forEach((r) => r());
		await Promise.all([p2, p3]);
	});
});

describe("D) settled-rotation reuse", () => {
	it("late arrival with consumed token reuses settled rotation result (no 2nd exchange)", async () => {
		const up = mockUpstream(20);
		const queue = new RefreshQueue(30_000);
		await queue.refresh("tok");
		expect(up.calls).toBe(1);
		// Caller that captured "tok" before rotation arrives after settle:
		const late = await queue.refresh("tok");
		expect(up.calls).toBe(1); // recentRotations served it
		expect(queue.getMetricsSnapshot().rotationReused).toBeGreaterThan(0);
		expect(late.type).toBe("success");
	});

	it("FAILED refresh leaves no settled reuse — next caller re-exchanges", async () => {
		vi.mocked(authModule.refreshAccessToken)
			.mockResolvedValueOnce({ type: "failed", reason: "http_error", statusCode: 401 })
			.mockResolvedValue(success("tok-new"));
		const queue = new RefreshQueue();
		const r1 = await queue.refresh("tok");
		expect(r1.type).toBe("failed");
		const r2 = await queue.refresh("tok");
		expect(r2.type).toBe("success");
		expect(authModule.refreshAccessToken).toHaveBeenCalledTimes(2);
	});
});
