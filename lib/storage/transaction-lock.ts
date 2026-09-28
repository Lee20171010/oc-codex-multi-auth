import { mkdir } from "node:fs/promises";
import * as nodeFs from "node:fs";
import { dirname } from "node:path";

import { lock } from "proper-lockfile";

import { StorageTransactionContentionError } from "../errors.js";
import { logWarn } from "../logger.js";
import { isWindowsLockError } from "./atomic-write.js";
import { withStorageLock } from "./state.js";

const TRANSACTION_LOCK_STALE_MS = 10_000;
const TRANSACTION_LOCK_UPDATE_MS = 2_000;

/**
 * Wait budget for the *storage* lease. Every holder of this lease does local
 * work only — read the file, mutate the object, atomically write it back — so
 * the lease is held for milliseconds and the only reason to queue is another
 * short write. The budget still has to exceed the 10s stale window: a
 * contender that gives up earlier can never reclaim the lock a SIGKILL'd
 * holder left behind (its mtime must age past `stale` before it may be
 * broken), so every first contender after a crash would fail with contention
 * despite the lock being recoverable. These retries sum to roughly fifteen
 * seconds — comfortably over the stale window even without jitter — while a
 * merely busy host resolves in milliseconds long before that.
 *
 * Network round trips deliberately do NOT happen under this lease; see
 * `withRefreshLease` below.
 */
const TRANSACTION_LOCK_RETRIES = {
	retries: 20,
	factor: 1.6,
	minTimeout: 50,
	maxTimeout: 1_000,
	randomize: true,
} as const;

/**
 * The refresh lease serializes the *OAuth exchange* itself across processes,
 * because refresh tokens are single-use: two processes exchanging the same
 * token means one of them gets `refresh_token_reused` and the account is dead
 * until the user logs in again.
 *
 * It is deliberately a different lockfile from the storage lease. Holding the
 * storage lease across a multi-second provider round trip would stall every
 * unrelated storage write on the host (`codex-note`, `codex-tag`, account
 * toggles, rotation stamps, TUI quota writes) behind a network call.
 *
 * `stale` therefore has to exceed a slow exchange rather than a slow write,
 * and the wait budget has to cover another process performing a full exchange
 * — and then reclaiming a dead holder's lock: the sum below is ~90 seconds
 * without jitter, past the 60s stale window, so the first contender after a
 * SIGKILL'd holder reaches the stale-break instead of failing with contention.
 */
const REFRESH_LEASE_STALE_MS = 60_000;
const REFRESH_LEASE_UPDATE_MS = 5_000;
const REFRESH_LEASE_RETRIES = {
	retries: 24,
	factor: 1.5,
	minTimeout: 200,
	maxTimeout: 5_000,
	randomize: true,
} as const;

export interface StorageTransactionLease {
	assertValid(): void;
}

export interface StorageTransactionOptions<Current, Persisted extends Current, Result> {
	readonly storagePath: string;
	readonly load: () => Promise<Current>;
	readonly persist: (storage: Persisted) => Promise<void>;
	readonly handler: (
		current: Current,
		persist: (storage: Persisted) => Promise<void>,
	) => Promise<Result>;
}

function hasErrorCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
}

function isContentionError(error: unknown): boolean {
	if (hasErrorCode(error, "ELOCKED")) return true;
	return process.platform === "win32" && isWindowsLockError(error);
}

async function releaseQuietly(
	release: () => Promise<void>,
	lockPath: string,
): Promise<void> {
	try {
		await release();
	} catch (error) {
		logWarn(
			`Failed to release account storage transaction lease at ${lockPath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

export function getStorageTransactionLockPath(storagePath: string): string {
	return `${storagePath}.transaction.lock`;
}

export function getRefreshLeasePath(storagePath: string): string {
	return `${storagePath}.refresh.lock`;
}

/**
 * The refresh lease is taken on a path DISTINCT from the storage file, because
 * `proper-lockfile` keys its in-process registry by the target path rather than
 * by `lockfilePath`. Locking the storage file twice (once for the refresh lease,
 * once for the storage transaction nested inside it) silently overwrites that
 * registry entry: releasing the inner lease deletes it, and releasing the outer
 * one then fails with `ENOTACQUIRED`, leaking the refresh lockfile until it goes
 * stale — which stalls every other process for the full stale window.
 *
 * The sentinel is only ever a registry key and a lockfile name; it is never
 * created or read as a file.
 */
function getRefreshLeaseTargetPath(storagePath: string): string {
	return `${storagePath}.refresh`;
}

/**
 * `proper-lockfile` creates the lockfile with a non-recursive `mkdir`, so it
 * fails with a raw `ENOENT` when the storage directory does not exist yet. The
 * directory is otherwise only created lazily at write time, so the very first
 * mutation on a fresh profile (or on a new `per_project_accounts` project) would
 * otherwise blow up with an error that names neither the lock nor the cause.
 */
async function ensureLockDirectory(lockPath: string): Promise<void> {
	// `mode` applies only to directories this call actually creates — an
	// existing directory is never re-chmodded.
	await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
}

/**
 * Self-verification state for one lease, maintained by the fs shim in
 * {@link leaseAwareFs} and consumed by {@link verifyLeaseHeld}.
 *
 * proper-lockfile detects a stolen lease only on its heartbeat timer: it
 * stats the lock dir, compares the mtime against the value it last wrote, and
 * flips `onCompromised` on a mismatch or a missing dir. On a stalled event
 * loop (sync busy work, a debugger pause, GC) that timer never runs, so a
 * holder whose lease was already stolen keeps believing it is valid — and
 * proceeds to overwrite the thief's committed work or re-spend a single-use
 * refresh token. The state below exists so `assertValid()` can instead
 * *synchronously* re-verify ownership on demand.
 */
interface LeaseOwnershipState {
	/**
	 * Every mtime (integer ms) observed on our own lock dir: utimes values we
	 * issued plus post-write stat results. A re-stat whose mtime is not in
	 * this set means the dir was removed and re-created by someone else —
	 * the lease was stolen — even if the heartbeat has not noticed yet.
	 */
	readonly ownMtimesMs: Set<number>;
	/**
	 * `Date.now()` when we last proved the lock dir still carries our mtime
	 * (acquisition, heartbeat stat, heartbeat utimes). If this ages past the
	 * stale window, the lease is *claimable* by contenders — whether or not a
	 * steal has happened yet — so spending a single-use token on it is unsafe.
	 */
	lastOwnershipProofAt: number;
	/**
	 * mtime of the foreign lock dir most recently observed while contending —
	 * the evidence a steal is based on. At removal time the dir must still
	 * carry exactly this mtime; a different one means a fresh holder replaced
	 * the stale dir between the staleness stat and the rmdir, and breaking it
	 * would delete a live lease.
	 */
	foreignMtimeMs: number | undefined;
	/**
	 * True once this process's `mkdir` created the lock dir — the point at
	 * which stats of the lock path start describing our own dir rather than
	 * a foreign holder's.
	 */
	created: boolean;
}

type LockFsCallback = (error: NodeJS.ErrnoException | null) => void;

interface LockFsShim {
	mkdir(path: string, callback: LockFsCallback): void;
	stat(
		path: string,
		callback: (error: NodeJS.ErrnoException | null, stats?: nodeFs.Stats) => void,
	): void;
	rmdir(path: string, callback: LockFsCallback): void;
	utimes(
		path: string,
		atime: number | Date,
		mtime: number | Date,
		callback: LockFsCallback,
	): void;
	rmdirSync(path: string): void;
	realpath(
		path: string,
		callback: (error: NodeJS.ErrnoException | null, resolved?: string) => void,
	): void;
}

function toMtimeMs(value: number | Date): number {
	return value instanceof Date ? value.getTime() : value;
}

/** Mirrors the error shape proper-lockfile produces so the retry layer treats it identically. */
function elockedError(file: string): NodeJS.ErrnoException {
	return Object.assign(new Error("Lock file is already being held"), {
		code: "ELOCKED",
		file,
	});
}

/**
 * An fs shim interposed between proper-lockfile and `node:fs`.
 *
 * Besides feeding {@link LeaseOwnershipState} it hardens two remove paths:
 *
 *  - **Stale-break (pre-acquire `rmdir`)**: re-verifies the dir synchronously —
 *    the mtime must still be exactly the one the staleness stat observed (a
 *    swapped-in fresh lockdir must never be deleted), and it must not lie in
 *    the future. A future mtime means the writer's clock ran ahead of ours, so
 *    our `mtime < now - stale` arithmetic is untrustworthy and the steal is
 *    refused as `ELOCKED` (retried, then surfaced as contention).
 *  - **Release/exit (`rmdir`/`rmdirSync`)**: refuses to remove a dir whose
 *    mtime is not one we wrote, so a compromised holder cannot delete the live
 *    lockdir of whichever process stole its lease.
 *
 * Both removal paths also recover `ENOTDIR`/`ENOTEMPTY` — a regular file or a
 * dir with foreign contents at the lock path cannot be `rmdir`'d; without the
 * `rm -rf` fallback a stray file at `*.transaction.lock` would brick every
 * future mutation on that store with a raw error.
 *
 * Residual risk, documented: if the *system* clock jumps forward across the
 * stale window, a contender sees a genuinely old stored mtime and the steal
 * cannot be distinguished from a dead holder — the holder-side
 * `assertValid()` re-verification is the backstop that keeps a stolen lease
 * from being used.
 */
function leaseAwareFs(
	lockPath: string,
	targetPath: string,
	state: LeaseOwnershipState,
): LockFsShim {
	const physicallyRemove = (path: string, callback: LockFsCallback) => {
		nodeFs.rmdir(path, (error) => {
			if (error && (error.code === "ENOTDIR" || error.code === "ENOTEMPTY")) {
				logWarn(
					`Removing a non-directory or non-empty object at storage lock path ${path} (${error.code}); it was judged stale`,
				);
				nodeFs.rm(path, { recursive: true, force: true }, (rmError) =>
					callback(rmError),
				);
				return;
			}
			callback(error);
		});
	};

	return {
		mkdir(path, callback) {
			nodeFs.mkdir(path, (error) => {
				if (!error && path === lockPath) {
					state.created = true;
					state.foreignMtimeMs = undefined;
					state.lastOwnershipProofAt = Date.now();
				}
				callback(error);
			});
		},
		stat(path, callback) {
			nodeFs.stat(path, (error, stats) => {
				if (!error && stats && path === lockPath) {
					const mtimeMs = stats.mtime.getTime();
					if (state.created) {
						state.ownMtimesMs.add(mtimeMs);
						state.lastOwnershipProofAt = Date.now();
					} else {
						state.foreignMtimeMs = mtimeMs;
					}
				}
				callback(error, stats);
			});
		},
		utimes(path, atime, mtime, callback) {
			if (path === lockPath && state.created) {
				// Record the value at call time, not in the completion callback:
				// the write can land on disk while its callback is still queued,
				// and a synchronous ownership check in between must already
				// recognize the new mtime as ours.
				state.ownMtimesMs.add(toMtimeMs(mtime));
			}
			nodeFs.utimes(path, atime, mtime, (error) => {
				if (!error && path === lockPath && state.created) {
					state.lastOwnershipProofAt = Date.now();
				}
				callback(error);
			});
		},
		rmdir(path, callback) {
			if (path !== lockPath) {
				nodeFs.rmdir(path, callback);
				return;
			}
			let current: nodeFs.Stats | undefined;
			try {
				current = nodeFs.statSync(path);
			} catch {
				current = undefined;
			}
			if (state.created) {
				// Release path. Only remove a dir still carrying a mtime we wrote:
				// if the lease was stolen, the lockdir belongs to the thief and
				// deleting it would let a third process contend with them.
				if (
					current !== undefined &&
					!state.ownMtimesMs.has(current.mtime.getTime())
				) {
					callback(null);
					return;
				}
				physicallyRemove(path, callback);
				return;
			}
			// Stale-break path. proper-lockfile only reaches this rmdir after a
			// stat judged the dir stale; re-verify that judgment synchronously
			// before deleting.
			if (current !== undefined) {
				const currentMtimeMs = current.mtime.getTime();
				if (
					currentMtimeMs > Date.now() ||
					state.foreignMtimeMs === undefined ||
					currentMtimeMs !== state.foreignMtimeMs
				) {
					callback(elockedError(targetPath));
					return;
				}
			}
			physicallyRemove(path, callback);
		},
		rmdirSync(path) {
			// signal-exit cleanup inside proper-lockfile: same ownership guard as
			// the release path so a dying holder cannot remove a thief's lockdir.
			if (path !== lockPath) {
				try {
					nodeFs.rmdirSync(path);
				} catch {
					// exit-time cleanup is best-effort
				}
				return;
			}
			try {
				const current = nodeFs.statSync(path);
				if (!state.ownMtimesMs.has(current.mtime.getTime())) return;
				nodeFs.rmdirSync(path);
			} catch {
				// exit-time cleanup is best-effort
			}
		},
		realpath(path, callback) {
			nodeFs.realpath(path, callback);
		},
	};
}

/**
 * Synchronously prove that the lease is still ours. Runs inside
 * `lease.assertValid()` — no timer, no microtask — so it works even on an
 * event loop the heartbeat cannot currently reach:
 *
 *  1. the lock dir must still exist on disk;
 *  2. its mtime must be one this process wrote (a recreated dir means a thief
 *     holds the lease now);
 *  3. our last ownership proof must be inside the stale window — past it, the
 *     lease is *claimable* whether or not anyone has claimed it yet.
 *
 * All failures surface as {@link StorageTransactionContentionError}, which
 * callers classify as retryable: aborting before spending a single-use token
 * is always cheaper than losing the exchange race.
 */
function verifyLeaseHeld(
	lockPath: string,
	reportPath: string,
	state: LeaseOwnershipState,
	staleMs: number,
	compromised: Error | undefined,
): void {
	if (compromised) {
		throw new StorageTransactionContentionError(reportPath, compromised);
	}
	let current: nodeFs.Stats;
	try {
		current = nodeFs.statSync(lockPath);
	} catch (error) {
		throw new StorageTransactionContentionError(
			reportPath,
			Object.assign(
				new Error(`Storage lease at ${lockPath} can no longer be verified on disk`),
				{ code: "ECOMPROMISED", cause: error },
			),
		);
	}
	if (!state.ownMtimesMs.has(current.mtime.getTime())) {
		throw new StorageTransactionContentionError(
			reportPath,
			Object.assign(
				new Error(`Storage lease at ${lockPath} was reclaimed by another process`),
				{ code: "ECOMPROMISED" },
			),
		);
	}
	if (Date.now() - state.lastOwnershipProofAt >= staleMs) {
		throw new StorageTransactionContentionError(
			reportPath,
			Object.assign(
				new Error(
					`Storage lease at ${lockPath} went without an ownership heartbeat for ` +
						`longer than its stale window and is now claimable by contenders`,
				),
				{ code: "ECOMPROMISED" },
			),
		);
	}
}

interface AcquiredLease {
	readonly release: () => Promise<void>;
	readonly verifyOwnership: () => void;
}

async function acquireLease(
	targetPath: string,
	lockPath: string,
	options: {
		stale: number;
		update: number;
		retries: typeof TRANSACTION_LOCK_RETRIES | typeof REFRESH_LEASE_RETRIES;
		onCompromised: (error: Error) => void;
		reportPath?: string;
	},
): Promise<AcquiredLease> {
	const storagePath = options.reportPath ?? targetPath;
	await ensureLockDirectory(lockPath);
	const state: LeaseOwnershipState = {
		ownMtimesMs: new Set(),
		lastOwnershipProofAt: Date.now(),
		foreignMtimeMs: undefined,
		created: false,
	};
	let compromised: Error | undefined;
	let release: () => Promise<void>;
	try {
		release = await lock(targetPath, {
			realpath: false,
			lockfilePath: lockPath,
			stale: options.stale,
			update: options.update,
			retries: options.retries,
			fs: leaseAwareFs(lockPath, targetPath, state),
			onCompromised: (error: Error) => {
				compromised = error;
				options.onCompromised(error);
			},
		});
	} catch (error) {
		if (isContentionError(error)) {
			throw new StorageTransactionContentionError(storagePath, error);
		}
		throw error;
	}

	return {
		release,
		verifyOwnership: () =>
			verifyLeaseHeld(
				lockPath,
				storagePath,
				state,
				options.stale,
				compromised,
			),
	};
}

async function withStorageTransactionLease<T>(
	storagePath: string,
	operation: (lease: StorageTransactionLease) => Promise<T>,
): Promise<T> {
	const lockPath = getStorageTransactionLockPath(storagePath);
	const lease = await acquireLease(storagePath, lockPath, {
		stale: TRANSACTION_LOCK_STALE_MS,
		update: TRANSACTION_LOCK_UPDATE_MS,
		retries: TRANSACTION_LOCK_RETRIES,
		onCompromised: (error: Error) => {
			logWarn(
				`Account storage transaction lease at ${lockPath} was compromised: ${error.message}`,
			);
		},
	});

	try {
		return await operation({ assertValid: lease.verifyOwnership });
	} finally {
		await releaseQuietly(lease.release, lockPath);
	}
}

/**
 * Serialize a refresh-token exchange for one storage file across processes.
 *
 * The callback runs with NO storage lease held, so it is free to perform the
 * provider round trip and to open short storage transactions of its own for the
 * pre-check and the commit.
 */
export async function withRefreshLease<T>(
	storagePath: string,
	operation: (lease: StorageTransactionLease) => Promise<T>,
): Promise<T> {
	const lockPath = getRefreshLeasePath(storagePath);
	const lease = await acquireLease(getRefreshLeaseTargetPath(storagePath), lockPath, {
		stale: REFRESH_LEASE_STALE_MS,
		update: REFRESH_LEASE_UPDATE_MS,
		retries: REFRESH_LEASE_RETRIES,
		reportPath: storagePath,
		onCompromised: (error: Error) => {
			logWarn(
				`Account refresh lease at ${lockPath} was compromised: ${error.message}`,
			);
		},
	});

	try {
		return await operation({
			// Callers MUST call this immediately before spending the single-use
			// refresh token. The check re-verifies the lock dir on disk
			// synchronously — a heartbeat's compromised flag cannot run on a
			// stalled event loop, and a lease past its stale window is claimable
			// whether or not a contender has claimed it yet. Aborting before the
			// exchange is always cheaper than `refresh_token_reused`.
			assertValid: lease.verifyOwnership,
		});
	} finally {
		await releaseQuietly(lease.release, lockPath);
	}
}

export function withStorageTransaction<Current, Persisted extends Current, Result>(
	options: StorageTransactionOptions<Current, Persisted, Result>,
): Promise<Result> {
	return withStorageLock(() =>
		withStorageTransactionLease(options.storagePath, async (lease) => {
			const current = await options.load();
			return options.handler(current, async (storage) => {
				lease.assertValid();
				await options.persist(storage);
			});
		}),
	);
}

/**
 * Internal seams exposed only to the `storage-lease-*` test suites so the
 * fs-shim guards (stale-break re-verification, foreign-dir release refusal,
 * malformed-lockpath recovery) can be exercised deterministically.
 */
export const __testOnly = {
	createOwnershipState(): LeaseOwnershipState {
		return {
			ownMtimesMs: new Set(),
			lastOwnershipProofAt: Date.now(),
			foreignMtimeMs: undefined,
			created: false,
		};
	},
	leaseAwareFs,
	verifyLeaseHeld,
};
