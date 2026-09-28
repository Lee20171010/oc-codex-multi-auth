/**
 * Legacy-storage migration safety: a present-but-unreadable or undecodable
 * legacy file is NEVER treated as "nothing to migrate". The failure must be
 * loud (typed StorageError) and the legacy file must be left in place, so a
 * retry — or a manual restore — can still recover the credentials a silent
 * empty pool would have overwritten.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
	loadAccounts,
	loadFlaggedAccounts,
	setStoragePath,
	setStoragePathDirect,
	getStoragePath,
	StorageError,
	type AccountStorageV3,
} from "../lib/storage.js";
import { getFlaggedAccountsPath } from "../lib/storage/flagged.js";
import { getProjectGlobalConfigDir } from "../lib/storage/paths.js";
import {
	LEGACY_ACCOUNTS_FILE_NAME,
	LEGACY_FLAGGED_ACCOUNTS_FILE_NAME,
	ACCOUNTS_FILE_NAME,
} from "../lib/constants.js";
import { UNKNOWN_V2_FORMAT_CODE } from "../lib/storage/migrations.js";

function storageJson(accountId: string): string {
	return JSON.stringify({
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
	});
}

describe("storage I/O: legacy migration loudness", () => {
	let workDir: string;
	let homeDir: string;
	let projectDir: string;
	const originalHome = process.env.HOME;
	const originalUserProfile = process.env.USERPROFILE;

	beforeEach(async () => {
		workDir = join(
			tmpdir(),
			`storage-io-migration-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		homeDir = join(workDir, "home");
		projectDir = join(workDir, "project");
		await fs.mkdir(homeDir, { recursive: true });
		await fs.mkdir(join(projectDir, ".git"), { recursive: true });
		process.env.HOME = homeDir;
		process.env.USERPROFILE = homeDir;
		setStoragePathDirect(null);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setStoragePathDirect(null);
		process.env.HOME = originalHome;
		process.env.USERPROFILE = originalUserProfile;
		await fs.rm(workDir, { recursive: true, force: true });
	});

	it("throws INVALID_STORAGE and keeps a corrupt legacy project file", async () => {
		setStoragePath(projectDir);
		const legacyPath = join(projectDir, ".opencode", LEGACY_ACCOUNTS_FILE_NAME);
		await fs.mkdir(join(projectDir, ".opencode"), { recursive: true });
		await fs.writeFile(legacyPath, "{ not json", "utf-8");

		await expect(loadAccounts()).rejects.toMatchObject({
			code: "INVALID_STORAGE",
		});
		// The legacy file must still be there — a corrupt file is a recovery
		// artefact, not a consumed migration.
		expect(existsSync(legacyPath)).toBe(true);
		expect(await fs.readFile(legacyPath, "utf-8")).toBe("{ not json");
		// And nothing was written to the destination.
		expect(existsSync(getStoragePath())).toBe(false);
	});

	it("throws a typed error and keeps an unreadable legacy project file", async () => {
		setStoragePath(projectDir);
		const legacyPath = join(projectDir, ".opencode", LEGACY_ACCOUNTS_FILE_NAME);
		await fs.mkdir(join(projectDir, ".opencode"), { recursive: true });
		await fs.writeFile(legacyPath, storageJson("legacy-account"), "utf-8");

		const originalReadFile = fs.readFile.bind(fs);
		const spy = vi
			.spyOn(fs, "readFile")
			.mockImplementation(async (path, options) => {
				if (String(path) === legacyPath) {
					throw Object.assign(new Error("simulated EACCES"), { code: "EACCES" });
				}
				return originalReadFile(path as string, options as never);
			});

		try {
			await expect(loadAccounts()).rejects.toBeInstanceOf(StorageError);
		} finally {
			spy.mockRestore();
		}
		expect(existsSync(legacyPath)).toBe(true);
		expect(existsSync(getStoragePath())).toBe(false);
	});

	it("propagates UNKNOWN_V2_FORMAT from a legacy global file and keeps it", async () => {
		// Global scope: no project selection at all.
		setStoragePath(null);
		const legacyGlobalPath = join(homeDir, ".opencode", LEGACY_ACCOUNTS_FILE_NAME);
		await fs.mkdir(join(homeDir, ".opencode"), { recursive: true });
		// The V2 detection shape: version 2 with an accounts array.
		await fs.writeFile(
			legacyGlobalPath,
			JSON.stringify({ version: 2, accounts: [{ refreshToken: "v2-token" }] }),
			"utf-8",
		);

		await expect(loadAccounts()).rejects.toMatchObject({
			code: UNKNOWN_V2_FORMAT_CODE,
		});
		expect(existsSync(legacyGlobalPath)).toBe(true);
	});

	it("propagates UNSUPPORTED_SCHEMA_VERSION from a legacy project file and keeps it", async () => {
		setStoragePath(projectDir);
		const legacyPath = join(projectDir, ".opencode", LEGACY_ACCOUNTS_FILE_NAME);
		await fs.mkdir(join(projectDir, ".opencode"), { recursive: true });
		await fs.writeFile(
			legacyPath,
			JSON.stringify({ version: 99, accounts: [], activeIndex: 0 }),
			"utf-8",
		);

		await expect(loadAccounts()).rejects.toMatchObject({
			code: "UNSUPPORTED_SCHEMA_VERSION",
		});
		expect(existsSync(legacyPath)).toBe(true);
	});

	it("keeps the legacy file when the destination write fails", async () => {
		setStoragePath(projectDir);
		const legacyPath = join(projectDir, ".opencode", LEGACY_ACCOUNTS_FILE_NAME);
		await fs.mkdir(join(projectDir, ".opencode"), { recursive: true });
		await fs.writeFile(legacyPath, storageJson("legacy-account"), "utf-8");

		// Fail only the rename that publishes the migrated destination.
		const projectPath = getStoragePath();
		const originalRename = fs.rename.bind(fs);
		const spy = vi.spyOn(fs, "rename").mockImplementation(async (src, dst) => {
			if (String(dst) === projectPath) {
				throw Object.assign(new Error("simulated EIO"), { code: "EIO" });
			}
			return originalRename(src as string, dst as string);
		});

		try {
			// The migrated pool is still returned (the data is usable) but the
			// legacy file survives so the next load can retry the migration.
			const loaded = await loadAccounts();
			expect(loaded?.accounts[0]?.accountId).toBe("legacy-account");
		} finally {
			spy.mockRestore();
		}
		expect(existsSync(legacyPath)).toBe(true);
		expect(await fs.readFile(legacyPath, "utf-8")).toBe(storageJson("legacy-account"));
	});

	it("throws INVALID_STORAGE for a corrupt flagged sibling file", async () => {
		setStoragePath(projectDir);
		const flaggedPath = getFlaggedAccountsPath();
		await fs.mkdir(join(getProjectGlobalConfigDir(projectDir)), { recursive: true });
		await fs.writeFile(flaggedPath, "{ broken", "utf-8");

		await expect(loadFlaggedAccounts()).rejects.toMatchObject({
			code: "INVALID_STORAGE",
		});
		expect(await fs.readFile(flaggedPath, "utf-8")).toBe("{ broken");
	});

	it("throws and keeps a corrupt legacy flagged file", async () => {
		setStoragePath(projectDir);
		const legacyFlagged = join(
			getProjectGlobalConfigDir(projectDir),
			LEGACY_FLAGGED_ACCOUNTS_FILE_NAME,
		);
		await fs.mkdir(getProjectGlobalConfigDir(projectDir), { recursive: true });
		await fs.writeFile(legacyFlagged, "nonsense", "utf-8");

		await expect(loadFlaggedAccounts()).rejects.toMatchObject({
			code: "INVALID_STORAGE",
		});
		expect(existsSync(legacyFlagged)).toBe(true);
	});

	it("throws UNSUPPORTED_SCHEMA_VERSION for a future-version flagged file", async () => {
		setStoragePath(projectDir);
		const flaggedPath = getFlaggedAccountsPath();
		await fs.mkdir(dirname(flaggedPath), { recursive: true });
		await fs.writeFile(
			flaggedPath,
			JSON.stringify({ version: 2, accounts: [] }),
			"utf-8",
		);

		await expect(loadFlaggedAccounts()).rejects.toMatchObject({
			code: "UNSUPPORTED_SCHEMA_VERSION",
		});
	});

	it("migrates a V1 main-store legacy global file to V3 and removes it", async () => {
		setStoragePath(null);
		const legacyGlobalPath = join(homeDir, ".opencode", LEGACY_ACCOUNTS_FILE_NAME);
		await fs.mkdir(join(homeDir, ".opencode"), { recursive: true });
		await fs.writeFile(
			legacyGlobalPath,
			JSON.stringify({
				version: 1,
				accounts: [
					{
						refreshToken: "v1-refresh",
						accountId: "v1-account",
						addedAt: 1,
						lastUsed: 1,
					},
				],
			}),
			"utf-8",
		);

		const loaded = await loadAccounts();
		expect(loaded?.version).toBe(3);
		expect(loaded?.accounts[0]?.accountId).toBe("v1-account");
		expect(existsSync(legacyGlobalPath)).toBe(false);
		const globalPath = join(homeDir, ".opencode", ACCOUNTS_FILE_NAME);
		expect(existsSync(globalPath)).toBe(true);
	});
});
