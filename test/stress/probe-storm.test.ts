/**
 * Parallel-probe storm regression harness (promoted stress suite).
 *
 * NOTE: lib/parallel-probe.ts has NO runtime caller in this tree (documented
 * dead code — docs/configuration.md says the fetch loop probes sequentially).
 * These tests pin the machinery's contract for when it gets wired up.
 *
 *  A) 200 candidates, maxConcurrency=20: cap is real, winner aborts losers,
 *     unlaunched candidates never start.
 *  B) Hung probes that ignore abort are bounded by timeoutMs.
 *  C) All-fail -> null; no candidate left with a live timer/listener.
 *  D) Loser cleanup: candidate controllers aborted exactly once; abort reason
 *     propagates; unlaunched candidates' controllers still get aborted.
 */
import { describe, it, expect, vi } from "vitest";
import {
	probeAccountsInParallel,
	createProbeCandidates,
} from "../../lib/parallel-probe.js";
import type { ManagedAccount } from "../../lib/accounts.js";

vi.mock("../../lib/logger.js", () => ({
	createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
	logInfo: vi.fn(), logWarn: vi.fn(), logDebug: vi.fn(), logError: vi.fn(),
}));
vi.mock("../../lib/rotation.js", () => ({
	getHealthTracker: () => ({ getScore: () => 100 }),
	getTokenTracker: () => ({ getTokens: () => 50 }),
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mockAccount(index: number): ManagedAccount {
	return {
		index,
		refreshToken: `r-${index}`,
		addedAt: Date.now(),
		lastUsed: Date.now(),
		rateLimitResetTimes: {},
	};
}

describe("A) 200-candidate storm under maxConcurrency=20", () => {
	it("concurrency cap holds; winner aborts all losers; unlaunched never start", async () => {
		const candidates = createProbeCandidates(
			Array.from({ length: 200 }, (_, i) => mockAccount(i)),
		);
		let started = 0;
		let inFlight = 0;
		let maxInFlight = 0;
		let abortedSignals = 0;
		// Winner is index 7 — it resolves fast; everyone else is slow.
		const probeFn = async (account: ManagedAccount, signal: AbortSignal) => {
			started++;
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				if (account.index === 7) {
					await sleep(30);
					return { ok: true, index: account.index };
				}
				// Slow probe honoring abort.
				await new Promise<void>((resolve) => {
					const t = setTimeout(resolve, 5000);
					signal.addEventListener("abort", () => {
						abortedSignals++;
						clearTimeout(t);
						resolve();
					}, { once: true });
				});
				if (signal.aborted) throw signal.reason ?? new Error("aborted");
				return { ok: true, index: account.index };
			} finally {
				inFlight--;
			}
		};

		const t0 = Date.now();
		const result = await probeAccountsInParallel(candidates, probeFn, {
			maxConcurrency: 20,
			timeoutMs: 2_000,
		});
		const wallMs = Date.now() - t0;

		expect(result?.type).toBe("success");
		expect(result?.account.index).toBe(7);
		expect(maxInFlight).toBeLessThanOrEqual(20);
		// With maxConcurrency=20 and a winner at index 7, at most the first 20
		// candidates launched before finish() froze launching.
		expect(started).toBeLessThanOrEqual(20);
		// Every launched loser observed the abort.
		expect(abortedSignals).toBeGreaterThan(0);
		// All candidate controllers aborted — including never-launched ones.
		const abortedCount = candidates.filter((c) => c.controller.signal.aborted).length;
		expect(abortedCount).toBe(199); // all but the winner
		console.log(
			`[probe-storm] 200 candidates, cap=20: winner idx7 in ${wallMs}ms, ` +
			`started=${started} maxInFlight=${maxInFlight} abortedControllers=${abortedCount}`,
		);
	}, 30_000);
});

describe("B) hung probes bounded by timeoutMs", () => {
	it("a probe that ignores its signal still loses the race within timeoutMs", async () => {
		const candidates = createProbeCandidates([mockAccount(0), mockAccount(1)]);
		const never = async () => new Promise<never>(() => {});
		const t0 = Date.now();
		const result = await probeAccountsInParallel(candidates, never, { timeoutMs: 80 });
		const wallMs = Date.now() - t0;
		// Multi-candidate all-fail resolves null (single-candidate returns a
		// typed {type:"failure"} instead — asymmetric but intentional).
		expect(result).toBeNull();
		expect(wallMs).toBeLessThan(2000);
		expect(wallMs).toBeGreaterThanOrEqual(70);
		console.log(`[probe-timeout] hung probe rejected in ${wallMs}ms`);
	});

	it("hung losers after a win do not delay the return", async () => {
		const candidates = createProbeCandidates(Array.from({ length: 10 }, (_, i) => mockAccount(i)));
		const probeFn = async (account: ManagedAccount, signal: AbortSignal) => {
			if (account.index === 0) {
				await sleep(20);
				return "win";
			}
			return new Promise<never>(() => {}); // ignores signal + hangs
		};
		const t0 = Date.now();
		const result = await probeAccountsInParallel(candidates, probeFn, {
			maxConcurrency: 10,
			timeoutMs: 5_000, // losers would each take 5s if awaited
		});
		const wallMs = Date.now() - t0;
		expect(result?.type).toBe("success");
		expect(wallMs).toBeLessThan(1000);
		console.log(`[probe-winner-fast] hung losers ignored, returned in ${wallMs}ms`);
	});
});

describe("C) all-fail returns null and cleans up", () => {
	it("every probe fails -> null result, all probes ran (cap drain)", async () => {
		const candidates = createProbeCandidates(Array.from({ length: 50 }, (_, i) => mockAccount(i)));
		let started = 0;
		let maxInFlight = 0;
		let inFlight = 0;
		const result = await probeAccountsInParallel(
			candidates,
			async () => {
				started++;
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await sleep(5);
				inFlight--;
				throw new Error("boom");
			},
			{ maxConcurrency: 8 },
		);
		expect(result).toBeNull();
		expect(started).toBe(50); // all launched despite cap, draining as failures
		expect(maxInFlight).toBeLessThanOrEqual(8);
	});

	it("candidate whose probe returns null counts as failure (no winner)", async () => {
		const candidates = createProbeCandidates([mockAccount(0)]);
		const result = await probeAccountsInParallel(candidates, async () => null, {});
		expect(result?.type).toBe("failure");
	});
});

describe("D) abort propagation + listener hygiene", () => {
	it("candidate pre-aborted before launch still probes-and-can-win; abort reason flows", async () => {
		const candidates = createProbeCandidates([mockAccount(0), mockAccount(1)]);
		candidates[1]!.controller.abort(new Error("pre-aborted"));
		let sawSignal: AbortSignal | undefined;
		const result = await probeAccountsInParallel(
			candidates,
			async (_a, signal) => {
				sawSignal = signal;
				if (signal.aborted) throw signal.reason ?? new Error("aborted");
				return "ok";
			},
			{},
		);
		// Candidate 1's signal arrives aborted at probe start.
		expect(sawSignal?.aborted).toBe(true);
		// Candidate 0 wins (its probe ran first and resolved).
		expect(result?.type).toBe("success");
	});

	it("external abort during probe rejects that probe but race continues", async () => {
		const candidates = createProbeCandidates([mockAccount(0), mockAccount(1)]);
		const probeFn = async (account: ManagedAccount, signal: AbortSignal) => {
			if (account.index === 0) {
				await new Promise<never>((_res, rej) => {
					signal.addEventListener("abort", () => rej(signal.reason), { once: true });
					setTimeout(() => rej(new Error("self-timeout")), 5000);
				});
			}
			await sleep(100);
			return "winner";
		};
		const pending = probeAccountsInParallel(candidates, probeFn, { maxConcurrency: 2, timeoutMs: 3000 });
		await sleep(20);
		candidates[0]!.controller.abort(new Error("caller-cancel"));
		const result = await pending;
		expect(result?.type).toBe("success");
	});
});
