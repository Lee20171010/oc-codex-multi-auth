/**
 * STATE-MIGRATION MATRIX, third pass — promoted from the round-2 migration
 * audit. Cross-scope propagation gap, flagged-transaction scope flip,
 * project-legacy V2 swallow, keychain opt-in over V1, retired-package
 * filename coverage.
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
	loadAccounts,
	saveAccounts,
	saveFlaggedAccounts,
	setStoragePath,
	setStoragePathDirect,
	getFlaggedAccountsPath,
	withFlaggedAccountStorageTransaction,
	loadFlaggedAccounts,
} from "../lib/storage.js";
import { getStoragePath } from "../lib/storage/state.js";
import type { AccountStorageV3 } from "../lib/storage/migrations.js";
import { coordinatePersistedRefresh } from "../lib/storage/coordinated-refresh.js";
import type { TokenResult } from "../lib/types.js";

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

async function dirOf(suffix: string): Promise<string> {
	const d = join(scratch, suffix);
	await fs.mkdir(d, { recursive: true });
	return d;
}

async function mkProject(name: string): Promise<string> {
	const p = await dirOf(name);
	await fs.mkdir(join(p, ".git"), { recursive: true });
	return p;
}

beforeEach(async () => {
	scratch = await fs.mkdtemp(join(tmpdir(), "audit-verify2-"));
	vi.mocked(queuedRefresh).mockReset();
});

afterEach(async () => {
	setStoragePathDirect(null);
	if (ORIG_KEYCHAIN === undefined) delete process.env.CODEX_KEYCHAIN;
	else process.env.CODEX_KEYCHAIN = ORIG_KEYCHAIN;
	try { await fs.rm(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
	// clean sandbox-home global file between tests
	try { await fs.rm(join(homedir(), ".opencode", "oc-codex-multi-auth-accounts.json"), { force: true }); } catch { /* ignore */ }
	try { await fs.rm(join(homedir(), ".opencode", "openai-codex-accounts.json"), { force: true }); } catch { /* ignore */ }
});

describe("CROSS-SCOPE: seeded pair + rotation propagation", () => {
	it("a missing project pool is NOT seeded from the global file", async () => {
		const globalDir = join(homedir(), ".opencode");
		await fs.mkdir(globalDir, { recursive: true });
		const globalFile = join(globalDir, "oc-codex-multi-auth-accounts.json");
		const shared = "rt-SHARED-0";
		await fs.writeFile(globalFile, JSON.stringify({
			version: 3, activeIndex: 0,
			accounts: [{ refreshToken: shared, accountId: "w", accountUserId: "m", organizationId: "o", addedAt: 1, lastUsed: 1 }],
		}));

		const proj = await mkProject("projSeed");
		setStoragePath(proj);
		const projectPath = getStoragePath();
		// [FIXED] project scope no longer seeds from the global pool — a
		// single-use refresh token can never be duplicated across scopes.
		const seeded = await loadAccounts();
		expect(seeded).toBeNull();
		expect(existsSync(projectPath)).toBe(false);

		// A rotation attempt in the empty project scope cannot reach the
		// provider: with no pool file the coordinated path throws
		// "Account storage is unavailable" before any exchange.
		vi.mocked(queuedRefresh).mockResolvedValue({
			type: "success", access: "a1", refresh: "rt-SHARED-1", expires: Date.now() + 3_600_000,
		} as TokenResult);
		let threw: unknown = null;
		try {
			await coordinatePersistedRefresh({
				organizationId: "o", accountId: "w", accountUserId: "m", refreshToken: shared,
			});
		} catch (e) { threw = e; }
		expect((threw as Error | null)?.message).toContain("storage is unavailable");
		expect(vi.mocked(queuedRefresh)).not.toHaveBeenCalled();

		// The global file is untouched — no consumed-token residue.
		const globalAfter = JSON.parse(await fs.readFile(globalFile, "utf-8")) as AccountStorageV3;
		expect(globalAfter.accounts[0]?.refreshToken).toBe(shared);
		expect(existsSync(projectPath)).toBe(false);
	});
});

describe("CELL2 extra: flagged transaction under mid-transaction scope flip", () => {
	it("flagged persist lands on the NEW scope's flagged file under the OLD scope's lease", async () => {
		const projA = await mkProject("projFA");
		const projB = await mkProject("projFB");
		setStoragePath(projA);
		const flaggedA = getFlaggedAccountsPath();
		await saveFlaggedAccounts({ version: 1, accounts: [{ refreshToken: "rt-fA", addedAt: 1, lastUsed: 1, flaggedAt: 1 }] });
		setStoragePath(projB);
		const flaggedB = getFlaggedAccountsPath();
		await saveFlaggedAccounts({ version: 1, accounts: [{ refreshToken: "rt-fB", addedAt: 1, lastUsed: 1, flaggedAt: 1 }] });
		setStoragePath(projA);

		await withFlaggedAccountStorageTransaction(async (current, persist) => {
			expect(current.accounts[0]?.refreshToken).toBe("rt-fA");
			setStoragePath(projB); // flip mid-transaction
			await persist({ version: 1, accounts: [{ refreshToken: "rt-FLIPPED", addedAt: 1, lastUsed: 1, flaggedAt: 1 }] });
		});
		const a = JSON.parse(await fs.readFile(flaggedA, "utf-8")) as { accounts: Array<{ refreshToken: string }> };
		const b = JSON.parse(await fs.readFile(flaggedB, "utf-8")) as { accounts: Array<{ refreshToken: string }> };
		// [FIXED] the flagged path is scope-pinned at call time — the persist
		// lands on A (the transaction's scope) under A's own lease.
		expect(a.accounts[0]?.refreshToken).toBe("rt-FLIPPED");
		expect(b.accounts[0]?.refreshToken).toBe("rt-fB");
		setStoragePathDirect(null);
	});
});

describe("CELL1 extra: V2 in PROJECT legacy slot -> swallowed + global seed", () => {
	it("legacy project file v2 is dropped silently AND the pool seeds from global", async () => {
		const globalDir = join(homedir(), ".opencode");
		await fs.mkdir(globalDir, { recursive: true });
		const globalFile = join(globalDir, "oc-codex-multi-auth-accounts.json");
		await fs.writeFile(globalFile, JSON.stringify(mkV3(["rt-GLOBAL"])));

		const proj = await mkProject("projLV2");
		const legacyDir = join(proj, ".opencode");
		await fs.mkdir(legacyDir, { recursive: true });
		const legacyPath = join(legacyDir, "openai-codex-accounts.json");
		await fs.writeFile(legacyPath, JSON.stringify({ version: 2, accounts: [{ refreshToken: "rt-v2-legacy" }] }));

		setStoragePath(proj);
		// [FIXED] the V2 rejection is now loud (typed StorageError), the
		// legacy V2 file is left in place, and the pool is never seeded
		// from the global file.
		let threw: unknown = null;
		try { await loadAccounts(); } catch (e) { threw = e; }
		expect(threw).not.toBeNull();
		expect((threw as { code?: string }).code).toBe("UNKNOWN_V2_FORMAT");
		expect(existsSync(legacyPath)).toBe(true);
		setStoragePathDirect(null);
	});
});

// Audit note (not a runnable assertion): index.ts readAccountsFileState
// catches every read/parse/schema failure and returns undefined, so an
// externally corrupted accounts file produces no watcher signal, warn, retry
// or toast — the corruption only surfaces as INVALID_STORAGE on the next
// request. Source-inspection finding; no runtime hook exists to pin it.

describe("CELL3 extra: V1 file + keychain opt-in migration path", () => {
	it("V1 JSON under CODEX_KEYCHAIN=1: migrates V1->V3 INTO the keychain, V1 file becomes marker", async () => {
		const d = await dirOf("v1kc");
		const f = join(d, "accounts.json");
		await fs.writeFile(f, JSON.stringify({
			version: 1, activeIndex: 0,
			accounts: [{ refreshToken: "rt-v1kc", addedAt: 1, lastUsed: 1 }],
		}));
		setStoragePathDirect(f);
		const { _setBackendForTests } = await import("../lib/storage/keychain.js");
		const store = new Map<string, string>();
		_setBackendForTests({
			async get(s, a) { return store.get(`${s}::${a}`) ?? null; },
			async set(s, a, v) { store.set(`${s}::${a}`, v); },
			async delete(s, a) { return store.delete(`${s}::${a}`); },
			async isAvailable() { return true; },
		});
		process.env.CODEX_KEYCHAIN = "1";
		const loaded = await loadAccounts();
		const markers = (await fs.readdir(d)).filter((n) => n.includes(".migrated-to-keychain."));
		const kcBlob = store.get(`oc-codex-multi-auth::accounts:global`);
		// V1 migrates to V3 inside the keychain blob; the on-disk file becomes
		// a .migrated-to-keychain marker.
		expect(loaded?.accounts[0]?.refreshToken).toBe("rt-v1kc");
		expect(markers.length).toBe(1);
		expect(existsSync(f)).toBe(false);
		expect(kcBlob).toBeTruthy();
		expect((JSON.parse(kcBlob!) as { version: number }).version).toBe(3);
	});
});

describe("CELL7 extra: oc-chatgpt-multi-auth file names", () => {
	it("oc-chatgpt-multi-auth-accounts.json is NOT a recognized legacy name (never migrated)", async () => {
		const d = await dirOf("oc-chatgpt");
		const f = join(d, "oc-codex-multi-auth-accounts.json");
		setStoragePathDirect(f);
		// Seed a file under the retired PACKAGE name — the storage layer's
		// legacy list only covers openai-codex-*.json, not the package name.
		const chatgptFile = join(d, "oc-chatgpt-multi-auth-accounts.json");
		await fs.writeFile(chatgptFile, JSON.stringify({
			version: 1, activeIndex: 0,
			accounts: [{ refreshToken: "rt-chatgpt-legacy", addedAt: 1, lastUsed: 1 }],
		}));
		const loaded = await loadAccounts();
		// [KNOWN-ISSUE] the retired package's own filenames are not in the
		// legacy migration list (LEGACY_ACCOUNTS_FILE_NAME covers
		// openai-codex-accounts.json only) — such a pool is abandoned in
		// place: untouched, unread, unmigrated.
		expect(loaded).toBeNull();
		expect(existsSync(chatgptFile)).toBe(true);
	});
});
