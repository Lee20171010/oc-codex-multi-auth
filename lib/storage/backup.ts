/**
 * Backup path formatting and pre-import backup file writer.
 *
 * Split out of `lib/storage.ts` in RC-2. `createTimestampedBackupPath` is a
 * pure path builder that every backup caller can use without taking a
 * dependency on the import pipeline. `writePreImportBackupFile` is the
 * bounded-time writer used inside `importAccounts` to snapshot the existing
 * accounts file before apply.
 *
 * Every file written here holds live refresh tokens, so the writer is the one
 * place that owns the 0600 mode, the bounded write time, and the temp+rename
 * swap. `writeBackupFileContent` exists so a caller that already has the exact
 * bytes it wants preserved — the pre-write credential snapshotter, which
 * copies the previous file verbatim rather than re-serializing it — does not
 * hand-roll a second writer with weaker guarantees.
 */

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import {
  fsyncParentDirectory,
  PRE_IMPORT_BACKUP_WRITE_TIMEOUT_MS,
  renameWithWindowsRetry,
  writeFileWithTimeout,
} from "./atomic-write.js";
import type { AccountStorageV3 } from "./migrations.js";
import { getStoragePath } from "./state.js";

function formatBackupTimestamp(date: Date = new Date()): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const mmm = String(date.getMilliseconds()).padStart(3, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}${mmm}`;
}

/**
 * The filename prefix every backup written under `prefix` will share.
 * Exported so retention pruning can scope its deletes to exactly the family
 * a caller created — the sanitization must match what
 * {@link createTimestampedBackupPathFor} applies, byte for byte.
 */
export function sanitizeBackupPrefix(prefix: string): string {
  const trimmed = prefix.trim();
  const safe = trimmed
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe.length > 0 ? safe : "codex-backup";
}

/**
 * The `backups/` directory that belongs to one accounts file.
 *
 * Every backup kind shares it: pre-import backups, keychain migration
 * artefacts, pre-global-migration directories, and credential snapshots. A
 * caller that prunes must therefore scope its deletes by its own filename
 * prefix rather than by this directory.
 */
export function getBackupDirectory(storagePath: string): string {
  return join(dirname(storagePath), "backups");
}

/**
 * Timestamped backup path beside an explicitly named accounts file.
 *
 * Callers that write a backup for a path other than the currently active one —
 * the global-storage migration writes to the global file while a project path
 * is active — must use this rather than {@link createTimestampedBackupPath},
 * so the backup lands next to the file it describes.
 */
export function createTimestampedBackupPathFor(
  storagePath: string,
  prefix = "codex-backup",
): string {
  const safePrefix = sanitizeBackupPrefix(prefix);
  const nonce = randomBytes(3).toString("hex");
  return join(
    getBackupDirectory(storagePath),
    `${safePrefix}-${formatBackupTimestamp()}-${nonce}.json`,
  );
}

export function createTimestampedBackupPath(prefix = "codex-backup"): string {
  return createTimestampedBackupPathFor(getStoragePath(), prefix);
}

/**
 * Write one backup file atomically, with a bounded write time and mode 0600.
 *
 * `content` is written verbatim. Temp+rename keeps a half-written backup from
 * ever being visible under its final name, and the timeout keeps a stuck disk
 * from blocking the operation the backup precedes.
 */
export async function writeBackupFileContent(backupPath: string, content: string): Promise<void> {
  const uniqueSuffix = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const tempPath = `${backupPath}.${uniqueSuffix}.tmp`;

  try {
    // `mode` applies only to directories this call actually creates.
    await fs.mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeFileWithTimeout(tempPath, content, PRE_IMPORT_BACKUP_WRITE_TIMEOUT_MS);
    await renameWithWindowsRetry(tempPath, backupPath);
    await fsyncParentDirectory(backupPath);
  } catch (error) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // Best effort temp-file cleanup.
    }
    throw error;
  }
}

export async function writePreImportBackupFile(backupPath: string, snapshot: AccountStorageV3): Promise<void> {
  await writeBackupFileContent(backupPath, JSON.stringify(snapshot, null, 2));
}
