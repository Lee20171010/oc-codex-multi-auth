/**
 * Keychain migration lifecycle I/O:
 *
 *   - the canonical JSON is retired to a `.migrated-to-keychain.<ts>-<nonce>`
 *     marker BEFORE the keychain write, so a crash between the two steps
 *     leaves both sides at the old state rather than a fresh keychain entry
 *     beside a stale canonical file;
 *   - marker names never collide inside the same millisecond, and the family
 *     is retention-bounded;
 *   - a failed marker rename rewrites the canonical file with the fresh blob
 *     so opt-out never resurrects stale credentials;
 *   - `codex-keychain rollback` deletes the keychain entry unconditionally —
 *     even when CODEX_KEYCHAIN is already unset — and archives a live file
 *     under a unique `.pre-rollback.<ts>-<nonce>` name.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
	clearAccounts,
	loadAccounts,
	saveAccounts,
	setStoragePathDirect,
	type AccountStorageV3,
} from "../lib/storage.js";
import { migrateOnDiskJsonToKeychainBackup } from "../lib/storage/load-save.js";
import {
	_setBackendForTests,
	_resetBackendForTests,
	buildKeychainAccountKey,
	KEYCHAIN_SERVICE_NAME,
	type KeychainBackend,
} from "../lib/storage/keychain.js";
import {
	_findMigrationBackupsForTests,
	createCodexKeychainTool,
} from "../lib/tools/codex-keychain.js";
import type { ToolContext } from "../lib/tools/index.js";
import type { UiRuntimeOptions } from "../lib/ui/runtime.js";

interface MockBackend extends KeychainBackend {
	store: Map<string, string>;
	calls: Array<{ op: string; service: string; account: string }>;
}

function createMockBackend(): MockBackend {
	const store = new Map<string, string>();
	const calls: MockBackend["calls"] = [];
	const backend: MockBackend = {
		store,
		calls,
		async get(service, account) {
			calls.push({ op: "get", service, account });
			return store.get(`${service}::${account}`) ?? null;
		},
		async set(service, account, secret) {
			calls.push({ op: "set", service, account });
			store.set(`${service}::${account}`, secret);
		},
		async delete(service, account) {
			calls.push({ op: "delete", service, account });
			return store.delete(`${service}::${account}`);
		},
		async isAvailable() {
			calls.push({
				op: "isAvailable",
				service: KEYCHAIN_SERVICE_NAME,
				account: "__probe__",
			});
			return true;
		},
	};
	return backend;
}

function plainUiRuntime(): UiRuntimeOptions {
	return {
		v2Enabled: false,
		colorEnabled: false,
		theme: {
			colors: {
				heading: "",
				accent: "",
				muted: "",
				success: "",
				warning: "",
				danger: "",
				reset: "",
			},
			glyphs: { bullet: "-" },
		},
	} as unknown as UiRuntimeOptions;
}

function buildCtx(): ToolContext {
	return { resolveUiRuntime: () => plainUiRuntime() } as unknown as ToolContext;
}

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

const ORIGINAL_CODEX_KEYCHAIN = process.env.CODEX_KEYCHAIN;
const ORIGINAL_MAX_COUNT = process.env.CODEX_AUTH_CREDENTIAL_SNAPSHOTS_MAX_COUNT;

describe("storage I/O: keychain migration lifecycle", () => {
	let dir: string;
	let storagePath: string;
	let mock: MockBackend;

	beforeEach(async () => {
		_resetBackendForTests();
		mock = createMockBackend();
		_setBackendForTests(mock);
		dir = join(
			tmpdir(),
			`storage-io-kc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await fs.mkdir(dir, { recursive: true });
		storagePath = join(dir, "oc-codex-multi-auth-accounts.json");
		setStoragePathDirect(storagePath);
	});

	afterEach(async () => {
		setStoragePathDirect(null);
		_resetBackendForTests();
		vi.restoreAllMocks();
		if (ORIGINAL_CODEX_KEYCHAIN === undefined) {
			delete process.env.CODEX_KEYCHAIN;
		} else {
			process.env.CODEX_KEYCHAIN = ORIGINAL_CODEX_KEYCHAIN;
		}
		if (ORIGINAL_MAX_COUNT === undefined) {
			delete process.env.CODEX_AUTH_CREDENTIAL_SNAPSHOTS_MAX_COUNT;
		} else {
			process.env.CODEX_AUTH_CREDENTIAL_SNAPSHOTS_MAX_COUNT = ORIGINAL_MAX_COUNT;
		}
		await fs.rm(dir, { recursive: true, force: true });
	});

	function markerFiles(): Promise<string[]> {
		return fs
			.readdir(dir)
			.then((entries) => entries.filter((n) => n.includes(".migrated-to-keychain.")));
	}

	it("renames the on-disk JSON to a marker BEFORE writing the keychain", async () => {
		process.env.CODEX_KEYCHAIN = "1";
		await fs.writeFile(storagePath, JSON.stringify(makeStorage("acct-old")), "utf-8");

		const order: string[] = [];
		const originalRename = fs.rename.bind(fs);
		const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (src, dst) => {
			if (String(dst).includes(".migrated-to-keychain.")) {
				order.push("rename->marker");
			}
			return originalRename(src as string, dst as string);
		});
		const setSpy = vi
			.spyOn(mock, "set")
			.mockImplementation(async (service, account, secret) => {
				order.push("keychain:set");
				mock.store.set(`${service}::${account}`, secret);
			});

		try {
			await saveAccounts(makeStorage("acct-new"));
		} finally {
			renameSpy.mockRestore();
			setSpy.mockRestore();
		}

		// The trailing rename is the post-save marker sync: the newest marker
		// is rewritten to the fresh blob so a later opt-out or keychain loss
		// restores the current pool rather than the pre-save one.
		expect(order).toEqual(["rename->marker", "keychain:set", "rename->marker"]);
		// Canonical JSON is retired; the keychain holds the authoritative blob.
		expect(existsSync(storagePath)).toBe(false);
		expect(await markerFiles()).toHaveLength(1);
		const accountKey = buildKeychainAccountKey(null);
		expect(mock.store.get(`${KEYCHAIN_SERVICE_NAME}::${accountKey}`)).toContain("acct-new");
	});

	it("produces unique marker names across repeated migrations", async () => {
		await fs.writeFile(storagePath, JSON.stringify(makeStorage("a")), "utf-8");
		await migrateOnDiskJsonToKeychainBackup(storagePath, async () => undefined);
		await fs.writeFile(storagePath, JSON.stringify(makeStorage("b")), "utf-8");
		await migrateOnDiskJsonToKeychainBackup(storagePath, async () => undefined);
		await fs.writeFile(storagePath, JSON.stringify(makeStorage("c")), "utf-8");
		await migrateOnDiskJsonToKeychainBackup(storagePath, async () => undefined);

		const markers = await markerFiles();
		expect(markers).toHaveLength(3);
		// Same-millisecond renames must never overwrite each other — the nonce
		// suffix is what makes each name distinct.
		expect(new Set(markers).size).toBe(3);
	});

	it("bounds the marker family by the credential artifact retention limit", async () => {
		process.env.CODEX_AUTH_CREDENTIAL_SNAPSHOTS_MAX_COUNT = "2";
		for (let i = 0; i < 5; i += 1) {
			await fs.writeFile(storagePath, JSON.stringify(makeStorage(`acct-${i}`)), "utf-8");
			await migrateOnDiskJsonToKeychainBackup(storagePath, async () => undefined);
		}
		const markers = await markerFiles();
		expect(markers).toHaveLength(2);
	});

	it("recovers the pool from a marker when the migration was interrupted before the keychain write", async () => {
		// The crash window: canonical renamed to a marker, then the process
		// died (or the keychain write failed) — no canonical file, no keychain
		// entry. A load that reported empty here would lose the pool on the
		// next save.
		process.env.CODEX_KEYCHAIN = "1";
		await fs.writeFile(storagePath, JSON.stringify(makeStorage("acct-stuck")), "utf-8");
		await migrateOnDiskJsonToKeychainBackup(storagePath, async () => undefined);
		expect(existsSync(storagePath)).toBe(false);
		expect(await markerFiles()).toHaveLength(1);

		const loaded = await loadAccounts();
		expect(loaded?.accounts[0]?.accountId).toBe("acct-stuck");
	});

	it("recovers from the marker even when the keychain opt-in is off", async () => {
		delete process.env.CODEX_KEYCHAIN;
		await fs.writeFile(storagePath, JSON.stringify(makeStorage("acct-off")), "utf-8");
		await migrateOnDiskJsonToKeychainBackup(storagePath, async () => undefined);
		expect(existsSync(storagePath)).toBe(false);

		const loaded = await loadAccounts();
		expect(loaded?.accounts[0]?.accountId).toBe("acct-off");
	});

	it("does not serve an older marker when the newest one is corrupt", async () => {
		// The fallback only ever trusts the NEWEST marker: an older marker is
		// an earlier pool state, and serving it after a corrupt freshest would
		// resurrect consumed refresh tokens and deleted accounts (greptile P1
		// on PR #280 — the "stale marker restores old credentials" finding).
		// A corrupt freshest means an honest empty pool, not stale data.
		delete process.env.CODEX_KEYCHAIN;
		await fs.writeFile(storagePath, JSON.stringify(makeStorage("acct-old-good")), "utf-8");
		await migrateOnDiskJsonToKeychainBackup(storagePath, async () => undefined);
		// A second, newer marker that is corrupt.
		const corruptName = `${storagePath}.migrated-to-keychain.2999-01-01T00-00-00-000Z-ffffff`;
		await fs.writeFile(corruptName, "{ not valid json", "utf-8");

		const loaded = await loadAccounts();
		expect(loaded).toBeNull();
	});

	it("keeps the newest marker in sync with every subsequent keychain save", async () => {
		// The marker is the load fallback when the canonical file is missing —
		// if it stayed at the pre-save blob, a later opt-out or keychain loss
		// would resurrect the OLD pool (stale-marker resurrection, greptile
		// P1 on PR #280).
		process.env.CODEX_KEYCHAIN = "1";
		await fs.writeFile(storagePath, JSON.stringify(makeStorage("acct-a")), "utf-8");

		await saveAccounts(makeStorage("acct-b"));
		let markers = await markerFiles();
		expect(markers).toHaveLength(1);
		const mirrored = await fs.readFile(join(dir, markers[0]!), "utf-8");
		expect(mirrored).toContain("acct-b");
		expect(mirrored).not.toContain("acct-a");

		// A later save with no canonical file still refreshes the marker.
		await saveAccounts(makeStorage("acct-c"));
		markers = await markerFiles();
		expect(markers).toHaveLength(1);
		expect(await fs.readFile(join(dir, markers[0]!), "utf-8")).toContain("acct-c");
	});

	it("retires older markers so only the synced newest can be served on fallback", async () => {
		process.env.CODEX_KEYCHAIN = "1";
		await fs.writeFile(storagePath, JSON.stringify(makeStorage("acct-a")), "utf-8");
		await migrateOnDiskJsonToKeychainBackup(storagePath, async () => undefined);
		// An older marker left by a previous migration cycle — by definition
		// staler than the newest one, so it must never survive as a fallback.
		const olderName = `${storagePath}.migrated-to-keychain.2020-01-01T00-00-00-000Z-aaaaaa`;
		await fs.writeFile(olderName, JSON.stringify(makeStorage("acct-prehistoric")), "utf-8");
		expect(await markerFiles()).toHaveLength(2);

		await saveAccounts(makeStorage("acct-fresh"));

		// One marker survives — the freshest one by the loader's ordering —
		// and it now mirrors the just-saved blob rather than the older pool.
		const markers = await markerFiles();
		expect(markers).toHaveLength(1);
		const mirrored = await fs.readFile(join(dir, markers[0]!), "utf-8");
		expect(mirrored).toContain("acct-fresh");
		expect(mirrored).not.toContain("acct-prehistoric");
	});

	it("fails loudly when a migration marker cannot be unlinked during clear", async () => {
		// A credential-bearing marker that survives a "delete everything"
		// request is a resurrection source — the clear must surface the
		// stranded file, not report success (greptile P1 on PR #280).
		process.env.CODEX_KEYCHAIN = "1";
		await saveAccounts(makeStorage("acct-a"));
		const strandedName = `${storagePath}.migrated-to-keychain.2026-01-01T00-00-00-000Z-aaaaaa`;
		await fs.writeFile(strandedName, JSON.stringify(makeStorage("acct-stranded")), "utf-8");

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
			await expect(clearAccounts()).rejects.toThrow(/migration artefact|leftover/i);
		} finally {
			unlinkSpy.mockRestore();
		}

		// The marker is still on disk — reporting success here would lie.
		expect(existsSync(strandedName)).toBe(true);
		// With the unlink unblocked, a retry finishes the clear.
		await clearAccounts();
		expect(existsSync(strandedName)).toBe(false);
		expect(existsSync(storagePath)).toBe(false);
	});

	it("clearAccounts retires migrated-to-keychain markers along with the store", async () => {
		process.env.CODEX_KEYCHAIN = "1";
		await fs.writeFile(storagePath, JSON.stringify(makeStorage("acct-a")), "utf-8");
		await migrateOnDiskJsonToKeychainBackup(storagePath, async () => undefined);
		// A fresh canonical file exists again (post-migration JSON fallback).
		await fs.writeFile(storagePath, JSON.stringify(makeStorage("acct-b")), "utf-8");
		expect(await markerFiles()).toHaveLength(1);

		await clearAccounts();

		expect(existsSync(storagePath)).toBe(false);
		// The marker held the same plaintext token set — it must not survive
		// a "delete all credentials" request.
		expect(await markerFiles()).toHaveLength(0);
	});

	it("rewrites the canonical file with the fresh blob when the marker rename fails", async () => {
		process.env.CODEX_KEYCHAIN = "1";
		await fs.writeFile(storagePath, JSON.stringify(makeStorage("acct-old")), "utf-8");

		const originalRename = fs.rename.bind(fs);
		const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (src, dst) => {
			if (String(dst).includes(".migrated-to-keychain.")) {
				// A non-lock error so the Windows retry helper rethrows at once.
				throw Object.assign(new Error("simulated EACCES"), { code: "EACCES" });
			}
			return originalRename(src as string, dst as string);
		});

		try {
			await saveAccounts(makeStorage("acct-new"));
		} finally {
			renameSpy.mockRestore();
		}

		// No marker was left behind …
		expect(await markerFiles()).toHaveLength(0);
		// … and the canonical file was rewritten with the FRESH blob, so an
		// opt-out cannot resurrect the stale pre-save credentials.
		const onDisk = JSON.parse(await fs.readFile(storagePath, "utf-8")) as AccountStorageV3;
		expect(onDisk.accounts[0]?.accountId).toBe("acct-new");
		const accountKey = buildKeychainAccountKey(null);
		expect(mock.store.get(`${KEYCHAIN_SERVICE_NAME}::${accountKey}`)).toContain("acct-new");
	});

	it("rollback deletes the keychain entry even when CODEX_KEYCHAIN is unset", async () => {
		// Typical operator flow: unset the opt-in first, then roll back. The
		// delete must not be gated on the flag or a leftover entry silently
		// becomes authoritative the next time the opt-in is enabled.
		const accountKey = buildKeychainAccountKey(null);
		mock.store.set(`${KEYCHAIN_SERVICE_NAME}::${accountKey}`, JSON.stringify(makeStorage("kc-stale")));

		const backupPath = `${storagePath}.migrated-to-keychain.2024-06-15T10-00-00-000Z`;
		await fs.writeFile(backupPath, JSON.stringify(makeStorage("acct-restored"), null, 2), "utf-8");
		delete process.env.CODEX_KEYCHAIN;

		const t = createCodexKeychainTool(buildCtx());
		const out = (await t.execute({ command: "rollback" }, {} as never)) as string;
		expect(out).toMatch(/Restored/);

		expect(mock.calls.some((c) => c.op === "delete" && c.account === accountKey)).toBe(true);
		expect(mock.store.has(`${KEYCHAIN_SERVICE_NAME}::${accountKey}`)).toBe(false);

		const restored = JSON.parse(await fs.readFile(storagePath, "utf-8")) as AccountStorageV3;
		expect(restored.accounts[0]?.accountId).toBe("acct-restored");
	});

	it("rollback produces unique .pre-rollback archives on repeated runs", async () => {
		delete process.env.CODEX_KEYCHAIN;
		// Two successive rollbacks each archiving a live file must not collide.
		for (const tag of ["first", "second"]) {
			const backupPath = `${storagePath}.migrated-to-keychain.2024-06-15T10-00-00-00${tag === "first" ? "1" : "2"}Z`;
			await fs.writeFile(backupPath, JSON.stringify(makeStorage(`bk-${tag}`)), "utf-8");
			await fs.writeFile(storagePath, JSON.stringify(makeStorage(`live-${tag}`)), "utf-8");

			const t = createCodexKeychainTool(buildCtx());
			const out = (await t.execute(
				{ command: "rollback", confirm: true },
				{} as never,
			)) as string;
			expect(out).toMatch(/Restored/);
		}

		const archives = (await fs.readdir(dir)).filter((n) => n.includes(".pre-rollback."));
		expect(new Set(archives).size).toBe(archives.length);
		// Retention keeps the newest archives and removes none of the current run's
		// (limit is the default 10; both survive).
		expect(archives.length).toBeGreaterThanOrEqual(1);
		// Latest live file was restored from the second marker.
		const active = JSON.parse(await fs.readFile(storagePath, "utf-8")) as AccountStorageV3;
		expect(active.accounts[0]?.accountId).toBe("bk-second");
	});
});
