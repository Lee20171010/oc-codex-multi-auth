import { readFile, rm } from "node:fs/promises";

import { extractAccountUserId } from "../auth/token-utils.js";
import { queuedRefresh } from "../refresh-queue.js";
import { logInfo, logWarn } from "../logger.js";
import { StorageTransactionContentionError } from "../errors.js";
import type { TokenResult } from "../types.js";
import {
	findAccountIndexByIdentityKeys,
	toAccountIdentityKeys,
} from "./identity.js";
import {
	getStoragePath,
	withAccountStorageTransaction,
	withFlaggedAccountStorageTransaction,
	type AccountStorageV3,
	type FlaggedAccountStorageV1,
} from "../storage.js";
import { withRefreshLease } from "./transaction-lock.js";
import { writeFileAtomic } from "./atomic-write.js";
import type { AccountMetadataV3 } from "./migrations.js";

export type PersistedRefreshIdentity = Pick<
	AccountMetadataV3,
	"organizationId" | "accountId" | "accountUserId" | "refreshToken"
>;

export type CoordinatedRefreshSuccess = Extract<TokenResult, { type: "success" }> & {
	readonly adopted: boolean;
	readonly rotatedAt?: number;
};

export type CoordinatedRefreshResult =
	| CoordinatedRefreshSuccess
	| Exclude<TokenResult, { type: "success" }>;

/**
 * How many times the durable commit is retried after the provider exchange has
 * already consumed the single-use refresh token. Losing the replacement at this
 * point would leave the account dead until the user logs in again, so the commit
 * is far more worth retrying than the acquisition was.
 */
const COMMIT_ATTEMPTS = 3;

function stableIdentityKeys(identity: PersistedRefreshIdentity): string[] {
	return toAccountIdentityKeys(identity).filter(
		(key) => !key.startsWith("refreshToken:"),
	);
}

function indexesMatchingKey(
	accounts: AccountMetadataV3[],
	key: string,
): number[] {
	return accounts.flatMap((account, index) =>
		toAccountIdentityKeys(account).includes(key) ? [index] : [],
	);
}

/**
 * Resolve the single stored record that a rotated refresh token must be written
 * to.
 *
 * Exact refresh-token matches are tried first: the caller is holding that token,
 * so a record carrying it is unambiguously the right target. Identity keys are
 * only a fallback for the case where the token has already rotated on disk, and
 * are only trusted when they resolve to exactly ONE record. A bare
 * `organizationId:` key routinely matches several records — a Business org with
 * two seats is stored as two accounts — and guessing there would exchange and
 * overwrite a different seat's credentials.
 */
function findRefreshTarget(
	accounts: AccountMetadataV3[],
	identity: PersistedRefreshIdentity,
): number {
	const keys = stableIdentityKeys(identity);

	// A seat key (`organizationId|accountId|accountUserId`) pins exactly one
	// member, so when the caller has one it is the ONLY key considered. Widening
	// to a workspace-level key here would resolve a *different* seat in the same
	// org, and a miss must stay a miss: the account really was removed.
	const seatKey = keys.find((key) => key.startsWith("seat:"));
	if (seatKey) {
		return findAccountIndexByIdentityKeys(accounts, [seatKey]);
	}

	for (const key of keys) {
		const matches = indexesMatchingKey(accounts, key);
		if (matches.length === 1) return matches[0] ?? -1;
		if (matches.length > 1) {
			// A bare `organizationId:` key matches every seat in a Business org, so
			// picking the first would exchange and overwrite another member's
			// credentials. The exact token the caller holds is the only safe
			// tiebreaker; without it, refuse rather than guess.
			const tokenMatch = matches.find(
				(index) => accounts[index]?.refreshToken === identity.refreshToken,
			);
			if (tokenMatch !== undefined) return tokenMatch;
			throw new Error(
				"Refresh identity is ambiguous after the persisted token rotated",
			);
		}
	}

	// No stable identity at all: the refresh token is the only handle available.
	const tokenMatches = accounts.flatMap((account, index) =>
		account.refreshToken === identity.refreshToken ? [index] : [],
	);
	if (tokenMatches.length > 0) return tokenMatches[0] ?? -1;

	throw new Error(
		"Refresh identity is ambiguous after the persisted token rotated",
	);
}

/**
 * A stored record can be adopted instead of exchanged when another process has
 * already rotated the token AND left a usable access token behind.
 */
function canAdopt(
	target: AccountMetadataV3,
	identity: PersistedRefreshIdentity,
): boolean {
	return (
		target.refreshToken !== identity.refreshToken &&
		Boolean(target.accessToken) &&
		target.expiresAt !== undefined &&
		target.expiresAt > Date.now()
	);
}

function adoptPersistedRotation(
	target: AccountMetadataV3,
): CoordinatedRefreshSuccess {
	if (!target.accessToken || target.expiresAt === undefined) {
		throw new Error("Persisted rotated credentials are incomplete");
	}
	return {
		type: "success",
		access: target.accessToken,
		refresh: target.refreshToken,
		expires: target.expiresAt,
		// Carried so consumers that read these off a refresh result behave the same
		// on the adopt path as on the exchange path. There is no `idToken` to carry
		// — nothing persists one — but `extractAccountEmail` falls back to the
		// access token, so email hydration still resolves; `scope` has no such
		// fallback, and `proactive-refresh.ts` rebuilds a TokenResult from both.
		...(target.oauthScope ? { scope: target.oauthScope } : {}),
		multiAccount: true,
		adopted: true,
		rotatedAt: target.tokenRotatedAt,
	};
}

function nextRotationTimestamp(accounts: AccountMetadataV3[]): number {
	const latest = accounts.reduce(
		(maximum, account) => Math.max(maximum, account.tokenRotatedAt ?? 0),
		0,
	);
	return Math.max(Date.now(), latest + 1);
}

interface StorageShape {
	accounts: AccountMetadataV3[];
}

interface RotationCommitOutcome {
	/** Undefined when the provider did not rotate the token. */
	readonly rotatedAt?: number;
	/** Resolved seat identity used for the same-grant sibling filter. */
	readonly memberId?: string;
	/**
	 * True when the target record already carried a NEWER refresh token than
	 * the one we exchanged — a serial rotation committed by another process
	 * while our provider call was in flight (i.e. the refresh lease was lost
	 * mid-exchange). Nothing was written in that case; `adoptedRefreshToken`
	 * is the live token now on disk.
	 */
	readonly adopted?: boolean;
	readonly adoptedRefreshToken?: string;
}

type TransactionRunner<T extends StorageShape> = <R>(
	handler: (current: T, persist: (storage: T) => Promise<void>) => Promise<R>,
) => Promise<R>;

/**
 * Write the rotated refresh token onto every record still holding the consumed
 * one.
 *
 * The member guard mirrors the in-file sibling filter in {@link commitRotation}:
 * when a member id is known, a record that names a DIFFERENT member belongs to a
 * different seat's grant and is left alone. Records carry the rotated refresh
 * token plus an expired-access marker (`expiresAt = 0`) — never another seat's
 * access token — so each one re-derives its own workspace-scoped credential on
 * next use.
 *
 * Returns the number of records updated.
 */
function stampConsumedTokenRotation(
	accounts: AccountMetadataV3[],
	exchangedToken: string,
	memberId: string | undefined,
	newRefreshToken: string,
	rotatedAt: number,
): number {
	let updated = 0;
	for (const account of accounts) {
		if (account.refreshToken !== exchangedToken) continue;
		if (
			memberId &&
			account.accountUserId?.trim() &&
			account.accountUserId.trim() !== memberId
		) {
			continue;
		}
		account.refreshToken = newRefreshToken;
		account.expiresAt = 0;
		account.tokenRotatedAt = rotatedAt;
		updated += 1;
	}
	return updated;
}

/**
 * Open one credential store and stamp the rotated token onto every record still
 * holding the consumed one, persisting only when something changed.
 *
 * `rotatedAt` pins the rotation stamp when the primary commit produced one (the
 * happy path, so both stores carry the same stamp). When it is absent — the
 * salvage and journal-replay paths, where the primary commit never ran — the
 * stamp is computed per store so it stays monotonic against whatever is already
 * persisted there.
 */
async function applyRotationToStore(
	store: "accounts" | "flagged",
	exchangedToken: string,
	memberId: string | undefined,
	newRefreshToken: string,
	rotatedAt?: number,
): Promise<number> {
	const apply = (accounts: AccountMetadataV3[]): number =>
		stampConsumedTokenRotation(
			accounts,
			exchangedToken,
			memberId,
			newRefreshToken,
			rotatedAt ?? nextRotationTimestamp(accounts),
		);

	if (store === "flagged") {
		let updated = 0;
		await withFlaggedAccountStorageTransaction(async (current, persist) => {
			updated = apply(current.accounts);
			if (updated > 0) {
				await persist(current);
			}
		});
		return updated;
	}

	let updated = 0;
	await withAccountStorageTransaction(async (current, persist) => {
		if (!current) return;
		updated = apply(current.accounts);
		if (updated > 0) {
			await persist(current);
		}
	});
	return updated;
}

/**
 * Apply a rotation committed to one credential store to the records still
 * holding the consumed token in the OTHER store.
 *
 * The main and flagged files each hold a copy of a quarantined account, and
 * both copies share one single-use refresh token. Without this step the side
 * that did not refresh keeps the consumed token; whichever copy refreshes
 * next then re-exchanges it, gets `refresh_token_reused`, and a healthy
 * account is flagged until the user logs in again — despite a valid rotated
 * credential sitting in the pool.
 *
 * This runs as a SEPARATE transaction opened only after the primary commit
 * has fully released its storage lease. Nesting a second
 * `withStorageTransaction` inside the first is a lock-ordering hazard, so
 * the sibling write happens sequentially while still inside the refresh
 * lease — the same lease the sibling store's own coordinated refresh takes.
 * While it is held no other process can be mid-exchange on this token, so
 * the propagation is race-free even though it is not atomic with the
 * primary commit.
 *
 * Best effort: a sibling-write failure leaves the sibling store exactly as
 * stale as it was before propagation existed, so the error is logged and
 * the committed refresh still reports success. The pending-rotation journal
 * is deliberately left behind in that case so the next refresh heals the
 * sibling instead of burning the consumed token.
 */
async function propagateRotationToSiblingStore(
	sibling: "accounts" | "flagged",
	exchangedToken: string,
	memberId: string | undefined,
	newRefreshToken: string,
	rotatedAt: number,
): Promise<number> {
	return applyRotationToStore(
		sibling,
		exchangedToken,
		memberId,
		newRefreshToken,
		rotatedAt,
	);
}

// ---------------------------------------------------------------------------
// Pending-rotation journal
//
// The provider consumes the single-use refresh token the moment the exchange
// is processed, but the replacement only becomes durable at commit time. A
// process killed — or a primary commit that cannot land because the record
// moved to the sibling store — in that gap leaves the consumed token on disk
// while the live rotated token dies in memory. The next refresh then presents
// the consumed token and gets `refresh_token_reused`: a permanently dead
// account.
//
// The journal is a tiny sidecar at `<accounts>.refresh.pending` written AFTER
// the exchange succeeds and deleted only once the rotation is durably applied
// to every store that still held the consumed token. It deliberately carries
// only the rotated refresh token — never an access token — so a recovered
// record is expired-access (`expiresAt = 0`) and re-derives a workspace-scoped
// access token on its next exchange.
//
// Residual: a SIGKILL between the provider response landing and the journal
// write itself (a sub-millisecond window, versus the whole commit round trip
// without it) can still lose the rotation; nothing short of a provider-side
// idempotency key closes that last gap.
// ---------------------------------------------------------------------------

interface PendingRotationJournal {
	readonly version: 1;
	/** The single-use refresh token the provider has already consumed. */
	readonly consumedRefreshToken: string;
	/** Its live replacement, returned by the completed exchange. */
	readonly rotatedRefreshToken: string;
	/** Seat identity for the same-grant filter, mirroring commitRotation. */
	readonly memberId?: string;
	readonly recordedAt: number;
}

function pendingRotationJournalPath(storagePath: string): string {
	return `${storagePath}.refresh.pending`;
}

async function writePendingRotationJournal(
	journalPath: string,
	journal: PendingRotationJournal,
): Promise<void> {
	try {
		await writeFileAtomic(journalPath, JSON.stringify(journal, null, 2));
	} catch (error) {
		// Best effort: a missing journal is no worse than the pre-journal code.
		logWarn(
			`Failed to journal an in-flight token rotation at ${journalPath}; a crash before the commit could lose it: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

async function deletePendingRotationJournal(journalPath: string): Promise<void> {
	try {
		await rm(journalPath, { force: true });
	} catch (error) {
		// A leftover journal is harmless — replay is idempotent — so this is
		// only worth a warning.
		logWarn(
			`Failed to remove the pending-rotation journal at ${journalPath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

async function readPendingRotationJournal(
	journalPath: string,
): Promise<PendingRotationJournal | undefined> {
	let raw: string;
	try {
		raw = await readFile(journalPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
			return undefined;
		}
		logWarn(
			`Failed to read the pending-rotation journal at ${journalPath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<PendingRotationJournal>;
		if (
			parsed?.version === 1 &&
			typeof parsed.consumedRefreshToken === "string" &&
			parsed.consumedRefreshToken.length > 0 &&
			typeof parsed.rotatedRefreshToken === "string" &&
			parsed.rotatedRefreshToken.length > 0
		) {
			return parsed as PendingRotationJournal;
		}
	} catch {
		// Fall through to the malformed-journal path below.
	}
	// A malformed journal can never be satisfied; leaving it would poison every
	// future refresh, so it is removed rather than retried.
	logWarn(`Discarding a malformed pending-rotation journal at ${journalPath}`);
	await deletePendingRotationJournal(journalPath);
	return undefined;
}

/**
 * Replay a leftover rotation journal, if one exists. Runs inside the refresh
 * lease — the same lease that serialized the exchange — so no other process
 * can be mid-exchange on the recorded token while we heal it. Any record in
 * either store still holding the consumed token is stamped with the rotated
 * replacement, then the journal is removed.
 *
 * @returns `true` when no journal remains (absent or fully replayed);
 *   `false` when a journal exists but could not be fully applied. The caller
 *   MUST NOT proceed to a fresh exchange in the `false` case: the journal is
 *   the only durable record of a consumed token's replacement, and the new
 *   exchange's journal write is a single slot — it would overwrite and lose
 *   the earlier rotation while the consumed records it was healing still
 *   point at a dead token.
 */
async function recoverPendingRotation(storagePath: string): Promise<boolean> {
	const journalPath = pendingRotationJournalPath(storagePath);
	const journal = await readPendingRotationJournal(journalPath);
	if (!journal) return true;

	for (const store of ["accounts", "flagged"] as const) {
		try {
			const healed = await applyRotationToStore(
				store,
				journal.consumedRefreshToken,
				journal.memberId,
				journal.rotatedRefreshToken,
			);
			if (healed > 0) {
				logInfo(
					`Recovered ${healed} record(s) in the ${store} store from a pending rotation journal`,
				);
			}
		} catch (error) {
			logWarn(
				`Failed to replay the pending rotation journal against the ${store} store; leaving it for the next refresh: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return false;
		}
	}
	await deletePendingRotationJournal(journalPath);
	return true;
}

/**
 * Apply a completed exchange to the freshly loaded storage.
 *
 * `persistAccessToken` is false for flagged storage: `normalizeFlaggedStorage`
 * intentionally keeps quarantined records credential-light, so writing a live
 * access token there would put it on disk only for it to be dropped on the next
 * read.
 */
function commitRotation(
	current: StorageShape,
	identity: PersistedRefreshIdentity,
	exchangedToken: string,
	refreshResult: Extract<TokenResult, { type: "success" }>,
	persistAccessToken: boolean,
): RotationCommitOutcome {
	const index = findRefreshTarget(current.accounts, identity);
	const target = current.accounts[index];
	if (!target) {
		throw new Error("Account was removed before its token could refresh");
	}

	if (
		target.refreshToken !== exchangedToken &&
		target.refreshToken !== refreshResult.refresh
	) {
		// The persisted record already carries a NEWER refresh token than the
		// one we just exchanged: another lease holder rotated serially while
		// our provider call was in flight (the refresh lease was lost
		// mid-exchange). Writing `refreshResult.refresh` now would clobber a
		// live token with one the provider has already consumed — the exact
		// dead-account outcome the rotation journal exists to prevent. Adopt
		// the persisted token instead; the caller rewrites the journal to it so
		// records still holding `exchangedToken` get healed with a LIVE token.
		return {
			adopted: true,
			adoptedRefreshToken: target.refreshToken,
			memberId:
				identity.accountUserId?.trim() || target.accountUserId?.trim() ||
				undefined,
			rotatedAt: target.tokenRotatedAt,
		};
	}

	const rotated = refreshResult.refresh !== exchangedToken;
	const targetMemberId = identity.accountUserId?.trim() || target.accountUserId?.trim();
	const siblings = current.accounts.filter(
		(account) =>
			account.refreshToken === exchangedToken &&
			(!targetMemberId ||
				!account.accountUserId?.trim() ||
				account.accountUserId.trim() === targetMemberId),
	);
	const rotatedAt = rotated ? nextRotationTimestamp(current.accounts) : undefined;
	if (rotated) {
		for (const sibling of siblings) {
			// Siblings share the OAuth grant but can belong to distinct orgs, so they
			// get the rotated refresh token and an expired access token — never the
			// target's access token, which is scoped to the target's workspace. The
			// zeroed expiry forces each sibling to run its own exchange with the
			// now-current token when it is next selected.
			sibling.refreshToken = refreshResult.refresh;
			sibling.expiresAt = 0;
			sibling.tokenRotatedAt = rotatedAt;
		}
	}

	target.refreshToken = refreshResult.refresh;
	target.accountUserId =
		extractAccountUserId(refreshResult.access) ?? target.accountUserId;
	if (persistAccessToken) {
		target.accessToken = refreshResult.access;
		target.expiresAt = refreshResult.expires;
	} else {
		delete target.accessToken;
		delete target.expiresAt;
	}
	if (refreshResult.scope) {
		target.oauthScope = refreshResult.scope;
	}
	if (rotatedAt !== undefined) {
		target.tokenRotatedAt = rotatedAt;
	}
	return { rotatedAt, memberId: targetMemberId };
}

/**
 * Salvage the rotated refresh token when the primary commit could not land.
 *
 * The provider has already consumed `exchangedToken`, so any record still
 * holding it — here or in the sibling store — is a dead credential on disk.
 * Whatever remains of the account needs the rotated token instead. This stamps
 * it onto every record still holding the consumed token in BOTH stores, under
 * the same member guard as the commit path. Failures are logged and absorbed:
 * the pending-rotation journal is left behind so the next lease holder replays
 * it, and the caller still receives the live credential for in-memory use.
 */
async function salvageConsumedRotation<T extends StorageShape>(
	runTransaction: TransactionRunner<T>,
	siblingStore: "accounts" | "flagged",
	exchangedToken: string,
	memberId: string | undefined,
	newRefreshToken: string,
): Promise<number> {
	let healed = 0;
	try {
		healed += await runTransaction<number>(async (current, persist) => {
			const updated = stampConsumedTokenRotation(
				current.accounts,
				exchangedToken,
				memberId,
				newRefreshToken,
				nextRotationTimestamp(current.accounts),
			);
			if (updated > 0) {
				await persist(current);
			}
			return updated;
		});
	} catch (error) {
		logWarn(
			`Failed to salvage a rotated refresh token into the primary store; the pending-rotation journal covers it: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	try {
		healed += await applyRotationToStore(
			siblingStore,
			exchangedToken,
			memberId,
			newRefreshToken,
		);
	} catch (error) {
		logWarn(
			`Failed to salvage a rotated refresh token into the ${siblingStore} store; the pending-rotation journal covers it: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	return healed;
}

/**
 * Refresh a persisted credential without holding a storage lease across the
 * provider round trip.
 *
 * Under the refresh lease, which serializes the exchange across processes
 * because refresh tokens are single-use:
 *  0. any pending-rotation journal left by a process that died between
 *     exchange and commit is replayed, healing both stores;
 *  1. a short storage transaction adopts a rotation another process already
 *     committed, or else reports the authoritative current token;
 *  2. the provider exchange runs with NO storage lease held — but only after
 *     a synchronous lease re-verification, so a lease stolen during an event
 *     loop stall can never be used to spend the token;
 *  3. the consumed→rotated mapping is journaled, then a short storage
 *     transaction commits the rotation;
 *  4. if the commit cannot land — the record moved to the sibling store
 *     mid-exchange, or the storage lease stayed contended — the rotation is
 *     salvaged onto every record still holding the consumed token in BOTH
 *     stores and the journal is left for the next lease holder.
 *
 * Steps 1 and 3 hold the storage lease only for a local read/write, so
 * unrelated writers (`codex-note`, `codex-tag`, account toggles, rotation
 * stamps, TUI quota writes) never queue behind the network call.
 *
 * The refresh lease is keyed on the *accounts* storage path even for flagged
 * storage. That is deliberate: a quarantined record and an active one can share
 * a refresh token, and one lease over both keeps them from exchanging it twice.
 * The same lease also covers the cross-store propagation in
 * {@link propagateRotationToSiblingStore}, which is what keeps the store that
 * did not refresh from re-exchanging the consumed token.
 */
async function coordinateRefresh<T extends StorageShape>(
	identity: PersistedRefreshIdentity,
	runTransaction: TransactionRunner<T>,
	persistAccessToken: boolean,
	siblingStore: "accounts" | "flagged",
): Promise<CoordinatedRefreshResult> {
	type Probe =
		| { kind: "adopt"; result: CoordinatedRefreshSuccess }
		| { kind: "exchange"; token: string; memberId: string | undefined };

	const probe = (): Promise<Probe> =>
		runTransaction<Probe>((current) => {
			const index = findRefreshTarget(current.accounts, identity);
			const target = current.accounts[index];
			if (!target) {
				throw new Error("Account was removed before its token could refresh");
			}
			if (canAdopt(target, identity)) {
				return Promise.resolve<Probe>({
					kind: "adopt",
					result: adoptPersistedRotation(target),
				});
			}
			return Promise.resolve<Probe>({
				kind: "exchange",
				token: target.refreshToken,
				// Resolved the same way commitRotation resolves targetMemberId, so
				// the journal/salvage member guard matches what a commit would do.
				memberId:
					identity.accountUserId?.trim() ||
					target.accountUserId?.trim() ||
					undefined,
			});
		});

	const storagePath = getStoragePath();
	return withRefreshLease(storagePath, async (lease) => {
		// A predecessor may have completed the provider exchange and then died
		// before committing (or the commit may have missed a record that moved
		// stores). The journal, if any, is replayed first so this refresh never
		// spends a token that is already consumed.
		const journalClear = await recoverPendingRotation(storagePath);
		if (!journalClear) {
			// A pending journal could not be fully replayed (one of the stores
			// is unreachable). Its rotated token is the only live credential
			// for the records it is healing — proceeding to our own exchange
			// would overwrite the single journal slot with a NEW pending entry
			// and strand that rotation permanently. Surface a retryable
			// contention error instead: the next lease holder retries the
			// replay before spending anything.
			throw new StorageTransactionContentionError(
				`${storagePath} (pending rotation journal replay incomplete)`,
			);
		}

		// Probed INSIDE the lease, not before it: whoever held the lease may have
		// just committed a rotation, and reading first would race with them. The
		// lease is a local file operation, so paying for it up front is cheaper
		// than an avoidable second exchange of a single-use token.
		const probed = await probe();
		if (probed.kind === "adopt") return probed.result;

		const exchangedToken = probed.token;
		// The probe reads from disk, which on a starved event loop or a slow
		// network volume can outlast the lease heartbeat. assertValid re-verifies
		// the lock dir synchronously — it does not trust the heartbeat's
		// compromised flag, which a starved loop cannot run — so a lease that was
		// stolen (or became claimable) while we probed can never be used to spend
		// this single-use token. The thrown error is classified retryable, so
		// the caller retries with a fresh lease.
		lease.assertValid();
		const refreshResult = await queuedRefresh(exchangedToken);
		if (refreshResult.type !== "success") {
			return refreshResult;
		}

		const rotated = refreshResult.refresh !== exchangedToken;
		const journalPath = pendingRotationJournalPath(storagePath);
		if (rotated) {
			// The provider has now invalidated `exchangedToken`; journal the
			// replacement BEFORE attempting the durable commit so a SIGKILL in
			// between is recoverable on the next refresh rather than fatal to the
			// account.
			await writePendingRotationJournal(journalPath, {
				version: 1,
				consumedRefreshToken: exchangedToken,
				rotatedRefreshToken: refreshResult.refresh,
				memberId: probed.memberId,
				recordedAt: Date.now(),
			});
		}

		// Post-exchange lease re-verification. The provider round trip can
		// outlast the stale window — especially on a starved event loop — and
		// let another holder take the lease and complete its own exchange+commit
		// while ours was in flight. A loss is logged, NOT raised: aborting now
		// would strand the rotated token, while the durable commit remains
		// safe — the commit-time adopt guard refuses to overwrite a newer
		// persisted token and the storage transaction serializes the write
		// itself. The pre-exchange check remains the gate on SPENDING the
		// token; this one only shapes the commit's view of the world.
		try {
			lease.assertValid();
		} catch (error) {
			logWarn(
				`Refresh lease was lost while the provider exchange was in flight; the journal is written and the commit adopts rather than clobbers a newer persisted token: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}

		// Contention is the one failure worth retrying here: a real I/O error
		// (a full disk, a read-only volume) will not resolve itself, and
		// swallowing it behind retries would just delay reporting it.
		let commit: RotationCommitOutcome | undefined;
		let commitError: unknown;
		for (let attempt = 1; ; attempt += 1) {
			try {
				commit = await runTransaction<RotationCommitOutcome>(
					async (current, persist) => {
						const outcome = commitRotation(
							current,
							identity,
							exchangedToken,
							refreshResult,
							persistAccessToken,
						);
						// An adopted outcome mutated nothing — persisting would
						// rewrite identical bytes.
						if (!outcome.adopted) {
							await persist(current);
						}
						return outcome;
					},
				);
				break;
			} catch (error) {
				const retryable =
					error instanceof StorageTransactionContentionError &&
					attempt < COMMIT_ATTEMPTS;
				if (!retryable) {
					commitError = error;
					break;
				}
				logWarn(
					`Retrying the commit of a rotated refresh token (attempt ${attempt}/${COMMIT_ATTEMPTS}): ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}

		if (commit === undefined) {
			if (!rotated) {
				// The provider did not rotate, so the stored credential is still
				// live and nothing was consumed — the commit failure is an ordinary
				// storage error and keeps its original surfacing.
				throw commitError;
			}
			// The exchange consumed the token but no durable commit landed —
			// typically because the record moved to the sibling store mid-exchange
			// (quarantine racing a refresh). Salvage the rotated token onto every
			// record still holding the consumed one in BOTH stores and leave the
			// journal for the next lease holder to finish healing.
			const healed = await salvageConsumedRotation(
				runTransaction,
				siblingStore,
				exchangedToken,
				probed.memberId,
				refreshResult.refresh,
			);
			if (healed === 0) {
				// Nothing durable holds the rotated token — the journal is the
				// only trace of it, and it only heals on the NEXT refresh lease.
				// Surface the storage failure instead of claiming success on a
				// credential no store could keep; the journal makes the throw
				// recoverable rather than fatal to the account.
				throw commitError;
			}
			// A durable copy exists, so the caller can keep the live credential:
			// failing here would strand an in-memory account on a token the
			// provider has already burned.
			logWarn(
				`The rotation commit failed (${
					commitError instanceof Error ? commitError.message : String(commitError)
				}); salvaged the rotated refresh token onto ${healed} record(s) and left the journal for follow-up healing`,
			);
			return { ...refreshResult, adopted: false };
		}

		if (commit.adopted) {
			// A serial rotation committed while our exchange was in flight (the
			// lease was lost and another holder rotated again). Our replacement
			// token is now consumed as well, so the journal must point at the
			// ADOPTED token — the only live one — or replay would stamp a dead
			// credential onto records still holding `exchangedToken`. Leave the
			// journal in place: the next lease holder replays it and finishes
			// healing the stragglers.
			if (rotated && commit.adoptedRefreshToken) {
				await writePendingRotationJournal(journalPath, {
					version: 1,
					consumedRefreshToken: exchangedToken,
					rotatedRefreshToken: commit.adoptedRefreshToken,
					memberId: commit.memberId ?? probed.memberId,
					recordedAt: Date.now(),
				});
				logWarn(
					"A serial rotation committed while this refresh was in flight; adopted the persisted token and retargeted the pending-rotation journal at it",
				);
			}
			return {
				...refreshResult,
				refresh: commit.adoptedRefreshToken ?? refreshResult.refresh,
				adopted: true,
				rotatedAt: commit.rotatedAt,
			};
		}

		// The sibling store may still carry the consumed token for this same
		// account; propagate the rotation while the refresh lease is still
		// held so neither direction can re-exchange it (see the function's
		// docstring for the locking argument). Skipped when the provider did
		// not rotate: `exchangedToken` is still the live credential there.
		if (commit.rotatedAt !== undefined) {
			try {
				const propagated = await propagateRotationToSiblingStore(
					siblingStore,
					exchangedToken,
					commit.memberId,
					refreshResult.refresh,
					commit.rotatedAt,
				);
				if (propagated > 0) {
					logInfo(
						`Propagated the rotated refresh token to ${propagated} record(s) in the ${siblingStore} store`,
					);
				}
			} catch (error) {
				// The journal stays on disk, so the next refresh-lease holder
				// replays it and heals the sibling store instead of re-exchanging
				// the consumed token.
				logWarn(
					`Failed to propagate a rotated refresh token to the ${siblingStore} store; the pending-rotation journal remains for recovery: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				return { ...refreshResult, adopted: false, rotatedAt: commit.rotatedAt };
			}
		}
		if (rotated) {
			await deletePendingRotationJournal(journalPath);
		}

		return { ...refreshResult, adopted: false, rotatedAt: commit.rotatedAt };
	});
}

const runAccountTransaction: TransactionRunner<AccountStorageV3> = (handler) =>
	withAccountStorageTransaction(async (current, persist) => {
		if (!current) {
			throw new Error("Account storage is unavailable");
		}
		return handler(current, persist);
	});

const runFlaggedTransaction: TransactionRunner<FlaggedAccountStorageV1> = (handler) =>
	withFlaggedAccountStorageTransaction((current, persist) => handler(current, persist));

export async function coordinatePersistedRefresh(
	identity: PersistedRefreshIdentity,
): Promise<CoordinatedRefreshResult> {
	return coordinateRefresh(identity, runAccountTransaction, true, "flagged");
}

export async function coordinateFlaggedPersistedRefresh(
	identity: PersistedRefreshIdentity,
): Promise<CoordinatedRefreshResult> {
	return coordinateRefresh(identity, runFlaggedTransaction, false, "accounts");
}
