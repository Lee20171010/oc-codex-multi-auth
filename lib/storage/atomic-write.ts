/**
 * Low-level atomic-write primitives shared by account storage, flagged
 * storage, and pre-import backups.
 *
 * Split out of `lib/storage.ts` in RC-2. These helpers intentionally contain
 * no business logic — every caller handles dedup/normalization above this
 * layer. The retry + timeout knobs here exist to tolerate Windows file-lock
 * contention from antivirus scanners and to keep a misbehaving disk from
 * hanging the plugin indefinitely.
 */

import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

export const WINDOWS_RENAME_RETRY_ATTEMPTS = 5;
export const WINDOWS_RENAME_RETRY_BASE_DELAY_MS = 10;
export const PRE_IMPORT_BACKUP_WRITE_TIMEOUT_MS = 3_000;

export function isWindowsLockError(error: unknown): error is NodeJS.ErrnoException {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EPERM" || code === "EBUSY";
}

/**
 * `fs.rename` with capped exponential retry on Windows EPERM/EBUSY.
 *
 * Windows reports transient lock contention (antivirus scanning the temp
 * file, indexer holding a handle open, etc.) as EPERM/EBUSY and surfaces it
 * to `rename`. A few short retries turn that into a successful atomic swap
 * without the caller needing to know anything about the platform.
 */
export async function renameWithWindowsRetry(sourcePath: string, destinationPath: string): Promise<void> {
  let lastError: NodeJS.ErrnoException | null = null;

  for (let attempt = 0; attempt < WINDOWS_RENAME_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await fs.rename(sourcePath, destinationPath);
      return;
    } catch (error) {
      if (isWindowsLockError(error)) {
        lastError = error;
        await new Promise((resolve) =>
          setTimeout(resolve, WINDOWS_RENAME_RETRY_BASE_DELAY_MS * 2 ** attempt),
        );
        continue;
      }
      throw error;
    }
  }

  if (lastError) {
    throw lastError;
  }
}

/**
 * fsync the directory holding `filePath`, best effort.
 *
 * A rename only makes the directory *entry* durable once the directory itself
 * is flushed: without this a crash between rename and the next automatic
 * writeback can resurrect the old file or drop the new one, which for the
 * credential stores means restoring a consumed refresh token (or losing the
 * rotated one). Windows cannot fsync a directory handle, so it is skipped
 * there outright; every other failure is absorbed because the write already
 * landed — a skipped directory flush narrows crash durability but is not an
 * I/O failure worth failing the save over.
 */
export async function fsyncParentDirectory(filePath: string): Promise<void> {
  if (process.platform === "win32") return;
  let dirHandle: FileHandle | undefined;
  try {
    dirHandle = await fs.open(dirname(filePath), "r");
    await dirHandle.sync();
  } catch {
    // Best effort — see the docstring.
  } finally {
    if (dirHandle) {
      try {
        await dirHandle.close();
      } catch {
        // Close failure on a directory handle is immaterial.
      }
    }
  }
}

/**
 * Write `content` to `filePath` atomically and crash-durably:
 *
 *   temp file (mode 0600) -> fsync(fd) -> rename -> fsync(parent dir)
 *
 * Temp+rename alone makes the write atomic for *readers*, but not durable
 * across a crash: the rename can hit disk while the file's pages are still in
 * the writeback cache, leaving an empty or torn file under the final name —
 * for the credential stores that reads back as a wiped account pool. The fd
 * fsync orders the payload before the rename, and the directory fsync orders
 * the rename itself. Callers keep their own "directory exists" and snapshot
 * steps; this helper owns the temp file's lifecycle (including unlinking it
 * on failure) so every store gets identical crash semantics.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const uniqueSuffix = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const tempPath = `${filePath}.${uniqueSuffix}.tmp`;

  const handle = await fs.open(tempPath, "w", 0o600);
  let closed = false;
  try {
    await handle.writeFile(content, { encoding: "utf-8" });
    await handle.sync();
    // A zero-byte payload must never be published under the canonical name:
    // a "successful" write that produced nothing reads back as a wiped store.
    // The serialized-length guard above this layer is the cheap first check;
    // this stat catches the filesystem having accepted-but-dropped the data.
    const { size } = await fs.stat(tempPath);
    if (size === 0) {
      throw Object.assign(new Error("File written but size is 0"), {
        code: "EEMPTY",
      });
    }
    await handle.close();
    closed = true;
    await renameWithWindowsRetry(tempPath, filePath);
  } catch (error) {
    if (!closed) {
      try {
        await handle.close();
      } catch {
        // Close failure is secondary to the write error being rethrown.
      }
    }
    try {
      await fs.unlink(tempPath);
    } catch {
      // Best effort temp-file cleanup.
    }
    throw error;
  }

  await fsyncParentDirectory(filePath);
}

/**
 * `fs.writeFile` with a hard wall-clock timeout, flushed to disk before the
 * handle closes.
 *
 * Used by the pre-import backup writer so a stuck disk or hanging FS driver
 * cannot block the import transaction forever; every other write path uses
 * {@link writeFileAtomic} or the normal, untimed `fs.writeFile`.
 */
export async function writeFileWithTimeout(filePath: string, content: string, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  // The handle is hoisted to function scope so the catch path can close it:
  // a wedged fsync cannot be cancelled, but leaving the fd open makes the
  // caller's temp-file unlink fail outright on Windows — and the file it
  // pins can contain refresh tokens.
  let flushHandle: FileHandle | undefined;
  try {
    await fs.writeFile(filePath, content, {
      encoding: "utf-8",
      mode: 0o600,
      signal: controller.signal,
    });
    // writeFile's internal close does not order the flush: re-open the file
    // just to fsync it, so the backup is durable the moment the caller moves
    // on to the rename. The reopen+fsync shares the same wall-clock budget —
    // a wedged disk most often stalls in fsync itself, so it races the same
    // abort signal and surfaces as ETIMEDOUT instead of outliving the
    // caller's deadline.
    const flushExisting = (async () => {
      try {
        flushHandle = await fs.open(filePath, "r+");
        await flushHandle.sync();
      } finally {
        if (flushHandle) {
          const handle = flushHandle;
          flushHandle = undefined;
          try {
            await handle.close();
          } catch {
            // Close failure is secondary to the write outcome.
          }
        }
      }
    })();
    const aborted = new Promise<never>((_resolve, reject) => {
      const fail = () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (controller.signal.aborted) {
        fail();
        return;
      }
      controller.signal.addEventListener("abort", fail, { once: true });
    });
    // Observe both arms so the loser never reports as unhandled — the race
    // only decides which outcome surfaces. A hung fsync cannot be cancelled,
    // but the caller stops waiting on it here.
    flushExisting.catch(() => {});
    aborted.catch(() => {});
    await Promise.race([flushExisting, aborted]);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      // The fsync may still hold the file open — on Windows that alone
      // blocks the caller's temp-file cleanup. Close it ourselves under a
      // short bound; if even close() hangs we must not wait on it.
      if (flushHandle) {
        const handle = flushHandle;
        flushHandle = undefined;
        await Promise.race([
          handle.close().catch(() => {}),
          new Promise<void>((resolve) => setTimeout(resolve, 250)),
        ]);
      }
      const timeoutError = Object.assign(
        new Error(`Timed out writing file after ${timeoutMs}ms`),
        { code: "ETIMEDOUT" },
      );
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}
