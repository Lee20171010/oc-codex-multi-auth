/**
 * Cross-store refresh-token rotation propagation.
 *
 * The main account store and the flagged quarantine store each keep their own
 * copy of an account — including the same single-use refresh token. Before the
 * propagation step existed, whichever side refreshed first consumed the token
 * and the OTHER side kept the dead copy; the sibling's next refresh then
 * exchanged `refresh_token_reused` upstream and the account was flagged until
 * the user logged in again.
 *
 * `coordinated-refresh.ts` now runs a second, best-effort transaction on the
 * sibling store after the primary commit (still inside the refresh lease, so
 * no competing process can exchange the consumed token in between). This file
 * pins both directions plus the failure contracts:
 *
 *   - main -> flagged: a flagged record holding the consumed token must be
 *     rewritten to the rotated one;
 *   - flagged -> main: symmetric;
 *   - the important regression order: flagged holds the OLD token, the main
 *     store refreshes first, and the flagged refresh afterwards must exchange
 *     the ROTATED token, never re-present the consumed one;
 *   - propagation is best-effort: a sibling-write failure warns but the
 *     committed refresh still reports success;
 *   - the member-id guard: a sibling record that names a different member
 *     must not be touched (it belongs to a different seat's grant).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TokenResult } from "../lib/types.js";

vi.mock("../lib/refresh-queue.js", () => ({
	queuedRefresh: vi.fn(),
}));

// Partial mock: every export stays the real implementation except
// withFlaggedAccountStorageTransaction, which is wrapped so a test can fail
// exactly the sibling-store leg of coordinatePersistedRefresh.
vi.mock("../lib/storage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/storage.js")>();
	return {
		...actual,
		withFlaggedAccountStorageTransaction: vi.fn(
			actual.withFlaggedAccountStorageTransaction,
		),
	};
});

import { queuedRefresh } from "../lib/refresh-queue.js";
import {
	coordinatePersistedRefresh,
	coordinateFlaggedPersistedRefresh,
	type PersistedRefreshIdentity,
} from "../lib/storage/coordinated-refresh.js";
import {
	loadAccounts,
	loadFlaggedAccounts,
	saveAccounts,
	saveFlaggedAccounts,
	setStoragePathDirect,
	withFlaggedAccountStorageTransaction,
} from "../lib/storage.js";

const FAR_FUTURE = 4_000_000_000_000;

const identity: PersistedRefreshIdentity = {
	organizationId: "org-1",
	accountId: "ws-1",
	accountUserId: "member-1",
	refreshToken: "r0",
};

async function allocateStorageDir(): Promise<string> {
	const dir = join(
		tmpdir(),
		`rotation-propagation-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

async function seedMainStore(refreshToken = "r0"): Promise<void> {
	await saveAccounts({
		version: 3,
		activeIndex: 0,
		accounts: [
			{
				refreshToken,
				organizationId: identity.organizationId,
				accountId: identity.accountId,
				accountUserId: identity.accountUserId,
				accessToken: "a0",
				expiresAt: 0,
				addedAt: 1,
				lastUsed: 1,
			},
		],
	});
}

async function seedFlaggedStore(
	refreshes: Array<{
		refreshToken: string;
		accountUserId?: string;
		accountId?: string;
	}> = [{ refreshToken: "r0", accountUserId: "member-1", accountId: "ws-1" }],
): Promise<void> {
	await saveFlaggedAccounts({
		version: 1,
		accounts: refreshes.map((entry) => ({
			refreshToken: entry.refreshToken,
			organizationId: identity.organizationId,
			accountId: entry.accountId ?? identity.accountId,
			accountUserId: entry.accountUserId,
			addedAt: 1,
			lastUsed: 1,
			flaggedAt: 1,
		})),
	});
}

function exchangeResult(access: string, refresh: string): TokenResult {
	return {
		type: "success",
		access,
		refresh,
		expires: FAR_FUTURE,
	};
}

describe("cross-store rotation propagation", () => {
	let storageDir: string;

	beforeEach(async () => {
		vi.mocked(queuedRefresh).mockReset();
		// mockClear keeps the delegate-to-original implementation set by the
		// vi.mock factory; mockImplementationOnce failures are consumed per call
		// and do not leak across tests.
		vi.mocked(withFlaggedAccountStorageTransaction).mockClear();
		storageDir = await allocateStorageDir();
		setStoragePathDirect(join(storageDir, "accounts.json"));
	});

	afterEach(async () => {
		setStoragePathDirect(null);
		try {
			await fs.rm(storageDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("propagates a main-store rotation into the flagged store", async () => {
		await seedMainStore("r0");
		await seedFlaggedStore();
		vi.mocked(queuedRefresh).mockResolvedValue(exchangeResult("a1", "r1"));

		const result = await coordinatePersistedRefresh(identity);
		expect(result.type).toBe("success");
		expect(vi.mocked(queuedRefresh)).toHaveBeenCalledWith("r0");

		const main = await loadAccounts();
		expect(main?.accounts[0]?.refreshToken).toBe("r1");

		const flagged = await loadFlaggedAccounts();
		expect(flagged.accounts[0]?.refreshToken).toBe("r1");
		expect(flagged.accounts[0]?.tokenRotatedAt).toBe(
			result.type === "success" ? result.rotatedAt : undefined,
		);
	});

	it("propagates a flagged-store rotation into the main store", async () => {
		await seedMainStore("r0");
		await seedFlaggedStore();
		vi.mocked(queuedRefresh).mockResolvedValue(exchangeResult("a1", "r1"));

		const result = await coordinateFlaggedPersistedRefresh(identity);
		expect(result.type).toBe("success");
		expect(vi.mocked(queuedRefresh)).toHaveBeenCalledWith("r0");

		const flagged = await loadFlaggedAccounts();
		expect(flagged.accounts[0]?.refreshToken).toBe("r1");

		const main = await loadAccounts();
		expect(main?.accounts[0]?.refreshToken).toBe("r1");
		// The sibling copy never inherits the exchange's access token — only
		// the rotated refresh token plus an expired-access marker so the seat
		// re-derives its own workspace-scoped token on next use.
		expect(main?.accounts[0]?.expiresAt).toBe(0);
		expect(main?.accounts[0]?.tokenRotatedAt).toBe(
			result.type === "success" ? result.rotatedAt : undefined,
		);
	});

	it("a flagged refresh after a main-side rotation exchanges the rotated token, not the consumed one", async () => {
		await seedMainStore("r0");
		// The flagged copy still holds r0 — the pre-propagation state where a
		// second exchange of the consumed token would be the failure.
		await seedFlaggedStore();
		vi.mocked(queuedRefresh).mockImplementation(async (token: string) => {
			if (token === "r0") return exchangeResult("a1", "r1");
			if (token === "r1") return exchangeResult("a2", "r2");
			return { type: "failed", reason: "refresh_token_reused" } as TokenResult;
		});

		const mainRefresh = await coordinatePersistedRefresh(identity);
		expect(mainRefresh.type).toBe("success");
		// Propagation must have moved the flagged copy off the consumed token.
		expect((await loadFlaggedAccounts()).accounts[0]?.refreshToken).toBe("r1");

		const flaggedRefresh = await coordinateFlaggedPersistedRefresh(identity);
		expect(flaggedRefresh.type).toBe("success");

		// Two exchanges total: r0 then r1. A re-presentation of the consumed
		// r0 — what happens without propagation — is the bug this pins.
		const exchanged = vi.mocked(queuedRefresh).mock.calls.map(([token]) => token);
		expect(exchanged).toEqual(["r0", "r1"]);

		expect((await loadFlaggedAccounts()).accounts[0]?.refreshToken).toBe("r2");
		// And the rotation propagates back to the main store too.
		expect((await loadAccounts())?.accounts[0]?.refreshToken).toBe("r2");
	});

	it("a transient sibling-store write failure is retried under the lease and still heals", async () => {
		// A propagation failure that leaves the sibling holding the consumed
		// token sets up `refresh_token_reused` on its next exchange. The
		// propagation leg is retried once while the refresh lease is still
		// held — idempotent, and no competitor can interleave — so a
		// one-off transaction failure no longer strands the sibling
		// (greptile P1 on PR #275).
		await seedMainStore("r0");
		await seedFlaggedStore();
		vi.mocked(queuedRefresh).mockResolvedValue(exchangeResult("a1", "r1"));

		vi.mocked(withFlaggedAccountStorageTransaction).mockImplementationOnce(
			async () => {
				throw new Error("sibling store unavailable");
			},
		);

		const result = await coordinatePersistedRefresh(identity);
		expect(result.type).toBe("success");

		const main = await loadAccounts();
		expect(main?.accounts[0]?.refreshToken).toBe("r1");
		// The retry healed the sibling copy instead of leaving it consumed.
		expect((await loadFlaggedAccounts()).accounts[0]?.refreshToken).toBe("r1");
		// Two flagged transactions total: the failed attempt and the retry.
		expect(vi.mocked(withFlaggedAccountStorageTransaction)).toHaveBeenCalledTimes(2);
	});

	it("a persistent sibling-store write failure stays best-effort: the committed refresh still succeeds", async () => {
		await seedMainStore("r0");
		await seedFlaggedStore();
		vi.mocked(queuedRefresh).mockResolvedValue(exchangeResult("a1", "r1"));

		// Fail BOTH propagation attempts — the contract only hardens against
		// transient failure; a persistently unavailable sibling still reports
		// the committed refresh as success.
		vi.mocked(withFlaggedAccountStorageTransaction)
			.mockImplementationOnce(async () => {
				throw new Error("sibling store unavailable");
			})
			.mockImplementationOnce(async () => {
				throw new Error("sibling store unavailable");
			});

		const result = await coordinatePersistedRefresh(identity);
		expect(result.type).toBe("success");

		const main = await loadAccounts();
		expect(main?.accounts[0]?.refreshToken).toBe("r1");
		expect((await loadFlaggedAccounts()).accounts[0]?.refreshToken).toBe("r0");
		expect(vi.mocked(withFlaggedAccountStorageTransaction)).toHaveBeenCalledTimes(2);
	});

	it("does not touch a flagged record that names a different member", async () => {
		await seedMainStore("r0");
		// Two flagged records sharing the consumed token: one for our seat, one
		// for a different member whose grant must not be overwritten.
		await seedFlaggedStore([
			{ refreshToken: "r0", accountUserId: "member-1", accountId: "ws-1" },
			{ refreshToken: "r0", accountUserId: "member-2", accountId: "ws-2" },
		]);
		vi.mocked(queuedRefresh).mockResolvedValue(exchangeResult("a1", "r1"));

		const result = await coordinatePersistedRefresh(identity);
		expect(result.type).toBe("success");

		const flagged = await loadFlaggedAccounts();
		const ours = flagged.accounts.find((a) => a.accountUserId === "member-1");
		const otherSeat = flagged.accounts.find((a) => a.accountUserId === "member-2");
		expect(ours?.refreshToken).toBe("r1");
		expect(otherSeat?.refreshToken).toBe("r0");
	});
});
