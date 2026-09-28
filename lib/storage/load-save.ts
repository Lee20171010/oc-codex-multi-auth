/**
 * Account storage load/save pipeline.
 *
 * Split out of `lib/storage.ts` in RC-2. This module owns:
 *   - the `.gitignore` side-effect when writing into a project repo,
 *   - the legacy project + global storage migrations triggered on ENOENT,
 *   - the atomic write (temp file + rename + EEMPTY guard),
 *   - and the `withAccountStorageTransaction` read-modify-write primitive
 *     that every mutating caller above the storage layer uses.
 *
 * Scope pinning: `loadAccounts`/`saveAccounts`/`clearAccounts`/
 * `withAccountStorageTransaction` all run under `withPinnedStorageScope`, so
 * the location resolved at entry — including the path the filesystem
 * transaction lease is taken on — is the location every read, write, and
 * keychain key inside the call resolves. A `setStoragePath` scope flip that
 * lands mid-transaction can no longer redirect a persist to a different
 * project store while the lease still names the old one.
 *
 * The error-handling contract is subtle and load-bearing: forward-compat
 * (`UNSUPPORTED_SCHEMA_VERSION`), unknown-V2 (`UNKNOWN_V2_FORMAT`), and
 * invalid/unreadable existing files (`INVALID_STORAGE`) MUST reach the
 * caller. Swallowing any of them would overwrite future-schema credentials,
 * silently discard a user's V2 file, or replace an unreadable store with an
 * empty pool — exactly the class of bug the audit flagged. For the same
 * reason a project-scoped ENOENT NEVER falls back to the live global file:
 * reading the global pool and writing a copy into the project store
 * duplicated single-use refresh tokens across scopes, so the first rotation
 * in either pool stranded the other copy.
 */

import { promises as fs, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { ACCOUNTS_FILE_NAME, LEGACY_ACCOUNTS_FILE_NAME } from "../constants.js";
import { createLogger } from "../logger.js";
import { AnyAccountStorageSchema, getValidationErrors } from "../schemas.js";
import {
  fsyncParentDirectory,
  renameWithWindowsRetry,
  writeFileAtomic,
} from "./atomic-write.js";
import { formatStorageErrorHint, StorageError } from "./errors.js";
import { normalizeAccountStorage } from "./normalize.js";
import { getConfigDir } from "./paths.js";
import {
  assertTestRunNeverTouchesRealHome,
  TEST_HOME_ESCAPE_CODE,
} from "./test-home-guard.js";
import {
  getCredentialArtifactRetentionLimit,
  pruneStorageArtifacts,
  trySnapshotCredentialStoreBeforeWrite,
} from "./credential-snapshots.js";
import {
  getCurrentLegacyProjectStoragePath,
  getCurrentProjectRoot,
  getCurrentProjectStorageKey,
  getCurrentStoragePath,
  getStoragePath,
  withPinnedStorageScope,
  withStorageLock,
} from "./state.js";
import {
  buildV2RecoveryHint,
  UNKNOWN_V2_FORMAT_CODE,
  type AccountStorageV3,
} from "./migrations.js";
import { acquireOrDetectLock } from "./worktree-lock.js";
import { withStorageTransaction } from "./transaction-lock.js";
import {
  isKeychainOptInEnabled,
  readFromKeychain,
  writeToKeychain,
  deleteFromKeychain,
} from "./keychain.js";
import os from "node:os";

const log = createLogger("storage");
let lastWrittenAccounts: { path: string; digest: string } | undefined;

export function consumeLastWrittenAccountsDigest(path = getStoragePath()): string | undefined {
  if (lastWrittenAccounts?.path !== path) return undefined;
  const digest = lastWrittenAccounts.digest;
  lastWrittenAccounts = undefined;
  return digest;
}
const COLLISION_WARNING_THROTTLE_MS = 60_000;
const COLLISION_WARNING_THROTTLE_MAX_ENTRIES = 128;
const collisionWarningTimes = new Map<string, number>();

export function __resetCollisionWarningThrottleForTests(): void {
  collisionWarningTimes.clear();
}

/**
 * Identity a collision warning is throttled against.
 *
 * Deliberately storage path + host only. Including the foreign `pid` and
 * `startedAt` meant a foreign holder that restarts - or several short-lived
 * sessions rotating - produced a brand new key on every probe, so the throttle
 * never fired and the log spam it exists to stop continued unabated. Those dead
 * identities also evicted live ones from the bounded map, which could stop a
 * genuinely recurring collision from ever being deduped.
 */
function collisionWarningKey(
  storagePath: string,
  foreign: { hostname: string },
): string {
  return JSON.stringify([storagePath, foreign.hostname]);
}

/** Pure query: has this identity already warned inside the current window? */
function hasWarnedForCollision(key: string, now: number): boolean {
  const warnedAt = collisionWarningTimes.get(key);
  if (warnedAt === undefined) return false;
  if (now < warnedAt) return false;
  return now - warnedAt < COLLISION_WARNING_THROTTLE_MS;
}

/**
 * Record a warning the caller has already emitted.
 *
 * Split from the check, and called after the emit, so a `log.warn` that throws
 * cannot leave the throttle believing it warned - which would silently suppress
 * the next 60s of collisions.
 */
function recordCollisionWarning(key: string, now: number): void {
  for (const [existingKey, warnedAt] of collisionWarningTimes) {
    if (now < warnedAt || now - warnedAt >= COLLISION_WARNING_THROTTLE_MS) {
      collisionWarningTimes.delete(existingKey);
    }
  }

  collisionWarningTimes.set(key, now);
  while (
    collisionWarningTimes.size > COLLISION_WARNING_THROTTLE_MAX_ENTRIES
  ) {
    const oldestKey = collisionWarningTimes.keys().next().value;
    if (oldestKey === undefined) break;
    collisionWarningTimes.delete(oldestKey);
  }
}

/**
 * Probes the worktree lock for the currently active storage path and surfaces
 * any foreign live lock as a non-fatal warning. The lock check is advisory:
 * Phase 4 F2 deliberately chose warn-over-block so a user with two legitimate
 * OpenCode sessions on the same project (separate worktrees, IDE + CLI) is
 * never stranded. The warning still carries enough detail (pid, host, cwd)
 * for the user to reconcile state manually if a rotation was lost to a race.
 *
 * Failure modes:
 *   - Storage path is not resolvable (no project, no global dir set): skip
 *     silently, the actual storage call will surface the real error.
 *   - Lock file unreadable (disk full, EACCES): log at debug so it cannot
 *     drown the normal "collision detected" warning, then continue. A broken
 *     sidecar must never gate auth-critical reads/writes.
 */
async function checkWorktreeLockForCurrentStorage(
  operation: "load" | "save",
): Promise<void> {
  let path: string;
  try {
    path = getStoragePath();
  } catch (error) {
    log.debug("Skipping worktree lock check: storage path unavailable", {
      error: String(error),
    });
    return;
  }
  // Before the probe, not inside the try: `acquireOrDetectLock` writes a lock
  // sidecar next to the accounts file, so a leaked HOME would touch the real
  // store here even on a pure read, and this function's catch would hide it.
  assertTestRunNeverTouchesRealHome(path);
  try {
    const result = await acquireOrDetectLock(path);
    if (!result.acquired && result.foreign) {
      const now = Date.now();
      const warningKey = collisionWarningKey(path, result.foreign);
      if (!hasWarnedForCollision(warningKey, now)) {
        log.warn("Multi-worktree collision detected on account storage", {
          operation,
          storagePath: path,
          foreignPid: result.foreign.pid,
          foreignHost: result.foreign.hostname,
          foreignCwd: result.foreign.cwd,
          foreignLastActive: result.foreign.lastActive,
          ourPid: process.pid,
          ourHost: os.hostname(),
          ourCwd: process.cwd(),
        });
        recordCollisionWarning(warningKey, now);
      }
    }
  } catch (error) {
    log.debug("Worktree lock probe failed", {
      operation,
      storagePath: path,
      error: String(error),
    });
  }
}

async function ensureGitignore(storagePath: string): Promise<void> {
  if (!getCurrentStoragePath()) return;

  const configDir = dirname(storagePath);
  const inferredProjectRoot = dirname(configDir);
  const candidateRoots = [getCurrentProjectRoot(), inferredProjectRoot].filter(
    (root): root is string => typeof root === "string" && root.length > 0,
  );
  const projectRoot = candidateRoots.find((root) => existsSync(join(root, ".git")));
  if (!projectRoot) return;
  const gitignorePath = join(projectRoot, ".gitignore");

  try {
    let content = "";
    if (existsSync(gitignorePath)) {
      content = await fs.readFile(gitignorePath, "utf-8");
      const lines = content.split("\n").map((l) => l.trim());
      if (lines.includes(".opencode") || lines.includes(".opencode/") || lines.includes("/.opencode") || lines.includes("/.opencode/")) {
        return;
      }
    }

    const newContent = content.endsWith("\n") || content === "" ? content : content + "\n";
    await fs.writeFile(gitignorePath, newContent + ".opencode/\n", "utf-8");
    log.debug("Added .opencode to .gitignore", { path: gitignorePath });
  } catch (error) {
    log.warn("Failed to update .gitignore", { error: String(error) });
  }
}

async function migrateStorageFileIfNeeded(
  legacyPath: string | null,
  nextPath: string,
  persist: (storage: AccountStorageV3) => Promise<void>,
  label: string,
): Promise<AccountStorageV3 | null> {
  // The test-home guard runs before any read of the legacy path so a leaked
  // HOME can never be probed by a test that escaped its sandbox.
  if (legacyPath) assertTestRunNeverTouchesRealHome(legacyPath);
  if (!legacyPath || legacyPath === nextPath || !existsSync(legacyPath)) {
    return null;
  }

  let legacyContent: string;
  try {
    legacyContent = await fs.readFile(legacyPath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Vanished between existsSync and readFile — genuinely absent.
    if (code === "ENOENT") return null;
    // A legacy file that exists but cannot be read must NOT look like "no
    // legacy file": the caller would proceed as though the pool were empty
    // and a later save would overwrite credentials it never saw.
    throw new StorageError(
      `Failed to read legacy ${label} at ${legacyPath}: ${error instanceof Error ? error.message : String(error)}`,
      code ?? "INVALID_STORAGE",
      legacyPath,
      "The existing legacy account file is unreadable. Repair it, restore it from a credential snapshot, or remove it to start fresh.",
      error instanceof Error ? error : undefined,
    );
  }

  // A UTF-8 BOM is legal on disk but not to JSON.parse — strip before parse.
  let legacyData: unknown;
  try {
    legacyData = JSON.parse(legacyContent.replace(/^\uFEFF/, "")) as unknown;
  } catch (error) {
    throw new StorageError(
      `Failed to parse legacy ${label} at ${legacyPath}: ${error instanceof Error ? error.message : String(error)}`,
      "INVALID_STORAGE",
      legacyPath,
      "The legacy account file is corrupt and was left in place untouched. Restore it from a credential snapshot in the backups directory, or remove it to start fresh.",
      error instanceof Error ? error : undefined,
    );
  }

  // normalizeAccountStorage throws typed StorageErrors for forward-compat
  // (UNSUPPORTED_SCHEMA_VERSION) and quarantined V2 payloads — let them reach
  // the caller verbatim so a future-schema or V2 file is never mistaken for
  // "nothing to migrate" and then silently stranded by an empty pool.
  const normalized = normalizeAccountStorage(legacyData, legacyPath);
  if (!normalized) {
    throw new StorageError(
      `Legacy ${label} at ${legacyPath} has an invalid format; refusing to replace it.`,
      "INVALID_STORAGE",
      legacyPath,
      "The legacy account file was left in place untouched. Restore the accounts from a credential snapshot in the backups directory, or remove the file to start fresh.",
    );
  }

  try {
    await persist(normalized);
  } catch (persistError) {
    // A failed persist leaves the legacy file in place, so nothing is lost:
    // return the migrated document anyway so the caller sees the real pool,
    // and the next load retries the write.
    log.warn(`Failed to persist migrated ${label}; legacy file kept`, {
      from: legacyPath,
      to: nextPath,
      error: String(persistError),
    });
    return normalized;
  }

  try {
    await fs.unlink(legacyPath);
    await fsyncParentDirectory(legacyPath);
    log.info(`Removed legacy ${label} after migration`, { path: legacyPath });
  } catch (unlinkError) {
    const code = (unlinkError as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      log.warn(`Failed to remove legacy ${label} after migration`, {
        path: legacyPath,
        error: String(unlinkError),
      });
    }
  }
  log.info(`Migrated legacy ${label}`, {
    from: legacyPath,
    to: nextPath,
    accounts: normalized.accounts.length,
  });
  return normalized;
}

async function migrateLegacyProjectStorageIfNeeded(
  persist: (storage: AccountStorageV3) => Promise<void>,
): Promise<AccountStorageV3 | null> {
  return migrateStorageFileIfNeeded(
    getCurrentLegacyProjectStoragePath(),
    getStoragePath(),
    persist,
    "project account storage",
  );
}

/**
 * Resolves the global (non-project) account storage path.
 */
function getGlobalAccountsStoragePath(): string {
  return join(getConfigDir(), ACCOUNTS_FILE_NAME);
}

function getLegacyGlobalAccountsStoragePath(): string {
  return join(getConfigDir(), LEGACY_ACCOUNTS_FILE_NAME);
}

async function migrateLegacyGlobalStorageIfNeeded(): Promise<AccountStorageV3 | null> {
  const nextPath = getGlobalAccountsStoragePath();
  const persistGlobalStorage = async (storage: AccountStorageV3): Promise<void> => {
    await writeAccountsToPathUnlocked(nextPath, storage);
  };

  return migrateStorageFileIfNeeded(
    getLegacyGlobalAccountsStoragePath(),
    nextPath,
    persistGlobalStorage,
    "global account storage",
  );
}


/**
 * Core account-loading routine shared by normal reads and transactional storage handlers.
 * Handles schema normalization, legacy migration, and optional fallback seeding.
 */
async function loadAccountsInternal(
  persistMigration: ((storage: AccountStorageV3) => Promise<void>) | null,
): Promise<AccountStorageV3 | null> {
  // Advisory: surface multi-worktree collisions before the read but never
  // block. Must come before the try/catch so a genuine storage error still
  // takes precedence over any lock-related log output below.
  await checkWorktreeLockForCurrentStorage("load");

  // Opt-in keychain backend. When `CODEX_KEYCHAIN=1` is set, the keychain
  // holds the authoritative V3 JSON blob and the on-disk file (if any) is
  // only kept as a post-migration rollback artefact. If the keychain lookup
  // fails for any reason (native module missing, keychain locked, no entry
  // yet) we fall through to the existing JSON load path so the plugin never
  // silently loses credentials. This preserves the default-off contract
  // default-off keychain contract.
  if (isKeychainOptInEnabled()) {
    const projectKey = getCurrentProjectStorageKey();
    try {
      const blob = await readFromKeychain(projectKey);
      if (blob !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(blob.replace(/^\uFEFF/, "")) as unknown;
        } catch (parseErr) {
          // Corrupt keychain entry: log but fall through to JSON so the
          // user can recover from their on-disk backup.
          log.warn("keychain: stored payload failed to parse; falling back to JSON", {
            error: String(parseErr),
          });
          parsed = undefined;
        }
        if (parsed !== undefined) {
          // normalizeAccountStorage throws typed StorageErrors for
          // forward-compat (UNSUPPORTED_SCHEMA_VERSION) and quarantined V2
          // payloads. These must NOT be swallowed here — otherwise a keychain
          // user silently falls through to an empty/JSON load and the next
          // save clobbers their future-format credentials. Let them propagate
          // exactly as the JSON path below does.
          const normalized = normalizeAccountStorage(parsed, "<keychain>");
          if (normalized) return normalized;
        }
      } else {
        log.info("keychain: no entry found; falling back to JSON read");
      }
    } catch (err) {
      // Forward-compat and quarantined-V2 rejects from normalizeAccountStorage
      // must reach the caller, not be downgraded to a JSON fallback that could
      // clobber the user's credentials on the next save (mirrors the JSON path).
      if (
        err instanceof StorageError &&
        (err.code === "UNSUPPORTED_SCHEMA_VERSION" ||
          err.code === UNKNOWN_V2_FORMAT_CODE)
      ) {
        throw err;
      }
      log.warn("keychain: read failed; falling back to JSON", {
        error: String(err),
      });
    }
  }

  try {
    const path = getStoragePath();
    const content = await fs.readFile(path, "utf-8");
    const data = JSON.parse(content.replace(/^\uFEFF/, "")) as unknown;

    const schemaErrors = getValidationErrors(AnyAccountStorageSchema, data);
    if (schemaErrors.length > 0) {
      log.warn("Account storage schema validation warnings", { errors: schemaErrors.slice(0, 5) });
    }

    const normalized = normalizeAccountStorage(data, path);
    if (!normalized) {
      throw new StorageError(
        "Account storage has an invalid format; refusing to replace it.",
        "INVALID_STORAGE",
        path,
        "Restore the accounts from a credential snapshot in the backups directory.",
      );
    }

    const storedVersion =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as { version?: unknown }).version
        : undefined;
    if (normalized && storedVersion !== normalized.version) {
      log.info("Migrating account storage to v3", { from: storedVersion, to: normalized.version });
      if (persistMigration) {
        try {
          await persistMigration(normalized);
        } catch (saveError) {
          log.warn("Failed to persist migrated storage", { error: String(saveError) });
        }
      }
    }

    return normalized;
  } catch (error) {
    // An existing but unreadable store must never become an empty account
    // pool: the next login or debounced save would replace its credentials.
    // Unknown-V2 detection must NOT be silently dropped: the catch below
    // swallows generic errors by design (keeps an unreadable file from
    // crashing the whole plugin), but V2 is a specific, recoverable case
    // where the user needs to know their credentials were quarantined.
    // Re-throw so the UI/CLI layer can render the recovery hint.
    if (error instanceof StorageError && error.code === UNKNOWN_V2_FORMAT_CODE) {
      // Annotate with the concrete storage path that triggered the reject
      // so the recovery hint points at the real file.
      const concretePath = (() => {
        try {
          return getStoragePath();
        } catch {
          return "";
        }
      })();
      if (concretePath) {
        throw new StorageError(
          error.message,
          UNKNOWN_V2_FORMAT_CODE,
          concretePath,
          buildV2RecoveryHint(concretePath),
          error,
        );
      }
      throw error;
    }
    if (error instanceof StorageError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // A missing canonical file with a `.migrated-to-keychain` marker still
      // present is the signature of a process that died (or a keychain write
      // that failed) between the pre-keychain rename and persisting the new
      // state. The marker holds the last good store — reads MUST see it or
      // the pool reports empty and the next save clobbers the credentials.
      // `path` was scoped to the try block, so re-resolve it the same way
      // the V2 recovery-hint block above does.
      const markerAnchor = (() => {
        try {
          return getStoragePath();
        } catch {
          return "";
        }
      })();
      for (const markerPath of markerAnchor
        ? await listKeychainMigrationMarkers(markerAnchor)
        : []) {
        try {
          const markerData = JSON.parse(
            (await fs.readFile(markerPath, "utf-8")).replace(/^\uFEFF/, ""),
          ) as unknown;
          const markerNormalized = normalizeAccountStorage(markerData, markerPath);
          if (markerNormalized) {
            log.warn(
              "Recovered account storage from an interrupted keychain-migration marker; the canonical file was missing",
              { markerPath },
            );
            return markerNormalized;
          }
        } catch (markerErr) {
          // A corrupt newest marker must not hide an older valid one — but
          // typed failures (forward schema, quarantined V2) stay loud exactly
          // as they do on the canonical path.
          if (
            markerErr instanceof StorageError &&
            markerErr.code !== "INVALID_STORAGE"
          ) {
            throw markerErr;
          }
          log.warn("keychain: skipping an unreadable migration marker", {
            markerPath,
            error: String(markerErr),
          });
        }
      }
      // Same-scope legacy migration only. A project-scoped ENOENT must NOT
      // fall back to the live global file: copying the global pool into the
      // project store duplicated single-use refresh tokens across scopes, so
      // the first rotation in either pool left the sibling copy holding a
      // consumed token (refresh_token_reused on its next refresh).
      const migrated = persistMigration
        ? await migrateLegacyProjectStorageIfNeeded(persistMigration)
        : null;
      if (migrated) return migrated;
      // The legacy global file only migrates when the caller is actually on
      // the global scope — a project-scoped or direct-override load must not
      // rewrite files belonging to another storage location.
      if (!getCurrentStoragePath() && persistMigration) {
        const migratedGlobal = await migrateLegacyGlobalStorageIfNeeded();
        if (migratedGlobal) return migratedGlobal;
      }
      return null;
    }
    const path = getStoragePath();
    const storageError = new StorageError(
      `Failed to load account storage: ${error instanceof Error ? error.message : String(error)}`,
      code ?? "INVALID_STORAGE",
      path,
      "The existing account file is unreadable. Restore it from a credential snapshot in the backups directory.",
      error instanceof Error ? error : undefined,
    );
    log.error("Failed to load account storage", { error: String(error) });
    throw storageError;
  }
}

/**
 * Writes account storage without acquiring the outer storage mutex.
 * Callers must already be inside withStorageLock when using this helper directly.
 */
async function writeAccountsToPathUnlocked(path: string, storage: AccountStorageV3): Promise<void> {
  assertTestRunNeverTouchesRealHome(path);

  try {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await ensureGitignore(path);

    // Normalize before persisting so every write path enforces dedup semantics
    // (exact identity dedupe plus legacy email dedupe for identity-less records).
    const normalizedStorage = normalizeAccountStorage(storage) ?? storage;
    // Preserve what is on disk now, before it is replaced. Compared against
    // the normalized payload rather than the caller's, so a difference
    // normalization erases never costs a snapshot. We are already inside
    // `withStorageLock`, so the captured state is exactly the state this write
    // supersedes.
    await trySnapshotCredentialStoreBeforeWrite(path, normalizedStorage);
    const content = JSON.stringify(normalizedStorage, null, 2);
    // The EEMPTY guard predates the temp+rename swap: a zero-byte payload must
    // never be published under the canonical name. Checking the serialized
    // bytes is equivalent to statting the temp file, minus the I/O.
    if (Buffer.byteLength(content, "utf-8") === 0) {
      const emptyError = Object.assign(new Error("File written but size is 0"), { code: "EEMPTY" });
      throw emptyError;
    }
    await writeFileAtomic(path, content);
    // Only a published write may suppress this process's live-reload watcher.
    lastWrittenAccounts = { path, digest: createHash("sha256").update(content).digest("hex") };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    const code = err?.code || "UNKNOWN";
    const hint = formatStorageErrorHint(error, path);

    log.error("Failed to save accounts", {
      path,
      code,
      message: err?.message,
      hint,
    });

    throw new StorageError(
      `Failed to save accounts: ${err?.message || "Unknown error"}`,
      code,
      path,
      hint,
      err instanceof Error ? err : undefined
    );
  }
}

/**
 * Pre-keychain-write retirement helper: if a legacy on-disk JSON file still
 * exists at `path`, rename it with a timestamped `.migrated-to-keychain.<ts>`
 * suffix instead of deleting it. Preserving the original file as a rollback
 * artefact is load-bearing: it is the user's explicit escape hatch if the
 * keychain backend turns out to be unreliable on their platform.
 *
 * Callers invoke this BEFORE the keychain write, not after it. Ordering the
 * rename first removes the crash window where the keychain already held the
 * new blob while the canonical JSON still held the old one: a kill between
 * the two steps now leaves marker + keychain at the same (old) state rather
 * than diverged, so a later `CODEX_KEYCHAIN` unset can never resurrect a
 * stale canonical file beside a fresh keychain entry.
 *
 * Shared by the main account store and the flagged sibling store, which gets
 * the same marker via `rewriteOnDisk` — the caller supplies the "refresh the
 * on-disk copy" half of the contract because each store serializes its own
 * document shape.
 *
 * Partial-failure handling (F1 post-merge HIGH finding): if the rename fails
 * (EACCES, EBUSY on Windows, disk full, parent dir permission drift) the file
 * at `path` would otherwise hold a stale-but-valid blob while the keychain
 * holds the authoritative fresh blob. This is safe while the opt-in is on
 * (keychain wins at load time) but silently resurrects stale credentials if
 * the user later unsets `CODEX_KEYCHAIN`. We resolve this by letting
 * `rewriteOnDisk` overwrite the file with the fresh normalized blob when the
 * rename fails so both sides agree, at the cost of losing that one rollback
 * artefact. This matches the "rollback invariant" documented in the F1
 * post-merge review (option (a)).
 */
export async function migrateOnDiskJsonToKeychainBackup(
  path: string,
  rewriteOnDisk: () => Promise<void>,
): Promise<void> {
  try {
    await fs.access(path);
  } catch {
    return; // No legacy file to migrate.
  }
  // The random nonce keeps marker names unique even when two migrations land
  // in the same millisecond (the previous timestamp-only suffix let a second
  // marker rename overwrite the first, destroying a rollback artefact).
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const nonce = randomBytes(3).toString("hex");
  const backup = `${path}.migrated-to-keychain.${timestamp}-${nonce}`;
  try {
    await renameWithWindowsRetry(path, backup);
    await fsyncParentDirectory(backup);
    // Re-apply 0o600 after rename (F1 post-merge LOW finding). POSIX
    // preserves mode across a rename in-place, but if the filesystem layer
    // or a prior process ever changed the mode (cp from a world-readable
    // source, umask drift on a foreign mount, manual `touch`) the backup
    // could end up group/world-readable. Re-chmod is a cheap belt-and-
    // braces guard. Windows ignores POSIX mode bits, so skip there.
    if (process.platform !== "win32") {
      try {
        await fs.chmod(backup, 0o600);
      } catch (chmodErr) {
        log.warn("keychain: failed to chmod backup to 0o600 after rename", {
          backup,
          error: String(chmodErr),
        });
      }
    }
    log.info("keychain: migrated on-disk JSON to keychain; original preserved for rollback", {
      from: path,
      backup,
    });
    // Bound the marker ring: every keychain save while a canonical JSON
    // exists leaves one behind, and each holds a full plaintext token set.
    // Prefix-scoped pruning keeps the newest few for rollback without
    // touching any other backup family in the same directory.
    await pruneStorageArtifacts(
      dirname(path),
      (name) => name.startsWith(`${basename(path)}.migrated-to-keychain.`),
      getCredentialArtifactRetentionLimit(),
    );
  } catch (err) {
    log.warn(
      "keychain: failed to rename on-disk JSON after successful keychain write; overwriting on-disk copy with fresh blob to prevent stale-rollback-on-opt-out",
      {
        path,
        error: String(err),
      },
    );
    try {
      await rewriteOnDisk();
    } catch (writeErr) {
      // Last-resort: on-disk refresh also failed. The keychain still
      // holds the authoritative blob so current operation succeeds, but
      // a subsequent opt-in toggle off would now surface the stale
      // file. Log at error so the operator can reconcile manually.
      log.error(
        "keychain: failed to refresh stale on-disk JSON after rename failure; opt-in toggle off may surface stale credentials",
        {
          path,
          error: String(writeErr),
        },
      );
    }
  }
}

/**
 * Remove every `.migrated-to-keychain.<ts>` rollback artefact beside
 * `storagePath`. Clear operations call this so a "delete all credentials"
 * request cannot leave a plaintext copy of the full token set sitting next
 * to the (now removed) store — an artefact a future `codex-keychain
 * rollback` or a casual `cat` would otherwise expose.
 *
 * Best-effort and strictly append-only on failure: each unlink failure is
 * warned about individually and never fails the enclosing clear, matching
 * the clear's own "partial failure warns, never throws" contract. Exported
 * for the flagged sibling store, whose clear shares the same contract.
 */
export async function retireKeychainMigrationArtifacts(
  storagePath: string,
): Promise<void> {
  const dir = dirname(storagePath);
  const prefix = `${basename(storagePath)}.migrated-to-keychain.`;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return; // Directory unreadable or absent — nothing to retire.
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const target = join(dir, name);
    try {
      await fs.unlink(target);
      await fsyncParentDirectory(target);
    } catch (err) {
      log.warn("keychain: failed to retire a migration artefact during clear", {
        target,
        error: String(err),
      });
    }
  }
}

/**
 * List `.migrated-to-keychain.<ts>` markers beside `storagePath`, newest
 * first. Loads use this as a recovery source: a process that died between
 * the pre-keychain rename and the keychain write leaves NO canonical file
 * while the marker still holds the last good store. Falling through to an
 * empty pool in that state would lose the accounts on the next save.
 *
 * Sorting is by `mtimeMs` (not the timestamp embedded in the name) so it
 * matches "most recently written" exactly; the filename is the tiebreaker
 * for the rare identical-mtime case so the order stays deterministic.
 */
export async function listKeychainMigrationMarkers(
  storagePath: string,
): Promise<string[]> {
  const dir = dirname(storagePath);
  const prefix = `${basename(storagePath)}.migrated-to-keychain.`;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const matches = entries.filter((name) => name.startsWith(prefix));
  const withMtime = await Promise.all(
    matches.map(async (name) => {
      const full = join(dir, name);
      let mtimeMs = Number.NEGATIVE_INFINITY;
      try {
        mtimeMs = (await fs.stat(full)).mtimeMs;
      } catch {
        // Stat raced with a prune — sort last.
      }
      return { full, name, mtimeMs };
    }),
  );
  withMtime.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.name < b.name ? 1 : a.name > b.name ? -1 : 0;
  });
  return withMtime.map((entry) => entry.full);
}

async function saveAccountsUnlocked(storage: AccountStorageV3): Promise<void> {
  // Refresh our lock (or surface a collision) on every write. This also
  // bumps `lastActive`, which is the stale-detection timestamp read by
  // other worktrees on their next acquire.
  await checkWorktreeLockForCurrentStorage("save");

  if (isKeychainOptInEnabled()) {
    // Credential snapshots are scoped to the JSON backend and do not cover
    // keychain mode. That is enforced inside the snapshotter itself rather
    // than by the absence of a call here, so neither the JSON fallback below
    // nor `clearAccounts` can reintroduce a plaintext copy of the token set -
    // see `snapshotCredentialStoreBeforeWrite`. Keychain users' recovery path
    // stays `codex-export` plus the keychain's own backing store.
    //
    // Normalize before serializing so the keychain receives the same shape
    // the JSON backend would have written. Using the same JSON format keeps
    // migration and rollback symmetric: a rolled-back JSON file is valid
    // input for a future opt-in migration in either direction.
    const normalizedStorage = normalizeAccountStorage(storage) ?? storage;
    const blob = JSON.stringify(normalizedStorage, null, 2);
    const projectKey = getCurrentProjectStorageKey();
    const path = getStoragePath();
    // Retire the on-disk JSON BEFORE writing the keychain: the crash window
    // between the two operations then leaves both sides at the OLD state
    // (marker holds the pre-save bytes, keychain keeps the pre-save blob),
    // never a fresh keychain entry beside a stale canonical file. If the
    // rename fails the helper overwrites the file in place so the sides
    // still agree once the keychain write lands.
    await migrateOnDiskJsonToKeychainBackup(path, () =>
      writeAccountsToPathUnlocked(path, normalizedStorage),
    );
    const result = await writeToKeychain(projectKey, blob);
    if (result.ok) {
      return;
    }
    log.warn("keychain: write failed; falling back to JSON for this save", {
      error: result.error,
    });
  }

  await writeAccountsToPathUnlocked(getStoragePath(), storage);
}

/**
 * Loads OAuth accounts from disk storage.
 * Automatically migrates v1 storage to v3 format if needed.
 * @returns AccountStorageV3 if file exists and is valid, null otherwise
 * @throws StorageError (code `UNSUPPORTED_SCHEMA_VERSION`) when the on-disk
 *   `version` field is greater than the newest format this plugin understands.
 *   Surfacing the error stops a downgraded plugin from overwriting the user's
 *   future-schema credentials with a stale or empty payload.
 */
export async function loadAccounts(): Promise<AccountStorageV3 | null> {
  return withPinnedStorageScope(() =>
    withStorageLock(async () => loadAccountsInternal(saveAccountsUnlocked)),
  );
}

/**
 * Executes a read-modify-write transaction under the storage lock and exposes
 * an unlocked persist callback so nested save operations do not deadlock.
 *
 * The whole transaction — lease acquisition, load, handler, and every persist
 * callback the handler invokes — runs under `withPinnedStorageScope`, so the
 * location captured at entry (which is also the path the filesystem lease is
 * taken on) is the only location the transaction can touch. A `setStoragePath`
 * scope flip issued mid-transaction applies to the real scope but cannot
 * redirect this transaction's writes: they stay on the file the lease covers.
 */
export async function withAccountStorageTransaction<T>(
  handler: (
    current: AccountStorageV3 | null,
    persist: (storage: AccountStorageV3) => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  return withPinnedStorageScope(() =>
    withStorageTransaction({
      storagePath: getStoragePath(),
      load: () => loadAccountsInternal(saveAccountsUnlocked),
      persist: saveAccountsUnlocked,
      handler,
    }),
  );
}

/**
 * Persists account storage to disk using atomic write (temp file + rename).
 * Creates the .opencode directory if it doesn't exist.
 * Verifies file was written correctly and provides detailed error messages.
 * @param storage - Account storage data to save
 * @throws StorageError with platform-aware hints on failure
 */
export async function saveAccounts(storage: AccountStorageV3): Promise<void> {
  return withPinnedStorageScope(() =>
    withStorageLock(async () => {
      await saveAccountsUnlocked(storage);
    }),
  );
}

/**
 * Deletes the account storage file from disk.
 * Silently ignores if file doesn't exist.
 *
 * Ordering (F1 post-merge MEDIUM finding): unlink the on-disk JSON FIRST,
 * then delete the keychain entry. If we cleared the keychain first and the
 * unlink failed for a non-ENOENT reason (EACCES, EBUSY, filesystem drift),
 * a subsequent load with opt-in still on would take the "no keychain entry,
 * fall back to JSON" branch (see `loadAccountsInternal`) and resurrect the
 * credentials from the still-present JSON file. Callers typically run
 * `clearAccounts` to recover from a compromised token, so a silent
 * resurrection is a meaningful failure mode.
 *
 * Fail-safe invariant: if the JSON unlink fails (non-ENOENT), we skip the
 * keychain delete and log at `error`. Both copies remain in sync so the
 * caller can retry safely. The operation is still best-effort (never
 * throws) to preserve the existing contract above the storage layer.
 *
 * @throws StorageError (code `TEST_HOME_ESCAPE`) - the single exception to
 *   best-effort, and inert outside vitest. The guard refuses the deletion, so
 *   absorbing it would return success for a clear that never happened.
 */
export async function clearAccounts(): Promise<void> {
  return withPinnedStorageScope(() =>
    withStorageTransaction({
      // The filesystem lease must name the same file the handler unlinks —
      // resolved under the pin so a mid-clear scope flip cannot make the
      // unlink hit a different location than the lease covers.
      storagePath: getStoragePath(),
      load: () => Promise.resolve<AccountStorageV3 | null>(null),
      persist: () => Promise.resolve(),
      handler: async () => {
        const path = getStoragePath();
        let jsonCleared = true;
        try {
          assertTestRunNeverTouchesRealHome(path);
          // Deleting the store outright needs no significance test - `null`
          // says there is no successor document to compare against. The
          // snapshotter still applies its own config and keychain gates.
          await trySnapshotCredentialStoreBeforeWrite(path, null);
          await fs.unlink(path);
          // Flush the directory so the deletion itself is crash-durable:
          // without it a power loss could resurrect the unlinked credential
          // file.
          await fsyncParentDirectory(path);
        } catch (error) {
          // The test-home guard is not a storage failure to absorb. It fires
          // only under vitest, and it exists to fail a run that escaped its
          // sandbox; it throws before the unlink, so swallowing it here would
          // report a successful clear for a deletion that deliberately did not
          // happen - fail-closed downgraded to fail-open on the one path that
          // destroys the store. The same re-throw covers the snapshotter,
          // which surfaces this code through
          // `trySnapshotCredentialStoreBeforeWrite` for the same reason.
          if (error instanceof StorageError && error.code === TEST_HOME_ESCAPE_CODE) {
            throw error;
          }
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            jsonCleared = false;
            log.error(
              "Failed to clear account storage; skipping keychain delete to keep storage sides in sync. Caller should retry.",
              { error: String(error) },
            );
          }
        }

        // Only delete the keychain entry after the on-disk copy is gone (or
        // was already absent). This preserves atomicity-enough semantics: a
        // partial failure leaves both sides present rather than clearing one
        // side and letting a subsequent load rehydrate from the other. A
        // FAILED delete is surfaced distinctly from "no entry existed": the
        // stale copy would silently resurrect the cleared credentials on the
        // next keychain-first load.
        if (jsonCleared && isKeychainOptInEnabled()) {
          const projectKey = getCurrentProjectStorageKey();
          const result = await deleteFromKeychain(projectKey);
          if (!result.deleted && result.error) {
            log.warn(
              "keychain: delete during clearAccounts failed; a stale keychain copy may survive and resurrect the cleared accounts on the next opt-in load",
              { error: result.error },
            );
          }
        }

        // The migration markers hold plaintext copies of the same token set.
        // A clear that retires only the canonical file and keychain entry
        // still leaves full credentials sitting next to the store.
        if (jsonCleared) {
          await retireKeychainMigrationArtifacts(path);
        }
      },
    }),
  );
}
