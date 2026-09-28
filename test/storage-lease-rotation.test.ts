/**
 * Exchange→commit gap recovery for coordinated refresh.
 *
 * The provider consumes the single-use refresh token the moment an exchange is
 * processed; the replacement only becomes durable when the commit lands. Two
 * defects lived in that gap:
 *
 *   - a primary commit that misses because the record moved to the sibling
 *     store mid-exchange used to throw BEFORE the sibling propagation ran, so
 *     the rotated credential died in memory while both stores kept the
 *     consumed token — every later refresh took `refresh_token_reused`;
 *   - a SIGKILL between the exchange and the commit left no trace the next
 *     process could recover from.
 *
 * `coordinated-refresh.ts` now journals the consumed→rotated mapping to
 * `<accounts>.refresh.pending` right after the exchange, replays it at the
 * head of the next refresh lease, and — when the commit cannot land — salvages
 * the rotated token onto every record still holding the consumed one in BOTH
 * stores instead of throwing the credential away.
 *
 * The tail of this file pins the boundary conditions a mutation audit keeps
 * alive: seat-key only resolution, unique-match cardinality, the token-only
 * fallback, the `expiresAt` adopt boundary, the `Math.max(Date.now(), ...)`
 * rotation-stamp floor, the in-file sibling loop, the commit retry budget,
 * the member guard, and the `updated > 0` no-op persist check.
 */

import {
	access,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/refresh-queue.js", () => ({
	queuedRefresh: vi.fn(),
}));

let realStorage!: typeof import("../lib/storage.js");

// Partial mock: every export stays the real implementation; the transaction
// wrappers are vi.fn delegating so a test can inject persist failures or count
// writes into a specific store.
vi.mock("../lib/storage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/storage.js")>();
	return {
		...actual,
		withAccountStorageTransaction: vi.fn(actual.withAccountStorageTransaction),
		withFlaggedAccountStorageTransaction: vi.fn(
			actual.withFlaggedAccountStorageTransaction,
		),
	};
});

import { queuedRefresh } from "../lib/refresh-queue.js";
import { StorageTransactionContentionError } from "../lib/errors.js";
import {
	coordinateFlaggedPersistedRefresh,
	coordinatePersistedRefresh,
	type CoordinatedRefreshResult,
	type CoordinatedRefreshSuccess,
	type PersistedRefreshIdentity,
} from "../lib/storage/coordinated-refresh.js";
import {
	getFlaggedAccountsPath,
	loadAccounts,
	loadFlaggedAccounts,
	saveAccounts,
	saveFlaggedAccounts,
	setStoragePathDirect,
	withAccountStorageTransaction,
	withFlaggedAccountStorageTransaction,
} from "../lib/storage.js";
import type { FlaggedAccountMetadataV1 } from "../lib/storage/flagged.js";
import type { AccountMetadataV3 } from "../lib/storage/migrations.js";
import type { TokenResult } from "../lib/types.js";

const FAR_FUTURE = 4_000_000_000_000;

const identity: PersistedRefreshIdentity = {
	organizationId: "org-1",
	accountId: "ws-1",
	accountUserId: "member-1",
	refreshToken: "r0",
};

function exchangeResult(access: string, refresh: string): TokenResult {
	return { type: "success", access, refresh, expires: FAR_FUTURE };
}

function expectRefreshSuccess(
	result: CoordinatedRefreshResult,
): asserts result is CoordinatedRefreshSuccess {
	if (result.type !== "success") {
		throw new Error(`Expected a successful refresh, got ${result.type}`);
	}
}

function accountFixture(
	overrides: Partial<AccountMetadataV3> & { refreshToken: string },
): AccountMetadataV3 {
	return { addedAt: 1, lastUsed: 1, ...overrides };
}

function flaggedFixture(
	overrides: Partial<FlaggedAccountMetadataV1> & { refreshToken: string },
): FlaggedAccountMetadataV1 {
	return { addedAt: 1, lastUsed: 1, flaggedAt: 1, ...overrides };
}

beforeAll(async () => {
	// `vi.importActual` bypasses the partial mock above so the injected-failure
	// wrappers can delegate to the genuine transaction functions.
	realStorage = await vi.importActual<typeof import("../lib/storage.js")>(
		"../lib/storage.js",
	);
});

/** Move the first main-store record into the flagged store — what a quarantine does. */
async function moveFirstAccountToFlagged(): Promise<void> {
	let moved: AccountMetadataV3 | undefined;
	await realStorage.withAccountStorageTransaction(async (current, persist) => {
		moved = current?.accounts.splice(0, 1)[0];
		if (current) await persist(current);
	});
	await realStorage.withFlaggedAccountStorageTransaction(async (current, persist) => {
		if (moved) {
			current.accounts.push({ ...moved, flaggedAt: Date.now() });
			await persist(current);
		}
	});
}

/** Move the first flagged record into the main store — what a reactivation does. */
async function moveFirstFlaggedToMain(): Promise<void> {
	let moved: FlaggedAccountMetadataV1 | undefined;
	await realStorage.withFlaggedAccountStorageTransaction(async (current, persist) => {
		moved = current.accounts.splice(0, 1)[0];
		await persist(current);
	});
	await realStorage.withAccountStorageTransaction(async (current, persist) => {
		if (current && moved) {
			current.accounts.push(
				accountFixture({
					refreshToken: moved.refreshToken,
					organizationId: moved.organizationId,
					accountId: moved.accountId,
					accountUserId: moved.accountUserId,
					accessToken: "a0",
					expiresAt: 0,
				}),
			);
			await persist(current);
		}
	});
}

describe("exchange→commit gap recovery", () => {
	let storageDir: string;
	let storagePath: string;
	let journalPath: string;

	beforeEach(async () => {
		vi.mocked(queuedRefresh).mockReset();
		vi.mocked(withAccountStorageTransaction).mockImplementation(
			realStorage.withAccountStorageTransaction,
		);
		vi.mocked(withFlaggedAccountStorageTransaction).mockImplementation(
			realStorage.withFlaggedAccountStorageTransaction,
		);
		storageDir = await mkdtemp(join(tmpdir(), "oc-codex-rotation-gap-"));
		storagePath = join(storageDir, "accounts.json");
		journalPath = `${storagePath}.refresh.pending`;
		setStoragePathDirect(storagePath);
	});

	afterEach(async () => {
		vi.useRealTimers();
		setStoragePathDirect(null);
		await rm(storageDir, { recursive: true, force: true });
	});

	it("replays a leftover journal before spending a possibly-consumed token", async () => {
		// given a predecessor that exchanged r0→rx and died before committing:
		// the store still carries r0 and only the journal knows rx is live
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				accountFixture({
					refreshToken: "r0",
					organizationId: "org-1",
					accountId: "ws-1",
					accountUserId: "member-1",
					accessToken: "a0",
					expiresAt: 0,
				}),
			],
		});
		await writeFile(
			journalPath,
			JSON.stringify({
				version: 1,
				consumedRefreshToken: "r0",
				rotatedRefreshToken: "rx",
				memberId: "member-1",
				recordedAt: 1,
			}),
		);
		vi.mocked(queuedRefresh).mockImplementation(async (token: string) => {
			if (token === "rx") return exchangeResult("aX", "rY");
			return { type: "failed", reason: "refresh_token_reused" } as TokenResult;
		});

		// when
		const result = await coordinatePersistedRefresh(identity);
		expectRefreshSuccess(result);

		// then the healed token was exchanged — never the consumed one
		expect(vi.mocked(queuedRefresh).mock.calls.map(([token]) => token)).toEqual([
			"rx",
		]);
		expect((await loadAccounts())?.accounts[0]?.refreshToken).toBe("rY");
		// and the journal was consumed
		await expect(access(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("discards a malformed journal instead of letting it poison every refresh", async () => {
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				accountFixture({
					refreshToken: "r0",
					organizationId: "org-1",
					accountId: "ws-1",
					accountUserId: "member-1",
					accessToken: "a0",
					expiresAt: 0,
				}),
			],
		});
		await writeFile(journalPath, "not-json{{{");
		vi.mocked(queuedRefresh).mockResolvedValue(exchangeResult("a1", "r1"));

		const result = await coordinatePersistedRefresh(identity);
		expectRefreshSuccess(result);

		await expect(access(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("removes the journal once a rotation is committed and propagated", async () => {
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				accountFixture({
					refreshToken: "r0",
					organizationId: "org-1",
					accountId: "ws-1",
					accountUserId: "member-1",
					accessToken: "a0",
					expiresAt: 0,
				}),
			],
		});
		vi.mocked(queuedRefresh).mockResolvedValue(exchangeResult("a1", "r1"));

		const result = await coordinatePersistedRefresh(identity);
		expectRefreshSuccess(result);

		await expect(access(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("salvages the rotated token when the record moved to the flagged store mid-exchange", async () => {
		// given a quarantine that lands between the exchange and the commit —
		// the exact run-flag-race window
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				accountFixture({
					refreshToken: "r0",
					organizationId: "org-1",
					accountId: "ws-1",
					accountUserId: "member-1",
					accessToken: "a0",
					expiresAt: 0,
				}),
			],
		});
		await saveFlaggedAccounts({ version: 1, accounts: [] });
		vi.mocked(queuedRefresh).mockImplementation(async () => {
			await moveFirstAccountToFlagged();
			return exchangeResult("a1", "r1");
		});

		// when
		const result = await coordinatePersistedRefresh(identity);
		expectRefreshSuccess(result);

		// then the live credential reaches the caller and the flagged copy that
		// still held the consumed r0 receives the rotation
		expect(result.refresh).toBe("r1");
		const flagged = await loadFlaggedAccounts();
		expect(flagged.accounts[0]?.refreshToken).toBe("r1");
		expect((await loadAccounts())?.accounts).toHaveLength(0);
		// and the journal is left for the next refresh to confirm the heal —
		// now named with a per-token suffix rather than the legacy bare path
		const pendingJournals = (await readdir(storageDir)).filter((name) =>
			name.startsWith("accounts.json.refresh.pending"),
		);
		expect(pendingJournals).toHaveLength(1);

		// a follow-up flagged refresh sees the healed copy and works normally
		vi.mocked(queuedRefresh).mockImplementation(async (token: string) =>
			token === "r1"
				? exchangeResult("a2", "r2")
				: ({ type: "failed", reason: "refresh_token_reused" } as TokenResult),
		);
		const followUp = await coordinateFlaggedPersistedRefresh(identity);
		expectRefreshSuccess(followUp);
		expect(vi.mocked(queuedRefresh).mock.calls.map(([token]) => token)).toEqual([
			"r0",
			"r1",
		]);
		expect((await loadFlaggedAccounts()).accounts[0]?.refreshToken).toBe("r2");
		expect(
			(await readdir(storageDir)).filter((name) =>
				name.startsWith("accounts.json.refresh.pending"),
			),
		).toEqual([]);
	});

	it("salvages the rotated token when the record moved to the main store mid-exchange", async () => {
		// the symmetric direction: a flagged refresh whose record got reactivated
		await saveFlaggedAccounts({
			version: 1,
			accounts: [
				flaggedFixture({
					refreshToken: "r0",
					organizationId: "org-1",
					accountId: "ws-1",
					accountUserId: "member-1",
				}),
			],
		});
		await saveAccounts({ version: 3, activeIndex: 0, accounts: [] });
		vi.mocked(queuedRefresh).mockImplementation(async () => {
			await moveFirstFlaggedToMain();
			return exchangeResult("a1", "r1");
		});

		const result = await coordinateFlaggedPersistedRefresh(identity);
		expectRefreshSuccess(result);

		expect((await loadAccounts())?.accounts[0]?.refreshToken).toBe("r1");
		expect((await loadFlaggedAccounts()).accounts).toHaveLength(0);
	});

	it("keeps the member guard while salvaging — a different seat's record is untouched", async () => {
		// given a flagged store that already holds ANOTHER member sharing the
		// same consumed token (two seats of one grant land there independently)
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				accountFixture({
					refreshToken: "r0",
					organizationId: "org-1",
					accountId: "ws-1",
					accountUserId: "member-1",
					accessToken: "a0",
					expiresAt: 0,
				}),
			],
		});
		await saveFlaggedAccounts({
			version: 1,
			accounts: [
				flaggedFixture({
					refreshToken: "r0",
					organizationId: "org-1",
					accountId: "ws-2",
					accountUserId: "member-2",
				}),
			],
		});
		vi.mocked(queuedRefresh).mockImplementation(async () => {
			await moveFirstAccountToFlagged();
			return exchangeResult("a1", "r1");
		});

		const result = await coordinatePersistedRefresh(identity);
		expectRefreshSuccess(result);

		const flagged = await loadFlaggedAccounts();
		const ours = flagged.accounts.find((a) => a.accountUserId === "member-1");
		const otherSeat = flagged.accounts.find((a) => a.accountUserId === "member-2");
		expect(ours?.refreshToken).toBe("r1");
		expect(otherSeat?.refreshToken).toBe("r0");
	});

	it("retries the commit, then salvages when every attempt misses", async () => {
		// given a commit path that loses the storage lease on every attempt —
		// COMMIT_ATTEMPTS is three, so the salvage persist is the fourth call
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				accountFixture({
					refreshToken: "r0",
					organizationId: "org-1",
					accountId: "ws-1",
					accountUserId: "member-1",
					accessToken: "a0",
					expiresAt: 0,
				}),
			],
		});
		await saveFlaggedAccounts({ version: 1, accounts: [] });
		vi.mocked(queuedRefresh).mockResolvedValue(exchangeResult("a1", "r1"));

		let persistCalls = 0;
		let remainingFailures = 3;
		vi.mocked(withAccountStorageTransaction).mockImplementation((handler) =>
			realStorage.withAccountStorageTransaction(async (current, persist) =>
				handler(current, async (storage) => {
					persistCalls += 1;
					if (remainingFailures > 0) {
						remainingFailures -= 1;
						throw new StorageTransactionContentionError(
							storagePath,
							new Error("injected lease contention"),
						);
					}
					await persist(storage);
				}),
			),
		);

		const result = await coordinatePersistedRefresh(identity);
		expectRefreshSuccess(result);

		// then all three commit attempts ran, then the salvage stamped r1 with an
		// expired-access marker — a full commit (access token + expiry) is proof
		// a fourth commit attempt slipped through an off-by-one
		expect(result.refresh).toBe("r1");
		expect(result.rotatedAt).toBeUndefined();
		expect(persistCalls).toBe(4);
		const stored = await loadAccounts();
		expect(stored?.accounts[0]?.refreshToken).toBe("r1");
		expect(stored?.accounts[0]?.expiresAt).toBe(0);
	});

	it("does not persist the sibling store when nothing there holds the consumed token", async () => {
		// given a flagged store whose only record carries an unrelated token
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				accountFixture({
					refreshToken: "r0",
					organizationId: "org-1",
					accountId: "ws-1",
					accountUserId: "member-1",
					accessToken: "a0",
					expiresAt: 0,
				}),
			],
		});
		await saveFlaggedAccounts({
			version: 1,
			accounts: [
				flaggedFixture({
					refreshToken: "unrelated",
					organizationId: "org-9",
					accountId: "ws-9",
					accountUserId: "member-9",
				}),
			],
		});
		vi.mocked(queuedRefresh).mockResolvedValue(exchangeResult("a1", "r1"));

		let flaggedPersists = 0;
		vi.mocked(withFlaggedAccountStorageTransaction).mockImplementation(
			(handler) =>
				realStorage.withFlaggedAccountStorageTransaction(
					async (current, persist) =>
						handler(current, async (storage) => {
							flaggedPersists += 1;
							await persist(storage);
						}),
				),
		);
		const before = await readFile(getFlaggedAccountsPath(), "utf8");

		const result = await coordinatePersistedRefresh(identity);
		expectRefreshSuccess(result);

		// no record matched, so no write must land — an `updated >= 0` no-op
		// persist would still churn the file
		expect(flaggedPersists).toBe(0);
		expect(await readFile(getFlaggedAccountsPath(), "utf8")).toBe(before);
	});
});

describe("refresh-target mutation boundaries", () => {
	let storageDir: string;
	let storagePath: string;

	beforeEach(async () => {
		vi.mocked(queuedRefresh).mockReset();
		vi.mocked(withAccountStorageTransaction).mockImplementation(
			realStorage.withAccountStorageTransaction,
		);
		vi.mocked(withFlaggedAccountStorageTransaction).mockImplementation(
			realStorage.withFlaggedAccountStorageTransaction,
		);
		storageDir = await mkdtemp(join(tmpdir(), "oc-codex-targeting-"));
		storagePath = join(storageDir, "accounts.json");
		setStoragePathDirect(storagePath);
	});

	afterEach(async () => {
		vi.useRealTimers();
		setStoragePathDirect(null);
		await rm(storageDir, { recursive: true, force: true });
	});

	it("does not widen a missed seat match to another seat's record", async () => {
		// given only a DIFFERENT seat in the same org, holding the same token —
		// the seat key resolves to nothing and the refresh must fail rather
		// than fall through to the org key and overwrite member-2's credential
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				accountFixture({
					refreshToken: "r0",
					organizationId: "org-1",
					accountId: "ws-1",
					accountUserId: "member-2",
					accessToken: "a0",
					expiresAt: 0,
				}),
			],
		});
		vi.mocked(queuedRefresh).mockResolvedValue(exchangeResult("a1", "r1"));

		// when
		await expect(coordinatePersistedRefresh(identity)).rejects.toThrow();

		// then the other seat was never exchanged nor overwritten
		expect(queuedRefresh).not.toHaveBeenCalled();
		expect((await loadAccounts())?.accounts[0]?.refreshToken).toBe("r0");
	});

	it("keeps the sibling filter tied to the stored member when the caller lacks one", async () => {
		// identity has no accountUserId, so targetMemberId must come from the
		// stored target — `x?.trim() || y?.trim()` is not interchangeable with
		// `&&` (which collapses to undefined whenever the caller's id is absent
		// and would let a different member's record be stamped)
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				accountFixture({
					refreshToken: "r0",
					organizationId: "org-1",
					accountId: "ws-1",
					accountUserId: "member-1",
					accessToken: "a0",
					expiresAt: 0,
				}),
				accountFixture({
					refreshToken: "r0",
					organizationId: "org-9",
					accountId: "ws-2",
					accountUserId: "member-2",
					accessToken: "a0",
					expiresAt: 0,
				}),
			],
		});
		vi.mocked(queuedRefresh).mockResolvedValue(exchangeResult("a1", "r1"));
		const callerIdentity: PersistedRefreshIdentity = {
			organizationId: "org-1",
			accountId: "ws-1",
			refreshToken: "r0",
		};

		const result = await coordinatePersistedRefresh(callerIdentity);
		expectRefreshSuccess(result);

		const stored = await loadAccounts();
		expect(
			stored?.accounts.find((a) => a.accountUserId === "member-2")?.refreshToken,
		).toBe("r0");
		expect(
			stored?.accounts.find((a) => a.accountUserId === "member-1")?.refreshToken,
		).toBe("r1");
	});

	it("resolves a unique identity-key match even when the stored token rotated", async () => {
		// `matches.length === 1` must take the unique-match branch — a `!==`
		// flip skips it and the token fallback cannot resolve a rotated record,
		// so the refresh would die as ambiguous
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				accountFixture({
					refreshToken: "rX",
					accountId: "ws-1",
					accessToken: "a0",
					expiresAt: 0,
				}),
			],
		});
		vi.mocked(queuedRefresh).mockResolvedValue(exchangeResult("a1", "r1"));

		const result = await coordinatePersistedRefresh({
			accountId: "ws-1",
			refreshToken: "r0",
		});
		expectRefreshSuccess(result);

		expect(vi.mocked(queuedRefresh).mock.calls.map(([token]) => token)).toEqual([
			"rX",
		]);
	});

	it("falls back to the refresh token when no identity key matches at all", async () => {
		// `tokenMatches.length > 0` admits a single token-only match; `> 1`
		// would reject it and the refresh would die as ambiguous
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				accountFixture({
					refreshToken: "r0",
					organizationId: "org-1",
					accountId: "ws-1",
					accessToken: "a0",
					expiresAt: 0,
				}),
			],
		});
		vi.mocked(queuedRefresh).mockResolvedValue(exchangeResult("a1", "r1"));

		const result = await coordinatePersistedRefresh({
			organizationId: "org-no-match",
			accountId: "ws-no-match",
			refreshToken: "r0",
		});
		expectRefreshSuccess(result);

		expect(vi.mocked(queuedRefresh).mock.calls.map(([token]) => token)).toEqual([
			"r0",
		]);
	});

	it("does not adopt a persisted access token expiring exactly now", async () => {
		// `expiresAt > Date.now()` — a `>=` flip adopts a token that is already
		// expired at read time and never runs the exchange
		vi.useFakeTimers({ toFake: ["Date"] });
		const now = Date.now();
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				accountFixture({
					refreshToken: "rX",
					organizationId: "org-1",
					accountId: "ws-1",
					accountUserId: "member-1",
					accessToken: "aX",
					expiresAt: now,
				}),
			],
		});
		vi.mocked(queuedRefresh).mockResolvedValue(exchangeResult("a1", "r1"));

		const result = await coordinatePersistedRefresh(identity);
		expectRefreshSuccess(result);
		vi.useRealTimers();

		expect(result.adopted).toBe(false);
		expect(vi.mocked(queuedRefresh).mock.calls.map(([token]) => token)).toEqual([
			"rX",
		]);
	});

	it("stamps rotations with a monotonic floor at the wall clock", async () => {
		// `Math.max(Date.now(), latest + 1)` — dropping the Date.now() leg lets
		// the stamp slide backwards whenever the stored stamps are all older
		vi.useFakeTimers({ toFake: ["Date"] });
		const now = Date.now();
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				accountFixture({
					refreshToken: "r0",
					organizationId: "org-1",
					accountId: "ws-1",
					accountUserId: "member-1",
					accessToken: "a0",
					expiresAt: 0,
					tokenRotatedAt: now - 5_000,
				}),
			],
		});
		vi.mocked(queuedRefresh).mockResolvedValue(exchangeResult("a1", "r1"));

		const result = await coordinatePersistedRefresh(identity);
		expectRefreshSuccess(result);
		vi.useRealTimers();

		expect(result.rotatedAt).toBe(now);
		expect((await loadAccounts())?.accounts[0]?.tokenRotatedAt).toBe(now);
	});

	it("stamps every same-member sibling in the file, not only the target", async () => {
		// an emptied sibling loop leaves the other same-grant record on the
		// consumed token — its next exchange is refresh_token_reused
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				accountFixture({
					refreshToken: "r0",
					organizationId: "org-1",
					accountId: "ws-1",
					accountUserId: "member-1",
					accessToken: "a0",
					expiresAt: 0,
				}),
				accountFixture({
					refreshToken: "r0",
					organizationId: "org-1",
					accountId: "ws-2",
					accountUserId: "member-1",
					accessToken: "b0",
					expiresAt: 0,
				}),
			],
		});
		vi.mocked(queuedRefresh).mockResolvedValue(exchangeResult("a1", "r1"));

		const result = await coordinatePersistedRefresh(identity);
		expectRefreshSuccess(result);

		const stored = await loadAccounts();
		const sibling = stored?.accounts.find((a) => a.accountId === "ws-2");
		expect(sibling?.refreshToken).toBe("r1");
		expect(sibling?.expiresAt).toBe(0);
		expect(sibling?.tokenRotatedAt).toBe(result.rotatedAt);
	});
});
