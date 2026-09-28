/**
 * Storage-scope pinning: `withPinnedStorageScope` holds one resolved storage
 * location for the whole lifetime of a transaction/load/save/clear even when
 * `setStoragePath` flips the active scope mid-flight.
 *
 * The defect this guards: a transaction acquired its filesystem lease for
 * project A's accounts file, then `perProjectAccounts` switching (or a test
 * resetting state) changed the active scope to project B, and the
 * transaction's load/persist — which resolved `getStoragePath()` dynamically —
 * read and wrote B's file while holding A's lease. The pin makes every getter
 * resolve the location captured at entry.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
	clearAccounts,
	getStoragePath,
	loadAccounts,
	saveAccounts,
	setStoragePath,
	setStoragePathDirect,
	withAccountStorageTransaction,
	withFlaggedAccountStorageTransaction,
	type AccountStorageV3,
} from "../lib/storage.js";
import { getFlaggedAccountsPath } from "../lib/storage/flagged.js";
import {
	getCurrentProjectStorageKey,
	withPinnedStorageScope,
} from "../lib/storage/state.js";
import { getProjectGlobalConfigDir } from "../lib/storage/paths.js";
import { FLAGGED_ACCOUNTS_FILE_NAME } from "../lib/constants.js";

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

describe("storage scope pinning", () => {
	let workDir: string;
	let homeDir: string;
	let projectDirA: string;
	let projectDirB: string;
	const originalHome = process.env.HOME;
	const originalUserProfile = process.env.USERPROFILE;

	beforeEach(async () => {
		workDir = join(
			tmpdir(),
			`storage-io-pin-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		homeDir = join(workDir, "home");
		projectDirA = join(workDir, "project-a");
		projectDirB = join(workDir, "project-b");
		await fs.mkdir(homeDir, { recursive: true });
		await fs.mkdir(join(projectDirA, ".git"), { recursive: true });
		await fs.mkdir(join(projectDirB, ".git"), { recursive: true });
		process.env.HOME = homeDir;
		process.env.USERPROFILE = homeDir;
		setStoragePathDirect(null);
	});

	afterEach(async () => {
		setStoragePathDirect(null);
		process.env.HOME = originalHome;
		process.env.USERPROFILE = originalUserProfile;
		await fs.rm(workDir, { recursive: true, force: true });
	});

	it("pins a transaction's load + persist to the scope captured at entry", async () => {
		setStoragePath(projectDirA);
		const pathA = getStoragePath();
		const pathB = join(getProjectGlobalConfigDir(projectDirB), "oc-codex-multi-auth-accounts.json");

		let observedInside: string | null = null;
		let keyInside: string | null | undefined;
		await withAccountStorageTransaction(async (_current, persist) => {
			// Flip the active scope mid-transaction. The lease was taken on A;
			// every path resolution below must still be A.
			setStoragePath(projectDirB);
			observedInside = getStoragePath();
			keyInside = getCurrentProjectStorageKey();
			await persist(makeStorage("account-a"));
			return undefined;
		});

		// Inside the pin both the path and the keychain-scope key stayed on A.
		expect(observedInside).toBe(pathA);
		expect(keyInside).toMatch(/^project-a-/);

		// The write landed on A's file — the path the lease covers — and B's
		// store was never created.
		expect(existsSync(pathA)).toBe(true);
		expect(existsSync(pathB)).toBe(false);
		const written = JSON.parse(await fs.readFile(pathA, "utf-8")) as AccountStorageV3;
		expect(written.accounts[0]?.accountId).toBe("account-a");

		// After the pin released, the flip applies: the live scope is B.
		expect(getStoragePath()).toBe(pathB);
	});

	it("pins a flagged transaction to the flagged file of the entry scope", async () => {
		setStoragePath(projectDirA);
		const flaggedA = join(
			getProjectGlobalConfigDir(projectDirA),
			FLAGGED_ACCOUNTS_FILE_NAME,
		);
		const flaggedB = join(
			getProjectGlobalConfigDir(projectDirB),
			FLAGGED_ACCOUNTS_FILE_NAME,
		);

		let observedFlaggedPath: string | null = null;
		await withFlaggedAccountStorageTransaction(async (_current, persist) => {
			setStoragePath(projectDirB);
			observedFlaggedPath = getFlaggedAccountsPath();
			await persist({
				version: 1,
				accounts: [
					{
						refreshToken: "flagged-refresh-a",
						accountId: "flagged-a",
						addedAt: 1,
						lastUsed: 1,
						flaggedAt: 1,
					},
				],
			});
			return undefined;
		});

		expect(observedFlaggedPath).toBe(flaggedA);
		expect(existsSync(flaggedA)).toBe(true);
		expect(existsSync(flaggedB)).toBe(false);
		// The scope flip did take effect once the pin dropped.
		expect(getFlaggedAccountsPath()).toBe(flaggedB);
	});

	it("keeps loadAccounts on the pinned scope while the live scope has flipped", async () => {
		setStoragePath(projectDirA);
		const pathA = getStoragePath();
		await fs.mkdir(dirname(pathA), { recursive: true });
		await fs.writeFile(pathA, JSON.stringify(makeStorage("account-a")), "utf-8");

		const loaded = await withPinnedStorageScope(async () => {
			setStoragePath(projectDirB);
			return loadAccounts();
		});

		// The pin captured A before the flip, so the load sees A's pool.
		expect(loaded?.accounts[0]?.accountId).toBe("account-a");
		expect(getStoragePath()).toBe(
			join(getProjectGlobalConfigDir(projectDirB), "oc-codex-multi-auth-accounts.json"),
		);
	});

	it("clears the pinned scope's file, not the scope it flipped to", async () => {
		setStoragePath(projectDirA);
		const pathA = getStoragePath();
		const pathB = join(getProjectGlobalConfigDir(projectDirB), "oc-codex-multi-auth-accounts.json");
		await fs.mkdir(dirname(pathA), { recursive: true });
		await fs.mkdir(dirname(pathB), { recursive: true });
		await fs.writeFile(pathA, JSON.stringify(makeStorage("account-a")), "utf-8");
		await fs.writeFile(pathB, JSON.stringify(makeStorage("account-b")), "utf-8");

		await withPinnedStorageScope(async () => {
			setStoragePath(projectDirB);
			await clearAccounts();
		});

		// A's file is gone; B's — now the live scope — was never touched.
		expect(existsSync(pathA)).toBe(false);
		expect(existsSync(pathB)).toBe(true);
	});

	it("does not leak the pin after the operation completes", async () => {
		setStoragePath(projectDirA);
		await withPinnedStorageScope(async () => {
			setStoragePath(projectDirB);
		});
		// No ambient pin remains: a save now writes to the live scope B.
		await saveAccounts(makeStorage("account-b"));
		const pathB = getStoragePath();
		const written = JSON.parse(await fs.readFile(pathB, "utf-8")) as AccountStorageV3;
		expect(written.accounts[0]?.accountId).toBe("account-b");
	});
});
