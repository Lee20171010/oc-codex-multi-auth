/**
 * Bounded credential-artifact retention.
 *
 * `backups/` is shared by several artifact families — credential snapshots
 * (`codex-credential-snapshot-*`), pre-import backups (`codex-pre-import-backup-*`),
 * keychain migration markers, and rollback archives — and each family is
 * pruned by its own prefix so retention for one can never delete another.
 * Covers the previously unbounded pre-import backup growth plus the clean
 * release of the filesystem lease `clearAccounts` now runs under.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	clearAccounts,
	importAccounts,
	saveAccounts,
	setStoragePathDirect,
	type AccountStorageV3,
} from "../lib/storage.js";
import { getBackupDirectory } from "../lib/storage/backup.js";

const ORIGINAL_MAX_COUNT = process.env.CODEX_AUTH_CREDENTIAL_SNAPSHOTS_MAX_COUNT;
const ORIGINAL_KEYCHAIN = process.env.CODEX_KEYCHAIN;

function makeStorage(accountId: string): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		accounts: [
			{
				refreshToken: `refresh-${accountId}`,
				accountId,
				addedAt: 1,
				lastUsed: 1,
			},
		],
	};
}

async function listFamily(dir: string, prefix: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(dir);
		return entries.filter((name) => name.startsWith(prefix));
	} catch {
		return [];
	}
}

describe("storage I/O: artifact retention", () => {
	let dir: string;
	let storagePath: string;
	let backupDir: string;

	beforeEach(async () => {
		dir = join(
			tmpdir(),
			`storage-io-artifacts-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await fs.mkdir(dir, { recursive: true });
		storagePath = join(dir, "oc-codex-multi-auth-accounts.json");
		backupDir = getBackupDirectory(storagePath);
		setStoragePathDirect(storagePath);
		// Snapshots only exist on the JSON backend — keep the keychain off.
		delete process.env.CODEX_KEYCHAIN;
	});

	afterEach(async () => {
		setStoragePathDirect(null);
		if (ORIGINAL_MAX_COUNT === undefined) {
			delete process.env.CODEX_AUTH_CREDENTIAL_SNAPSHOTS_MAX_COUNT;
		} else {
			process.env.CODEX_AUTH_CREDENTIAL_SNAPSHOTS_MAX_COUNT = ORIGINAL_MAX_COUNT;
		}
		if (ORIGINAL_KEYCHAIN === undefined) {
			delete process.env.CODEX_KEYCHAIN;
		} else {
			process.env.CODEX_KEYCHAIN = ORIGINAL_KEYCHAIN;
		}
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("bounds pre-import backups by the retention limit", async () => {
		process.env.CODEX_AUTH_CREDENTIAL_SNAPSHOTS_MAX_COUNT = "2";
		await saveAccounts(makeStorage("acct-base"));

		const importFile = join(dir, "import.json");
		await fs.writeFile(
			importFile,
			JSON.stringify({
				version: 3,
				accounts: [
					{
						refreshToken: "refresh-imported",
						accountId: "acct-imported",
						addedAt: 1,
						lastUsed: 1,
					},
				],
			}),
			"utf-8",
		);

		for (let i = 0; i < 4; i += 1) {
			const result = await importAccounts(importFile);
			expect(result.backupStatus).toBe("created");
		}

		const backups = await listFamily(backupDir, "codex-pre-import-backup-");
		expect(backups).toHaveLength(2);
	});

	it("prunes each artifact family independently", async () => {
		process.env.CODEX_AUTH_CREDENTIAL_SNAPSHOTS_MAX_COUNT = "2";

		// Three significant writes => two retained credential snapshots after
		// pruning (the first save has nothing to snapshot yet).
		for (let i = 0; i < 4; i += 1) {
			await saveAccounts(makeStorage(`acct-${i}`));
		}
		const snapshots = await listFamily(backupDir, "codex-credential-snapshot-");
		expect(snapshots).toHaveLength(2);

		// Pre-import backups live in the same directory but a different family;
		// one import adds one backup and leaves the snapshots untouched.
		const importFile = join(dir, "import.json");
		await fs.writeFile(
			importFile,
			JSON.stringify({
				version: 3,
				accounts: [
					{
						refreshToken: "refresh-other",
						accountId: "acct-other",
						addedAt: 1,
						lastUsed: 1,
					},
				],
			}),
			"utf-8",
		);
		await importAccounts(importFile);

		expect(await listFamily(backupDir, "codex-pre-import-backup-")).toHaveLength(1);
		expect(await listFamily(backupDir, "codex-credential-snapshot-")).toHaveLength(2);
	});

	it("clearAccounts runs under the filesystem lease and leaves no lock dir", async () => {
		await saveAccounts(makeStorage("acct-clear"));
		expect(existsSync(storagePath)).toBe(true);

		await clearAccounts();

		expect(existsSync(storagePath)).toBe(false);
		// proper-lockfile removes its own lock directory on a clean release; a
		// stranded one would mean the lease was leaked.
		expect(existsSync(`${storagePath}.transaction.lock`)).toBe(false);
	});

	it("clearAccounts preserves the keychain marker files' sibling backups dir", async () => {
		// Clearing must never sweep unrelated artifacts — a marker is the only
		// rollback path for a keychain migration.
		await saveAccounts(makeStorage("acct-x"));
		const marker = `${storagePath}.migrated-to-keychain.2024-01-01T00-00-00-000Z`;
		await fs.writeFile(marker, "{}", "utf-8");

		await clearAccounts();

		expect(existsSync(storagePath)).toBe(false);
		expect(existsSync(marker)).toBe(true);
	});
});
