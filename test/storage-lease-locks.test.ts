/**
 * Lease-level hardening for the storage transaction and refresh locks.
 *
 * `proper-lockfile` detects a stolen lease only on its heartbeat timer —
 * `onCompromised` fires from the heartbeat callback, which a stalled event
 * loop cannot run. A holder that slept through a steal would wake up with a
 * stale `compromised === false`, pass `assertValid()`, and either overwrite
 * the thief's committed work or re-spend a single-use refresh token. The
 * leases in `transaction-lock.ts` therefore re-verify ownership
 * synchronously: `assertValid()` re-stats the lock dir and requires its mtime
 * to be one this process wrote, inside the stale window.
 *
 * Pinned here:
 *
 *   - `assertValid()` throws a typed contention error after the lock dir was
 *     removed (stolen) or removed-and-recreated (replaced) — on both the
 *     storage transaction lease and the refresh lease;
 *   - a holder whose heartbeat has not run for the stale window is refused
 *     even though nobody stole the lease yet — it is claimable, which is
 *     already unsafe for a single-use token;
 *   - a stale lockdir is still legitimately reclaimed (the guards must not
 *     break the actual recovery path);
 *   - a regular file or a non-empty dir at the lock path — un-rmdir-able by
 *     `proper-lockfile`, which surfaced a raw ENOTDIR/ENOTEMPTY — is removed
 *     once it is genuinely stale;
 *   - a foreign lockdir whose mtime lies in the future is never stolen: the
 *     staleness arithmetic cannot be trusted against a skewed writer;
 *   - a stale holder's `release` must not delete the lockdir a thief
 *     re-created (the release path is ownership-guarded too);
 *   - the fs-shim guards are unit-tested deterministically via `__testOnly`.
 */

import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StorageTransactionContentionError } from "../lib/errors.js";
import {
	setStoragePathDirect,
	withAccountStorageTransaction,
} from "../lib/storage.js";
import {
	__testOnly,
	getRefreshLeasePath,
	getStorageTransactionLockPath,
	withRefreshLease,
} from "../lib/storage/transaction-lock.js";

const STORAGE_FIXTURE = {
	version: 3,
	activeIndex: 0,
	accounts: [{ refreshToken: "fixture-token", addedAt: 1, lastUsed: 1 }],
};

/** Used so utimes-produced mtimes land at an exactly-known instant. */
function pastTime(offsetMs: number): Date {
	return new Date(Date.now() - offsetMs);
}

async function pathMtimeMs(path: string): Promise<number> {
	return (await stat(path)).mtime.getTime();
}

describe("storage lease re-verification", () => {
	let directory: string;
	let storagePath: string;
	let lockPath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "oc-codex-storage-lease-"));
		storagePath = join(directory, "accounts.json");
		lockPath = getStorageTransactionLockPath(storagePath);
		await writeFile(storagePath, JSON.stringify(STORAGE_FIXTURE), { mode: 0o600 });
		setStoragePathDirect(storagePath);
	});

	afterEach(async () => {
		vi.useRealTimers();
		setStoragePathDirect(null);
		await rm(directory, { recursive: true, force: true });
	});

	it("fails a persist when the lock dir was removed mid-transaction", async () => {
		// given a holder whose lock dir disappears while its handler runs —
		// the observable state after a contender's stale-break steal
		const observed = await withAccountStorageTransaction(async (current, persist) => {
			await rm(lockPath, { recursive: true, force: true });

			// then
			await expect(persist(current)).rejects.toBeInstanceOf(
				StorageTransactionContentionError,
			);
			return "handler-returned";
		});

		expect(observed).toBe("handler-returned");
	});

	it("fails a persist when the lock dir was replaced by another holder", async () => {
		// given a dir a thief re-created: same path, a different mtime that this
		// process never wrote
		const observed = await withAccountStorageTransaction(async (current, persist) => {
			await rm(lockPath, { recursive: true, force: true });
			await mkdir(lockPath);
			// Pin the replacement to a distinct instant so filesystems with a
			// coarse mtime granularity cannot collide with the stolen dir's mtime.
			const foreign = pastTime(30_000);
			await utimes(lockPath, foreign, foreign);

			// then — the recreated dir is not ours, even though nothing has run
			// the heartbeat yet
			await expect(persist(current)).rejects.toBeInstanceOf(
				StorageTransactionContentionError,
			);
			return "handler-returned";
		});

		expect(observed).toBe("handler-returned");
		// and the foreign holder's lockdir survives our release — deleting a live
		// lease would restart the very race the release guard exists to stop
		await access(lockPath);
	});

	it("fails a persist when the heartbeat could not have run inside the stale window", async () => {
		// given an event loop stalled past the 10s stale window: nobody stole the
		// lease, but it is claimable and a contender could be mid-steal right now
		const observed = await withAccountStorageTransaction(async (current, persist) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(Date.now() + 11_000);
			try {
				await expect(persist(current)).rejects.toBeInstanceOf(
					StorageTransactionContentionError,
				);
			} finally {
				vi.useRealTimers();
			}
			return "handler-returned";
		});

		expect(observed).toBe("handler-returned");
	});

	it("still persists normally while the lease is provably ours", async () => {
		const observed = await withAccountStorageTransaction(async (current, persist) => {
			const account = current?.accounts[0];
			if (!account) throw new Error("Expected account storage fixture");
			account.accountLabel = "touched-by-lease";
			await persist(current);
			return "committed";
		});

		expect(observed).toBe("committed");
		const stored = JSON.parse(await readFile(storagePath, "utf8")) as {
			accounts: Array<{ accountLabel?: string }>;
		};
		expect(stored.accounts[0]?.accountLabel).toBe("touched-by-lease");
	});

	it("fails the refresh lease when its lock dir was replaced before the exchange", async () => {
		// Mirrors the stale-theft race the refresh lease exists to stop: a
		// contender broke our lease and now owns the dir, but the heartbeat that
		// would flip `compromised` has not run yet. assertValid must refuse
		// synchronously so the single-use token is never spent.
		const refreshLockPath = getRefreshLeasePath(storagePath);
		const operation = withRefreshLease(storagePath, async (lease) => {
			await rm(refreshLockPath, { recursive: true, force: true });
			await mkdir(refreshLockPath);
			const foreign = pastTime(30_000);
			await utimes(refreshLockPath, foreign, foreign);

			expect(() => lease.assertValid()).toThrow(StorageTransactionContentionError);
			return "asserted";
		});

		await expect(operation).resolves.toBe("asserted");
	});
});

describe("stale and malformed lock paths", () => {
	let directory: string;
	let storagePath: string;
	let lockPath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "oc-codex-stale-lock-"));
		storagePath = join(directory, "accounts.json");
		lockPath = getStorageTransactionLockPath(storagePath);
		await writeFile(storagePath, JSON.stringify(STORAGE_FIXTURE), { mode: 0o600 });
		setStoragePathDirect(storagePath);
	});

	afterEach(async () => {
		setStoragePathDirect(null);
		await rm(directory, { recursive: true, force: true });
	});

	it("reclaims a genuinely stale lockdir left by a dead holder", async () => {
		// given a lockdir whose holder died: it has not heartbeated in far
		// longer than the stale window
		await mkdir(lockPath);
		const dead = pastTime(60_000);
		await utimes(lockPath, dead, dead);

		// when
		const observed = await withAccountStorageTransaction(async () => "committed");

		// then the dead lease was broken and ours committed
		expect(observed).toBe("committed");
	});

	it("removes a stale regular file at the lock path instead of failing with ENOTDIR", async () => {
		// given a stray file where the lockdir is expected — proper-lockfile's
		// rmdir cannot remove it, which used to surface a raw ENOTDIR and brick
		// every mutation on the store
		await writeFile(lockPath, "not-a-lockdir");
		const dead = pastTime(60_000);
		await utimes(lockPath, dead, dead);

		// when
		const observed = await withAccountStorageTransaction(async () => "committed");

		// then
		expect(observed).toBe("committed");
		await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("removes a stale non-empty lockdir that rmdir cannot take", async () => {
		// given a lockdir with foreign contents — e.g. a crashed writer left a
		// temp file inside it — rmdir raises ENOTEMPTY
		await mkdir(lockPath);
		await writeFile(join(lockPath, "stray"), "junk");
		const dead = pastTime(60_000);
		await utimes(lockPath, dead, dead);

		// when
		const observed = await withAccountStorageTransaction(async () => "committed");

		// then
		expect(observed).toBe("committed");
		await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("never steals a foreign lockdir whose mtime lies in the future", async () => {
		// given a live holder whose heartbeat wrote an mtime ahead of our clock —
		// or our clock jumping backwards: either way `mtime < now - stale` is
		// untrustworthy and the lock must not be broken
		await mkdir(lockPath);
		const future = new Date(Date.now() + 120_000);
		await utimes(lockPath, future, future);

		let settled = false;
		const transaction = withAccountStorageTransaction(async () => {
			settled = true;
			return "committed";
		});
		const swallow = transaction.catch(() => undefined);

		// when — give the contender ample event-loop turns to attempt a steal
		await new Promise((resolve) => setTimeout(resolve, 1_500));

		// then the foreign dir was never removed and the transaction is still queued
		expect(settled).toBe(false);
		await access(lockPath);
		expect(await pathMtimeMs(lockPath)).toBe(future.getTime());

		// when the holder releases for real, the queued transaction proceeds
		await rm(lockPath, { recursive: true });
		await expect(transaction).resolves.toBe("committed");
		await swallow;
	}, 20_000);
});

describe("lease fs-shim guards", () => {
	let directory: string;
	let lockPath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "oc-codex-lock-shim-"));
		lockPath = join(directory, "accounts.json.transaction.lock");
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	function makeShim(
		created: boolean,
		foreignMtimeMs?: number,
		ownMtimesMs: number[] = [],
	) {
		const state = __testOnly.createOwnershipState();
		state.created = created;
		state.foreignMtimeMs = foreignMtimeMs;
		for (const mtimeMs of ownMtimesMs) state.ownMtimesMs.add(mtimeMs);
		return { state, fs: __testOnly.leaseAwareFs(lockPath, "/x/accounts.json", state) };
	}

	function rmdirAsync(
		fs: { rmdir(path: string, callback: (error: Error | null) => void): void },
		path: string,
	) {
		return new Promise<void>((resolve, reject) => {
			fs.rmdir(path, (error) => (error ? reject(error) : resolve()));
		});
	}

	it("refuses a stale-break rmdir when the observed dir was replaced", async () => {
		// given a dir that changed hands between the staleness stat and the
		// removal — the fresh holder's dir must not be deleted
		await mkdir(lockPath);
		const observedForeign = pastTime(60_000);
		const { fs } = makeShim(false, observedForeign.getTime());
		const replacedBy = pastTime(45_000);
		await utimes(lockPath, replacedBy, replacedBy);

		// when
		await expect(rmdirAsync(fs, lockPath)).rejects.toMatchObject({
			code: "ELOCKED",
		});

		// then the replacement is untouched
		expect(await pathMtimeMs(lockPath)).toBe(replacedBy.getTime());
	});

	it("refuses a stale-break rmdir when the dir's mtime lies in the future", async () => {
		// given a skewed/live writer: the same mtime the staleness stat saw, but
		// ahead of our clock — the stale arithmetic is not trustworthy here
		await mkdir(lockPath);
		const future = new Date(Date.now() + 120_000);
		await utimes(lockPath, future, future);
		const { fs } = makeShim(false, future.getTime());

		// when
		await expect(rmdirAsync(fs, lockPath)).rejects.toMatchObject({
			code: "ELOCKED",
		});

		// then
		await access(lockPath);
	});

	it("removes a stale dir whose mtime still matches the staleness stat", async () => {
		// given the happy-path steal: same mtime, safely in the past
		await mkdir(lockPath);
		const dead = pastTime(60_000);
		await utimes(lockPath, dead, dead);
		const { fs } = makeShim(false, dead.getTime());

		// when
		await rmdirAsync(fs, lockPath);

		// then
		await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("keeps a re-created dir on the release path — it belongs to a thief", async () => {
		// given our lease was stolen and the thief's dir sits at the lock path:
		// release must not delete a live lease
		await mkdir(lockPath);
		const ours = pastTime(5_000);
		const thief = pastTime(1_000);
		await utimes(lockPath, thief, thief);
		const { fs } = makeShim(true, undefined, [ours.getTime()]);

		// when the compromised holder releases
		await rmdirAsync(fs, lockPath);

		// then the thief's lockdir survives
		expect(await pathMtimeMs(lockPath)).toBe(thief.getTime());
	});

	it("removes our own dir on the release path", async () => {
		// given
		await mkdir(lockPath);
		const { fs } = makeShim(true, undefined, [await pathMtimeMs(lockPath)]);

		// when
		await rmdirAsync(fs, lockPath);

		// then
		await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses rmdirSync on a re-created (foreign) dir", async () => {
		// given
		await mkdir(lockPath);
		const ours = pastTime(5_000);
		const foreign = pastTime(1_000);
		await utimes(lockPath, foreign, foreign);
		const { fs } = makeShim(true, undefined, [ours.getTime()]);

		// when
		fs.rmdirSync(lockPath);

		// then the foreign dir is left alone
		expect(await pathMtimeMs(lockPath)).toBe(foreign.getTime());
	});

	it("removes our own dir on rmdirSync", async () => {
		await mkdir(lockPath);
		const { fs } = makeShim(true, undefined, [await pathMtimeMs(lockPath)]);

		fs.rmdirSync(lockPath);
		await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("falls back to rm -rf for a regular file at the lock path", async () => {
		// given a stale stray file — rmdir raises ENOTDIR
		await writeFile(lockPath, "not-a-dir");
		const dead = pastTime(60_000);
		await utimes(lockPath, dead, dead);
		const { fs } = makeShim(false, dead.getTime());

		// when
		await rmdirAsync(fs, lockPath);

		// then
		await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("falls back to rm -rf for a non-empty lockdir", async () => {
		await mkdir(lockPath);
		await writeFile(join(lockPath, "stray"), "junk");
		const dead = pastTime(60_000);
		await utimes(lockPath, dead, dead);
		const { fs } = makeShim(false, dead.getTime());

		await rmdirAsync(fs, lockPath);
		await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
