import { mkdir } from "node:fs/promises";
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
 * short write. The budget still sums to roughly five seconds so that a busy
 * host, a slow network drive, or a Windows virus scanner cannot turn ordinary
 * contention into a user-visible `StorageTransactionContentionError`.
 *
 * Network round trips deliberately do NOT happen under this lease; see
 * `withRefreshLease` below.
 */
const TRANSACTION_LOCK_RETRIES = {
	retries: 10,
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
 * `stale` therefore has to exceed a slow exchange rather than a slow write, and
 * the wait budget has to cover another process performing a full exchange, so
 * both are an order of magnitude larger than the storage lease's.
 */
const REFRESH_LEASE_STALE_MS = 60_000;
const REFRESH_LEASE_UPDATE_MS = 5_000;
const REFRESH_LEASE_RETRIES = {
	retries: 15,
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
): Promise<() => Promise<void>> {
	const storagePath = options.reportPath ?? targetPath;
	await ensureLockDirectory(lockPath);
	try {
		return await lock(targetPath, {
			realpath: false,
			lockfilePath: lockPath,
			stale: options.stale,
			update: options.update,
			retries: options.retries,
			onCompromised: options.onCompromised,
		});
	} catch (error) {
		if (isContentionError(error)) {
			throw new StorageTransactionContentionError(storagePath, error);
		}
		throw error;
	}
}

async function withStorageTransactionLease<T>(
	storagePath: string,
	operation: (lease: StorageTransactionLease) => Promise<T>,
): Promise<T> {
	const lockPath = getStorageTransactionLockPath(storagePath);
	let compromised: Error | undefined;
	const release = await acquireLease(storagePath, lockPath, {
		stale: TRANSACTION_LOCK_STALE_MS,
		update: TRANSACTION_LOCK_UPDATE_MS,
		retries: TRANSACTION_LOCK_RETRIES,
		onCompromised: (error: Error) => {
			compromised = error;
			logWarn(
				`Account storage transaction lease at ${lockPath} was compromised: ${error.message}`,
			);
		},
	});

	try {
		return await operation({
			assertValid() {
				if (compromised) {
					throw new StorageTransactionContentionError(storagePath, compromised);
				}
			},
		});
	} finally {
		await releaseQuietly(release, lockPath);
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
	let compromised: Error | undefined;
	const release = await acquireLease(getRefreshLeaseTargetPath(storagePath), lockPath, {
		stale: REFRESH_LEASE_STALE_MS,
		update: REFRESH_LEASE_UPDATE_MS,
		retries: REFRESH_LEASE_RETRIES,
		reportPath: storagePath,
		onCompromised: (error: Error) => {
			compromised = error;
			logWarn(
				`Account refresh lease at ${lockPath} was compromised: ${error.message}`,
			);
		},
	});

	try {
		return await operation({
			// Callers MUST call this immediately before spending the single-use
			// refresh token. A compromised lease means another process can reclaim
			// it and exchange the same token, and the loser of that race gets
			// `refresh_token_reused` — an unrecoverable state that forces the user
			// to log in again. Aborting before the exchange is always cheaper.
			assertValid() {
				if (compromised) {
					throw new StorageTransactionContentionError(storagePath, compromised);
				}
			},
		});
	} finally {
		await releaseQuietly(release, lockPath);
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
