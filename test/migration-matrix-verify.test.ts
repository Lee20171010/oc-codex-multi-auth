/**
 * STATE-MIGRATION MATRIX, second pass — promoted from the round-2 migration
 * audit. Re-checks anomalies the first pass surfaced, in isolation, plus
 * matrix cells the first pass did not reach (marker collisions, flagged
 * transactions over corrupt files, corrupt file mid-refresh, keychain
 * idempotency, lock residue, legacy blocked-accounts migration,
 * quota-notification corruption).
 *
 * Tests labelled [KNOWN-ISSUE] pin *observed* deficient behaviour so the
 * failure mode stays characterized; a fix should flip the expectation in the
 * same commit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

vi.mock("../lib/refresh-queue.js", () => ({
	queuedRefresh: vi.fn(),
}));

import { queuedRefresh } from "../lib/refresh-queue.js";
import {
	getFlaggedAccountsPath,
	loadAccounts,
	loadFlaggedAccounts,
	saveAccounts,
	saveFlaggedAccounts,
	setStoragePathDirect,
	withFlaggedAccountStorageTransaction,
} from "../lib/storage.js";
import type { AccountStorageV3 } from "../lib/storage/migrations.js";
import {
	_resetBackendForTests,
	_setBackendForTests,
	buildKeychainAccountKey,
	KEYCHAIN_SERVICE_NAME,
	type KeychainBackend,
} from "../lib/storage/keychain.js";
import { coordinatePersistedRefresh } from "../lib/storage/coordinated-refresh.js";
import { createCodexKeychainTool } from "../lib/tools/codex-keychain.js";
import { getUiRuntimeOptions } from "../lib/ui/runtime.js";
import type { TokenResult } from "../lib/types.js";
import { StorageError } from "../lib/errors.js";

let scratch: string;
const ORIG_KEYCHAIN = process.env.CODEX_KEYCHAIN;

function mkV3(tokens: string[]): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		accounts: tokens.map((refreshToken, i) => ({
			refreshToken,
			addedAt: i + 1,
			lastUsed: i + 1,
		})),
	};
}

interface MockBackend extends KeychainBackend {
	store: Map<string, string>;
}
function createMockBackend(): MockBackend {
	const store = new Map<string, string>();
	const b: MockBackend = {
		store,
		async get(service, account) {
			return store.get(`${service}::${account}`) ?? null;
		},
		async set(service, account, secret) {
			store.set(`${service}::${account}`, secret);
		},
		async delete(service, account) {
			return store.delete(`${service}::${account}`);
		},
		async isAvailable() {
			return true;
		},
	};
	return b;
}
function setOptIn(on: boolean) {
	if (on) process.env.CODEX_KEYCHAIN = "1";
	else delete process.env.CODEX_KEYCHAIN;
}

async function dirOf(suffix: string): Promise<string> {
	const d = join(scratch, suffix);
	await fs.mkdir(d, { recursive: true });
	return d;
}

beforeEach(async () => {
	scratch = await fs.mkdtemp(join(tmpdir(), "audit-verify-"));
	vi.mocked(queuedRefresh).mockReset();
});

afterEach(async () => {
	setStoragePathDirect(null);
	setOptIn(false);
	_resetBackendForTests();
	if (ORIG_KEYCHAIN === undefined) delete process.env.CODEX_KEYCHAIN;
	else process.env.CODEX_KEYCHAIN = ORIG_KEYCHAIN;
	try { await fs.rm(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("VERIFY: 6b marker collision", () => {
	it("repeated migrations in the same millisecond overwrite markers", async () => {
		const d = await dirOf("mk");
		const f = join(d, "accounts.json");
		setStoragePathDirect(f);
		setOptIn(false);
		await saveAccounts(mkV3(["rt-seed"]));
		const backend = createMockBackend();
		_setBackendForTests(backend);
		setOptIn(true);

		for (let i = 0; i < 5; i++) {
			await fs.writeFile(f, JSON.stringify(mkV3([`rt-${i}`])));
			await saveAccounts(mkV3([`rt-${i}`]));
		}
		const entries = await fs.readdir(d);
		const markers = entries.filter((n) => n.includes(".migrated-to-keychain."));
		// [KNOWN-ISSUE] markers accumulate with no purge, but fs.rename silently
		// replaces same-timestamp siblings — the count is timing-dependent,
		// bounded by the iteration count.
		expect(markers.length).toBeGreaterThanOrEqual(1);
		expect(markers.length).toBeLessThanOrEqual(5);
	});

	it("marker filename collision: rename replaces a same-name marker", async () => {
		const d = await dirOf("mk2");
		const f = join(d, "accounts.json");
		setStoragePathDirect(f);
		setOptIn(false);
		await saveAccounts(mkV3(["rt-seed"]));
		const backend = createMockBackend();
		_setBackendForTests(backend);
		setOptIn(true);

		// Force identical timestamps by stubbing Date — proves rename-overwrite
		// semantics if collisions can occur in the wild.
		const RealDate = Date;
		const fixed = new RealDate("2026-01-01T00:00:00.000Z");
		vi.useFakeTimers({ now: fixed });
		try {
			for (let i = 0; i < 3; i++) {
				await fs.writeFile(f, JSON.stringify(mkV3([`rt-collision-${i}`])));
				await saveAccounts(mkV3([`rt-collision-${i}`]));
			}
		} finally {
			vi.useRealTimers();
		}
		const markers = (await fs.readdir(d)).filter((n) => n.includes(".migrated-to-keychain."));
		// [KNOWN-ISSUE] same-ms migrations collide on one marker name; fs.rename
		// overwrites, so only the last write survives — earlier rollback
		// artefacts are silently destroyed.
		expect(markers.length).toBe(1);
		const survivor = JSON.parse(
			await fs.readFile(join(d, markers[0]!), "utf-8"),
		) as { accounts: Array<{ refreshToken: string }> };
		expect(survivor.accounts[0]?.refreshToken).toBe("rt-collision-2");
	});
});

describe("VERIFY: 7c corrupt legacy global in isolation", () => {
	it("corrupt legacy global + NO existing new file -> empty pool, warn only, file kept", async () => {
		const globalDir = join(homedir(), ".opencode");
		await fs.mkdir(globalDir, { recursive: true });
		const legacyGlobal = join(globalDir, "openai-codex-accounts.json");
		const newFile = join(globalDir, "oc-codex-multi-auth-accounts.json");
		// ensure no contamination
		try { await fs.rm(newFile, { force: true }); } catch { /* ignore */ }
		await fs.writeFile(legacyGlobal, "{not json");
		setStoragePathDirect(null);
		const loaded = await loadAccounts();
		// [KNOWN-ISSUE] with no modern file present, a corrupt legacy global
		// yields a silent empty pool — no INVALID_STORAGE, no recovery hint;
		// the corrupt file is kept and no new file is written.
		expect(loaded).toBeNull();
		expect(existsSync(legacyGlobal)).toBe(true);
		expect(existsSync(newFile)).toBe(false);
		try { await fs.rm(legacyGlobal, { force: true }); } catch { /* ignore */ }
	});

	it("V2 legacy global + NO existing new file -> swallowed, only warn", async () => {
		const globalDir = join(homedir(), ".opencode");
		await fs.mkdir(globalDir, { recursive: true });
		const legacyGlobal = join(globalDir, "openai-codex-accounts.json");
		const newFile = join(globalDir, "oc-codex-multi-auth-accounts.json");
		try { await fs.rm(newFile, { force: true }); } catch { /* ignore */ }
		await fs.writeFile(legacyGlobal, JSON.stringify({ version: 2, accounts: [{ refreshToken: "rt-v2" }] }));
		setStoragePathDirect(null);
		let threw: unknown = null;
		let loaded: Awaited<ReturnType<typeof loadAccounts>> = null;
		try { loaded = await loadAccounts(); } catch (e) { threw = e; }
		// [KNOWN-ISSUE] the V2 rejection is swallowed inside
		// migrateStorageFileIfNeeded — only UNSUPPORTED_SCHEMA_VERSION is
		// rethrown; V2 legacy data is silently unrecovered.
		expect(threw).toBeNull();
		expect(loaded).toBeNull();
		try { await fs.rm(legacyGlobal, { force: true }); } catch { /* ignore */ }
	});
});

describe("NEW CELL: flagged transaction over corrupt file", () => {
	it("corrupt flagged file -> transaction persist silently replaces it (snapshot saves bytes)", async () => {
		const d = await dirOf("ftx");
		setStoragePathDirect(join(d, "accounts.json"));
		const flaggedPath = getFlaggedAccountsPath();
		await fs.writeFile(flaggedPath, "{corrupt flagged");
		let seen = -1;
		await withFlaggedAccountStorageTransaction(async (current, persist) => {
			seen = current.accounts.length;
			await persist({ version: 1, accounts: [{ refreshToken: "rt-new", addedAt: 1, lastUsed: 1, flaggedAt: 1 }] });
		});
		const snaps = existsSync(join(d, "backups"))
			? (await fs.readdir(join(d, "backups"))).filter((n) => n.startsWith("codex-credential-snapshot-"))
			: [];
		// [KNOWN-ISSUE] the transaction sees an empty pool and persists over the
		// corrupt file; the corrupt file's live tokens survive only inside
		// backups/ via the pre-write credential snapshot.
		expect(seen).toBe(0);
		expect(snaps.length).toBeGreaterThan(0);
	});
});

describe("NEW CELL: corrupt main mid-refresh", () => {
	it("file corrupts between probe and commit -> refresh token lost, error propagates", async () => {
		const d = await dirOf("midrf");
		const f = join(d, "accounts.json");
		setStoragePathDirect(f);
		await saveAccounts(mkV3(["rt-0"]));
		// Corrupt the file AFTER seeding. coordinatePersistedRefresh probes
		// (throws INVALID_STORAGE inside the refresh lease) — verify whether
		// the error reaches the caller and what happens to the token.
		await fs.writeFile(f, '{"version":3,"accounts":[{"refreshToken":"rt');
		vi.mocked(queuedRefresh).mockResolvedValue({
			type: "success", access: "a1", refresh: "r1", expires: Date.now() + 3_600_000,
		} as TokenResult);
		let threw: unknown = null;
		try {
			await coordinatePersistedRefresh({ refreshToken: "rt-0" });
		} catch (e) { threw = e; }
		// the corrupt file surfaces INVALID_STORAGE to the caller BEFORE any
		// provider exchange — the refresh token is never consumed.
		expect((threw as StorageError | null)?.code).toBe("INVALID_STORAGE");
		const called = vi.mocked(queuedRefresh).mock.calls.length;
		expect(called).toBe(0);
	});
});

describe("NEW CELL: keychain migrate idempotency + rollback race", () => {
	it("codex-keychain migrate run twice is a no-op second time", async () => {
		const d = await dirOf("kc-idem");
		const f = join(d, "accounts.json");
		setStoragePathDirect(f);
		setOptIn(false);
		await saveAccounts(mkV3(["rt-a"]));
		const backend = createMockBackend();
		_setBackendForTests(backend);
		setOptIn(true);
		const tool = createCodexKeychainTool({ resolveUiRuntime: () => getUiRuntimeOptions() } as never);
		const out1 = await tool.execute({ command: "migrate" });
		const out2 = await tool.execute({ command: "migrate" });
		expect(typeof out1).toBe("string");
		expect(typeof out2).toBe("string");
		const markers = (await fs.readdir(d)).filter((n) => n.includes(".migrated-to-keychain."));
		// second migrate is a no-op — only the first created a marker
		expect(markers.length).toBe(1);
	});

	it("rollback when NO marker exists but keychain does -> refuses, keychain still authoritative", async () => {
		const d = await dirOf("kc-noroll");
		const f = join(d, "accounts.json");
		setStoragePathDirect(f);
		setOptIn(true);
		const backend = createMockBackend();
		_setBackendForTests(backend);
		// keychain-only state: blob written directly, no JSON ever
		const { writeToKeychain } = await import("../lib/storage/keychain.js");
		await writeToKeychain(null, JSON.stringify(mkV3(["rt-kconly"])));
		const tool = createCodexKeychainTool({ resolveUiRuntime: () => getUiRuntimeOptions() } as never);
		const out = await tool.execute({ command: "rollback", confirm: true });
		const stillKc = backend.store.get(`${KEYCHAIN_SERVICE_NAME}::${buildKeychainAccountKey(null)}`);
		// [KNOWN-ISSUE] rollback refuses and LEAVES the keychain authoritative —
		// there is no path to eject keychain-only creds to JSON.
		expect(String(out)).toContain("Nothing to restore");
		expect(stillKc).toBeTruthy();
	});
});

describe("NEW CELL: flagged store under keychain opt-out", () => {
	it("flagged migrated to keychain; opt-out without rollback reads EMPTY flagged pool", async () => {
		const d = await dirOf("kf");
		setStoragePathDirect(join(d, "accounts.json"));
		setOptIn(false);
		await saveFlaggedAccounts({ version: 1, accounts: [{ refreshToken: "rt-fl", addedAt: 1, lastUsed: 1, flaggedAt: 1 }] });
		const backend = createMockBackend();
		_setBackendForTests(backend);
		setOptIn(true);
		await saveFlaggedAccounts({ version: 1, accounts: [{ refreshToken: "rt-fl", addedAt: 1, lastUsed: 1, flaggedAt: 1 }] });
		setOptIn(false);
		const flagged = await loadFlaggedAccounts();
		// [KNOWN-ISSUE] same gap as the main store: the marker is not
		// auto-restored on opt-out, so the flagged pool reads EMPTY.
		expect(flagged.accounts.length).toBe(0);
	});
});

describe("NEW CELL: worktree lock + lockfile leftovers", () => {
	it("storage transaction leaves no blocking lock dir after clean release", async () => {
		const d = await dirOf("locks");
		const f = join(d, "accounts.json");
		setStoragePathDirect(f);
		await saveAccounts(mkV3(["rt-1"]));
		await loadAccounts();
		const entries = await fs.readdir(d);
		// proper-lockfile's <file>.lock dir may linger as an empty released
		// marker; what must not survive is a *blocking* lease — a subsequent
		// save still acquires and completes.
		const leftovers = entries.filter((n) => n.includes(".transaction.lock") || n.includes(".worktree"));
		expect(leftovers).toEqual([]);
		await saveAccounts(mkV3(["rt-2"]));
		const reloaded = await loadAccounts();
		expect(reloaded?.accounts[0]?.refreshToken).toBe("rt-2");
	});
});

describe("NEW CELL: V1 flagged legacy blocked-accounts migration", () => {
	it("openai-codex-blocked-accounts.json migrates to flagged store", async () => {
		const d = await dirOf("blocked");
		setStoragePathDirect(join(d, "accounts.json"));
		const blockedPath = join(d, "openai-codex-blocked-accounts.json");
		await fs.writeFile(blockedPath, JSON.stringify({
			version: 1, accounts: [{ refreshToken: "rt-blocked", flaggedAt: 5 }],
		}));
		const loaded = await loadFlaggedAccounts();
		expect(loaded.accounts.length).toBe(1);
		expect(existsSync(blockedPath)).toBe(false);
	});
});

describe("NEW CELL: quota-notification corrupt file", () => {
	it("corrupt quota-notification file -> treated as absent, no crash", async () => {
		const { readQuotaNotificationState } = await import("../lib/quota-notification-state.js");
		const d = await dirOf("qn");
		const p = join(d, "oc-codex-multi-auth-quota-notifications.json");
		await fs.writeFile(p, "{corrupt");
		const read = await readQuotaNotificationState(p);
		// corrupt state degrades to absent (warn-level), rewritten on the next
		// threshold event
		expect(read).toBeUndefined();
	});
});
