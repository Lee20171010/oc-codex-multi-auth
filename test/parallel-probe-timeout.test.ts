import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	probeAccountsInParallel,
	createProbeCandidates,
} from "../lib/parallel-probe.js";
import type { ManagedAccount } from "../lib/accounts.js";

function createMockAccount(index: number): ManagedAccount {
	return {
		index,
		refreshToken: `token-${index}`,
		lastUsed: Date.now() - index * 1000 * 60 * 60,
		addedAt: Date.now(),
		rateLimitResetTimes: {},
	};
}

const never = () => new Promise<string>(() => {});

describe("probeAccountsInParallel timeoutMs and maxConcurrency", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("a hung probe finishes on timeoutMs instead of blocking forever", async () => {
		const candidates = createProbeCandidates([createMockAccount(0)]);
		const promise = probeAccountsInParallel(candidates, never, {
			timeoutMs: 5_000,
		});

		await vi.advanceTimersByTimeAsync(5_000);
		const result = await promise;

		expect(result?.type).toBe("failure");
		expect(result?.error?.message).toContain("timed out");
	});

	it("aborts the probe's own signal on timeout", async () => {
		const candidates = createProbeCandidates([createMockAccount(0)]);
		let observedSignal: AbortSignal | undefined;
		const promise = probeAccountsInParallel(
			candidates,
			async (_account, signal) => {
				observedSignal = signal;
				return never();
			},
			{ timeoutMs: 1_000 },
		);

		await vi.advanceTimersByTimeAsync(1_000);
		await promise;

		expect(observedSignal?.aborted).toBe(true);
		// The candidate's caller-visible controller stays under caller control:
		// only the per-probe linked controller is aborted by the timeout.
		expect(candidates[0].controller.signal.aborted).toBe(false);
	});

	it("a hung probe that ignores its signal still resolves via the race", async () => {
		const candidates = createProbeCandidates([
			createMockAccount(0),
			createMockAccount(1),
		]);
		const promise = probeAccountsInParallel(
			candidates,
			async (account) => {
				if (account.index === 0) return never();
				return "healthy";
			},
			{ timeoutMs: 2_000 },
		);

		const result = await promise;
		// The healthy probe wins immediately — the hung one does not need its
		// timeout to fire for the race to resolve.
		expect(result?.type).toBe("success");
		expect(result?.response).toBe("healthy");
	});

	it("all probes timing out resolves null for a multi-candidate pool", async () => {
		const candidates = createProbeCandidates([
			createMockAccount(0),
			createMockAccount(1),
		]);
		const promise = probeAccountsInParallel(candidates, never, {
			timeoutMs: 3_000,
		});

		await vi.advanceTimersByTimeAsync(3_000);
		const result = await promise;
		expect(result).toBeNull();
	});

	it("enforces maxConcurrency across the whole pool", async () => {
		// Chained microtask flushes are brittle under fake timers; the in-flight
		// assertions here are synchronous anyway.
		vi.useRealTimers();
		const candidates = createProbeCandidates([
			createMockAccount(0),
			createMockAccount(1),
			createMockAccount(2),
			createMockAccount(3),
		]);
		let inFlight = 0;
		let peak = 0;
		const release: ((payload: string | null) => void)[] = [];
		const flush = () => new Promise<void>((r) => setImmediate(r));

		const promise = probeAccountsInParallel(
			candidates,
			async () => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				return new Promise<string | null>((resolvePromise) => {
					release.push((payload) => {
						inFlight--;
						resolvePromise(payload);
					});
				});
			},
			{ maxConcurrency: 2 },
		);

		await flush();
		expect(peak).toBe(2);
		expect(release.length).toBe(2);

		// A failed slot frees capacity for the queued candidate; a success
		// would end the race instead of launching it.
		release[0](null);
		for (let i = 0; i < 10 && release.length < 3; i++) {
			await flush();
		}
		expect(release.length).toBe(3);
		expect(peak).toBe(2);

		release[1](null);
		release[2]("done");
		const result = await promise;
		expect(result?.type).toBe("success");
		expect(result?.response).toBe("done");
		expect(peak).toBe(2);
	});

	it("first success still wins under a concurrency cap and aborts the losers", async () => {
		const candidates = createProbeCandidates([
			createMockAccount(0),
			createMockAccount(1),
			createMockAccount(2),
		]);

		const result = await probeAccountsInParallel(
			candidates,
			async (account) => {
				if (account.index === 0) {
					throw new Error("slot freed by failure");
				}
				if (account.index === 1) return "queued-winner";
				return never();
			},
			{ maxConcurrency: 2 },
		);

		expect(result?.type).toBe("success");
		expect(result?.response).toBe("queued-winner");
		expect(candidates[2].controller.signal.aborted).toBe(true);
	});

	it("treats an empty (undefined) probe response as failure, not success", async () => {
		const candidates = createProbeCandidates([
			createMockAccount(0),
			createMockAccount(1),
		]);

		const result = await probeAccountsInParallel(candidates, async (account) => {
			if (account.index === 0) return undefined as unknown as string;
			return "real-response";
		});

		// The empty response must not win the race — it counts as a failure so
		// the pool continues and the real response wins.
		expect(result?.type).toBe("success");
		expect(result?.response).toBe("real-response");
	});

	it("empty response on a single candidate returns a failure ProbeResult", async () => {
		const candidates = createProbeCandidates([createMockAccount(0)]);
		const result = await probeAccountsInParallel(
			candidates,
			async () => undefined as unknown as string,
		);

		expect(result?.type).toBe("failure");
		expect(result?.error?.message).toContain("empty");
	});

	it("a synchronous probeFn throw counts as failure instead of blowing up the race", async () => {
		const candidates = createProbeCandidates([
			createMockAccount(0),
			createMockAccount(1),
		]);

		const result = await probeAccountsInParallel(candidates, (account) => {
			if (account.index === 0) throw new Error("sync boom");
			return Promise.resolve("survivor");
		});

		expect(result?.type).toBe("success");
		expect(result?.response).toBe("survivor");
	});
});
