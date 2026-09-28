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
  migrateOnDiskJsonToKeychainBackup,
  retireKeychainMigrationBackups,
} from "./load-save.js";
import { getStoragePath, getCurrentProjectStorageKey, withStorageLock } from "./state.js";
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

function normalizeFlaggedStorage(data: unknown): FlaggedAccountStorageV1 {
  if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.accounts)) {
    return { version: 1, accounts: [] };
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
          return normalizeFlaggedStorage(JSON.parse(blob.replace(/^\uFEFF/, "")) as unknown);
        } catch (parseErr) {
          log.warn("keychain: flagged payload failed to parse; falling back to JSON", {
            error: String(parseErr),
          });
        }
      }
    } catch (err) {
      log.warn("keychain: flagged read failed; falling back to JSON", {
        error: String(err),
      });
    }
  }

  try {
    const content = await fs.readFile(path, "utf-8");
    // A UTF-8 BOM is legal on disk but not to JSON.parse — strip before parse.
    const data = JSON.parse(content.replace(/^\uFEFF/, "")) as unknown;
    return normalizeFlaggedStorage(data);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      log.error("Failed to load flagged account storage", { path, error: String(error) });
      return empty;
    }
  }

  for (const legacyPath of [getLegacyFlaggedAccountsPath(), getLegacyBlockedAccountsPath()]) {
    if (!existsSync(legacyPath)) {
      continue;
    }

    try {
      const legacyContent = await fs.readFile(legacyPath, "utf-8");
      const legacyData = JSON.parse(legacyContent.replace(/^\uFEFF/, "")) as unknown;
      const migrated = normalizeFlaggedStorage(legacyData);
      if (migrated.accounts.length > 0) {
        await saveUnlocked(migrated);
      }
      try {
        await fs.unlink(legacyPath);
      } catch {
        // Best effort cleanup.
      }
      log.info("Migrated legacy flagged account storage", {
        from: legacyPath,
        to: path,
        accounts: migrated.accounts.length,
      });
      return migrated;
    } catch (error) {
      log.error("Failed to migrate legacy flagged account storage", {
        from: legacyPath,
        to: path,
        error: String(error),
      });
      return empty;
    }
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
  if (isKeychainOptInEnabled()) {
    const projectKey = getCurrentProjectStorageKey();
    const result = await writeFlaggedToKeychain(projectKey, content);
    if (result.ok) {
      // Same contract as the main store's post-keychain-write migration: the
      // on-disk JSON is preserved as a `.migrated-to-keychain.<ts>` rollback
      // artefact rather than deleted (or overwritten with the fresh blob when
      // the rename itself fails), so an opt-in toggle-off never resurrects a
      // stale flagged pool.
      await migrateOnDiskJsonToKeychainBackup(path, () =>
        writeFlaggedJsonToDisk(path, normalized, content),
      );
      return;
    }
    log.warn("keychain: flagged write failed; falling back to JSON for this save", {
      error: result.error,
    });
  }

  await writeFlaggedJsonToDisk(path, normalized, content);
}

export async function loadFlaggedAccounts(): Promise<FlaggedAccountStorageV1> {
  return withStorageLock(async () => loadFlaggedAccountsUnlocked(saveFlaggedAccountsUnlocked));
}

/**
 * Executes a read-modify-write transaction for flagged account storage under the
 * shared storage lock so concurrent callers cannot lose updates.
 */
export async function withFlaggedAccountStorageTransaction<T>(
  handler: (
    current: FlaggedAccountStorageV1,
    persist: (storage: FlaggedAccountStorageV1) => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
	return withStorageTransaction({
		storagePath: getFlaggedAccountsPath(),
		load: () => loadFlaggedAccountsUnlocked(saveFlaggedAccountsUnlocked),
		persist: saveFlaggedAccountsUnlocked,
		handler,
	});
}

export async function saveFlaggedAccounts(storage: FlaggedAccountStorageV1): Promise<void> {
  return withStorageLock(async () => {
    await saveFlaggedAccountsUnlocked(storage);
  });
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
  return withStorageLock(async () => {
    const path = getFlaggedAccountsPath();
    let jsonCleared = true;
    try {
      assertTestRunNeverTouchesRealHome(path);
      // Deleting the store outright is unconditionally significant - `null`
      // says there is no successor document to compare against.
      await trySnapshotCredentialStoreBeforeWrite(path, null);
      await fs.unlink(path);
      // Flush the directory so the deletion itself is crash-durable.
      await fsyncParentDirectory(path);
    } catch (error) {
      // Same fail-loud rule as `clearAccounts`: the test-home guard exists to
      // fail a run that escaped its sandbox, so absorbing it here would
      // report a clear that deliberately did not happen.
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

    // Only delete the flagged keychain entry after the on-disk copy is gone
    // (or was already absent). Leaving the keychain blob behind would
    // resurrect every cleared flagged account on the next keychain-first
    // load — the exact failure mode this function exists to prevent.
    if (jsonCleared && isKeychainOptInEnabled()) {
      const projectKey = getCurrentProjectStorageKey();
      try {
        await deleteFlaggedFromKeychain(projectKey);
        // `false` is ambiguous between "entry absent" and "backend refused"
        // — and a surviving entry serves the cleared pool on the next
        // keychain-first load. Verify with a read instead of trusting the
        // boolean, and surface a survivor loudly rather than reporting a
        // clear that did not happen.
        if ((await readFlaggedFromKeychain(projectKey)) !== null) {
          log.error(
            "keychain: flagged entry survived the clearFlaggedAccounts delete; the cleared credentials remain reachable. Remove the keychain entry manually.",
          );
        }
      } catch (err) {
        log.warn("keychain: flagged delete during clearFlaggedAccounts failed", {
          error: String(err),
        });
      }
    }

    // Flagged saves preserve the pre-keychain JSON as `.migrated-to-keychain`
    // backups — each one still carries flagged refresh tokens in plaintext
    // after the pool is cleared.
    if (jsonCleared) {
      await retireKeychainMigrationBackups(path);
    }
  });
}
