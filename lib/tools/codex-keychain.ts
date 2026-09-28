/**
 * `codex-keychain` tool — inspect and manage the opt-in OS-keychain backend.
 *
 * Phase 4 F1. Companion to `lib/storage/keychain.ts`. The tool exposes three
 * subcommands chosen for operator-level control over the credential surface:
 *
 *   - `status`: report which backend is active and whether the OS keychain
 *     is reachable. Never mutates state; safe to run under any config.
 *   - `migrate`: explicitly move the current on-disk JSON accounts file into
 *     the OS keychain, rename the JSON as
 *     `<path>.migrated-to-keychain.<ts>` for rollback, and leave the
 *     authoritative copy in the keychain. Idempotent: running again when
 *     the keychain already holds a fresher copy is a no-op.
 *   - `rollback`: restore the most recent `.migrated-to-keychain.<ts>`
 *     backup next to the accounts file and delete the keychain entry so
 *     subsequent loads read from disk again. The inverse of `migrate`.
 *     A flagged-store marker beside it is restored the same way so
 *     quarantined credentials do not stay keychain-only.
 *
 * Runs under the same storage lock as `saveAccounts`/`loadAccounts` so the
 * mutation cannot interleave with an in-flight rotation save.
 *
 * Security notes:
 *   - No secret value ever reaches the tool output. Success messages show
 *     account counts and file paths, never token material.
 *   - Failures fall back to JSON at the storage layer — this tool never
 *     hides that from the operator.
 */

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import { withAccountStorageTransaction } from "../storage.js";
import {
	getFlaggedAccountsPath,
	normalizeFlaggedStorage,
} from "../storage/flagged.js";
import {
	deleteFlaggedFromKeychain,
	deleteFromKeychain,
	isKeychainOptInEnabled,
	keychainIsAvailable,
	readFlaggedFromKeychain,
	readFromKeychain,
} from "../storage/keychain.js";
import {
	getCurrentProjectStorageKey,
	getStoragePath,
	withPinnedStorageScope,
} from "../storage/state.js";
import { withStorageTransaction } from "../storage/transaction-lock.js";
import {
	fsyncParentDirectory,
	renameWithWindowsRetry,
	writeFileAtomic,
} from "../storage/atomic-write.js";
import {
	getCredentialArtifactRetentionLimit,
	pruneStorageArtifacts,
} from "../storage/credential-snapshots.js";
import { normalizeAccountStorage } from "../storage/normalize.js";
import {
	formatUiHeader,
	formatUiItem,
	formatUiKeyValue,
} from "../ui/format.js";
import type { ToolContext } from "./index.js";

type Subcommand = "status" | "migrate" | "rollback";

function normalizeSubcommand(raw: string | undefined): Subcommand {
	const v = (raw ?? "").trim().toLowerCase();
	if (v === "migrate" || v === "rollback") return v;
	return "status";
}

/**
 * List `<path>.migrated-to-keychain.<ts>` siblings of the current storage
 * path, sorted most-recent first by `fs.stat().mtimeMs` (F1 post-merge
 * MEDIUM finding). The previous implementation sorted the filenames
 * lexicographically, which happens to produce the correct order when all
 * filenames share the fixed-width ISO-8601 suffix
 * (`YYYY-MM-DDTHH-MM-SS-mmmZ`) emitted by `migrateOnDiskJsonToKeychainBackup`
 * in `lib/storage/load-save.ts`. Any format drift (locale epoch, test
 * fixture with non-ISO suffix, future migration-suffix change) silently
 * picks the alphabetically-last entry instead of the most-recent. Sorting
 * by `mtimeMs` is format-independent and matches "most recent backup"
 * exactly. The filename tiebreaker (rare: identical mtime) preserves the
 * previous descending-lex behaviour so the function stays deterministic.
 *
 * Exported as `_findMigrationBackupsForTests` below so the sort order can
 * be asserted without stubbing the tool closure.
 */
async function findMigrationBackups(storagePath: string): Promise<string[]> {
	const dir = dirname(storagePath);
	const base = basename(storagePath);
	const prefix = `${base}.migrated-to-keychain.`;
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
				const st = await fs.stat(full);
				mtimeMs = st.mtimeMs;
			} catch {
				// Stat failure: keep -Infinity so the entry sorts last.
				// This protects against a backup that disappeared between
				// readdir and stat (race) without crashing the tool.
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

/**
 * Test-only export for `findMigrationBackups`. Kept separate from the
 * tool factory so the sort semantics can be asserted directly against a
 * temp directory in `test/tools-codex-keychain.test.ts`.
 */
export async function _findMigrationBackupsForTests(
	storagePath: string,
): Promise<string[]> {
	return findMigrationBackups(storagePath);
}

/**
 * Unique timestamped name for an archived artifact beside `path` so repeated
 * rollbacks cannot collide or overwrite each other within the same
 * millisecond.
 */
function timestampedArtifactName(path: string, suffix: string): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const nonce = randomBytes(3).toString("hex");
	return `${path}${suffix}${timestamp}-${nonce}`;
}

/**
 * Bound one archived-artifact family next to `path` so repeated
 * migrations/rollbacks cannot grow the directory without limit. Best-effort:
 * a pruning failure never fails the operation that produced the artifact.
 */
async function pruneSiblingArtifacts(path: string, suffix: string): Promise<void> {
	await pruneStorageArtifacts(
		dirname(path),
		`${basename(path)}${suffix}`,
		getCredentialArtifactRetentionLimit(),
	);
}

/**
 * Preserve a live keychain blob before the rollback deletes the entry.
 *
 * Rollback restores a point-in-time backup over whatever the keychain held
 * — but after migration, every save writes the keychain ONLY (the on-disk
 * copy stays frozen at migration time). The live entry can therefore be
 * strictly newer than the backup being restored; deleting it would lose
 * every rotation and quarantine that landed since. Archiving the blob to a
 * `.pre-rollback-keychain.<ts>` file beside the restored store keeps the
 * divergence recoverable.
 *
 * Returns `true` when it is safe to delete the entry (nothing live to
 * preserve, or the archive landed). A failed archive returns `false` — the
 * caller must then SKIP the delete, because deleting without a preserved
 * copy is exactly the loss this guard exists to prevent.
 */
async function archiveLiveKeychainBlob(
	read: () => Promise<string | null>,
	anchorPath: string,
	warnings: string[],
	label: string,
): Promise<boolean> {
	let live: string | null;
	try {
		live = await read();
	} catch (err) {
		warnings.push(
			`codex-keychain rollback: could not read the live ${label} OS-keychain entry before deleting it: ${(err as Error).message}. The entry was left in place — delete it manually after verifying it holds nothing newer than the restored file.`,
		);
		return false;
	}
	if (live === null) return true;
	const archive = timestampedArtifactName(anchorPath, ".pre-rollback-keychain.");
	try {
		await writeFileAtomic(archive, live);
		await fsyncParentDirectory(archive);
	} catch (err) {
		warnings.push(
			`codex-keychain rollback: could not archive the live ${label} OS-keychain entry to ${archive}: ${(err as Error).message}. The entry was left in place so its newer state is not lost.`,
		);
		return false;
	}
	warnings.push(
		`codex-keychain rollback: archived the live ${label} OS-keychain entry to ${archive} before deleting it; it may hold state newer than the restored backup.`,
	);
	return true;
}

/**
 * Restore the flagged store from its newest `.migrated-to-keychain` backup,
 * under the flagged store's OWN transaction lease.
 *
 * This runs after the main-store rollback has released its lease — the two
 * stores serialize on different lock files, and `withStorageLock` is not
 * re-entrant, so nesting flagged work inside the main transaction would
 * both deadlock and leave the flagged file mutated under the wrong lease.
 *
 * Every failure degrades to a warning and `restored: false`: the main store
 * is already authoritative again by the time this runs.
 */
async function restoreFlaggedStoreFromKeychainBackup(options: {
	confirm: boolean;
	optIn: boolean;
	projectKey: string | null;
}): Promise<{ restored: boolean; warnings: string[] }> {
	const warnings: string[] = [];
	let flaggedPath: string;
	try {
		flaggedPath = getFlaggedAccountsPath();
	} catch (err) {
		warnings.push(
			`codex-keychain rollback: could not resolve the flagged accounts path: ${(err as Error).message}. The main store was still restored.`,
		);
		return { restored: false, warnings };
	}
	const outcome = await withStorageTransaction({
		storagePath: flaggedPath,
		load: () => Promise.resolve<null>(null),
		persist: () => Promise.resolve(),
		handler: async () => {
			try {
				const flaggedBackup = (await findMigrationBackups(flaggedPath))[0];
				if (!flaggedBackup) {
					return { restored: false, warnings };
				}
				// Validate against the real flagged-store shape — not merely "has
				// an accounts array". A structurally wrong backup (wrong version,
				// corrupt entry) promoted to the flagged path would be rejected
				// by the loader on the next read and could quarantine-live-state.
				let flaggedParses = false;
				try {
					const parsed = JSON.parse(
						await fs.readFile(flaggedBackup, "utf-8"),
					) as unknown;
					normalizeFlaggedStorage(parsed, flaggedBackup);
					flaggedParses = true;
				} catch {
					/* unreadable, unparseable, or shape-invalid: stays false */
				}
				if (!flaggedParses) {
					warnings.push(
						`codex-keychain rollback: flagged backup at ${flaggedBackup} did not parse as flagged-account storage; left in place.`,
					);
					return { restored: false, warnings };
				}

				let flaggedCurrentExists = false;
				try {
					await fs.access(flaggedPath);
					flaggedCurrentExists = true;
				} catch (err) {
					// Only ENOENT means "no flagged file". Any other failure
					// (EACCES, transient I/O) leaves existence unknown — guessing
					// "absent" could silently clobber live flagged credentials,
					// so the restore is skipped rather than the confirm gate.
					if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
						warnings.push(
							`codex-keychain rollback: could not check for an existing flagged accounts file at ${flaggedPath}: ${(err as Error).message}. Flagged restore skipped.`,
						);
						return { restored: false, warnings };
					}
				}
				if (flaggedCurrentExists && !options.confirm) {
					warnings.push(
						`codex-keychain rollback: flagged backup ${flaggedBackup} found but a flagged file already exists at ${flaggedPath} and confirm was not set -- left in place.`,
					);
					return { restored: false, warnings };
				}

				let flaggedArchive: string | null = null;
				if (flaggedCurrentExists) {
					flaggedArchive = timestampedArtifactName(flaggedPath, ".pre-rollback.");
					try {
						await renameWithWindowsRetry(flaggedPath, flaggedArchive);
					} catch (err) {
						warnings.push(
							`codex-keychain rollback: could not archive the existing flagged file at ${flaggedPath}: ${(err as Error).message}. Flagged restore skipped.`,
						);
						return { restored: false, warnings };
					}
				}

				if (process.platform !== "win32") {
					try {
						await fs.chmod(flaggedBackup, 0o600);
					} catch {
						warnings.push(
							`codex-keychain rollback: could not set restrictive permissions on flagged backup ${flaggedBackup} before restoring it.`,
						);
					}
				}
				let restored = false;
				try {
					await renameWithWindowsRetry(flaggedBackup, flaggedPath);
					await fsyncParentDirectory(flaggedPath);
					restored = true;
				} catch (renameErr) {
					if (flaggedArchive) {
						try {
							await renameWithWindowsRetry(flaggedArchive, flaggedPath);
							warnings.push(
								`codex-keychain rollback: failed to restore flagged backup ${flaggedBackup} -> ${flaggedPath}: ${(renameErr as Error).message}. Recovered the previously archived flagged file.`,
							);
						} catch (recoveryErr) {
							warnings.push(
								`codex-keychain rollback: failed to restore flagged backup ${flaggedBackup} -> ${flaggedPath}: ${(renameErr as Error).message}. Recovery also failed: ${(recoveryErr as Error).message}. Check ${flaggedArchive} manually.`,
							);
						}
					} else {
						warnings.push(
							`codex-keychain rollback: failed to restore flagged backup ${flaggedBackup} -> ${flaggedPath}: ${(renameErr as Error).message}.`,
						);
					}
				}

				if (restored) {
					// Preserve then delete the flagged keychain entry — same
					// divergence rule as the main entry: post-migration saves
					// wrote keychain-only, so the live entry may hold quarantines
					// newer than the backup. A failed archive SKIPS the delete so
					// newer flagged state is never destroyed unpreserved.
					const flaggedSafeToDelete = await archiveLiveKeychainBlob(
						() => readFlaggedFromKeychain(options.projectKey),
						flaggedPath,
						warnings,
						"flagged accounts",
					);
					if (flaggedSafeToDelete) {
						const result = await deleteFlaggedFromKeychain(options.projectKey);
						if (!result.deleted && (result.error || options.optIn)) {
							warnings.push(
								`codex-keychain rollback: could not confirm the flagged OS-keychain entry was deleted${
									result.error ? ` (${result.error})` : ""
								}. The keychain copy may still be preferred on the next load -- delete it manually or disable CODEX_KEYCHAIN.`,
							);
						}
					}
				}
				return { restored, warnings };
			} catch (err) {
				warnings.push(
					`codex-keychain rollback: flagged-store rollback probe failed: ${(err as Error).message}. The main store was still restored.`,
				);
				return { restored: false, warnings };
			}
		},
	});
	// Bound the flagged artifact families the same way the main store's are
	// bounded — best-effort, a prune failure never fails the rollback.
	try {
		await pruneSiblingArtifacts(flaggedPath, ".migrated-to-keychain.");
		await pruneSiblingArtifacts(flaggedPath, ".pre-rollback.");
		await pruneSiblingArtifacts(flaggedPath, ".pre-rollback-keychain.");
	} catch {
		/* pruning is best-effort */
	}
	return outcome;
}

export function createCodexKeychainTool(ctx: ToolContext): ToolDefinition {
	// ctx.resolveUiRuntime is the only helper we need: it threads the v2
	// TUI / color-profile state from plugin config + CODEX_TUI_* env into
	// every format helper call, so output is consistent with the rest of
	// the codex-* tools without leaking the UI-runtime plumbing in here.
	const { resolveUiRuntime } = ctx;
	return tool({
		description:
			"Inspect and manage the opt-in OS-keychain credential backend. Subcommands: status (default), migrate, rollback. Rollback requires confirm=true when a current accounts JSON file exists alongside the backup (safety gate).",
		args: {
			command: tool.schema
				.string()
				.optional()
				.describe(
					'Subcommand: "status" (default), "migrate", or "rollback".',
				),
			confirm: tool.schema
				.boolean()
				.optional()
				.describe(
					"rollback only: pass true to archive any current accounts JSON as `.pre-rollback.<ts>` before restoring the backup. Without confirm=true, rollback refuses if a current file exists.",
				),
		},
		async execute({
			command,
			confirm,
		}: {
			command?: string;
			confirm?: boolean;
		}) {
			const ui = resolveUiRuntime();
			const sub = normalizeSubcommand(command);
			const optIn = isKeychainOptInEnabled();
			const projectKey = getCurrentProjectStorageKey();
			const storagePath = (() => {
				try {
					return getStoragePath();
				} catch {
					return "<unresolved>";
				}
			})();

			if (sub === "status") {
				// When opt-in is off, skip the probe entirely (F1 post-merge
				// LOW finding). Probing under an unset `CODEX_KEYCHAIN`
				// violates the "unset -> no keychain code path" invariant
				// and can trigger a first-run macOS "allow/always allow"
				// prompt for users who run `codex-keychain status` without
				// opting in. `keychainIsAvailable` already short-circuits
				// on the opt-in check; we surface that explicitly here so
				// the status line reads "not checked; CODEX_KEYCHAIN unset"
				// instead of the misleading "keychain unavailable".
				const available = optIn ? await keychainIsAvailable() : false;
				const keychainHasEntry = optIn
					? (await readFromKeychain(projectKey)) !== null
					: false;
				const activeBackend = !optIn
					? "JSON (keychain disabled; CODEX_KEYCHAIN unset)"
					: available && keychainHasEntry
						? "keychain"
						: available
							? "keychain (empty, JSON fallback)"
							: "JSON (keychain unavailable)";

				const lines: string[] = [];
				lines.push(...formatUiHeader(ui, "Codex keychain status"));
				lines.push("");
				lines.push(formatUiKeyValue(ui, "Active backend", activeBackend));
				lines.push(
					formatUiKeyValue(
						ui,
						"CODEX_KEYCHAIN",
						optIn ? "1 (enabled)" : "unset/disabled",
					),
				);
				lines.push(
					formatUiKeyValue(
						ui,
						"Keychain reachable",
						optIn ? (available ? "yes" : "no") : "not checked (opt-in off)",
					),
				);
				lines.push(
					formatUiKeyValue(
						ui,
						"Project scope",
						projectKey ?? "global",
					),
				);
				lines.push(formatUiKeyValue(ui, "On-disk path", storagePath));
				// A marker file means a JSON copy was retired beside the store —
				// after opt-out it is the only rollback path, and after opt-in
				// each one still holds a plaintext token set. Surface the count
				// so a stranded marker is never invisible to the operator.
				if (storagePath !== "<unresolved>") {
					const markers = await findMigrationBackups(storagePath);
					lines.push(
						formatUiKeyValue(
							ui,
							"Rollback markers",
							String(markers.length),
						),
					);
					if (markers.length > 0) {
						lines.push(
							formatUiItem(
								ui,
								`${markers.length} .migrated-to-keychain marker(s) sit next to the accounts file; "codex-keychain rollback" restores the newest.`,
							),
						);
					}
				}
				if (!optIn) {
					lines.push("");
					lines.push(
						formatUiItem(
							ui,
							"Set CODEX_KEYCHAIN=1 to enable the OS-keychain backend. Migration runs on the next save.",
						),
					);
				}
				return lines.join("\n");
			}

			if (sub === "migrate") {
				if (!optIn) {
					return "codex-keychain migrate: refusing to migrate because CODEX_KEYCHAIN is not set to 1. Enable the opt-in first, then re-run this command.";
				}
				// Read and re-save under a single storage-lock transaction so a
				// concurrent rotation save landing between the read and the
				// write cannot be clobbered by a stale snapshot (the docstring
				// above claims this already ran under the same lock as
				// saveAccounts/loadAccounts; loadAccounts()+saveAccounts() as
				// two independent calls did not actually guarantee that).
				return withAccountStorageTransaction(async (current, persist) => {
					if (!current) {
						return "codex-keychain migrate: no accounts found to migrate. Nothing to do.";
					}
					// Re-saving under the opt-in path triggers the same keychain
					// write + JSON-backup flow used by every rotation save, so we
					// avoid duplicating the migration logic here.
					await persist(current);
					return [
						...formatUiHeader(ui, "Codex keychain migrate"),
						"",
						formatUiItem(
							ui,
							`Migrated ${current.accounts.length} account(s) to the OS keychain.`,
						),
						formatUiKeyValue(ui, "Project scope", projectKey ?? "global"),
						formatUiItem(
							ui,
							"On-disk JSON (if any) was renamed with a .migrated-to-keychain.<timestamp> suffix. Use `codex-keychain rollback` to restore it.",
						),
					].join("\n");
				});
			}

			// rollback
			//
			// Pin the storage scope for the whole probe + critical section so a
			// concurrent perProjectAccounts scope flip cannot leave the backup
			// scan, the filesystem lease, and the flagged-store restore pointing
			// at sibling files in different scopes. The shadowed `storagePath`
			// and `projectKey` below are re-resolved under the pin so they can
			// never disagree with the paths used inside the critical section.
			return withPinnedStorageScope(async () => {
			const storagePath = (() => {
				try {
					return getStoragePath();
				} catch {
					return "<unresolved>";
				}
			})();
			if (storagePath === "<unresolved>") {
				return "codex-keychain rollback: could not resolve the accounts storage path for the current scope. Aborted.";
			}
			const projectKey = getCurrentProjectStorageKey();
			const backups = await findMigrationBackups(storagePath);
			const mostRecent = backups[0];
			if (!mostRecent) {
				return `codex-keychain rollback: no .migrated-to-keychain.<ts> backup found next to ${storagePath}. Nothing to restore.`;
			}
			// Verify the backup parses as a V3 storage blob before we trust
			// it. A corrupt backup must not be promoted to the active file.
			let accountCount = 0;
			try {
				const raw = await fs.readFile(mostRecent, "utf-8");
				const parsed = JSON.parse(raw) as unknown;
				const normalized = normalizeAccountStorage(parsed, mostRecent);
				if (!normalized) {
					return `codex-keychain rollback: backup at ${mostRecent} did not parse as V3 account storage. Aborted.`;
				}
				accountCount = normalized.accounts.length;
			} catch (err) {
				return `codex-keychain rollback: failed to read backup at ${mostRecent}: ${(err as Error).message}`;
			}

			// Everything below mutates the canonical storage path (JSON file +
			// keychain entry) and must run as one critical section under the
			// same mutex loadAccounts/saveAccounts use AND the cross-process
			// filesystem lease on `storagePath`, so neither an in-process
			// rotation save nor a sibling process's transaction can land
			// between the existence check and the final rename below.
			// withStorageLock (inside withStorageTransaction) is NOT re-entrant,
			// so this callback uses raw fs operations + the already-unlocked
			// deleteFromKeychain instead of the locked clearAccounts/
			// loadAccounts/saveAccounts wrappers -- calling any of those in
			// here would deadlock against this very lock acquisition.
			//
			// Silent-clobber guard (F1 post-merge MEDIUM finding) is folded
			// into the same critical section: on POSIX, `rename(backup,
			// storagePath)` silently overwrites an existing destination, so a
			// current file is archived (with explicit confirm=true) or refused
			// rather than deleted outright before the backup takes its place.
			const rollbackResult = await withStorageTransaction({
				storagePath,
				load: () => Promise.resolve<null>(null),
				persist: () => Promise.resolve(),
				handler: async () => {
				const warnings: string[] = [];
				let currentExists = false;
				try {
					await fs.access(storagePath);
					currentExists = true;
				} catch (err) {
					const code = (err as NodeJS.ErrnoException).code;
					if (code !== "ENOENT") {
						// Only ENOENT means "nothing at this path". Any other
						// failure (EACCES, a transient FS error, ...) means we
						// genuinely don't know whether a current file exists, so
						// proceeding past the confirm guard could silently
						// clobber live credentials. Abort instead of guessing.
						return {
							ok: false as const,
							message: `codex-keychain rollback: failed to check for an existing accounts file at ${storagePath}: ${(err as Error).message}. Aborted.`,
						};
					}
					/* ENOENT: canonical path is clear; safe to rename */
				}
				let preRollbackArchive: string | null = null;
				if (currentExists) {
					if (!confirm) {
						return {
							ok: false as const,
							message: [
								`codex-keychain rollback: refusing to overwrite existing accounts file at ${storagePath}.`,
								`Backup at ${mostRecent} was not restored.`,
								"Pass confirm=true to archive the current file as .pre-rollback.<timestamp> and proceed, or move the current file aside and re-run.",
							].join("\n"),
						};
					}
					preRollbackArchive = timestampedArtifactName(storagePath, ".pre-rollback.");
					try {
						await renameWithWindowsRetry(storagePath, preRollbackArchive);
					} catch (err) {
						return {
							ok: false as const,
							message: `codex-keychain rollback: failed to archive current accounts file at ${storagePath} -> ${preRollbackArchive}: ${(err as Error).message}. Backup at ${mostRecent} was not restored.`,
						};
					}
				}

				// Apply 0o600 to the BACKUP file BEFORE promoting it, so the
				// active file can never briefly (or permanently, if the
				// process dies between rename and chmod) end up group/world
				// readable. rename() preserves the source file's mode, so
				// chmodding the backup here has the same effect on the
				// eventual `storagePath` as chmodding it after the rename
				// would have -- without the intermediate window. Windows
				// ignores POSIX mode bits, so skip there. A chmod failure is
				// a hardening nicety, not a reason to abort a recovery tool
				// on a permission-quirky mount -- but it must not be
				// silently swallowed either.
				if (process.platform !== "win32") {
					try {
						await fs.chmod(mostRecent, 0o600);
					} catch (err) {
						warnings.push(
							`codex-keychain rollback: could not set restrictive permissions on the backup before restoring it (${(err as Error).message}). The restored file's permissions were not hardened; verify them manually.`,
						);
					}
				}

				try {
					await renameWithWindowsRetry(mostRecent, storagePath);
					await fsyncParentDirectory(storagePath);
				} catch (err) {
					const renameError = (err as Error).message;
					if (preRollbackArchive) {
						// The current file was already archived; try to put it
						// back so this failure doesn't leave the canonical path
						// empty.
						try {
							await renameWithWindowsRetry(preRollbackArchive, storagePath);
							return {
								ok: false as const,
								message: `codex-keychain rollback: failed to promote backup ${mostRecent} -> ${storagePath}: ${renameError}. Recovered by restoring the previously archived file from ${preRollbackArchive}.`,
							};
						} catch (recoveryErr) {
							return {
								ok: false as const,
								message: `codex-keychain rollback: failed to promote backup ${mostRecent} -> ${storagePath}: ${renameError}. Recovery also failed: could not restore the archived file from ${preRollbackArchive} back to ${storagePath}: ${(recoveryErr as Error).message}. Manual intervention required -- check both ${preRollbackArchive} and ${mostRecent}.`,
							};
						}
					}
					return {
						ok: false as const,
						message: `codex-keychain rollback: failed to rename ${mostRecent} -> ${storagePath}: ${renameError}`,
					};
				}
				// Preserve then delete the keychain entry now that the backup
				// is active. Rollback means "stop trusting the keychain copy",
				// and the typical flow is `unset CODEX_KEYCHAIN` BEFORE rolling
				// back — gating the delete on opt-in would leave a stale entry
				// that silently becomes authoritative again on the next opt-in.
				// The live entry is archived first: every post-migration save
				// wrote keychain-only, so it can hold state strictly newer than
				// the backup being restored. A failed archive SKIPS the delete —
				// deleting unpreserved newer state is the loss this tool exists
				// to prevent.
				const mainSafeToDelete = await archiveLiveKeychainBlob(
					() => readFromKeychain(projectKey),
					storagePath,
					warnings,
					"accounts",
				);
				if (mainSafeToDelete) {
					const result = await deleteFromKeychain(projectKey);
					if (!result.deleted && (result.error || optIn)) {
						warnings.push(
							`codex-keychain rollback: could not confirm the OS-keychain entry was deleted${
								result.error ? ` (${result.error})` : ""
							}. The keychain copy may still exist and would be preferred over this restored file on the next load -- delete it manually or disable CODEX_KEYCHAIN.`,
						);
					}
				}
				return {
					ok: true as const,
					preRollbackArchive,
					warnings,
				};
				},
			});

			if (!rollbackResult.ok) {
				return rollbackResult.message;
			}
			// Flagged-store parity: flagged entries migrate to the keychain
			// under the same `.migrated-to-keychain.<ts>` marker scheme, so a
			// rollback that restores only the main file leaves quarantined
			// credentials keychain-only. The flagged store carries its OWN
			// transaction lease — running the flagged renames inside the main
			// transaction would mutate it unprotected (and deadlocks anyway:
			// withStorageLock is not re-entrant), so it runs here, after the
			// main lease is released, under the flagged lease itself.
			const flaggedOutcome = await restoreFlaggedStoreFromKeychainBackup({
				confirm: confirm === true,
				optIn,
				projectKey,
			});
			const warnings = [
				...rollbackResult.warnings,
				...flaggedOutcome.warnings,
			];
			// Bound the artifact families this tool creates. The marker just
			// promoted out of `migrated-to-keychain` is already gone; pruning
			// here keeps older markers plus the `pre-rollback` archives from
			// accumulating without limit across repeated migrate/rollback
			// cycles. Best-effort — a prune failure never fails the rollback.
			await pruneSiblingArtifacts(storagePath, ".migrated-to-keychain.");
			await pruneSiblingArtifacts(storagePath, ".pre-rollback.");
			await pruneSiblingArtifacts(storagePath, ".pre-rollback-keychain.");
			const preRollbackArchive = rollbackResult.preRollbackArchive;

			// Warnings and paths are app-generated but interpolate long storage
			// paths — give them a bound well above the untrusted-label cap so a
			// hard truncate cannot cut the message before its reason.
			const lines: string[] = [
				...formatUiHeader(ui, "Codex keychain rollback"),
				"",
				formatUiItem(
					ui,
					`Restored ${accountCount} account(s) from backup ${mostRecent}.`,
					"normal",
					"",
					400,
				),
				formatUiKeyValue(ui, "Active file", storagePath, "normal", 400),
			];
			if (preRollbackArchive) {
				lines.push(
					formatUiKeyValue(
						ui,
						"Previous file archived at",
						preRollbackArchive,
						"normal",
						400,
					),
				);
			}
			if (flaggedOutcome.restored) {
				lines.push(
					formatUiItem(
						ui,
						"Flagged store restored from its most recent .migrated-to-keychain backup.",
					),
				);
			}
			for (const warning of warnings) {
				lines.push(formatUiItem(ui, warning, "warning", "", 400));
			}
			lines.push(
				formatUiItem(
					ui,
					"To stop using the keychain backend, unset CODEX_KEYCHAIN (or set it to any value other than \"1\") before the next save.",
				),
			);
			return lines.join("\n");
			});
		},
	});
}
