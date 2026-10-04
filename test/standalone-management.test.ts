import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runInstaller } from "../scripts/install-oc-codex-multi-auth-core.js";
import * as storageMod from "../lib/storage.js";
import * as managementMod from "../lib/standalone-management.js";
import * as refreshMod from "../lib/tools/refresh-account.js";
import { repairDoctorAccounts } from "../lib/tools/doctor-repair.js";
import { MODEL_FAMILIES } from "../lib/prompts/codex.js";
import { getTuiQuotaCachePath, getTuiQuotaOverviewCachePath, TUI_QUOTA_OVERVIEW_CACHE_FILE } from "../lib/tui-quota-cache.js";
import type { AccountStorageV3 } from "../lib/storage.js";

const testHome = vi.hoisted(() => `/tmp/oc-managed-cli-${process.pid}-${Date.now()}`);
vi.mock("node:os", async () => ({ ...await vi.importActual<typeof import("node:os")>("node:os"), homedir: () => testHome }));

describe("standalone account management", () => {
	let home: string;
	let path: string;
	let output: ReturnType<typeof vi.spyOn>;
	beforeEach(async () => {
		home = testHome;
		await mkdir(home, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("OPENCODE_STATE_DIR", join(home, "state"));
		vi.stubEnv("CODEX_KEYCHAIN", "0");
		vi.stubEnv("CODEX_AUTH_PER_PROJECT_ACCOUNTS", "1");
		await mkdir(join(home, ".opencode"));
		path = join(home, ".opencode", "oc-codex-multi-auth-accounts.json");
		await writeFile(path, JSON.stringify({ version: 3, activeIndex: 0, accounts: [1, 2].map((n) => ({
			accountId: `FAKE_ACCOUNT_${n}`, refreshToken: `FAKE_REFRESH_${n}`,
			accessToken: `FAKE_ACCESS_${n}`, addedAt: 1, lastUsed: 1,
			rateLimitResetTimes: { codex: Date.now() + 100000 },
		})) }));
		storageMod.setStoragePathDirect(path);
		output = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(async () => {
		storageMod.setStoragePathDirect(null);
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(home, { recursive: true, force: true });
	});
	const pool = async (): Promise<AccountStorageV3> => JSON.parse(await readFile(path, "utf8"));
	it("prints account numbers matching mutation inputs while preserving legacy JSON offsets", async () => {
		await runInstaller(["list"], { projectDir: home });
		expect(output.mock.calls.map(([line]) => line).join("\n")).toContain("- [1] Account 1");
		const { payload } = await run(["list"]);
		expect(payload.activeIndex).toBe(0);
		expect(payload.activeAccountNumber).toBe(1);
		expect(payload.accounts.map((a: { index: number; accountNumber: number }) => [a.index, a.accountNumber])).toEqual([[0, 1], [1, 2]]);
	});
	async function run(args: string[], projectDir = home) {
		output.mockClear();
		const result = await runInstaller([...args, "--json"], {
			projectDir,
			loadManagementRuntime: async () => [storageMod, managementMod, { setShutdownOwnsProcess: () => {} }],
		});
		const last = output.mock.calls.at(-1)?.[0];
		return { result, payload: typeof last === "string" ? JSON.parse(last) : null };
	}

	it("switches all model families without changing credentials or existing cooldown data", async () => {
		const before = await pool();
		const { result, payload } = await run(["switch", "2"]);
		expect(result.exitCode).toBe(0);
		expect(payload).toMatchObject({ ok: true, index: 2, activeIndex: 2, restartRequired: false });
		const after = await pool();
		expect(after.activeIndex).toBe(1);
		for (const family of MODEL_FAMILIES) expect(after.activeIndexByFamily?.[family]).toBe(1);
		expect(after.accounts[1].refreshToken).toBe(before.accounts[1].refreshToken);
		expect(after.accounts[1].rateLimitResetTimes).toEqual(before.accounts[1].rateLimitResetTimes);
		expect(JSON.stringify(payload)).not.toMatch(/FAKE_REFRESH|FAKE_ACCESS/);
	});

	it("sets and clears labels, normalized tags and notes through the shared transactions", async () => {
		expect((await run(["label", "2", "Work\x1b[8m"])).result.exitCode).toBe(0);
		expect((await run(["tag", "2", "Work,work, PRIMARY"])).result.exitCode).toBe(0);
		expect((await run(["note", "2", " weekday primary "])).result.exitCode).toBe(0);
		expect((await pool()).accounts[1]).toMatchObject({ accountLabel: "Work", accountTags: ["work", "primary"], accountNote: "weekday primary" });
		for (const command of ["label", "tag", "note"]) expect((await run([command, "2", ""])).result.exitCode).toBe(0);
		const record = (await pool()).accounts[1];
		expect(record.accountLabel).toBeUndefined();
		expect(record.accountTags).toBeUndefined();
		expect(record.accountNote).toBeUndefined();
	});
	it.each(["tag", "note"])("preserves quota snapshots when changing %s", async (command) => {
		const ownedOverview = join(home, ".opencode", TUI_QUOTA_OVERVIEW_CACHE_FILE);
		const cachePaths = [getTuiQuotaCachePath(), getTuiQuotaOverviewCachePath(), ownedOverview];
		await mkdir(join(home, "state"));
		for (const cache of cachePaths) await writeFile(cache, "FAKE_KNOWN_QUOTA");
		await writeFile(`${ownedOverview}.invalidated`, "FAKE_EXISTING_GENERATION");
		expect((await run([command, "2", "work"])).result.exitCode).toBe(0);
		for (const cache of cachePaths) expect(await readFile(cache, "utf8")).toBe("FAKE_KNOWN_QUOTA");
		expect(await readFile(`${ownedOverview}.invalidated`, "utf8")).toBe("FAKE_EXISTING_GENERATION");
	});
	it.each([["switch", "2"], ["label", "2", "Work"]])("invalidates quota display snapshots for %s", async (...args) => {
		const ownedOverview = join(home, ".opencode", TUI_QUOTA_OVERVIEW_CACHE_FILE);
		await writeFile(ownedOverview, "FAKE_OLD_DISPLAY");
		expect((await run(args)).result.exitCode).toBe(0);
		await expect(readFile(ownedOverview)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(`${ownedOverview}.invalidated`, "utf8")).not.toBe("");
	});

	it.each(["0", "-1", "1.5", "999", "Infinity"])("refuses invalid account %s without changing the pool", async (index) => {
		const before = await readFile(path, "utf8");
		const { result, payload } = await run(["switch", index]);
		expect(result.exitCode).toBe(1);
		expect(payload.ok).toBe(false);
		expect(await readFile(path, "utf8")).toBe(before);
	});

	it("refuses over-limit metadata and a migrated backup selection", async () => {
		const before = await readFile(path, "utf8");
		expect((await run(["label", "1", "a".repeat(61)])).result.exitCode).toBe(1);
		expect((await run(["note", "1", "a".repeat(241)])).result.exitCode).toBe(1);
		const backup = `${path}.migrated-to-keychain.1`;
		await writeFile(backup, before);
		expect((await run(["switch", "2", "--config-path", backup])).result.exitCode).toBe(1);
		expect(await readFile(backup, "utf8")).toBe(before);
		expect(await readFile(path, "utf8")).toBe(before);
	});

	it("reports persistence failure with a nonzero exit instead of a success", async () => {
		const before = await readFile(path, "utf8");
		vi.spyOn(storageMod, "withAccountStorageTransaction").mockImplementationOnce(async (operation) =>
			operation(await pool(), () => { throw new Error("FAKE_WRITE_FAILURE"); }));
		const { result, payload } = await run(["switch", "2"]);
		expect(result.exitCode).toBe(1);
		expect(payload).toMatchObject({ ok: false, message: expect.stringContaining("No change was persisted") });
		expect(await readFile(path, "utf8")).toBe(before);
	});

	it("uses the project pool unless an account file is explicitly selected", async () => {
		const project = join(home, "project");
		await mkdir(project);
		await writeFile(join(project, "package.json"), "{}");
		await writeFile(join(home, ".opencode", "openai-codex-auth-config.json"), JSON.stringify({ perProjectAccounts: true }));
		const empty = await run(["switch", "2"], project);
		expect(empty.result.exitCode).toBe(1);
		expect((await pool()).activeIndex).toBe(0);
		storageMod.setStoragePath(project);
		const projectPath = storageMod.getStoragePath();
		await mkdir(join(projectPath, ".."), { recursive: true });
		await writeFile(projectPath, await readFile(path, "utf8"));
		const first = await run(["switch", "2"], project);
		expect(first.result.exitCode, JSON.stringify(first.payload)).toBe(0);
		expect(first.payload.storageScope).toBe("project");
		expect((await pool()).activeIndex).toBe(0);
		expect(JSON.parse(await readFile(first.payload.storagePath, "utf8")).activeIndex).toBe(1);
		const explicit = await run(["switch", "2", "--config-path", path], project);
		expect(explicit.payload.storageScope).toBe("explicit");
		expect((await pool()).activeIndex).toBe(1);
	});

	it("manages model pools with stable identities, mode changes and dry-run preservation", async () => {
		const configPath = join(home, ".opencode", "openai-codex-auth-config.json");
		expect((await run(["pool", "set", "gpt-6.1-sol", "1,2"])).result.exitCode).toBe(0);
		let config = JSON.parse(await readFile(configPath, "utf8"));
		expect(config.modelAccountPools["gpt-6.1-sol"]).toEqual(["FAKE_ACCOUNT_1", "FAKE_ACCOUNT_2"]);
		expect((await run(["pool", "set-mode", "gpt-6.1-sol", "strict"])).payload.pool.poolMode).toBe("strict");
		const status = await run(["pool", "status", "gpt-6.1-sol"]);
		expect(status.payload.pools[0]).toMatchObject({ poolMode: "strict", configuredCount: 2 });
		expect(JSON.stringify(status.payload)).not.toContain("FAKE_ACCOUNT");
		const before = await readFile(configPath, "utf8");
		expect((await run(["pool", "remove", "gpt-6.1-sol", "1", "--dry-run"])).result.exitCode).toBe(0);
		expect(await readFile(configPath, "utf8")).toBe(before);
		expect((await run(["pool", "remove", "gpt-6.1-sol", "1"])).result.exitCode).toBe(0);
		config = JSON.parse(await readFile(configPath, "utf8"));
		expect(config.modelAccountPools["gpt-6.1-sol"]).toEqual(["FAKE_ACCOUNT_2"]);
		expect((await run(["pool", "add", "gpt-6.1-sol", "1"])).result.exitCode).toBe(0);
		expect((await run(["pool", "clear", "gpt-6.1-sol"])).result.exitCode).toBe(0);
		expect((await run(["pool", "status"])).payload.pools).toEqual([]);
	});

	it("preserves a newer quota block written during doctor credential verification", async () => {
		const original = await pool();
		original.accounts[0].quotaExhaustedUntil = Date.now() + 60000;
		original.accounts[0].quotaExhaustedStampAt = 10;
		await writeFile(path, JSON.stringify(original));
		vi.spyOn(refreshMod, "refreshAndPersistAccount").mockImplementation(async (input) => {
			if (input.index === 0) {
				await storageMod.withAccountStorageTransaction(async (current, persist) => {
					if (!current) throw new Error("Missing fake pool");
					current.accounts[0].quotaExhaustedStampAt = 20;
					await persist(current);
				});
			}
			return { status: "refreshed", index: input.index, result: { index: input.index, identity: input.identity,
				refreshToken: input.identity.refreshToken, accessToken: "FAKE_ACCESS", expiresAt: Date.now() + 60000, persisted: true } };
		});
		await repairDoctorAccounts(original.accounts);
		expect((await pool()).accounts[0]).toMatchObject({ quotaExhaustedUntil: original.accounts[0].quotaExhaustedUntil, quotaExhaustedStampAt: 20 });
	});

	it("doctor repair clears both old quota displays only after successful credential verification", async () => {
		const ownedOverview = join(home, ".opencode", TUI_QUOTA_OVERVIEW_CACHE_FILE);
		const cachePaths = [getTuiQuotaCachePath(), getTuiQuotaOverviewCachePath(), ownedOverview];
		await mkdir(join(home, "state"));
		for (const cache of cachePaths) await writeFile(cache, "FAKE_OLD_QUOTA_TIME");
		const before = await pool();
		vi.spyOn(refreshMod, "refreshAndPersistAccount").mockImplementation(async (input) => ({
			status: "refreshed", index: input.index, result: { index: input.index, identity: input.identity,
				refreshToken: input.identity.refreshToken, accessToken: "FAKE_ACCESS", expiresAt: Date.now() + 60000, persisted: true },
		}));
		const result = await repairDoctorAccounts(before.accounts);
		expect(result.fixErrors).toEqual([]);
		expect(result.appliedFixes).toContain("Cleared stale account and pool quota caches.");
		for (const cache of cachePaths) await expect(readFile(cache)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(`${ownedOverview}.invalidated`, "utf8")).not.toBe("");
		expect((await pool()).accounts.every((a) => Object.keys(a.rateLimitResetTimes ?? {}).length === 0)).toBe(true);
		for (const cache of cachePaths) await writeFile(cache, "FAKE_KNOWN_QUOTA");
		vi.mocked(refreshMod.refreshAndPersistAccount).mockImplementation(async (input) => ({
			status: "failed", index: input.index, identity: input.identity, error: "FAKE_401",
		}));
		const failed = await repairDoctorAccounts((await pool()).accounts);
		expect(failed.refreshedCount).toBe(0);
		for (const cache of cachePaths) expect(await readFile(cache, "utf8")).toBe("FAKE_KNOWN_QUOTA");
	});
});
