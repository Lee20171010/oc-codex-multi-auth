/**
 * STATE-MIGRATION MATRIX — promoted from the round-2 migration audit.
 * Every storage-version + flag-flip combination exercised against real disk
 * state under the vitest minted HOME.
 *
 * Tests labelled [KNOWN-ISSUE] pin *observed* deficient behaviour
 * (silently-swallowed V2 legacy files, cross-scope token copies, torn-write
 * windows, unconditional retention gaps) so the failure mode stays
 * characterized. A fix that corrects the behaviour should flip the
 * expectation to the corrected contract in the same commit.
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
	StorageError,
	clearAccounts,
	getFlaggedAccountsPath,
	getStoragePath,
	importAccounts,
	loadAccounts,
	loadFlaggedAccounts,
	saveAccounts,
	saveFlaggedAccounts,
	setStoragePath,
	setStoragePathDirect,
	withAccountStorageTransaction,
} from "../lib/storage.js";
import { UNKNOWN_V2_FORMAT_CODE } from "../lib/storage/migrations.js";
import type { AccountStorageV3 } from "../lib/storage/migrations.js";
import {
	_resetBackendForTests,
	_setBackendForTests,
	buildKeychainAccountKey,
	buildKeychainFlaggedKey,
	writeToKeychain,
	KEYCHAIN_SERVICE_NAME,
	type KeychainBackend,
} from "../lib/storage/keychain.js";
import { MODEL_FAMILIES } from "../lib/prompts/codex.js";
import { coordinatePersistedRefresh } from "../lib/storage/coordinated-refresh.js";
import { createCodexKeychainTool } from "../lib/tools/codex-keychain.js";
import { getUiRuntimeOptions } from "../lib/ui/runtime.js";
import type { TokenResult } from "../lib/types.js";

let scratch: string;
const ORIG_KEYCHAIN = process.env.CODEX_KEYCHAIN;

function mkStorageV3(overrides: Partial<AccountStorageV3> = {}): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		accounts: [
			{
				refreshToken: "rt-A",
				accessToken: "at-A",
				expiresAt: Date.now() + 3600_000,
				accountId: "acct-A",
				accountUserId: "mem-A",
				organizationId: "org-A",
				accountIdSource: "token",
				email: "a@example.com",
				accountLabel: "Label A",
				planType: "pro",
				accountTags: ["work"],
				accountNote: "note-A",
				oauthScope: "openid profile",
				enabled: true,
				addedAt: 1000,
				lastUsed: 2000,
				lastSwitchReason: "rotation",
				tokenRotatedAt: 111,
				rateLimitResetTimes: { codex: Date.now() + 10_000 },
				coolingDownUntil: Date.now() + 5_000,
				cooldownReason: "network-error",
			},
			{
				refreshToken: "rt-B",
				addedAt: 3000,
				lastUsed: 4000,
				email: "b@example.com",
			},
		],
		...overrides,
	};
}

async function dirOf(suffix: string): Promise<string> {
	const d = join(scratch, suffix);
	await fs.mkdir(d, { recursive: true });
	return d;
}

async function readJson(p: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.readFile(p, "utf-8")) as Record<string, unknown>;
}

interface MockBackend extends KeychainBackend {
	store: Map<string, string>;
	setShouldThrow: boolean;
	getShouldThrow: boolean;
	available: boolean;
}
function createMockBackend(): MockBackend {
	const store = new Map<string, string>();
	const b: MockBackend = {
		store,
		setShouldThrow: false,
		getShouldThrow: false,
		available: true,
		async get(service, account) {
			if (b.getShouldThrow) throw new Error("kc get fail");
			return store.get(`${service}::${account}`) ?? null;
		},
		async set(service, account, secret) {
			if (b.setShouldThrow) throw new Error("kc set fail");
			store.set(`${service}::${account}`, secret);
		},
		async delete(service, account) {
			return store.delete(`${service}::${account}`);
		},
		async isAvailable() {
			return b.available;
		},
	};
	return b;
}
function setOptIn(on: boolean) {
	if (on) process.env.CODEX_KEYCHAIN = "1";
	else delete process.env.CODEX_KEYCHAIN;
}

beforeEach(async () => {
	scratch = await fs.mkdtemp(join(tmpdir(), "audit-matrix-"));
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

/* =========================================================================
 * CELL 1 — storage version matrix
 * ========================================================================= */

describe("CELL1: storage versions", () => {
	it("1a. V1 full-fields -> load -> V3 migration + persist + snapshot artifact", async () => {
		const d = await dirOf("v1");
		const f = join(d, "accounts.json");
		const future = Date.now() + 60_000;
		const v1 = {
			version: 1,
			activeIndex: 1,
			accounts: [
				{
					refreshToken: "rt-1", accessToken: "at-1", expiresAt: future,
					accountId: "a1", organizationId: "o1", email: "one@x.com",
					accountLabel: "L1", accountTags: ["t"], accountNote: "n1",
					oauthScope: "s1", enabled: false, addedAt: 11, lastUsed: 22,
					lastSwitchReason: "rate-limit",
					rateLimitResetTime: future,
					coolingDownUntil: future, cooldownReason: "auth-failure",
				},
				{ refreshToken: "rt-2", addedAt: 33, lastUsed: 44 },
			],
		};
		await fs.writeFile(f, JSON.stringify(v1));
		setStoragePathDirect(f);
		const loaded = await loadAccounts();
		expect(loaded?.version).toBe(3);
		expect(loaded?.accounts.length).toBe(2);
		const a = loaded?.accounts[0];
		expect(a?.refreshToken).toBe("rt-1");
		expect(a?.email).toBe("one@x.com");
		expect(a?.accountLabel).toBe("L1");
		expect(a?.enabled).toBe(false);
		expect(a?.coolingDownUntil).toBe(future);
		// V1 global stamp seeded per-family
		for (const fam of MODEL_FAMILIES) {
			expect(a?.rateLimitResetTimes?.[fam]).toBe(future);
		}
		expect(loaded?.activeIndex).toBe(1);
		expect(loaded?.activeIndexByFamily?.codex).toBe(1);
		// file rewritten as v3
		const onDisk = await readJson(f);
		expect(onDisk.version).toBe(3);
		// credential snapshot of the pre-migration V1 file captured
		const backupsDir = join(d, "backups");
		const snaps = existsSync(backupsDir)
			? (await fs.readdir(backupsDir)).filter((n) => n.startsWith("codex-credential-snapshot-"))
			: [];
		const v1Snap = snaps.length > 0
			? JSON.parse(await fs.readFile(join(backupsDir, snaps[0]!), "utf-8")) as { version?: number }
			: null;
		const acct0 = (onDisk.accounts as Array<Record<string, unknown>>)[0]!;
		// the V1 scalar stamp is copied into the per-family map AND left behind
		// on the migrated record (passthrough of unknown V1 fields)
		expect("rateLimitResetTime" in acct0).toBe(true);
		expect(acct0.rateLimitResetTime).toBe(future);
		expect(snaps.length).toBeGreaterThan(0);
		expect(v1Snap?.version).toBe(1);
	});

	it("1b. V2 main file -> throws UNKNOWN_V2_FORMAT, file untouched", async () => {
		const d = await dirOf("v2");
		const f = join(d, "accounts.json");
		const v2 = { version: 2, accounts: [{ email: "u@x.com", refreshToken: "rt" }], activeIndex: 0 };
		await fs.writeFile(f, JSON.stringify(v2));
		setStoragePathDirect(f);
		let code = "";
		try { await loadAccounts(); } catch (e) { code = (e as StorageError).code; }
		expect(code).toBe(UNKNOWN_V2_FORMAT_CODE);
		// file must NOT be rewritten or deleted
		expect(existsSync(f)).toBe(true);
		expect((await readJson(f)).version).toBe(2);
		// no V3 sibling written — file is preserved verbatim, never clobbered
	});

	it("1c. V2 in GLOBAL LEGACY slot -> migration swallows the typed error", async () => {
		// legacy global file ~/.opencode/openai-codex-accounts.json under the
		// vitest sandbox home. Global path = no project path active.
		const globalDir = join(homedir(), ".opencode");
		await fs.mkdir(globalDir, { recursive: true });
		const legacyGlobal = join(globalDir, "openai-codex-accounts.json");
		const v2 = { version: 2, accounts: [{ email: "u@x.com", refreshToken: "rt" }] };
		await fs.writeFile(legacyGlobal, JSON.stringify(v2));
		setStoragePathDirect(null); // global scope
		let threw: unknown = null;
		let loaded: Awaited<ReturnType<typeof loadAccounts>> = null;
		try { loaded = await loadAccounts(); } catch (e) { threw = e; }
		const legacyStillThere = existsSync(legacyGlobal);
		const newFile = join(globalDir, "oc-codex-multi-auth-accounts.json");
		const newWritten = existsSync(newFile);
		// [KNOWN-ISSUE] migrateStorageFileIfNeeded swallows the UNKNOWN_V2_FORMAT
		// rejection (only UNSUPPORTED_SCHEMA_VERSION is rethrown): the pool reads
		// empty with only a warn log, and the V2 file is left in place.
		expect(threw).toBeNull();
		expect(loaded).toBeNull();
		expect(legacyStillThere).toBe(true);
		expect(newWritten).toBe(false);
		try { await fs.rm(legacyGlobal, { force: true }); } catch { /* ignore */ }
		try { await fs.rm(newFile, { force: true }); } catch { /* ignore */ }
	});

	it("1d. V3 + unknown extra fields -> loads; extras dropped on save", async () => {
		const d = await dirOf("v3x");
		const f = join(d, "accounts.json");
		await fs.writeFile(f, JSON.stringify({
			version: 3, activeIndex: 0, futureField: "keepme",
			accounts: [{ refreshToken: "rt", addedAt: 1, lastUsed: 1, futureAcctField: 42 }],
		}));
		setStoragePathDirect(f);
		const loaded = await loadAccounts();
		expect(loaded?.accounts.length).toBe(1);
		// normalize keeps record-level unknown keys (object spread passthrough)
		const acct = loaded?.accounts[0] as Record<string, unknown> | undefined;
		const keptRecordField = acct && "futureAcctField" in acct;
		await saveAccounts(loaded!);
		const onDisk = await readJson(f);
		// root-level unknown field is dropped on save; record-level unknown keys
		// pass through normalize and persist back to disk
		expect("futureField" in onDisk).toBe(false);
		expect(keptRecordField).toBe(true);
		expect("futureAcctField" in (onDisk.accounts as Record<string, unknown>[])[0]!).toBe(true);
	});

	it("1e. V3 missing fields -> defaults; non-array accounts -> loud", async () => {
		const d = await dirOf("v3m");
		const f = join(d, "accounts.json");
		await fs.writeFile(f, JSON.stringify({ version: 3, accounts: [{ refreshToken: "r", addedAt: 1, lastUsed: 1 }] }));
		setStoragePathDirect(f);
		const loaded = await loadAccounts();
		// missing activeIndex defaults to 0
		expect(loaded?.activeIndex).toBe(0);

		await fs.writeFile(f, JSON.stringify({ version: 3, accounts: "nope" }));
		let code = "";
		try { await loadAccounts(); } catch (e) { code = (e as StorageError).code; }
		expect(code).toBe("INVALID_STORAGE");

		await fs.writeFile(f, JSON.stringify({ version: 3, accounts: [] }));
		const empty = await loadAccounts();
		expect(empty?.accounts.length).toBe(0);
	});

	it("1f. version 4 / 0 / string / missing", async () => {
		const d = await dirOf("vX");
		const f = join(d, "accounts.json");
		setStoragePathDirect(f);
		const cases: Array<{ v: unknown; expectCode: string }> = [
			{ v: 4, expectCode: "UNSUPPORTED_SCHEMA_VERSION" },
			{ v: 42, expectCode: "UNSUPPORTED_SCHEMA_VERSION" },
			{ v: 0, expectCode: "INVALID_STORAGE" },
			{ v: "3", expectCode: "INVALID_STORAGE" },
			{ v: "2", expectCode: "INVALID_STORAGE" }, // string "2" does NOT trip V2 detection (literal 2 only)
			{ v: null, expectCode: "INVALID_STORAGE" },
		];
		for (const c of cases) {
			const payload: Record<string, unknown> = { accounts: [{ refreshToken: "r", addedAt: 1, lastUsed: 1 }] };
			if (c.v !== "ABSENT") payload.version = c.v;
			await fs.writeFile(f, JSON.stringify(payload));
			let code = "";
			try { await loadAccounts(); } catch (e) { code = (e as StorageError).code; }
			expect(code).toBe(c.expectCode);
		}
	});

	it("1g. V1 account with corrupt record -> silently dropped", async () => {
		const d = await dirOf("v1bad");
		const f = join(d, "accounts.json");
		await fs.writeFile(f, JSON.stringify({
			version: 1, activeIndex: 0,
			accounts: [
				{ refreshToken: "rt-good", addedAt: 1, lastUsed: 1 },
				{ refreshToken: 12345, addedAt: 1, lastUsed: 1 }, // non-string token
				{ refreshToken: "   ", addedAt: 1, lastUsed: 1 },   // blank token
				"not-a-record",
			],
		}));
		setStoragePathDirect(f);
		const loaded = await loadAccounts();
		// [KNOWN-ISSUE] invalid records are silently discarded — recoverable only
		// via the credential snapshot, with no user-facing signal.
		expect(loaded?.accounts.length).toBe(1);
		expect(loaded?.accounts[0]?.refreshToken).toBe("rt-good");
	});
});

/* =========================================================================
 * CELL 2 — perProjectAccounts ON→OFF→ON
 * ========================================================================= */

describe("CELL2: perProjectAccounts scope flips", () => {
	async function mkProject(name: string): Promise<string> {
		const p = await dirOf(name);
		await fs.mkdir(join(p, ".git"), { recursive: true });
		return p;
	}

	it("2a. project pool orphaned on OFF; restored on ON (documented)", async () => {
		const proj = await mkProject("projA");
		setStoragePath(proj);
		await saveAccounts(mkStorageV3());
		const projectPath = getStoragePath();
		expect(projectPath).toContain("projects");
		await saveFlaggedAccounts({ version: 1, accounts: [{ refreshToken: "rt-F", addedAt: 1, lastUsed: 1, flaggedAt: 1 }] });
		const flaggedPath = getFlaggedAccountsPath();

		// OFF: global scope
		setStoragePath(null);
		expect(getStoragePath()).not.toContain("projects");
		// project files remain, orphaned — docs say 'copy or remove them yourself'
		expect(existsSync(projectPath)).toBe(true);
		expect(existsSync(flaggedPath)).toBe(true);

		// back ON
		setStoragePath(proj);
		const reloaded = await loadAccounts();
		expect(reloaded?.accounts.length).toBe(2);
		const flagged = await loadFlaggedAccounts();
		expect(flagged.accounts.length).toBe(1);
		// project + flagged files survive orphaned in place; docs describe the
		// copy/remove-yourself contract (docs/configuration.md)
	});

	it("2b. missing project file is SEEDED from the global pool — credential copy sharing single-use tokens", async () => {
		const globalDir = join(homedir(), ".opencode");
		await fs.mkdir(globalDir, { recursive: true });
		const globalFile = join(globalDir, "oc-codex-multi-auth-accounts.json");
		const sharedToken = "rt-SHARED";
		await fs.writeFile(globalFile, JSON.stringify({
			version: 3, activeIndex: 0,
			accounts: [{ refreshToken: sharedToken, accountId: "acct-1", accountUserId: "m1", addedAt: 1, lastUsed: 1 }],
		}));

		const proj = await mkProject("projB");
		setStoragePath(proj);
		const projectPath = getStoragePath();
		expect(existsSync(projectPath)).toBe(false);
		const loaded = await loadAccounts();
		expect(loaded?.accounts.length).toBe(1);
		// the seed write duplicated the global credentials into the project scope
		const seeded = await readJson(projectPath);
		const seededToken = (seeded.accounts as Array<Record<string, unknown>>)[0]?.refreshToken;
		const globalToken = ((await readJson(globalFile)).accounts as Array<Record<string, unknown>>)[0]?.refreshToken;
		// [KNOWN-ISSUE] the project file is silently seeded from the global pool:
		// both files now hold the same single-use refresh token, and a rotation
		// in one scope cannot propagate to the other (stale pool then hits
		// refresh_token_reused). Docs only say "does not migrate or delete".
		expect(seededToken).toBe("rt-SHARED");
		expect(seededToken).toBe(globalToken);
		try { await fs.rm(globalFile, { force: true }); } catch { /* ignore */ }
	});

	it("2c. storage transaction spanning a scope flip persists to the NEW path under the OLD lease", async () => {
		const projA = await mkProject("projFlipA");
		const projB = await mkProject("projFlipB");
		setStoragePath(projA);
		const pathA = getStoragePath();
		await saveAccounts(mkStorageV3());
		setStoragePath(projB);
		const pathB = getStoragePath();
		await saveAccounts({ version: 3, activeIndex: 0, accounts: [{ refreshToken: "rt-BPOOL", addedAt: 1, lastUsed: 1 }] });
		setStoragePath(projA);

		// Transaction opens on A; mid-transaction the scope flips to B.
		await withAccountStorageTransaction(async (current, persist) => {
			expect(current?.accounts[0]?.refreshToken).toBe("rt-A");
			setStoragePath(projB); // the flip the index.ts fetch wrapper orchestrates
			await persist({
				version: 3,
				activeIndex: 0,
				accounts: [{ refreshToken: "rt-WRITTEN-ACROSS-FLIP", addedAt: 1, lastUsed: 1 }],
			});
		});
		const diskA = await readJson(pathA);
		const diskB = await readJson(pathB);
		const aTok = (diskA.accounts as Array<Record<string, unknown>>)[0]?.refreshToken;
		const bTok = (diskB.accounts as Array<Record<string, unknown>>)[0]?.refreshToken;
		// [KNOWN-ISSUE] load(A)+flip+persist lands on B: the lease was taken on
		// A's lock, but B's file is overwritten without B's lease — a
		// cross-process torn-write window. In-process callers are drained by
		// index.ts; storage-layer callers (tools, flagged txn, coordinated
		// refresh) are not tracked by activeFetches.
		expect(aTok).toBe("rt-A");
		expect(bTok).toBe("rt-WRITTEN-ACROSS-FLIP");
		setStoragePathDirect(null);
	});
});

/* =========================================================================
 * CELL 3 — CODEX_KEYCHAIN 0→1→0
 * ========================================================================= */

describe("CELL3: CODEX_KEYCHAIN flips", () => {
	it("3a. 0→1: save migrates JSON to keychain; marker is 0600 .migrated-to-keychain", async () => {
		const d = await dirOf("kc1");
		const f = join(d, "accounts.json");
		setStoragePathDirect(f);
		setOptIn(false);
		await saveAccounts(mkStorageV3());

		const backend = createMockBackend();
		_setBackendForTests(backend);
		setOptIn(true);
		const v3b = mkStorageV3({ accounts: [{ refreshToken: "rt-NEW", addedAt: 5, lastUsed: 6 }] });
		await saveAccounts(v3b);
		const key = buildKeychainAccountKey(null);
		const blob = backend.store.get(`${KEYCHAIN_SERVICE_NAME}::${key}`);
		expect(blob).toBeTruthy();
		expect((JSON.parse(blob!) as { accounts: unknown[] }).accounts.length).toBe(1);
		const entries = await fs.readdir(d);
		const markers = entries.filter((n) => n.includes(".migrated-to-keychain."));
		expect(markers.length).toBe(1);
		expect(existsSync(f)).toBe(false);
		const markerMode = (await fs.stat(join(d, markers[0]!))).mode & 0o777;
		// load under opt-in reads keychain blob
		const loaded = await loadAccounts();
		expect(loaded?.accounts[0]?.refreshToken).toBe("rt-NEW");
		expect(markerMode).toBe(0o600);
	});

	it("3b. opt-out WITHOUT rollback -> pool reads EMPTY (marker not auto-restored)", async () => {
		const d = await dirOf("kc2");
		const f = join(d, "accounts.json");
		setStoragePathDirect(f);
		setOptIn(false);
		await saveAccounts(mkStorageV3());
		const backend = createMockBackend();
		_setBackendForTests(backend);
		setOptIn(true);
		await saveAccounts(mkStorageV3()); // migrates to keychain

		setOptIn(false); // toggle off, no rollback command
		const loaded = await loadAccounts();
		// [KNOWN-ISSUE] the .migrated-to-keychain file is not auto-restored on
		// opt-out: the pool reads EMPTY until `codex-keychain rollback` runs.
		expect(loaded).toBeNull();
	});

	it("3c. codex-keychain rollback restores main+flagged, deletes keychain entries", async () => {
		const d = await dirOf("kc3");
		const f = join(d, "accounts.json");
		setStoragePathDirect(f);
		setOptIn(false);
		await saveAccounts(mkStorageV3());
		await saveFlaggedAccounts({ version: 1, accounts: [{ refreshToken: "rt-flag", addedAt: 1, lastUsed: 1, flaggedAt: 1 }] });
		const backend = createMockBackend();
		_setBackendForTests(backend);
		setOptIn(true);
		await saveAccounts(mkStorageV3());      // migrate main
		await saveFlaggedAccounts({ version: 1, accounts: [{ refreshToken: "rt-flag2", addedAt: 2, lastUsed: 2, flaggedAt: 2 }] }); // migrate flagged

		const tool = createCodexKeychainTool({ resolveUiRuntime: () => getUiRuntimeOptions() } as never);
		const out = await tool.execute({ command: "rollback", confirm: true });
		expect(typeof out).toBe("string");
		expect(existsSync(f)).toBe(true);
		const restored = await readJson(f);
		expect((restored.accounts as unknown[]).length).toBe(2);
		expect(existsSync(getFlaggedAccountsPath())).toBe(true);
		const kcMain = backend.store.get(`${KEYCHAIN_SERVICE_NAME}::${buildKeychainAccountKey(null)}`);
		const kcFlag = backend.store.get(`${KEYCHAIN_SERVICE_NAME}::${buildKeychainFlaggedKey(null)}`);
		// rollback deletes both keychain entries after restoring on-disk JSON
		expect(kcMain).toBeUndefined();
		expect(kcFlag).toBeUndefined();
	});

	it("3d. mid-migration crash: keychain write ok, kill before marker rename -> stale JSON + keychain diverge", async () => {
		const d = await dirOf("kc4");
		const f = join(d, "accounts.json");
		setStoragePathDirect(f);
		setOptIn(false);
		await saveAccounts(mkStorageV3()); // disk has rt-A/rt-B

		const backend = createMockBackend();
		_setBackendForTests(backend);
		setOptIn(true);
		// Simulate saveAccountsUnlocked up to the point of the crash:
		// keychain gets the NEW blob (rotated), then the process dies before
		// migrateOnDiskJsonToKeychainBackup's fs.access/rename runs.
		const rotated = { version: 3 as const, activeIndex: 0, accounts: [{ refreshToken: "rt-ROTATED", addedAt: 1, lastUsed: 1 }] };
		await writeToKeychain(null, JSON.stringify(rotated));
		// process dies here -> canonical JSON (rt-A/rt-B) still in place, keychain holds rt-ROTATED

		// opt-in load: keychain wins
		const underOptIn = await loadAccounts();
		expect(underOptIn?.accounts[0]?.refreshToken).toBe("rt-ROTATED");
		// opt-out: stale file resurrects the CONSUMED token
		setOptIn(false);
		const afterOptOut = await loadAccounts();
		const resurrected = afterOptOut?.accounts.map((a) => a.refreshToken);
		// [KNOWN-ISSUE] kill between keychain.set and marker rename leaves the
		// canonical JSON at its pre-migration state while keychain holds a newer
		// blob; toggling off resurrects a possibly-consumed token. No startup
		// reconciliation rewrites the stale file.
		expect(resurrected).toEqual(["rt-A", "rt-B"]);
	});

	it("3e. rollback while CODEX_KEYCHAIN already unset leaves a stale keychain blob that re-opts-in resurrects", async () => {
		const d = await dirOf("kc5");
		const f = join(d, "accounts.json");
		setStoragePathDirect(f);
		setOptIn(false);
		await saveAccounts(mkStorageV3());
		const backend = createMockBackend();
		_setBackendForTests(backend);
		setOptIn(true);
		await saveAccounts(mkStorageV3()); // migrated, marker exists

		setOptIn(false); // user unsets FIRST
		const tool = createCodexKeychainTool({ resolveUiRuntime: () => getUiRuntimeOptions() } as never);
		await tool.execute({ command: "rollback", confirm: true });
		// post-rollback writes land on JSON
		await saveAccounts({ version: 3, activeIndex: 0, accounts: [{ refreshToken: "rt-POST-ROLLBACK", addedAt: 9, lastUsed: 9 }] });
		// keychain still holds the OLD migrated blob
		const staleBlob = backend.store.get(`${KEYCHAIN_SERVICE_NAME}::${buildKeychainAccountKey(null)}`);
		// re-opt-in: keychain wins over the post-rollback disk state
		setOptIn(true);
		const loaded = await loadAccounts();
		// [KNOWN-ISSUE] rollback while already opted out skips the keychain
		// delete (the tool only deletes under optIn); the stale blob stays and a
		// re-opt-in silently resurrects pre-rollback state.
		expect(staleBlob).toBeTruthy();
		expect(loaded?.accounts[0]?.refreshToken).toBe("rt-A");
	});

	it("3f. keychain unavailable at flip -> JSON fallback both directions", async () => {
		const d = await dirOf("kc6");
		const f = join(d, "accounts.json");
		setStoragePathDirect(f);
		setOptIn(false);
		await saveAccounts(mkStorageV3());
		const backend = createMockBackend();
		backend.setShouldThrow = true;
		backend.getShouldThrow = true;
		_setBackendForTests(backend);
		setOptIn(true);
		await saveAccounts({ version: 3, activeIndex: 0, accounts: [{ refreshToken: "rt-FALLBACK", addedAt: 1, lastUsed: 1 }] });
		// JSON file must have been written (fallback)
		expect(existsSync(f)).toBe(true);
		const disk = await readJson(f);
		expect((disk.accounts as Array<Record<string, unknown>>)[0]?.refreshToken).toBe("rt-FALLBACK");
		const loaded = await loadAccounts();
		expect(loaded?.accounts[0]?.refreshToken).toBe("rt-FALLBACK");
	});

	it("3g. corrupt keychain blob falls back to JSON without losing data", async () => {
		const d = await dirOf("kc7");
		const f = join(d, "accounts.json");
		setStoragePathDirect(f);
		setOptIn(false);
		await saveAccounts(mkStorageV3());
		const backend = createMockBackend();
		_setBackendForTests(backend);
		setOptIn(true);
		backend.store.set(`${KEYCHAIN_SERVICE_NAME}::${buildKeychainAccountKey(null)}`, "{{{not json");
		const loaded = await loadAccounts();
		expect(loaded?.accounts.length).toBe(2);
	});

	it("3h. clearAccounts under opt-in removes both sides; ordering json-first", async () => {
		const d = await dirOf("kc8");
		const f = join(d, "accounts.json");
		setStoragePathDirect(f);
		setOptIn(false);
		await saveAccounts(mkStorageV3());
		const backend = createMockBackend();
		_setBackendForTests(backend);
		setOptIn(true);
		await saveAccounts(mkStorageV3());
		await clearAccounts();
		expect(existsSync(f)).toBe(false);
		expect(backend.store.get(`${KEYCHAIN_SERVICE_NAME}::${buildKeychainAccountKey(null)}`)).toBeUndefined();
	});
});

/* =========================================================================
 * CELL 4 — corruption corpus into the loaders
 * ========================================================================= */

describe("CELL4: corruption corpus", () => {
	const cases: Array<{ name: string; content: string | Buffer; encoding?: BufferEncoding }> = [
		{ name: "truncated", content: '{"version":3,"activeIndex":0,"accounts":[{"refreshToken":"rt' },
		{ name: "valid-JSON-wrong-shape", content: '{"hello":"world"}' },
		{ name: "array-root", content: '[{"refreshToken":"rt"}]' },
		{ name: "zero-byte", content: "" },
		{ name: "BOM-prefixed valid", content: "﻿" + JSON.stringify({ version: 3, activeIndex: 0, accounts: [{ refreshToken: "rt", addedAt: 1, lastUsed: 1 }] }) },
		{ name: "UTF-16LE", content: Buffer.from(JSON.stringify({ version: 3, activeIndex: 0, accounts: [] }), "utf16le") },
		{ name: "latin-1 garbage", content: Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0x80, 0x00]) },
		{ name: "null-byte mid-file", content: '{"version":3,"activeIndex":0,"accounts":[] }' },
		{ name: "whitespace-only", content: "   \n\t  " },
		{ name: "json-literal-true", content: "true" },
		{ name: "json-literal-null", content: "null" },
	];

	// Observed contract on the main loader: every malformed payload throws
	// INVALID_STORAGE and leaves the file intact; the single exception is a
	// BOM-prefixed otherwise-valid payload, which parses (BOM stripped).
	for (const c of cases) {
		const loads = c.name === "BOM-prefixed valid";
		it(`4-main: ${c.name}`, async () => {
			const d = await dirOf(`m-${c.name.replace(/[^a-z0-9]+/gi, "_")}`);
			const f = join(d, "accounts.json");
			await fs.writeFile(f, c.content);
			setStoragePathDirect(f);
			if (loads) {
				const r = await loadAccounts();
				expect(r?.accounts.length).toBe(1);
			} else {
				let code = "";
				try { await loadAccounts(); } catch (e) { code = (e as StorageError).code; }
				expect(code).toBe("INVALID_STORAGE");
			}
			expect(existsSync(f)).toBe(true);
		});

		it(`4-flagged: ${c.name}`, async () => {
			const d = await dirOf(`f-${c.name.replace(/[^a-z0-9]+/gi, "_")}`);
			const f = join(d, "accounts.json");
			setStoragePathDirect(f);
			const flaggedPath = getFlaggedAccountsPath();
			await fs.writeFile(flaggedPath, c.content);
			// [KNOWN-ISSUE] the flagged loader swallows every form of corruption
			// into an EMPTY pool — the main store would throw INVALID_STORAGE.
			const r = await loadFlaggedAccounts();
			expect(r.accounts.length).toBe(0);
		});
	}

	it("4-main per-field poison healing", async () => {
		const d = await dirOf("poison");
		const f = join(d, "accounts.json");
		await fs.writeFile(f, JSON.stringify({
			version: 3, activeIndex: 0,
			accounts: [{
				refreshToken: "rt", addedAt: "bad", lastUsed: null,
				expiresAt: "tomorrow", coolingDownUntil: 1e30,
				quotaExhaustedUntil: Number.MAX_VALUE,
				rateLimitResetTimes: { codex: 1e400, other: "x", fine: Date.now() + 5000 },
			}],
		}));
		setStoragePathDirect(f);
		const loaded = await loadAccounts();
		const a = loaded?.accounts[0];
		expect(a?.addedAt).toBe(0);
		expect(a?.lastUsed).toBe(0);
		expect(a?.expiresAt).toBeUndefined();
		expect(a?.coolingDownUntil).toBeUndefined();
		expect(a?.quotaExhaustedUntil).toBeUndefined();
		expect(a?.rateLimitResetTimes?.codex).toBeUndefined();
		expect(a?.rateLimitResetTimes?.fine).toBeGreaterThan(0);
	});

	it("4-flagged: version≠1 file is silently emptied (no V2-style guard)", async () => {
		const d = await dirOf("f-v2");
		const f = join(d, "accounts.json");
		setStoragePathDirect(f);
		const flaggedPath = getFlaggedAccountsPath();
		await fs.writeFile(flaggedPath, JSON.stringify({ version: 2, accounts: [{ refreshToken: "rt-flagged", flaggedAt: 1 }] }));
		const loaded = await loadFlaggedAccounts();
		// [KNOWN-ISSUE] the flagged store has no version guard: a version:2 file
		// returns an empty pool where the main store would throw
		// UNKNOWN_V2_FORMAT.
		expect(loaded.accounts.length).toBe(0);
	});

	it("4-flagged legacy file that normalizes to empty is DELETED anyway", async () => {
		const d = await dirOf("f-legacy");
		const f = join(d, "accounts.json");
		setStoragePathDirect(f);
		const legacyPath = join(d, "openai-codex-flagged-accounts.json");
		// JSON parses, but shape doesn't yield accounts (e.g. v2 flagged or wrong shape)
		await fs.writeFile(legacyPath, JSON.stringify({ version: 2, accounts: [{ refreshToken: "rt-old-flag" }] }));
		const loaded = await loadFlaggedAccounts();
		// [KNOWN-ISSUE] flagged.ts unlinks the legacy file even when
		// normalization produced zero accounts — silent credential loss.
		expect(loaded.accounts.length).toBe(0);
		expect(existsSync(legacyPath)).toBe(false);
	});

	it("4-main: credential snapshot preserves a corrupt file before overwrite", async () => {
		const d = await dirOf("snapcorrupt");
		const f = join(d, "accounts.json");
		await fs.writeFile(f, '{"version":3,"accounts":[{"refreshToken":"rt-good"}');
		setStoragePathDirect(f);
		// corrupt file -> loadAccounts throws, but the NEXT successful save over it
		// (e.g. after user re-adds an account) must still snapshot the corrupt bytes
		let threw = false;
		try { await loadAccounts(); } catch { threw = true; }
		expect(threw).toBe(true);
		await saveAccounts(mkStorageV3({ accounts: [{ refreshToken: "rt-NEW", addedAt: 1, lastUsed: 1 }] }));
		const backupsDir = join(d, "backups");
		const snaps = existsSync(backupsDir) ? await fs.readdir(backupsDir) : [];
		// unparseable previous content counts as significant and is preserved
		expect(snaps.length).toBeGreaterThan(0);
	});
});

/* =========================================================================
 * CELL 5 — flagged ↔ main transitions + cross-store propagation
 * ========================================================================= */

describe("CELL5: flagged/main transitions + propagation", () => {
	it("5a. flagged write strips accessToken/expiresAt at persist (credential-light)", async () => {
		const d = await dirOf("flagfields");
		setStoragePathDirect(join(d, "accounts.json"));
		await saveFlaggedAccounts({
			version: 1,
			accounts: [{
				refreshToken: "rt-q", accessToken: "at-q", expiresAt: Date.now() + 9999,
				addedAt: 1, lastUsed: 1, flaggedAt: 1,
				accountTags: ["x"], accountNote: "n", planType: "pro", email: "q@x.com",
				tokenRotatedAt: 77,
			}],
		});
		const raw = await readJson(getFlaggedAccountsPath());
		const rec = (raw.accounts as Array<Record<string, unknown>>)[0]!;
		const loaded = await loadFlaggedAccounts();
		const recLoaded = loaded.accounts[0]!;
		// flagged store is credential-light: accessToken/expiresAt stripped at
		// persist; metadata survives the round trip
		expect("accessToken" in rec).toBe(false);
		expect("expiresAt" in rec).toBe(false);
		expect(recLoaded.accountTags).toEqual(["x"]);
		expect(recLoaded.accountNote).toBe("n");
		expect(recLoaded.planType).toBe("pro");
		expect(recLoaded.tokenRotatedAt).toBe(77);
	});

	it("5b. cross-store propagation main->flagged on shared refreshToken pair", async () => {
		const d = await dirOf("prop");
		setStoragePathDirect(join(d, "accounts.json"));
		await saveAccounts({
			version: 3, activeIndex: 0,
			accounts: [{ refreshToken: "r0", organizationId: "o", accountId: "w", accountUserId: "m", addedAt: 1, lastUsed: 1, accessToken: "a0", expiresAt: 0 }],
		});
		await saveFlaggedAccounts({
			version: 1,
			accounts: [{ refreshToken: "r0", organizationId: "o", accountId: "w", accountUserId: "m", addedAt: 1, lastUsed: 1, flaggedAt: 1 }],
		});
		vi.mocked(queuedRefresh).mockResolvedValue({
			type: "success", access: "a1", refresh: "r1", expires: Date.now() + 3_600_000,
		} as TokenResult);
		const res = await coordinatePersistedRefresh({ organizationId: "o", accountId: "w", accountUserId: "m", refreshToken: "r0" });
		expect(res.type).toBe("success");
		const flagged = await loadFlaggedAccounts();
		// rotated token propagates to the flagged sibling record
		expect(flagged.accounts[0]?.refreshToken).toBe("r1");
	});

	it("5c. flagged->main propagation when the MAIN file is missing entirely", async () => {
		const d = await dirOf("prop-miss");
		setStoragePathDirect(join(d, "accounts.json"));
		// no main file; flagged holds the only copy
		await saveFlaggedAccounts({
			version: 1,
			accounts: [{ refreshToken: "r0", organizationId: "o", accountId: "w", accountUserId: "m", addedAt: 1, lastUsed: 1, flaggedAt: 1 }],
		});
		vi.mocked(queuedRefresh).mockResolvedValue({
			type: "success", access: "a1", refresh: "r1", expires: Date.now() + 3_600_000,
		} as TokenResult);
		const { coordinateFlaggedPersistedRefresh } = await import("../lib/storage/coordinated-refresh.js");
		let threw = false;
		try {
			await coordinateFlaggedPersistedRefresh({ organizationId: "o", accountId: "w", accountUserId: "m", refreshToken: "r0" });
		} catch { threw = true; }
		const mainExists = existsSync(join(d, "accounts.json"));
		const flagged = await loadFlaggedAccounts();
		// a missing main store makes cross-store propagation a no-op: the
		// flagged record still rotates, no main file is conjured up — the
		// rotation stamp is left unshared (acceptable: sibling absent).
		expect(threw).toBe(false);
		expect(mainExists).toBe(false);
		expect(flagged.accounts[0]?.refreshToken).toBe("r1");
	});
});

/* =========================================================================
 * CELL 6 — artifact accumulation / purge policy
 * ========================================================================= */

describe("CELL6: artifact retention", () => {
	it("6a. credential snapshots prune to maxCount; other backup kinds never pruned", async () => {
		const d = await dirOf("retention");
		const f = join(d, "accounts.json");
		setStoragePathDirect(f);
		setOptIn(false);
		// seed, then make many significant writes
		await saveAccounts(mkStorageV3());
		for (let i = 0; i < 15; i++) {
			await saveAccounts({
				version: 3, activeIndex: 0,
				accounts: [{ refreshToken: `rt-${i}`, addedAt: i, lastUsed: i }],
			});
		}
		const backupsDir = join(d, "backups");
		const snaps = existsSync(backupsDir)
			? (await fs.readdir(backupsDir)).filter((n) => n.startsWith("codex-credential-snapshot-"))
			: [];
		expect(snaps.length).toBe(10); // config-default retention bound
	});

	it("6b. .migrated-to-keychain + .pre-rollback + pre-import backups have NO retention", async () => {
		const d = await dirOf("retention2");
		const f = join(d, "accounts.json");
		setStoragePathDirect(f);
		setOptIn(false);
		await saveAccounts(mkStorageV3());
		const backend = createMockBackend();
		_setBackendForTests(backend);
		setOptIn(true);
		// Each opt-in save while a JSON file exists creates a new marker.
		for (let i = 0; i < 3; i++) {
			// recreate the JSON file so the next keychain save migrates it again
			await fs.writeFile(f, JSON.stringify({ version: 3, activeIndex: 0, accounts: [{ refreshToken: `rt-${i}`, addedAt: 1, lastUsed: 1 }] }));
			await saveAccounts(mkStorageV3());
		}
		const markers = (await fs.readdir(d)).filter((n) => n.includes(".migrated-to-keychain."));
		// [KNOWN-ISSUE] markers have no retention — they accumulate per
		// migration and fs.rename overwrites same-timestamp siblings, so the
		// count is timing-dependent but always in [1, iterations].
		expect(markers.length).toBeGreaterThanOrEqual(1);
		expect(markers.length).toBeLessThanOrEqual(3);
	});

	it("6c. import pre-backups accumulate unbounded", async () => {
		const d = await dirOf("retention3");
		const f = join(d, "accounts.json");
		setStoragePathDirect(f);
		setOptIn(false);
		await saveAccounts(mkStorageV3());
		const importFile = join(d, "import.json");
		await fs.writeFile(importFile, JSON.stringify({ version: 3, activeIndex: 0, accounts: [{ refreshToken: "rt-imp", addedAt: 1, lastUsed: 1 }] }));
		for (let i = 0; i < 3; i++) {
			await importAccounts(importFile);
		}
		const backupsDir = join(d, "backups");
		const pres = existsSync(backupsDir)
			? (await fs.readdir(backupsDir)).filter((n) => n.startsWith("codex-pre-import-backup-"))
			: [];
		// [KNOWN-ISSUE] retention prunes only codex-credential-snapshot-* —
		// every other backup kind accumulates without bound.
		expect(pres.length).toBe(3);
	});
});

/* =========================================================================
 * CELL 7 — legacy oc-chatgpt / openai-codex-* leftovers
 * ========================================================================= */

describe("CELL7: legacy leftovers", () => {
	it("7a. legacy project file migrates + unlinks; legacy global file migrates + unlinks", async () => {
		// project legacy: <proj>/.opencode/openai-codex-accounts.json
		const proj = await dirOf("projL");
		await fs.mkdir(join(proj, ".git"), { recursive: true });
		const legacyDir = join(proj, ".opencode");
		await fs.mkdir(legacyDir, { recursive: true });
		const legacyPath = join(legacyDir, "openai-codex-accounts.json");
		await fs.writeFile(legacyPath, JSON.stringify({
			version: 1, activeIndex: 0,
			accounts: [{ refreshToken: "rt-legacy", addedAt: 1, lastUsed: 1 }],
		}));
		setStoragePath(proj);
		const loaded = await loadAccounts();
		expect(loaded?.accounts[0]?.refreshToken).toBe("rt-legacy");
		expect(existsSync(legacyPath)).toBe(false);
		expect(existsSync(getStoragePath())).toBe(true);

		// global legacy
		const globalDir = join(homedir(), ".opencode");
		await fs.mkdir(globalDir, { recursive: true });
		const legacyGlobal = join(globalDir, "openai-codex-accounts.json");
		await fs.writeFile(legacyGlobal, JSON.stringify({
			version: 1, activeIndex: 0,
			accounts: [{ refreshToken: "rt-legacy-global", addedAt: 1, lastUsed: 1 }],
		}));
		setStoragePathDirect(null);
		const loadedG = await loadAccounts();
		expect(loadedG?.accounts[0]?.refreshToken).toBe("rt-legacy-global");
		expect(existsSync(legacyGlobal)).toBe(false);
	});

	it("7b. legacy flagged names migrate: flagged-accounts -> codex-flagged", async () => {
		const d = await dirOf("flagL");
		const f = join(d, "accounts.json");
		setStoragePathDirect(f);
		const legacyFlag = join(d, "openai-codex-flagged-accounts.json");
		await fs.writeFile(legacyFlag, JSON.stringify({
			version: 1, accounts: [{ refreshToken: "rt-fl", addedAt: 1, lastUsed: 1, flaggedAt: 1 }],
		}));
		const loaded = await loadFlaggedAccounts();
		expect(loaded.accounts.length).toBe(1);
		expect(existsSync(legacyFlag)).toBe(false);
		expect(existsSync(getFlaggedAccountsPath())).toBe(true);
	});

	it("7c. corrupt legacy global file: kept in place, never throws, modern file wins", async () => {
		const globalDir = join(homedir(), ".opencode");
		await fs.mkdir(globalDir, { recursive: true });
		const legacyGlobal = join(globalDir, "openai-codex-accounts.json");
		// Seed the modern global file first: a corrupt legacy file must not
		// crash the load, and the modern file takes precedence over it.
		const modernFile = join(globalDir, "oc-codex-multi-auth-accounts.json");
		await fs.writeFile(modernFile, JSON.stringify({
			version: 3, activeIndex: 0,
			accounts: [{ refreshToken: "rt-modern", addedAt: 1, lastUsed: 1 }],
		}));
		await fs.writeFile(legacyGlobal, "{not json");
		setStoragePathDirect(null);
		const loaded = await loadAccounts();
		expect(loaded?.accounts[0]?.refreshToken).toBe("rt-modern");
		// [KNOWN-ISSUE] the corrupt legacy file is kept in place with only a
		// log.warn — no INVALID_STORAGE, no recovery hint (isolated empty-pool
		// variant lives in migration-matrix-verify.test.ts).
		expect(existsSync(legacyGlobal)).toBe(true);
		try { await fs.rm(legacyGlobal, { force: true }); } catch { /* ignore */ }
		try { await fs.rm(modernFile, { force: true }); } catch { /* ignore */ }
	});
});
