/**
 * Assorted storage hardening pins that do not fit the keychain/rotation files:
 *
 *   - `sanitizeAccountNumericState` (via `normalizeAccountStorage`) must
 *     return a sanitized COPY — pruning `rateLimitResetTimes` (or any other
 *     field) on the caller's object would leak "unsanitized" state back out
 *     through the original reference the caller may still hold.
 *   - A UTF-8 BOM is legal file content but crashes `JSON.parse`; every
 *     parse site (main load, flagged load, import file) strips it first.
 *   - `resolvePath` must follow symlinks before the containment check, so a
 *     link inside an allowed root cannot smuggle a write outside it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	loadAccounts,
	saveAccounts,
	setStoragePathDirect,
	clearFlaggedAccounts,
	loadFlaggedAccounts,
	saveFlaggedAccounts,
	importAccounts,
} from "../lib/storage.js";
import { normalizeAccountStorage } from "../lib/storage/normalize.js";
import { resolvePath } from "../lib/storage/paths.js";
import { StorageError } from "../lib/storage/errors.js";

async function allocateDir(): Promise<string> {
	const dir = join(
		tmpdir(),
		`storage-hardening-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

describe("sanitizeAccountNumericState copy semantics", () => {
	it("returns a sanitized copy and never mutates or aliases the input", () => {
		const poisoned = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "rt",
					addedAt: 1,
					lastUsed: 1,
					expiresAt: Infinity,
					rateLimitResetTimes: {
						codex: Infinity,
						"gpt-5-codex": 100,
					},
				},
			],
		};

		const normalized = normalizeAccountStorage(poisoned);
		expect(normalized).not.toBeNull();
		const account = normalized!.accounts[0]!;

		// Sanitized output: non-finite values are gone, finite ones kept.
		expect(account.expiresAt).toBeUndefined();
		expect(account.rateLimitResetTimes).toEqual({ "gpt-5-codex": 100 });

		// Input is untouched — including the nested map. Before the fix, the
		// Infinity key was pruned from the caller's shared map while other
		// fields kept raw values, leaking half-sanitized state.
		const inputAccount = poisoned.accounts[0]!;
		expect(inputAccount.expiresAt).toBe(Infinity);
		expect(inputAccount.rateLimitResetTimes.codex).toBe(Infinity);
		expect(inputAccount.rateLimitResetTimes["gpt-5-codex"]).toBe(100);

		// And the returned map is a different object entirely.
		expect(account.rateLimitResetTimes).not.toBe(
			inputAccount.rateLimitResetTimes,
		);
	});

	it("drops every non-finite rate-limit entry without touching the input map", () => {
		const input = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "rt",
					addedAt: 1,
					lastUsed: 1,
					rateLimitResetTimes: { codex: NaN },
				},
			],
		};
		const normalized = normalizeAccountStorage(input);
		expect(normalized?.accounts[0]?.rateLimitResetTimes).toBeUndefined();
		expect(Number.isNaN(input.accounts[0]!.rateLimitResetTimes.codex)).toBe(true);
	});
});

describe("UTF-8 BOM handling", () => {
	let dir: string;
	let storagePath: string;
	let flaggedPath: string;

	beforeEach(async () => {
		dir = await allocateDir();
		storagePath = join(dir, "accounts.json");
		flaggedPath = join(dir, "oc-codex-multi-auth-flagged-accounts.json");
		setStoragePathDirect(storagePath);
	});
	afterEach(async () => {
		setStoragePathDirect(null);
		try {
			await fs.rm(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("loadAccounts parses a file that starts with a BOM", async () => {
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [{ refreshToken: "rt", addedAt: 1, lastUsed: 1 }],
		});
		const raw = await fs.readFile(storagePath, "utf-8");
		await fs.writeFile(storagePath, String.fromCharCode(0xfeff) + raw, "utf-8");

		const loaded = await loadAccounts();
		expect(loaded?.accounts[0]?.refreshToken).toBe("rt");
	});

	it("loadFlaggedAccounts parses a file that starts with a BOM", async () => {
		await saveFlaggedAccounts({
			version: 1,
			accounts: [
				{ refreshToken: "frt", addedAt: 1, lastUsed: 1, flaggedAt: 1 },
			],
		});
		const raw = await fs.readFile(flaggedPath, "utf-8");
		await fs.writeFile(flaggedPath, String.fromCharCode(0xfeff) + raw, "utf-8");

		const loaded = await loadFlaggedAccounts();
		expect(loaded.accounts[0]?.refreshToken).toBe("frt");
	});

	it("importAccounts accepts a BOM-prefixed export file", async () => {
		const exportFile = join(dir, "bom-export.json");
		const payload = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "imported-rt",
					accountId: "acct-imported",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		};
		await fs.writeFile(
			exportFile,
			String.fromCharCode(0xfeff) + JSON.stringify(payload, null, 2),
			"utf-8",
		);

		const result = await importAccounts(exportFile, { backupMode: "none" });
		expect(result.imported).toBeGreaterThanOrEqual(1);
		const loaded = await loadAccounts();
		expect(
			loaded?.accounts.some((a) => a.refreshToken === "imported-rt"),
		).toBe(true);
	});
});

describe.skipIf(process.platform === "win32")(
	"resolvePath symlink canonicalization",
	() => {
		let dir: string;

		beforeEach(async () => {
			dir = await allocateDir();
		});
		afterEach(async () => {
			try {
				await fs.rm(dir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		});

		it("denies a symlink inside an allowed root that points outside all roots", async () => {
			// tmpdir is an allowed root; `/` exists everywhere POSIX and sits
			// outside every allowed root.
			const linkPath = join(dir, "escape-link");
			await fs.symlink("/", linkPath);
			expect(() => resolvePath(join(linkPath, "stolen.json"))).toThrowError(
				StorageError,
			);
		});

		it("allows a symlink that stays inside an allowed root", async () => {
			const realDir = join(dir, "real");
			await fs.mkdir(realDir);
			const linkPath = join(dir, "inside-link");
			await fs.symlink(realDir, linkPath);

			const resolved = resolvePath(join(linkPath, "ok.json"));
			// The lexical path is returned for the caller to write through; the
			// canonical check is what vetted it.
			expect(resolved).toBe(join(linkPath, "ok.json"));
		});
	},
);

describe("flagged-store clear without keychain (baseline)", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await allocateDir();
		setStoragePathDirect(join(dir, "accounts.json"));
	});
	afterEach(async () => {
		setStoragePathDirect(null);
		try {
			await fs.rm(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("clearFlaggedAccounts removes the JSON store", async () => {
		const flaggedPath = join(dir, "oc-codex-multi-auth-flagged-accounts.json");
		await saveFlaggedAccounts({
			version: 1,
			accounts: [
				{ refreshToken: "frt", addedAt: 1, lastUsed: 1, flaggedAt: 1 },
			],
		});
		expect(existsSync(flaggedPath)).toBe(true);
		await clearFlaggedAccounts();
		expect(existsSync(flaggedPath)).toBe(false);
		expect((await loadFlaggedAccounts()).accounts).toHaveLength(0);
	});
});
