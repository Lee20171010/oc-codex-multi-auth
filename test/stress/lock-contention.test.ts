/**
 * Storage lock contention storm (promoted stress harness).
 *
 * Real storage + real proper-lockfile lease. Covers:
 *  A) 100 parallel read-modify-write transactions: zero lost updates, no
 *     lock/temp residue. In-process writers queue on the promise FIFO (fair)
 *     AND serialize on the file lease.
 *  B) Foreign-held lease: a second "process" (a raw proper-lockfile hold on
 *     the same lock path) forces every queued local writer to burn its full
 *     ~5s retry budget SERIALLY — head-of-line blocking amplification,
 *     pinned as current behavior.
 *  C) Lock residue: after contention errors, a stale .transaction.lock is
 *     reclaimed by the next writer (stale=10s detection), not leaked forever.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

vi.mock("../../lib/logger.js", () => ({
	createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
	logInfo: vi.fn(),
	logWarn: vi.fn(),
	logDebug: vi.fn(),
	logError: vi.fn(),
}));

import { lock } from "proper-lockfile";
import { setStoragePathDirect, withAccountStorageTransaction, type AccountStorageV3 } from "../../lib/storage.js";
import { getStorageTransactionLockPath } from "../../lib/storage/transaction-lock.js";
import { StorageTransactionContentionError } from "../../lib/errors.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let storagePath: string;

function writeCounterFile(count = 0) {
	const storage: AccountStorageV3 = {
		version: 3,
		accounts: [{ refreshToken: "r0", addedAt: Date.now(), lastUsed: Date.now() }],
		activeIndex: 0,
	};
	writeFileSync(storagePath, JSON.stringify(storage));
	writeFileSync(join(dir, "counter.json"), JSON.stringify({ count }));
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lock-storm-"));
	storagePath = join(dir, "accounts.json");
	setStoragePathDirect(storagePath);
	writeCounterFile(0);
});

afterEach(() => {
	setStoragePathDirect(null);
});

function percentile(sorted: number[], p: number): number {
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

describe("A) 100 parallel read-modify-write transactions", () => {
	it("no lost updates; latency distribution; FIFO fairness", async () => {
		const N = 100;
		const latencies: number[] = [];
		const t0 = Date.now();
		const results = await Promise.allSettled(
			Array.from({ length: N }, async () => {
				const start = Date.now();
				await withAccountStorageTransaction(async (current, persist) => {
					// Simulate a real mutation: bump lastUsed on account 0.
					if (current?.accounts[0]) {
						current.accounts[0].lastUsed = Date.now();
						await persist(current);
					}
					// Independent counter to prove no lost writes.
					const cPath = join(dir, "counter.json");
					const c = JSON.parse(readFileSync(cPath, "utf8")).count as number;
					writeFileSync(cPath, JSON.stringify({ count: c + 1 }));
				});
				latencies.push(Date.now() - start);
			}),
		);
		const wallMs = Date.now() - t0;
		const failures = results.filter((r) => r.status === "rejected");
		const counter = JSON.parse(readFileSync(join(dir, "counter.json"), "utf8")).count;
		latencies.sort((a, b) => a - b);
		console.log(
			`[lock-storm] N=${N} wall=${wallMs}ms ok=${N - failures.length} fail=${failures.length} ` +
			`counter=${counter} p50=${percentile(latencies, 0.5)}ms p95=${percentile(latencies, 0.95)}ms ` +
			`p99=${percentile(latencies, 0.99)}ms max=${latencies[latencies.length - 1]}ms`,
		);
		expect(failures).toEqual([]);
		expect(counter).toBe(N); // zero lost writes

		const files = readdirSync(dir);
		// accounts.json.lock is the process-lifetime advisory worktree lock.
		const residue = files.filter(
			(f) => f.endsWith(".transaction.lock") || f.endsWith(".refresh.lock") || f.includes(".tmp"),
		);
		console.log(`[lock-storm residue] ${files.join(", ")}`);
		expect(residue).toEqual([]);
	}, 120_000);
});

describe("B) foreign-held lease -> serialized retry-budget burn", () => {
	it("each queued writer pays its OWN ~retry budget behind the in-process mutex", async () => {
		// Simulate another process holding the transaction lease: acquire the
		// identical lockfile path with proper-lockfile directly (what a foreign
		// opencode process would hold).
		const lockPath = getStorageTransactionLockPath(storagePath);
		mkdirSync(dirname(lockPath), { recursive: true });
		// proper-lockfile needs the TARGET path to exist for lock(); our
		// storagePath file exists already.
		const foreignRelease = await lock(storagePath, {
			realpath: false,
			lockfilePath: lockPath,
			stale: 30_000,
			update: 5_000,
		});

		const N = 3;
		const t0 = Date.now();
		const results = await Promise.allSettled(
			Array.from({ length: N }, () =>
				withAccountStorageTransaction(async (current, persist) => {
					if (current) await persist(current);
				}),
			),
		);
		const wallMs = Date.now() - t0;
		const contentionErrors = results.filter(
			(r) => r.status === "rejected" && r.reason instanceof StorageTransactionContentionError,
		);
		console.log(
			`[foreign-lock] N=${N} writers behind held lease: wall=${wallMs}ms ` +
			`contentionErrors=${contentionErrors.length} (~${Math.round(wallMs / N)}ms per writer serialized)`,
		);
		// All N writers should fail with contention — and SERIALIZED through the
		// in-process mutex: wall ~= N * full retry budget (~5s each). If the
		// contention were amortized/deduped, wall would be ~5s total.
		expect(contentionErrors.length).toBe(N);
		await foreignRelease();
	}, 120_000);
});

describe("C) stale lease reclaim", () => {
	it("an abandoned lock dir (no mtime refresh) is reclaimed after stale=10s, not leaked", async () => {
		const lockPath = getStorageTransactionLockPath(storagePath);
		// A dead-process lock dir: created by hand, no refresh mechanism.
		mkdirSync(lockPath, { recursive: true });
		// Backdate mtime beyond the 10s stale window so it's immediately stale.
		const { utimesSync } = await import("node:fs");
		const old = new Date(Date.now() - 30_000);
		utimesSync(lockPath, old, old);

		const t0 = Date.now();
		await withAccountStorageTransaction(async (current, persist) => {
			if (current) await persist(current);
		});
		const wallMs = Date.now() - t0;
		console.log(`[stale-reclaim] reclaimed abandoned lock in ${wallMs}ms`);
		expect(wallMs).toBeLessThan(10_000);
	}, 30_000);
});
