/**
 * Pre-write snapshots of the credential stores.
 *
 * The stores are the JSON files holding live refresh tokens: the V3 account
 * store and the flagged-accounts file beside it, which retains quarantined
 * records' refresh tokens so they can be restored later. Anything that
 * replaces either wholesale — a bad merge, a test run that escaped
 * its sandbox, a partial restore — takes the tokens with it, and a backup old
 * enough to predate the last few refreshes restores accounts whose refresh
 * tokens have since been rotated and are therefore dead. This module keeps a
 * bounded ring of recent snapshots so there is always a *live-token* copy to
 * restore from.
 *
 * Two decisions carry the design:
 *
 *   1. The snapshot captures the document already on disk, taken before the
 *      new one replaces it. Snapshotting the incoming document would be
 *      useless for the case this exists for: a clobber would simply be
 *      snapshotted as a clobber. What is worth keeping is the last good state.
 *
 *   2. Significance is a denylist, not an allowlist. Everything counts as a
 *      significant change unless it is explicitly ignored below. A field added
 *      to the schema later therefore cannot silently switch snapshots off; the
 *      worst it can do is cost one extra snapshot, which is recoverable, where
 *      a missing snapshot is not.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { loadPluginConfig, getCredentialSnapshots, getCredentialSnapshotsMaxCount } from "../config.js";
import { createLogger } from "../logger.js";
import {
  createTimestampedBackupPathFor,
  getBackupDirectory,
  writeBackupFileContent,
} from "./backup.js";
import { StorageError } from "./errors.js";
import { isKeychainOptInEnabled } from "./keychain.js";
import {
  assertTestRunNeverTouchesRealHome,
  TEST_HOME_ESCAPE_CODE,
} from "./test-home-guard.js";
import type { AccountStorageV3 } from "./migrations.js";
import type { FlaggedAccountStorageV1 } from "./flagged.js";

const log = createLogger("credential-snapshots");

/**
 * The documents this module diffs: the V3 account store and the V1
 * flagged-account store. Both are `{ version, accounts }` JSON documents, and
 * the significance projection below reads them generically, so the union is a
 * name for the contract rather than a shape the code depends on. The import
 * is type-only on purpose — `flagged.ts` calls back into this module at
 * runtime.
 */
export type CredentialStoreDocument = AccountStorageV3 | FlaggedAccountStorageV1;

/**
 * Filename prefix owned exclusively by this module.
 *
 * `backups/` is shared with `codex-pre-import-backup-*`, `codex-backup-*`,
 * `*.migrated-to-keychain.*` and `pre-global-migration-*`. Retention deletes
 * strictly by this prefix, because deleting one of those would be a
 * data-loss bug inside a feature whose only purpose is preventing data loss.
 */
export const CREDENTIAL_SNAPSHOT_PREFIX = "codex-credential-snapshot";

/**
 * Document-level fields that never, on their own, justify a snapshot.
 *
 * The rotation cursor moves on essentially every request under the default
 * hybrid strategy. Snapshotting on it would churn the whole ring away within
 * minutes and leave nothing but cursor movements to restore from.
 */
const IGNORED_ROOT_FIELDS: ReadonlySet<string> = new Set([
  "activeIndex",
  "activeIndexByFamily",
]);

/**
 * Per-account fields that never, on their own, justify a snapshot.
 *
 * All of it is scheduling churn: it changes constantly, it is re-derived from
 * upstream on the next request, and none of it is recoverable state. Note what
 * is deliberately absent — `refreshToken`, `accessToken`, `expiresAt`,
 * `tokenRotatedAt` — so every token refresh produces a snapshot. That is the
 * case that matters most: a snapshot whose tokens are stale restores accounts
 * that cannot authenticate.
 */
const IGNORED_ACCOUNT_FIELDS: ReadonlySet<string> = new Set([
  "lastUsed",
  "lastSwitchReason",
  "rateLimitResetTimes",
  "rateLimitResetTime",
  "coolingDownUntil",
  "cooldownReason",
  "quotaExhaustedUntil",
  "quotaExhaustedStampAt",
  "quotaExhaustedClearedAt",
  "autoRedeemClaimedAt",
]);

export function isCredentialSnapshotFileName(name: string): boolean {
  return name.startsWith(`${CREDENTIAL_SNAPSHOT_PREFIX}-`) && name.endsWith(".json");
}

/**
 * Sort keys and drop `undefined`-valued ones so two documents with identical
 * content compare equal as strings.
 *
 * This is load-bearing rather than tidiness: the previous document comes from
 * `JSON.parse`, so its key order is the file's, while the incoming one is
 * built in code. Comparing their raw serializations would report a difference
 * on every single write. Dropping `undefined` matches `JSON.stringify`, which
 * omits those keys when the document is written, so an in-memory
 * `{ email: undefined }` and an on-disk absent `email` are the same state.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    if (entry === undefined) continue;
    result[key] = canonicalize(entry);
  }
  return result;
}

function projectAccount(account: unknown): unknown {
  if (account === null || typeof account !== "object" || Array.isArray(account)) {
    return account;
  }
  const source = account as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (IGNORED_ACCOUNT_FIELDS.has(key)) continue;
    result[key] = source[key];
  }
  return result;
}

/**
 * The document reduced to the parts a snapshot exists to preserve.
 *
 * Accounts are compared position-wise, so a reorder reads as significant. That
 * is the intended bias: an extra snapshot costs one file, a missed one costs
 * the credentials.
 */
function significantProjection(document: unknown): string {
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return JSON.stringify(canonicalize(document)) ?? "null";
  }

  const source = document as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (IGNORED_ROOT_FIELDS.has(key) || key === "accounts") continue;
    projected[key] = source[key];
  }

  const accounts = source.accounts;
  projected.accounts = Array.isArray(accounts) ? accounts.map(projectAccount) : accounts;

  return JSON.stringify(canonicalize(projected)) ?? "null";
}

export function isSignificantStorageChange(
  previousContent: string,
  next: CredentialStoreDocument,
): boolean {
  let previous: unknown;
  try {
    previous = JSON.parse(previousContent) as unknown;
  } catch {
    // A file that no longer parses is precisely the state worth preserving:
    // the write about to happen replaces it, and whatever it held is then gone
    // for good. Treat it as changed so it is captured before that happens.
    return true;
  }
  return significantProjection(previous) !== significantProjection(next);
}

/**
 * POSIX-only hardening. Windows has no POSIX mode bits for `fs.chmod` to set,
 * so the restriction is skipped there outright rather than reported as
 * applied — snapshots on Windows rely on the profile directory's ACLs.
 */
async function restrictDirectoryMode(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await fs.chmod(directory, 0o700);
  } catch (error) {
    log.warn("Failed to restrict credential snapshot directory to 0700", {
      path: directory,
      error: String(error),
    });
  }
}

/**
 * The retention limit used for every credential-adjacent artifact family —
 * snapshots, `.migrated-to-keychain` markers, `pre-rollback` archives, and
 * pre-import backups. One knob keeps all the lifecycles bounded by the same
 * user-controlled budget instead of inventing a second retention surface.
 *
 * `credentialSnapshots.maxCount <= 0` means "keep everything", and that
 * choice is honoured for every family.
 */
export function getCredentialArtifactRetentionLimit(): number {
  return getCredentialSnapshotsMaxCount(loadPluginConfig());
}

/**
 * Delete all but the newest `maxCount` files in `directory` selected by
 * `match` — the generic form of the snapshot ring, used for the other
 * bounded artifact families (keychain-migration markers, pre-rollback
 * archives, pre-import backups) that share `backups/` or the store
 * directory. `match` is either a filename-prefix string or a predicate.
 *
 * The selector is the whole contract: it must name a single artifact family
 * owned by a single producer, because anything else matching it is deleted.
 *
 * `maxCount <= 0` keeps every artifact; turning the feature off is the
 * boolean setting's job, not a magic zero.
 */
export async function pruneStorageArtifacts(
  directory: string,
  match: string | ((name: string) => boolean),
  maxCount: number,
): Promise<void> {
  if (!Number.isFinite(maxCount) || maxCount <= 0) return;

  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch {
    return;
  }

  const matches =
    typeof match === "function" ? match : (name: string) => name.startsWith(match);
  const candidates = entries.filter(matches);
  if (candidates.length <= maxCount) return;

  const dated = await Promise.all(
    candidates.map(async (name) => {
      const full = join(directory, name);
      let mtimeMs = Number.NEGATIVE_INFINITY;
      let isFile = false;
      try {
        const stats = await fs.stat(full);
        mtimeMs = stats.mtimeMs;
        isFile = stats.isFile();
      } catch {
        // Vanished between readdir and stat: leave it out rather than racing
        // another process for the unlink.
      }
      return { full, name, mtimeMs, isFile };
    }),
  );

  // Newest first. The embedded timestamp breaks mtime ties, which happens when
  // several snapshots land inside one filesystem timestamp granule.
  const ordered = dated
    .filter((entry) => entry.isFile)
    .sort((a, b) => {
      if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
      return a.name < b.name ? 1 : a.name > b.name ? -1 : 0;
    });

  for (const stale of ordered.slice(maxCount)) {
    try {
      await fs.unlink(stale.full);
    } catch (error) {
      log.warn("Failed to prune storage artifact", {
        path: stale.full,
        error: String(error),
      });
    }
  }
}

/**
 * Delete all but the newest `maxCount` snapshots — the credential-snapshot
 * specialisation of {@link pruneStorageArtifacts}. `maxCount <= 0` keeps
 * every snapshot; turning the feature off is the boolean setting's job, not
 * a magic zero.
 */
export async function pruneCredentialSnapshots(
  backupDirectory: string,
  maxCount: number,
): Promise<void> {
  await pruneStorageArtifacts(backupDirectory, isCredentialSnapshotFileName, maxCount);
}

/**
 * Preserve the document currently at `storagePath` before it is replaced.
 *
 * `next` is the document about to be written, or `null` when the store is
 * about to be deleted outright — deletion is unconditionally significant.
 *
 * Callers must already hold the storage lock, so the snapshot is consistent
 * with the write it precedes.
 */
export async function snapshotCredentialStoreBeforeWrite(
  storagePath: string,
  next: CredentialStoreDocument | null,
): Promise<void> {
  const config = loadPluginConfig();
  if (!getCredentialSnapshots(config)) return;

  // Scoped to the JSON backend, enforced here rather than at each call site.
  // Under the keychain opt-in the authoritative pool lives in the OS keychain,
  // and whatever JSON remains at `storagePath` is a pre-migration or
  // write-fallback artefact. Copying it into `backups/` would put the whole
  // token set in a plaintext file that a user who opted into the keychain
  // asked us not to create, and it would archive a document that is already
  // stale. Every write path - ordinary save, the JSON fallback after a failed
  // keychain write, and `clearAccounts` - goes through here, so one check
  // covers all of them.
  if (isKeychainOptInEnabled()) return;

  const backupDirectory = getBackupDirectory(storagePath);
  assertTestRunNeverTouchesRealHome(backupDirectory);

  let previousContent: string;
  try {
    previousContent = await fs.readFile(storagePath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      log.warn("Skipping credential snapshot: existing store is unreadable", {
        path: storagePath,
        error: String(error),
      });
    }
    // No file yet is the ordinary first-write case: there is no previous state
    // to preserve, which is not an error.
    return;
  }

  if (next !== null && !isSignificantStorageChange(previousContent, next)) return;

  const snapshotPath = createTimestampedBackupPathFor(storagePath, CREDENTIAL_SNAPSHOT_PREFIX);
  await fs.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  await restrictDirectoryMode(backupDirectory);
  await writeBackupFileContent(snapshotPath, previousContent);
  log.info("Captured credential store snapshot", { path: snapshotPath });

  await pruneCredentialSnapshots(backupDirectory, getCredentialSnapshotsMaxCount(config));
}

/**
 * {@link snapshotCredentialStoreBeforeWrite}, with every failure downgraded to
 * a warning.
 *
 * A snapshot is a safety net, never a precondition. Letting a transient disk
 * error fail the write it precedes would break a token refresh, and therefore
 * the user's live sessions, to protect a copy of the file — strictly worse
 * than having no snapshot. The one exception is the test-home guard: that
 * exists to stop a test run writing over real credentials, so swallowing it
 * would disarm it.
 */
export async function trySnapshotCredentialStoreBeforeWrite(
  storagePath: string,
  next: CredentialStoreDocument | null,
): Promise<void> {
  try {
    await snapshotCredentialStoreBeforeWrite(storagePath, next);
  } catch (error) {
    if (error instanceof StorageError && error.code === TEST_HOME_ESCAPE_CODE) throw error;
    log.warn("Credential snapshot failed; continuing with the write", {
      path: storagePath,
      error: String(error),
    });
  }
}
