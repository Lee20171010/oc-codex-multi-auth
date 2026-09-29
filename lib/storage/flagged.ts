/**
 * Flagged-account storage: load/save/clear + transactional update.
 *
 * Split out of `lib/storage.ts` in RC-2. Flagged accounts live in a sibling
 * file next to the main accounts file and follow the same mutex, temp-file +
 * rename, and legacy-file migration pattern — just with a simpler V1-only
 * schema and different legacy filenames (flagged-accounts.json and the
 * older blocked-accounts.json).
 */

import { promises as fs, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  FLAGGED_ACCOUNTS_FILE_NAME,
  LEGACY_BLOCKED_ACCOUNTS_FILE_NAME,
  LEGACY_FLAGGED_ACCOUNTS_FILE_NAME,
} from "../constants.js";
import { createLogger } from "../logger.js";
import { extractAccountUserId } from "../auth/token-utils.js";
import { fsyncParentDirectory, writeFileAtomic } from "./atomic-write.js";
import { trySnapshotCredentialStoreBeforeWrite } from "./credential-snapshots.js";
import { StorageError } from "./errors.js";
import { getWorkspaceIdentityKey, isRecord } from "./identity.js";
import {
  listKeychainMigrationMarkers,
  migrateOnDiskJsonToKeychainBackup,
  retireKeychainMigrationArtifacts,
  syncKeychainMigrationMarkers,
} from "./load-save.js";
import {
  getStoragePath,
  getCurrentProjectStorageKey,
  withPinnedStorageScope,
  withStorageLock,
} from "./state.js";
import {
  assertTestRunNeverTouchesRealHome,
  TEST_HOME_ESCAPE_CODE,
} from "./test-home-guard.js";
import {
  deleteFlaggedFromKeychain,
  isKeychainOptInEnabled,
  readFlaggedFromKeychain,
  writeFlaggedToKeychain,
} from "./keychain.js";
import type { AccountMetadataV3 } from "./migrations.js";
import { withStorageTransaction } from "./transaction-lock.js";

const log = createLogger("storage");

/**
 * Symbolic path recorded on errors raised while decoding the keychain blob —
 * the blob has no on-disk path, so messages name the side they came from.
 */
const FLAGGED_KEYCHAIN_PATH = "keychain://oc-codex-multi-auth/accounts:flagged";

export interface FlaggedAccountMetadataV1 extends AccountMetadataV3 {
  flaggedAt: number;
  flaggedReason?: string;
  lastError?: string;
}

export interface FlaggedAccountStorageV1 {
  version: 1;
  accounts: FlaggedAccountMetadataV1[];
}

export function getFlaggedAccountsPath(): string {
  return join(dirname(getStoragePath()), FLAGGED_ACCOUNTS_FILE_NAME);
}

function getLegacyFlaggedAccountsPath(): string {
  return join(dirname(getStoragePath()), LEGACY_FLAGGED_ACCOUNTS_FILE_NAME);
}

function getLegacyBlockedAccountsPath(): string {
  return join(dirname(getStoragePath()), LEGACY_BLOCKED_ACCOUNTS_FILE_NAME);
}

export function normalizeFlaggedStorage(data: unknown, sourcePath?: string): FlaggedAccountStorageV1 {
  // Loud contract, mirroring normalizeAccountStorage: an unreadable or
  // unsupported flagged store must surface to the caller instead of becoming
  // an empty pool, because the caller would otherwise persist that empty
  // pool over real quarantined credentials.
  const resolvedPath = sourcePath ?? "<flagged store>";
  if (!isRecord(data)) {
    throw new StorageError(
      "Flagged account storage has an invalid format; refusing to replace it.",
      "INVALID_STORAGE",
      resolvedPath,
      "Restore the flagged accounts from a credential snapshot in the backups directory, or remove the file to start fresh.",
    );
  }
  const rawVersion = data.version;
  if (typeof rawVersion === "number" && Number.isFinite(rawVersion) && rawVersion > 1) {
    throw new StorageError(
      `Unsupported flagged account storage schema version ${rawVersion}; this plugin supports version 1.`,
      "UNSUPPORTED_SCHEMA_VERSION",
      resolvedPath,
      `The flagged account file at ${resolvedPath} was written by a newer version of this plugin (schema v${rawVersion}). Upgrade the plugin to a build that understands it, or back up and remove the file to start fresh.`,
    );
  }
  if (data.version !== 1 || !Array.isArray(data.accounts)) {
    throw new StorageError(
      "Flagged account storage has an invalid format; refusing to replace it.",
      "INVALID_STORAGE",
      resolvedPath,
      "Restore the flagged accounts from a credential snapshot in the backups directory, or remove the file to start fresh.",
    );
  }

  const byIdentityKey = new Map<string, FlaggedAccountMetadataV1>();
  for (const rawAccount of data.accounts) {
    if (!isRecord(rawAccount)) continue;
    const refreshToken =
      typeof rawAccount.refreshToken === "string" ? rawAccount.refreshToken.trim() : "";
    if (!refreshToken) continue;

    const flaggedAt = typeof rawAccount.flaggedAt === "number" ? rawAccount.flaggedAt : Date.now();
    const isAccountIdSource = (
      value: unknown,
    ): value is AccountMetadataV3["accountIdSource"] =>
      value === "token" || value === "id_token" || value === "org" || value === "manual";
    const isSwitchReason = (
      value: unknown,
    ): value is AccountMetadataV3["lastSwitchReason"] =>
      value === "rate-limit" || value === "initial" || value === "rotation";
    const isCooldownReason = (
      value: unknown,
    ): value is AccountMetadataV3["cooldownReason"] =>
      value === "auth-failure" || value === "network-error";
    const normalizeTags = (value: unknown): string[] | undefined => {
      if (!Array.isArray(value)) return undefined;
      const normalized = value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0);
      return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
    };

    let rateLimitResetTimes: AccountMetadataV3["rateLimitResetTimes"] | undefined;
    if (isRecord(rawAccount.rateLimitResetTimes)) {
      const normalizedRateLimits: Record<string, number | undefined> = {};
      for (const [key, value] of Object.entries(rawAccount.rateLimitResetTimes)) {
        if (typeof value === "number") {
          normalizedRateLimits[key] = value;
        }
      }
      if (Object.keys(normalizedRateLimits).length > 0) {
        rateLimitResetTimes = normalizedRateLimits;
      }
    }

    const accountIdSource = isAccountIdSource(rawAccount.accountIdSource)
      ? rawAccount.accountIdSource
      : undefined;
    const lastSwitchReason = isSwitchReason(rawAccount.lastSwitchReason)
      ? rawAccount.lastSwitchReason
      : undefined;
    const cooldownReason = isCooldownReason(rawAccount.cooldownReason)
      ? rawAccount.cooldownReason
      : undefined;
    const accountTags = normalizeTags(rawAccount.accountTags);
    const accountNote =
      typeof rawAccount.accountNote === "string" && rawAccount.accountNote.trim()
        ? rawAccount.accountNote.trim()
        : undefined;

    const normalized: FlaggedAccountMetadataV1 = {
      refreshToken,
      addedAt: typeof rawAccount.addedAt === "number" ? rawAccount.addedAt : flaggedAt,
      lastUsed: typeof rawAccount.lastUsed === "number" ? rawAccount.lastUsed : flaggedAt,
      organizationId:
        typeof rawAccount.organizationId === "string" ? rawAccount.organizationId : undefined,
      accountId: typeof rawAccount.accountId === "string" ? rawAccount.accountId : undefined,
      accountUserId:
        (typeof rawAccount.accountUserId === "string" && rawAccount.accountUserId.trim()) ||
        extractAccountUserId(
          typeof rawAccount.accessToken === "string" ? rawAccount.accessToken : undefined,
        ),
      accountIdSource,
      accountLabel: typeof rawAccount.accountLabel === "string" ? rawAccount.accountLabel : undefined,
      // Carried like accountLabel: this normalizer rebuilds records field by
      // field, so a field it does not name is dropped on the way through
      // quarantine and the restored account reports an unknown plan until the
      // next login or token refresh.
      planType: typeof rawAccount.planType === "string" ? rawAccount.planType : undefined,
      accountTags,
      accountNote,
      email: typeof rawAccount.email === "string" ? rawAccount.email : undefined,
      enabled: typeof rawAccount.enabled === "boolean" ? rawAccount.enabled : undefined,
      lastSwitchReason,
      rateLimitResetTimes,
      coolingDownUntil:
        typeof rawAccount.coolingDownUntil === "number" ? rawAccount.coolingDownUntil : undefined,
      quotaExhaustedUntil:
        typeof rawAccount.quotaExhaustedUntil === "number" ? rawAccount.quotaExhaustedUntil : undefined,
      // Provenance/tombstone for the quota stamp: carried so a restore does
      // not produce a stamp the cross-process merge treats as undated.
      quotaExhaustedStampAt:
        typeof rawAccount.quotaExhaustedStampAt === "number" ? rawAccount.quotaExhaustedStampAt : undefined,
      quotaExhaustedClearedAt:
        typeof rawAccount.quotaExhaustedClearedAt === "number" ? rawAccount.quotaExhaustedClearedAt : undefined,
      // The auto-redeem window claim travels with a quarantined account so a
      // restore does not re-arm a spend another process already claimed.
      autoRedeemWeeklyResetAt:
        typeof rawAccount.autoRedeemWeeklyResetAt === "number" ? rawAccount.autoRedeemWeeklyResetAt : undefined,
      cooldownReason,
      flaggedAt,
      flaggedReason: typeof rawAccount.flaggedReason === "string" ? rawAccount.flaggedReason : undefined,
      lastError: typeof rawAccount.lastError === "string" ? rawAccount.lastError : undefined,
      // Rotation ordering has to survive a round trip through this file, or a
      // rotated refresh token committed by `coordinateFlaggedPersistedRefresh`
      // looks older than a stale in-memory snapshot and gets clobbered.
      // `accessToken`/`expiresAt` are deliberately NOT carried: quarantined
      // records stay credential-light, so a live OAuth access token is never
      // written to flagged-accounts.json.
      tokenRotatedAt:
        typeof rawAccount.tokenRotatedAt === "number" ? rawAccount.tokenRotatedAt : undefined,
    };
    // Keep flagged dedup aligned with active cleanup so sibling workspaces only
    // collapse when they resolve to the same shared workspace identity.
    byIdentityKey.set(getWorkspaceIdentityKey(normalized), normalized);
  }

  return {
    version: 1,
    accounts: Array.from(byIdentityKey.values()),
  };
}

async function loadFlaggedAccountsUnlocked(
  saveUnlocked: (storage: FlaggedAccountStorageV1) => Promise<void>,
): Promise<FlaggedAccountStorageV1> {
  const path = getFlaggedAccountsPath();
  const empty: FlaggedAccountStorageV1 = { version: 1, accounts: [] };

  // Keychain-first when opt-in is enabled, mirroring the main account store.
  // A null/throw is treated as "fall back to JSON" — never as "no flagged
  // accounts" — so a locked keychain doesn't hide the on-disk copy.
  if (isKeychainOptInEnabled()) {
    try {
      const blob = await readFlaggedFromKeychain(getCurrentProjectStorageKey());
      if (blob !== null) {
        try {
          return normalizeFlaggedStorage(
            JSON.parse(blob.replace(/^\uFEFF/, "")) as unknown,
            FLAGGED_KEYCHAIN_PATH,
          );
        } catch (parseErr) {
          // Bytes that are not our document (unreadable blob, empty payload
          // returned while the platform keychain was locked) keep the JSON
          // fallback — but a *recognized* typed failure, like a flagged store
          // written by a newer plugin, must propagate rather than be silently
          // downgraded into an empty pool.
          if (parseErr instanceof StorageError && parseErr.code !== "INVALID_STORAGE") {
            throw parseErr;
          }
          log.warn("keychain: flagged payload failed to parse; falling back to JSON", {
            error: String(parseErr),
          });
        }
      }
    } catch (err) {
      if (err instanceof StorageError && err.code !== "INVALID_STORAGE") {
        throw err;
      }
      log.warn("keychain: flagged read failed; falling back to JSON", {
        error: String(err),
      });
    }
  }

  try {
    const content = await fs.readFile(path, "utf-8");
    // A UTF-8 BOM is legal on disk but not to JSON.parse — strip before parse.
    const data = JSON.parse(content.replace(/^\uFEFF/, "")) as unknown;
    return normalizeFlaggedStorage(data, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // Loud contract: a present-but-unreadable or malformed sibling file is
      // surfaced, never replaced by an empty pool the next save would commit
      // over real quarantined credentials.
      if (error instanceof StorageError) throw error;
      throw new StorageError(
        `Failed to read flagged account storage: ${error instanceof Error ? error.message : String(error)}`,
        "INVALID_STORAGE",
        path,
        "Restore the flagged accounts from a credential snapshot in the backups directory, or remove the file to start fresh.",
      );
    }
  }

  // A missing flagged file with a `.migrated-to-keychain` marker present is
  // the interrupted-migration signature — the marker holds the last good
  // flagged store and must be read before concluding the pool is empty.
  // Newest-first: a VALID newest marker always wins so staler siblings can
  // never shadow it, but a CORRUPT newest must not hide the older ones —
  // an older parseable marker is a real snapshot and reporting empty lets
  // the next save permanently mask recoverable accounts (greptile P1 on
  // PR #280). Steady-state staleness is prevented at save time: each
  // successful keychain write mirrors the newest marker and retires the
  // rest, so an older file only survives when that sync never ran.
  for (const markerPath of await listKeychainMigrationMarkers(path)) {
    try {
      const markerData = JSON.parse(
        (await fs.readFile(markerPath, "utf-8")).replace(/^\uFEFF/, ""),
      ) as unknown;
      const migrated = normalizeFlaggedStorage(markerData, markerPath);
      log.warn(
        "Recovered flagged account storage from an interrupted keychain-migration marker; the canonical file was missing",
        { markerPath },
      );
      return migrated;
    } catch (markerErr) {
      if (
        markerErr instanceof StorageError &&
        markerErr.code !== "INVALID_STORAGE"
      ) {
        throw markerErr;
      }
      log.warn("keychain: skipping an unreadable flagged migration marker", {
        markerPath,
        error: String(markerErr),
      });
    }
  }

  for (const legacyPath of [getLegacyFlaggedAccountsPath(), getLegacyBlockedAccountsPath()]) {
    if (!existsSync(legacyPath)) {
      continue;
    }

    // Read and normalize first; the legacy file stays in place until the
    // migrated destination has been durably written, so a failed migration
    // leaves the credentials where a retry — or a manual restore — can find
    // them instead of stranding them behind a half-finished copy.
    let legacyContent: string;
    try {
      legacyContent = await fs.readFile(legacyPath, "utf-8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        continue;
      }
      throw new StorageError(
        `Failed to read legacy flagged account storage at ${legacyPath}: ${error instanceof Error ? error.message : String(error)}`,
        "FILE_READ_FAILED",
        legacyPath,
        `Fix permissions on ${legacyPath} or remove it to let the migration finish.`,
      );
    }

    let legacyData: unknown;
    try {
      legacyData = JSON.parse(legacyContent.replace(/^\uFEFF/, "")) as unknown;
    } catch {
      throw new StorageError(
        `Legacy flagged account storage at ${legacyPath} contains invalid JSON; refusing to discard it.`,
        "INVALID_STORAGE",
        legacyPath,
        `Restore a valid copy of ${legacyPath} from backup, or delete it to drop the quarantined accounts.`,
      );
    }

    const migrated = normalizeFlaggedStorage(legacyData, legacyPath);
    if (migrated.accounts.length > 0) {
      // saveUnlocked performs the snapshot + atomic write; a failure leaves
      // the legacy file untouched so the next load retries the migration.
      await saveUnlocked(migrated);
    }
    try {
      await fs.unlink(legacyPath);
      await fsyncParentDirectory(legacyPath);
    } catch {
      // Best effort cleanup — destination already holds the data; a stranded
      // source only means the migration repeats next load.
    }
    log.info("Migrated legacy flagged account storage", {
      from: legacyPath,
      to: path,
      accounts: migrated.accounts.length,
    });
    return migrated;
  }

  return empty;
}

/**
 * JSON-backend write for the flagged store. Split from
 * {@link saveFlaggedAccountsUnlocked} so the keychain migration path can use
 * it as the "refresh the on-disk copy" half of the marker contract — the
 * same shape the main store's `writeAccountsToPathUnlocked` plays there.
 */
async function writeFlaggedJsonToDisk(
  path: string,
  normalized: FlaggedAccountStorageV1,
  content: string,
): Promise<void> {
  try {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // This file retains live refresh tokens for quarantined accounts, so it
    // gets the same pre-write snapshot as the main account store — under the
    // same significance, retention, and test-home rules — before the rename
    // replaces what is on disk. Compared against the normalized payload for
    // the same reason `writeAccountsToPathUnlocked` does: a difference
    // normalization erases never costs a snapshot.
    await trySnapshotCredentialStoreBeforeWrite(path, normalized);
    await writeFileAtomic(path, content);
  } catch (error) {
    log.error("Failed to save flagged account storage", { path, error: String(error) });
    throw error;
  }
}

async function saveFlaggedAccountsUnlocked(storage: FlaggedAccountStorageV1): Promise<void> {
  const path = getFlaggedAccountsPath();
  assertTestRunNeverTouchesRealHome(path);
  const normalized = normalizeFlaggedStorage(storage);
  const content = JSON.stringify(normalized, null, 2);

  // When keychain opt-in is enabled, store flagged credentials in the OS
  // keychain like the main account store. Flagged records carry raw refresh
  // tokens (required to restore via verify-flagged), so writing them as
  // plaintext JSON would defeat the keychain protection the user opted into.
  // Deferred stale-entry retire (same contract as the main store): a refused
  // keychain write leaves an entry that can never be updated, but it is also
  // the only surviving copy until the JSON fallback lands — retire it only
  // after that write is durable.
  let retireFlaggedKeychainProjectKey: string | null | undefined;
  if (isKeychainOptInEnabled()) {
    const projectKey = getCurrentProjectStorageKey();
    // Same contract as the main store: retire the on-disk JSON BEFORE the
    // keychain write so a kill between the two steps leaves marker + keychain
    // at the old state rather than a fresh keychain entry beside a stale
    // canonical file. On rename failure the helper rewrites the file with the
    // fresh blob so the sides still agree.
    await migrateOnDiskJsonToKeychainBackup(path, () =>
      writeFlaggedJsonToDisk(path, normalized, content),
    );
    const result = await writeFlaggedToKeychain(projectKey, content);
    if (result.ok) {
      // Mirror the newest marker to the blob just written — a marker left
      // at the migration-time pool resurrects the pre-rotation flagged set
      // on the interrupted-migration fallback or an opt-out restore.
      await syncKeychainMigrationMarkers(path, content);
      return;
    }
    if (result.refused) {
      retireFlaggedKeychainProjectKey = projectKey;
    }
    log.warn("keychain: flagged write failed; falling back to JSON for this save", {
      error: result.error,
    });
  }

  await writeFlaggedJsonToDisk(path, normalized, content);
  if (retireFlaggedKeychainProjectKey !== undefined) {
    const cleared = await deleteFlaggedFromKeychain(
      retireFlaggedKeychainProjectKey,
    );
    log.warn("keychain: retired stale flagged entry after write refusal", {
      staleEntryCleared: cleared.deleted,
      ...(cleared.error ? { staleEntryDeleteError: cleared.error } : {}),
    });
  }
}

export async function loadFlaggedAccounts(): Promise<FlaggedAccountStorageV1> {
  return withPinnedStorageScope(() =>
    withStorageLock(async () => loadFlaggedAccountsUnlocked(saveFlaggedAccountsUnlocked)),
  );
}

/**
 * Executes a read-modify-write transaction for flagged account storage under the
 * shared storage lock so concurrent callers cannot lose updates.
 *
 * The transaction runs under `withPinnedStorageScope` with the same contract
 * as the main store's transaction: the flagged path captured at entry is the
 * path the filesystem lease covers, and a mid-transaction `setStoragePath`
 * scope flip cannot redirect this transaction's load/persist to a sibling
 * file the lease does not cover.
 */
export async function withFlaggedAccountStorageTransaction<T>(
  handler: (
    current: FlaggedAccountStorageV1,
    persist: (storage: FlaggedAccountStorageV1) => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  return withPinnedStorageScope(() =>
    withStorageTransaction({
      storagePath: getFlaggedAccountsPath(),
      load: () => loadFlaggedAccountsUnlocked(saveFlaggedAccountsUnlocked),
      persist: saveFlaggedAccountsUnlocked,
      handler,
    }),
  );
}

export async function saveFlaggedAccounts(storage: FlaggedAccountStorageV1): Promise<void> {
  return withPinnedStorageScope(() =>
    withStorageLock(async () => {
      await saveFlaggedAccountsUnlocked(storage);
    }),
  );
}

/**
 * Deletes the flagged account storage file from disk, and — when the keychain
 * opt-in is enabled — the flagged keychain entry as well.
 *
 * Ordering mirrors `clearAccounts` (F1 post-merge MEDIUM finding, applied to
 * the sibling store): unlink the on-disk JSON FIRST, then delete the keychain
 * entry. Clearing the keychain first while the unlink failed would let a
 * subsequent load take the "no keychain entry, fall back to JSON" branch of
 * `loadFlaggedAccountsUnlocked` and resurrect the flagged records from the
 * still-present file — and vice versa, which is the resurrection this
 * ordering exists to prevent. A partial failure therefore leaves both sides
 * present so the caller can retry, and the operation stays best-effort
 * (never throws) apart from the test-home guard.
 *
 * @throws StorageError (code `TEST_HOME_ESCAPE`) - see `clearAccounts`; the
 *   guard refuses the deletion, so absorbing it would report a clear that
 *   deliberately did not happen.
 */
export async function clearFlaggedAccounts(): Promise<void> {
  return withPinnedStorageScope(() =>
    withStorageTransaction({
      // Lease the same file the handler unlinks — pinned so a mid-clear scope
      // flip cannot make the unlink hit a location the lease does not cover.
      storagePath: getFlaggedAccountsPath(),
      load: () => Promise.resolve({ version: 1 as const, accounts: [] }),
      persist: () => Promise.resolve(),
      handler: async () => {
        const path = getFlaggedAccountsPath();
        let jsonCleared = true;
        try {
          assertTestRunNeverTouchesRealHome(path);
          // Deleting the store outright is unconditionally significant -
          // `null` says there is no successor document to compare against.
          await trySnapshotCredentialStoreBeforeWrite(path, null);
          await fs.unlink(path);
          // Flush the directory so the deletion itself is crash-durable.
          await fsyncParentDirectory(path);
        } catch (error) {
          // Same fail-loud rule as `clearAccounts`: the test-home guard
          // exists to fail a run that escaped its sandbox, so absorbing it
          // here would report a clear that deliberately did not happen.
          if (error instanceof StorageError && error.code === TEST_HOME_ESCAPE_CODE) {
            throw error;
          }
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            jsonCleared = false;
            log.error(
              "Failed to clear flagged account storage; skipping keychain delete to keep storage sides in sync. Caller should retry.",
              { error: String(error) },
            );
          }
        }

        // Only delete the flagged keychain entry after the on-disk copy is
        // gone (or was already absent). Leaving the keychain blob behind
        // would resurrect every cleared flagged account on the next
        // keychain-first load — the exact failure mode this function exists
        // to prevent. A FAILED delete is surfaced distinctly from "no entry
        // existed": the stale copy resurrects the cleared records just the
        // same as one that was never attempted.
        if (jsonCleared && isKeychainOptInEnabled()) {
          const projectKey = getCurrentProjectStorageKey();
          const result = await deleteFlaggedFromKeychain(projectKey);
          if (!result.deleted && result.error) {
            log.warn(
              "keychain: flagged delete during clearFlaggedAccounts failed; a stale keychain copy may survive and resurrect the cleared records on the next opt-in load",
              { error: result.error },
            );
          } else if (
            !result.deleted &&
            (await readFlaggedFromKeychain(projectKey)) !== null
          ) {
            // Same ambiguity as the main store: a `false` with no error is
            // "entry absent" or "backend refused silently" — and a survivor
            // resurrects the cleared pool on the next keychain-first load.
            log.error(
              "keychain: flagged entry survived the clearFlaggedAccounts delete; the cleared credentials remain reachable. Remove the keychain entry manually.",
            );
          }
        }

        // `.migrated-to-keychain` markers beside the flagged file hold the
        // same plaintext token set — a clear that leaves them behind has not
        // actually cleared the credentials, and the load fallback reads the
        // newest marker back into memory. Fail loudly on a stranded artefact
        // rather than report a successful partial clear.
        if (jsonCleared) {
          const stranded = await retireKeychainMigrationArtifacts(path);
          if (stranded.length > 0) {
            throw new StorageError(
              `Flagged account storage was cleared, but ${stranded.length} migration artefact(s) could not be removed and still hold the credential set`,
              "ARTIFACT_RETIRE_FAILED",
              stranded[0] ?? path,
              "Remove the leftover .migrated-to-keychain files beside the flagged accounts file, then retry the clear.",
            );
          }
        }
      },
    }),
  );
}
