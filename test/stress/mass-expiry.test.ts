/**
 * Mass-expiry thundering herd (promoted stress harness).
 *
 * Real storage on the vitest sandbox HOME. Mocks only the provider exchange
 * (`refreshAccessToken`); everything else — proper-lockfile refresh lease,
 * storage transaction mutex, atomic writes, sibling propagation — is real.
 *
 * Proves:
 *  A) N concurrent coordinatePersistedRefresh on the SAME expired account ->
 *     exactly 1 provider exchange; N-1 callers adopt the committed rotation.
 *  B) The refresh lease is FILE-scoped: 20 distinct accounts expiring together
 *     serialize ALL 20 exchanges (each holds the lease across a network RTT).
 *     Correctness holds (exactly 1 exchange/token) but latency = sum of RTTs.
 *  C) A same-account stampede does not double-penalize: callers either get the
 *     fresh token or a retryable contention error — never a burnt token.
 *  D) No lease or temp-file residue is left behind after the storm.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

vi.mock("../../lib/auth/auth.js", () => ({
	refreshAccessToken: vi.fn(),
	decodeJWT: vi.fn(() => null), // fake access tokens carry no claims
}));
vi.mock("../../lib/logger.js", () => ({
	createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
	logInfo: vi.fn(),
	logWarn: vi.fn(),
	logDebug: vi.fn(),
	logError: vi.fn(),
}));

import * as authModule from "../../lib/auth/auth.js";
import { setStoragePathDirect, loadAccounts, type AccountStorageV3 } from "../../lib/storage.js";
import { coordinatePersistedRefresh } from "../../lib/storage/coordinated-refresh.js";
import { refreshExpiringAccounts } from "../../lib/proactive-refresh.js";
import { resetRefreshQueue } from "../../lib/refresh-queue.js";
import type { ManagedAccount } from "../../lib/accounts/state.js";
import type { TokenResult } from "../../lib/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let storagePath: string;
let upstreamCalls: { token: string; at: number }[] = [];
let exchangeLatency = 40;
let inFlight = 0;
let maxInFlight = 0;

function writePool(n: number, opts: { expired?: boolean; sharedToken?: string } = {}) {
	const accounts = Array.from({ length: n }, (_, i) => ({
		accountId: `acct-${i}`,
		organizationId: `org-${i}`,
		accountUserId: `user-${i}`,
		email: `user${i}@example.com`,
		refreshToken: opts.sharedToken ?? `R-${i}`,
		accessToken: `stale-access-${i}`,
		expiresAt: opts.expired === false ? Date.now() + 3_600_000 : Date.now() - 1_000,
		addedAt: Date.now(),
		lastUsed: Date.now(),
	}));
	const storage: AccountStorageV3 = { version: 3, accounts, activeIndex: 0 };
	mkdirSync(dirname(storagePath), { recursive: true });
	writeFileSync(storagePath, JSON.stringify(storage));
	return accounts;
}

function mockExchange() {
	vi.mocked(authModule.refreshAccessToken).mockImplementation(async (token: string) => {
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		upstreamCalls.push({ token, at: Date.now() });
		await sleep(exchangeLatency);
		inFlight -= 1;
		const result: TokenResult = {
			type: "success",
			access: `fresh-access-for-${token}`,
			refresh: `${token}-rotated`,
			expires: Date.now() + 3_600_000,
		};
		return result;
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	resetRefreshQueue();
	dir = mkdtempSync(join(tmpdir(), "stampede-storage-"));
	storagePath = join(dir, "accounts.json");
	setStoragePathDirect(storagePath);
	upstreamCalls = [];
	exchangeLatency = 40;
	inFlight = 0;
	maxInFlight = 0;
	mockExchange();
});

afterEach(() => {
	setStoragePathDirect(null);
	resetRefreshQueue();
});

describe("A) same-account stampede — 50 concurrent refreshers, 1 exchange", () => {
	it("coalesces to exactly one provider exchange; rest adopt", async () => {
		const [a] = writePool(1);
		const identity = {
			refreshToken: a!.refreshToken,
			accountId: a!.accountId,
			organizationId: a!.organizationId,
			accountUserId: a!.accountUserId,
		};
		const N = 50;
		const t0 = Date.now();
		const results = await Promise.allSettled(
			Array.from({ length: N }, () => coordinatePersistedRefresh(identity)),
		);
		const wallMs = Date.now() - t0;

		const succeeded = results.filter((r) => r.status === "fulfilled" && r.value.type === "success");
		const failed = results.filter((r) => r.status === "rejected" || (r.status === "fulfilled" && r.value.type !== "success"));

		expect(upstreamCalls.length).toBe(1);
		expect(upstreamCalls[0]!.token).toBe("R-0");
		// Every caller succeeded — adoption path served the other 49.
		expect(succeeded.length).toBe(N);
		expect(failed.length).toBe(0);
		// Adopters got the committed rotated token, not their stale R-0.
		for (const r of succeeded) {
			if (r.status === "fulfilled" && r.value.type === "success") {
				expect(r.value.refresh).toBe("R-0-rotated");
			}
		}
		// Adoption serializes under the same lease; log for the report.
		console.log(`[mass-expiry A] N=${N} same-account refresh: wall=${wallMs}ms upstream=${upstreamCalls.length}`);
		expect(maxInFlight).toBe(1);
	}, 90_000);
});

describe("B) 20-account mass expiry — file-scoped lease serializes everything", () => {
	it("exactly 1 exchange per token; all 20 committed; serialization measured", async () => {
		const accounts = writePool(20);
		// Drive the proactive-refresh path the way refreshExpiringAccounts does.
		const managed: ManagedAccount[] = accounts.map((a, i) => ({
			index: i,
			refreshToken: a.refreshToken,
			access: a.accessToken,
			expires: a.expiresAt,
			accountId: a.accountId,
			organizationId: a.organizationId,
			accountUserId: a.accountUserId,
			email: a.email,
			addedAt: a.addedAt,
			lastUsed: a.lastUsed,
			rateLimitResetTimes: {},
		}));

		exchangeLatency = 30;
		const t0 = Date.now();
		const results = await refreshExpiringAccounts(managed, 0);
		const wallMs = Date.now() - t0;

		expect(results.size).toBe(20);
		// Exactly one exchange per distinct token — no account double-exchanged.
		expect(upstreamCalls.length).toBe(20);
		const perToken = new Map<string, number>();
		for (const c of upstreamCalls) perToken.set(c.token, (perToken.get(c.token) ?? 0) + 1);
		for (const [, count] of perToken) expect(count).toBe(1);
		for (let i = 0; i < 20; i++) {
			expect(perToken.has(`R-${i}`)).toBe(true);
			expect(results.get(i)?.reason).toBe("success");
		}
		// The file-scoped refresh lease serializes exchanges ACROSS accounts:
		// even though refreshExpiringAccounts runs them "in parallel", no two
		// provider calls overlap. Latency ~= serial march: 20 * (RTT + 2 txns).
		console.log(`[mass-expiry B] 20 accts: wall=${wallMs}ms upstream=${upstreamCalls.length} maxInFlight=${maxInFlight} (serialization proof)`);
		expect(maxInFlight).toBe(1);

		// Final storage: all rotated, all consistent.
		const stored = await loadAccounts();
		expect(stored?.accounts.length).toBe(20);
		for (const acc of stored!.accounts) {
			expect(acc.refreshToken.endsWith("-rotated")).toBe(true);
			expect(acc.expiresAt).toBeGreaterThan(Date.now());
		}
	}, 60_000);
});

describe("C) mixed stampede — distinct accounts + same-account burst", () => {
	it("same-token callers adopt; distinct tokens each exchange once", async () => {
		const accounts = writePool(5);
		// 5 distinct accounts; 10 concurrent refreshers each = 50 callers.
		const t0 = Date.now();
		const results = await Promise.allSettled(
			accounts.flatMap((a) =>
				Array.from({ length: 10 }, () =>
					coordinatePersistedRefresh({
						refreshToken: a.refreshToken,
						accountId: a.accountId,
						organizationId: a.organizationId,
						accountUserId: a.accountUserId,
					}),
				),
			),
		);
		const wallMs = Date.now() - t0;

		expect(upstreamCalls.length).toBe(5); // one per distinct token
		for (const r of results) {
			expect(r.status).toBe("fulfilled");
			if (r.status === "fulfilled") expect(r.value.type).toBe("success");
		}
		console.log(`[mass-expiry C] 5x10 burst: wall=${wallMs}ms upstream=${upstreamCalls.length} maxInFlight=${maxInFlight}`);
		expect(maxInFlight).toBe(1);
	}, 60_000);
});

describe("D) lock residue check", () => {
	it("leaves no *.lock dirs or *.tmp files behind after the storm", async () => {
		const accounts = writePool(3);
		await Promise.all(
			Array.from({ length: 10 }, (_, i) => {
				const a = accounts[i % 3]!;
				return coordinatePersistedRefresh({
					refreshToken: a.refreshToken,
					accountId: a.accountId,
					organizationId: a.organizationId,
					accountUserId: a.accountUserId,
				});
			}),
		);
		const files = readdirSync(dir);
		// `accounts.json.lock` is the worktree ADVISORY lock — deliberately held
		// for the process lifetime and only removed by the shutdown cleanup
		// hook (worktree-lock.ts). What must never linger: the transaction and
		// refresh lease dirs and atomic-write temp files.
		const residue = files.filter(
			(f) => f.endsWith(".transaction.lock") || f.endsWith(".refresh.lock") || f.includes(".tmp"),
		);
		console.log(`[residue] dir contents: ${files.join(", ")}`);
		expect(residue).toEqual([]);
	});
});
