/**
 * Flagged-store keychain parity tests.
 *
 * The main account store already had the load/save/clear keychain contract
 * covered in `storage-keychain.test.ts`. The flagged sibling store had the
 * writes but not the contract:
 *
 *   - `clearFlaggedAccounts` deleted only the JSON file, so under
 *     `CODEX_KEYCHAIN=1` a cleared flagged pool resurrected from the
 *     keychain-first read on the next load.
 *   - Flagged saves under the opt-in did not produce the
 *     `.migrated-to-keychain.<ts>` rollback artefact the main store's
 *     marker contract guarantees.
 *
 * This file pins both, plus the JSON-first clear ordering and the
 * never-throw-on-keychain-failure guarantee.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	_resetBackendForTests,
	_setBackendForTests,
	GLOBAL_KEYCHAIN_ACCOUNT_KEY,
	KEYCHAIN_SERVICE_NAME,
	buildKeychainFlaggedKey,
	deleteFlaggedFromKeychain,
	readFlaggedFromKeychain,
	writeFlaggedToKeychain,
	type KeychainBackend,
} from "../lib/storage/keychain.js";
import {
	clearFlaggedAccounts,
	loadFlaggedAccounts,
	saveFlaggedAccounts,
} from "../lib/storage.js";
import { setStoragePathDirect } from "../lib/storage/state.js";
import type { FlaggedAccountStorageV1 } from "../lib/storage/flagged.js";

/** Same shape as the mock in `storage-keychain.test.ts`, plus a delete gate. */
interface MockBackend extends KeychainBackend {
	store: Map<string, string>;
	calls: Array<{ op: string; service: string; account: string }>;
	setShouldThrow: boolean;
	deleteShouldThrow: boolean;
	deleteShouldKeepEntry: boolean;
}

function createMockBackend(): MockBackend {
	const store = new Map<string, string>();
	const calls: MockBackend["calls"] = [];
	const backend: MockBackend = {
		store,
		calls,
		setShouldThrow: false,
		deleteShouldThrow: false,
		deleteShouldKeepEntry: false,
		async get(service, account) {
			calls.push({ op: "get", service, account });
			return store.get(`${service}::${account}`) ?? null;
		},
		async set(service, account, secret) {
			calls.push({ op: "set", service, account });
			if (backend.setShouldThrow) {
				throw new Error("simulated keychain write failure");
			}
			store.set(`${service}::${account}`, secret);
		},
		async delete(service, account) {
			calls.push({ op: "delete", service, account });
			if (backend.deleteShouldThrow) {
				throw new Error("simulated keychain delete failure");
			}
			if (backend.deleteShouldKeepEntry) {
				// A backend that reports "not deleted" while the entry survives —
				// indistinguishable from "entry absent" on the boolean alone.
				return false;
			}
			return store.delete(`${service}::${account}`);
		},
		async isAvailable() {
			return true;
		},
	};
	return backend;
}

async function allocateStorageDir(): Promise<string> {
	const dir = join(
		tmpdir(),
		`flagged-keychain-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

const ORIGINAL_CODEX_KEYCHAIN = process.env.CODEX_KEYCHAIN;

function setOptIn(on: boolean): void {
	if (on) {
		process.env.CODEX_KEYCHAIN = "1";
	} else {
		delete process.env.CODEX_KEYCHAIN;
	}
}

function restoreOptIn(): void {
	if (ORIGINAL_CODEX_KEYCHAIN === undefined) {
		delete process.env.CODEX_KEYCHAIN;
	} else {
		process.env.CODEX_KEYCHAIN = ORIGINAL_CODEX_KEYCHAIN;
	}
}

function makeFlagged(): FlaggedAccountStorageV1 {
	return {
		version: 1,
		accounts: [
			{
				refreshToken: "flagged-refresh-token-redacted",
				accountId: "acct-flagged-1",
				organizationId: "org-1",
				addedAt: 1,
				lastUsed: 2,
				flaggedAt: 3,
			},
		],
	};
}

/** Storage-path-direct => no project key => global flagged keychain key. */
const FLAGGED_KEYCHAIN_KEY = buildKeychainFlaggedKey(null);

describe("flagged-store low-level keychain helpers", () => {
	beforeEach(() => {
		_resetBackendForTests();
	});
	afterEach(() => {
		_resetBackendForTests();
	});

	it("buildKeychainFlaggedKey namespaces the global key", () => {
		expect(FLAGGED_KEYCHAIN_KEY).toBe(`${GLOBAL_KEYCHAIN_ACCOUNT_KEY}:flagged`);
		expect(buildKeychainFlaggedKey("proj-key")).toBe("flagged:proj-key");
		// Must not collide with the main account key for the same scope.
		expect(buildKeychainFlaggedKey("proj-key")).not.toBe("accounts:proj-key");
	});

	it("write/read/delete round-trips the flagged blob", async () => {
		const mock = createMockBackend();
		_setBackendForTests(mock);

		const blob = JSON.stringify(makeFlagged());
		const write = await writeFlaggedToKeychain(null, blob);
		expect(write.ok).toBe(true);
		expect(mock.store.get(`${KEYCHAIN_SERVICE_NAME}::${FLAGGED_KEYCHAIN_KEY}`)).toBe(blob);

		expect(await readFlaggedFromKeychain(null)).toBe(blob);

		expect((await deleteFlaggedFromKeychain(null)).deleted).toBe(true);
		expect(mock.store.size).toBe(0);
		const gone = await deleteFlaggedFromKeychain(null);
		expect(gone.deleted).toBe(false);
		expect(gone.error).toBeUndefined();
	});

	it("writeFlaggedToKeychain returns ok=false when backend throws", async () => {
		const mock = createMockBackend();
		mock.setShouldThrow = true;
		_setBackendForTests(mock);

		const result = await writeFlaggedToKeychain(null, "{}");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("simulated keychain write failure");
	});
});

describe("flagged-store load/save/clear with CODEX_KEYCHAIN", () => {
	let storageDir: string;
	let flaggedPath: string;
	let mock: MockBackend;

	beforeEach(async () => {
		_resetBackendForTests();
		mock = createMockBackend();
		_setBackendForTests(mock);
		storageDir = await allocateStorageDir();
		// The flagged file is derived from the main accounts path's directory.
		setStoragePathDirect(join(storageDir, "accounts.json"));
		flaggedPath = join(storageDir, "oc-codex-multi-auth-flagged-accounts.json");
	});

	afterEach(async () => {
		setStoragePathDirect(null);
		_resetBackendForTests();
		restoreOptIn();
		try {
			await fs.rm(storageDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("with CODEX_KEYCHAIN unset, flagged save writes JSON and never touches the backend", async () => {
		setOptIn(false);
		await saveFlaggedAccounts(makeFlagged());
		expect(existsSync(flaggedPath)).toBe(true);
		expect(mock.calls.filter((c) => c.op === "set")).toHaveLength(0);
	});

	it("with CODEX_KEYCHAIN=1, flagged save migrates JSON to the flagged key and keeps a rollback artefact", async () => {
		// Existing-JSON user flipping the opt-in on.
		setOptIn(false);
		await saveFlaggedAccounts(makeFlagged());
		expect(existsSync(flaggedPath)).toBe(true);

		setOptIn(true);
		await saveFlaggedAccounts(makeFlagged());

		const stored = mock.store.get(
			`${KEYCHAIN_SERVICE_NAME}::${FLAGGED_KEYCHAIN_KEY}`,
		);
		expect(stored).toBeDefined();
		expect(JSON.parse(stored!).accounts[0].accountId).toBe("acct-flagged-1");

		// Canonical JSON renamed to the rollback marker, not deleted.
		expect(existsSync(flaggedPath)).toBe(false);
		const entries = await fs.readdir(storageDir);
		const backup = entries.find((name) =>
			name.startsWith(
				"oc-codex-multi-auth-flagged-accounts.json.migrated-to-keychain.",
			),
		);
		expect(backup).toBeDefined();
	});

	it("keeps the newest flagged marker in sync with every keychain save", async () => {
		// Same stale-marker resurrection guard as the main store (greptile P1
		// on PR #280): the fallback marker must mirror the freshest blob or a
		// later opt-out restores flagged accounts that were already removed.
		setOptIn(false);
		await saveFlaggedAccounts(makeFlagged());

		setOptIn(true);
		const updated = makeFlagged();
		updated.accounts[0]!.accountId = "acct-flagged-fresh";
		await saveFlaggedAccounts(updated);

		const entries = await fs.readdir(storageDir);
		const markers = entries.filter((name) =>
			name.startsWith("oc-codex-multi-auth-flagged-accounts.json.migrated-to-keychain."),
		);
		expect(markers).toHaveLength(1);
		const mirrored = await fs.readFile(join(storageDir, markers[0]!), "utf-8");
		expect(mirrored).toContain("acct-flagged-fresh");

		// A later save with no canonical file refreshes the marker again.
		const third = makeFlagged();
		third.accounts[0]!.accountId = "acct-flagged-newest";
		await saveFlaggedAccounts(third);
		const after = (await fs.readdir(storageDir)).filter((name) =>
			name.startsWith("oc-codex-multi-auth-flagged-accounts.json.migrated-to-keychain."),
		);
		expect(after).toHaveLength(1);
		expect(await fs.readFile(join(storageDir, after[0]!), "utf-8")).toContain(
			"acct-flagged-newest",
		);
	});

	it("fails loudly when a flagged migration marker cannot be unlinked during clear", async () => {
		setOptIn(true);
		await saveFlaggedAccounts(makeFlagged());
		const strandedName = `${flaggedPath}.migrated-to-keychain.2026-01-01T00-00-00-000Z-aaaaaa`;
		await fs.writeFile(strandedName, JSON.stringify(makeFlagged()), "utf-8");

		const realUnlink = fs.unlink.bind(fs);
		const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
			if (String(target).includes(".migrated-to-keychain.")) {
				throw Object.assign(new Error("simulated EBUSY on marker unlink"), {
					code: "EBUSY",
				});
			}
			return realUnlink(target as string);
		});
		try {
			await expect(clearFlaggedAccounts()).rejects.toThrow(
				/migration artefact|leftover/i,
			);
		} finally {
			unlinkSpy.mockRestore();
		}
		expect(existsSync(strandedName)).toBe(true);

		await clearFlaggedAccounts();
		expect(existsSync(strandedName)).toBe(false);
	});

	it("with CODEX_KEYCHAIN=1, flagged load reads the keychain blob first", async () => {
		setOptIn(true);
		const flagged = makeFlagged();
		flagged.accounts[0]!.accountId = "acct-flagged-keychain";
		await saveFlaggedAccounts(flagged);

		const loaded = await loadFlaggedAccounts();
		expect(loaded.accounts[0]?.accountId).toBe("acct-flagged-keychain");
		const getCalls = mock.calls.filter(
			(c) => c.op === "get" && c.account === FLAGGED_KEYCHAIN_KEY,
		);
		expect(getCalls.length).toBeGreaterThanOrEqual(1);
	});

	it("clearFlaggedAccounts deletes the flagged keychain entry AND the JSON; a cleared pool cannot resurrect", async () => {
		setOptIn(true);
		await saveFlaggedAccounts(makeFlagged());
		// Put a canonical JSON back in place so both sides hold data, then clear.
		await fs.writeFile(
			flaggedPath,
			JSON.stringify(makeFlagged(), null, 2),
			{ encoding: "utf-8", mode: 0o600 },
		);
		expect(mock.store.size).toBe(1);
		expect(existsSync(flaggedPath)).toBe(true);

		await clearFlaggedAccounts();

		expect(existsSync(flaggedPath)).toBe(false);
		expect(mock.store.get(`${KEYCHAIN_SERVICE_NAME}::${FLAGGED_KEYCHAIN_KEY}`)).toBeUndefined();

		// Resurrection check: the next load must NOT find the cleared pool on
		// any side (keychain-first read returns null, JSON is gone, and the
		// .migrated-to-keychain artefact — which IS a load fallback — was
		// retired by the clear).
		const loaded = await loadFlaggedAccounts();
		expect(loaded.accounts).toHaveLength(0);
	});

	it("flagged load recovers the pool from a migration marker when the canonical file is missing", async () => {
		// Interrupted flagged migration: canonical renamed to a marker, then the
		// process died before the keychain write — no canonical, no entry. The
		// marker is the only copy and loads MUST see it.
		setOptIn(true);
		await fs.writeFile(
			flaggedPath,
			JSON.stringify(makeFlagged(), null, 2),
			{ encoding: "utf-8", mode: 0o600 },
		);
		const { migrateOnDiskJsonToKeychainBackup } = await import(
			"../lib/storage/load-save.js"
		);
		await migrateOnDiskJsonToKeychainBackup(flaggedPath, async () => undefined);
		expect(existsSync(flaggedPath)).toBe(false);

		const loaded = await loadFlaggedAccounts();
		expect(loaded.accounts[0]?.accountId).toBe("acct-flagged-1");
	});

	it("clearFlaggedAccounts retires migrated-to-keychain markers beside the flagged file", async () => {
		setOptIn(false);
		await saveFlaggedAccounts(makeFlagged());
		const { migrateOnDiskJsonToKeychainBackup } = await import(
			"../lib/storage/load-save.js"
		);
		await migrateOnDiskJsonToKeychainBackup(flaggedPath, async () => undefined);
		await fs.writeFile(
			flaggedPath,
			JSON.stringify(makeFlagged(), null, 2),
			{ encoding: "utf-8", mode: 0o600 },
		);
		const markerPrefix = "oc-codex-multi-auth-flagged-accounts.json.migrated-to-keychain.";
		const markersBefore = (await fs.readdir(storageDir)).filter((n) =>
			n.startsWith(markerPrefix),
		);
		expect(markersBefore.length).toBeGreaterThan(0);

		await clearFlaggedAccounts();

		expect(existsSync(flaggedPath)).toBe(false);
		const markersAfter = (await fs.readdir(storageDir)).filter((n) =>
			n.startsWith(markerPrefix),
		);
		expect(markersAfter).toHaveLength(0);
	});

	it("clearFlaggedAccounts skips the keychain delete when the JSON unlink fails (sides stay in sync)", async () => {
		setOptIn(true);
		await saveFlaggedAccounts(makeFlagged());
		await fs.writeFile(
			flaggedPath,
			JSON.stringify(makeFlagged(), null, 2),
			{ encoding: "utf-8", mode: 0o600 },
		);

		const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementationOnce(async () => {
			throw Object.assign(new Error("simulated EBUSY on unlink"), {
				code: "EBUSY",
			});
		});
		try {
			await expect(clearFlaggedAccounts()).resolves.toBeUndefined();
		} finally {
			unlinkSpy.mockRestore();
		}

		// Keychain blob survives: deleting it while JSON remains would let the
		// next keychain-first read resurrect the pool from the still-present file.
		expect(
			mock.store.get(`${KEYCHAIN_SERVICE_NAME}::${FLAGGED_KEYCHAIN_KEY}`),
		).toBeDefined();
		const deleteCalls = mock.calls.filter(
			(c) => c.op === "delete" && c.account === FLAGGED_KEYCHAIN_KEY,
		);
		expect(deleteCalls).toHaveLength(0);
	});

	it("clearFlaggedAccounts retires .migrated-to-keychain backups that still hold flagged tokens", async () => {
		// A flagged save under opt-in preserves the pre-keychain JSON as a
		// rollback artefact — plaintext flagged refresh tokens that a clear
		// must also erase, not just the canonical file (greptile P1 on
		// PR #275, flagged.ts:310).
		setOptIn(true);
		await saveFlaggedAccounts(makeFlagged());
		await fs.writeFile(
			flaggedPath,
			JSON.stringify(makeFlagged(), null, 2),
			{ encoding: "utf-8", mode: 0o600 },
		);
		// Seed a second flagged save after the canonical file is back so the
		// migration path produces a real `.migrated-to-keychain.<ts>` backup.
		await saveFlaggedAccounts(makeFlagged());
		const backupName = (
			await fs.readdir(storageDir)
		).find((name) =>
			name.startsWith(
				"oc-codex-multi-auth-flagged-accounts.json.migrated-to-keychain.",
			),
		);
		expect(backupName).toBeDefined();
		// Recreate the canonical pool so the clear has all three artefacts to retire.
		await fs.writeFile(
			flaggedPath,
			JSON.stringify(makeFlagged(), null, 2),
			{ encoding: "utf-8", mode: 0o600 },
		);

		await clearFlaggedAccounts();

		expect(existsSync(flaggedPath)).toBe(false);
		expect(existsSync(join(storageDir, backupName!))).toBe(false);
		const survivors = (await fs.readdir(storageDir)).filter((name) =>
			name.includes(".migrated-to-keychain."),
		);
		expect(survivors).toHaveLength(0);
	});

	it("clearFlaggedAccounts verifies the keychain delete with a read — a surviving entry is surfaced", async () => {
		// `delete` reporting false is ambiguous with "entry absent" — the clear
		// must re-read the key to catch a backend that refused but left the
		// blob in place, or the cleared pool resurrects on the next
		// keychain-first load (greptile P1 on PR #275, flagged.ts:402).
		setOptIn(true);
		await saveFlaggedAccounts(makeFlagged());
		await fs.writeFile(
			flaggedPath,
			JSON.stringify(makeFlagged(), null, 2),
			{ encoding: "utf-8", mode: 0o600 },
		);
		mock.deleteShouldKeepEntry = true;

		await expect(clearFlaggedAccounts()).resolves.toBeUndefined();

		const ops = mock.calls.map((c) => `${c.op}:${c.account}`);
		const deleteIdx = ops.indexOf(`delete:${FLAGGED_KEYCHAIN_KEY}`);
		expect(deleteIdx).toBeGreaterThanOrEqual(0);
		// The verify-read ran AFTER the delete — the result was not trusted.
		expect(ops.indexOf(`get:${FLAGGED_KEYCHAIN_KEY}`, deleteIdx)).toBeGreaterThan(deleteIdx);
	});

	it("a flagged keychain delete failure during clear is warned, not thrown", async () => {
		setOptIn(true);
		await saveFlaggedAccounts(makeFlagged());
		await fs.writeFile(
			flaggedPath,
			JSON.stringify(makeFlagged(), null, 2),
			{ encoding: "utf-8", mode: 0o600 },
		);
		mock.deleteShouldThrow = true;

		await expect(clearFlaggedAccounts()).resolves.toBeUndefined();
		// JSON-first ordering: the on-disk copy is still removed even though the
		// keychain delete failed.
		expect(existsSync(flaggedPath)).toBe(false);
	});

	it("with CODEX_KEYCHAIN unset, clear never touches the backend", async () => {
		setOptIn(false);
		await saveFlaggedAccounts(makeFlagged());
		await clearFlaggedAccounts();
		expect(mock.calls.filter((c) => c.op === "delete")).toHaveLength(0);
	});

	it("flagged keychain write failure falls back to JSON without losing data", async () => {
		setOptIn(true);
		mock.setShouldThrow = true;

		await saveFlaggedAccounts(makeFlagged());

		expect(mock.store.size).toBe(0);
		expect(existsSync(flaggedPath)).toBe(true);
		const onDisk = JSON.parse(await fs.readFile(flaggedPath, "utf-8"));
		expect(onDisk.accounts[0].accountId).toBe("acct-flagged-1");
	});
});
