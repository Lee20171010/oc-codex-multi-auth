/// <reference lib="es2022.array" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression coverage for standalone-CLI hardening: the $HOME project-root
// boundary, keychain-migrated pools, schema parity with the runtime, BOM
// handling, special-file guards, stdout/stderr discipline, the diag --json
// contract, option-value parsing, and warm error masking.

vi.mock("../scripts/install-oc-codex-multi-auth-core.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../scripts/install-oc-codex-multi-auth-core.js")>();
	return { ...actual, runInstaller: async (...args: Parameters<typeof actual.runInstaller>) => {
		const [argv, options] = args;
		return actual.runInstaller(argv, {
			loadWarmRuntime: async () => {
				const [storageMod, usageMod, warmReqMod, warmMod, recoveryMod, loggerMod] = await Promise.all([
					import("../lib/storage.js"), import("../lib/codex-usage.js"), import("../lib/accounts/warm-request.js"),
					import("../lib/accounts/warm.js"), import("../lib/accounts/warm-recovery.js"), import("../lib/logger.js"),
				]);
				return { storageMod, usageMod, warmReqMod, warmMod, recoveryMod, loggerMod };
			},
			loadLimitsRuntime: async () => {
				const [
					storageMod, usageMod, loggerMod, configMod, planMod, planTierMod,
					quotaCacheMod, quotaOverviewMod, themeMod,
				] = await Promise.all([
					import("../lib/storage.js"), import("../lib/codex-usage.js"), import("../lib/logger.js"),
					import("../lib/config.js"), import("../lib/plan-allotment.js"), import("../lib/auth/plan-tier.js"),
					import("../lib/tui-quota-cache.js"), import("../lib/tui-quota-overview.js"), import("../lib/ui/theme.js"),
				]);
				return {
					storageMod, usageMod, loggerMod, configMod, planMod, planTierMod,
					quotaCacheMod, quotaOverviewMod, themeMod,
				};
			},
			...options,
		});
	} };
});

async function createTempHome() {
	return realpathSync(await mkdtemp(join(tmpdir(), "oc-codex-standalone-hard-")));
}

async function seedPool(home: string, accounts: unknown[]) {
	const opencodeDir = join(home, ".opencode");
	await mkdir(opencodeDir, { recursive: true });
	await writeFile(
		join(opencodeDir, "oc-codex-multi-auth-accounts.json"),
		JSON.stringify({ version: 3, activeIndex: 0, accounts }, null, 2),
		"utf-8",
	);
}

async function makeFifo(path: string) {
	const { execFileSync } = await import("node:child_process");
	execFileSync("mkfifo", [path]);
}

const PER_PROJECT_ENV = "CODEX_AUTH_PER_PROJECT_ACCOUNTS";

const VALID_V3 = JSON.stringify({
	version: 3,
	activeIndex: 0,
	accounts: [
		{ accountId: "acct1234567890", email: "user-one@example.com", refreshToken: "rt-1", accountLabel: "Main" },
	],
});

describe("standalone CLI hardening (fuzz corpus regressions)", () => {
	let tempHome: string | null = null;
	let previousPerProject: string | undefined;

	beforeEach(() => {
		previousPerProject = process.env[PER_PROJECT_ENV];
		process.env[PER_PROJECT_ENV] = "0";
	});

	afterEach(async () => {
		if (previousPerProject === undefined) delete process.env[PER_PROJECT_ENV];
		else process.env[PER_PROJECT_ENV] = previousPerProject;
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		if (tempHome) {
			await rm(tempHome, { recursive: true, force: true });
			tempHome = null;
		}
	});

	it("status run anywhere under $HOME resolves the global pool, not a phantom project root", async () => {
		// ~/.opencode is the global state dir; counting it as a project marker
		// would park every account under `projects/<home-key>/` instead.
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		await seedPool(tempHome, [
			{ accountId: "acct1234567890", email: "user-one@example.com", refreshToken: "rt-1" },
		]);
		const nested = join(tempHome, "work", "notes");
		await mkdir(nested, { recursive: true });
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		const result = await runInstaller(["status", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, [PER_PROJECT_ENV]: "1" },
			projectDir: nested,
		});

		expect(result).toMatchObject({ exitCode: 0, storageScope: "global" });
		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).totalAccounts).toBe(1);
	});

	it("still resolves a real project root below $HOME", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const projDir = join(tempHome, "myproj");
		await mkdir(join(projDir, ".git"), { recursive: true });
		const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const key = __test.getStandaloneProjectStorageKey(projDir);
		await mkdir(join(tempHome, ".opencode", "projects", key), { recursive: true });
		await writeFile(
			join(tempHome, ".opencode", "projects", key, "oc-codex-multi-auth-accounts.json"),
			VALID_V3,
			"utf-8",
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		const result = await runInstaller(["status", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, [PER_PROJECT_ENV]: "1" },
			projectDir: projDir,
		});

		expect(result).toMatchObject({ exitCode: 0, storageScope: "project" });
		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).totalAccounts).toBe(1);
	});

	it("a keychain-migrated pool reports an error instead of 'No accounts configured'", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const opencodeDir = join(tempHome, ".opencode");
		await mkdir(opencodeDir, { recursive: true });
		// codex-keychain migrate renamed the live file to this sibling backup.
		await writeFile(
			join(opencodeDir, "oc-codex-multi-auth-accounts.json.migrated-to-keychain.20260101000000"),
			VALID_V3,
			"utf-8",
		);
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		for (const command of ["status", "list", "doctor", "health"]) {
			const result = await runInstaller([command, "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			});
			expect(result.exitCode, command).toBe(1);
		}
		const status = await runInstaller(["status", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});
		expect(status.exitCode).toBe(1);
	});

	it("an explicitly selected migrated backup reads for status but mutating commands refuse", async () => {
		// Read-only inspection of a named rollback artifact is legitimate; the
		// file is a valid frozen V3 copy. doctor --fix/warm/limits must never
		// treat it as writable live storage.
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const migrated = join(tempHome, "accounts.migrated-to-keychain.20260101000000.json");
		await writeFile(migrated, VALID_V3, "utf-8");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const env = { ...process.env, HOME: tempHome, USERPROFILE: tempHome };

		const status = await runInstaller(["status", "--config-path", migrated, "--json"], { env });
		expect(status.exitCode).toBe(0);
		const statusOut = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(statusOut.totalAccounts).toBe(1);
		expect(statusOut.warning).toMatch(/keychain-migration backup/);

		for (const args of [
			["doctor", "--fix", "--config-path", migrated, "--json"],
			["warm", "--config-path", migrated, "--json"],
			["limits", "--config-path", migrated, "--json"],
		]) {
			const result = await runInstaller(args, { env });
			expect(result.exitCode, args.join(" ")).toBe(1);
			const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
			expect(output.error).toMatch(/keychain-migration backup/);
		}
	});

	it("a migrated sibling's message points at rollback, not at an empty pool", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const opencodeDir = join(tempHome, ".opencode");
		await mkdir(opencodeDir, { recursive: true });
		await writeFile(
			join(opencodeDir, "oc-codex-multi-auth-accounts.json.migrated-to-keychain.9"),
			VALID_V3,
			"utf-8",
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		const result = await runInstaller(["status", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		expect(result.exitCode).toBe(1);
		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.error).toContain("migrated-to-keychain");
		expect(output.error).toMatch(/keychain/);
		expect(output.totalAccounts).toBe(0);
	});

	it.each([
		["v2 rejected like the runtime", JSON.stringify({ version: 2, accounts: [{ refreshToken: "r" }] }), /version 2|schema/i],
		["v4 forward-compat", JSON.stringify({ version: 4, accounts: [] }), /version 4/],
		["string version", JSON.stringify({ version: "3", accounts: [] }), /schema version/i],
		["absent version", JSON.stringify({ accounts: [] }), /schema version/i],
		["fractional version", JSON.stringify({ version: 3.5, accounts: [] }), /schema version/i],
	])("storage schema parity: %s", async (_name, contents, pattern) => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const opencodeDir = join(tempHome, ".opencode");
		await mkdir(opencodeDir, { recursive: true });
		await writeFile(join(opencodeDir, "oc-codex-multi-auth-accounts.json"), contents, "utf-8");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		const result = await runInstaller(["status", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		expect(result.exitCode).toBe(1);
		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).error).toMatch(pattern);
	});

	it("storage errors carry snapshot/doctor remediation guidance", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const opencodeDir = join(tempHome, ".opencode");
		await mkdir(opencodeDir, { recursive: true });
		await writeFile(join(opencodeDir, "oc-codex-multi-auth-accounts.json"), "{ broken", "utf-8");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		const result = await runInstaller(["status", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		expect(result.exitCode).toBe(1);
		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.error).toMatch(/codex-credential-snapshot|backups\//);
		expect(output.error).toMatch(/doctor --fix|codex-doctor/);
	});

	it("a BOM-prefixed accounts file reads exactly like the runtime accepts it", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const opencodeDir = join(tempHome, ".opencode");
		await mkdir(opencodeDir, { recursive: true });
		await writeFile(
			join(opencodeDir, "oc-codex-multi-auth-accounts.json"),
			`﻿${VALID_V3}`,
			"utf-8",
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		const result = await runInstaller(["status", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).totalAccounts).toBe(1);
	});

	it("a FIFO accounts file fails fast instead of hanging the read", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const opencodeDir = join(tempHome, ".opencode");
		await mkdir(opencodeDir, { recursive: true });
		await makeFifo(join(opencodeDir, "oc-codex-multi-auth-accounts.json"));
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		const started = Date.now();
		const result = await runInstaller(["status", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		expect(Date.now() - started).toBeLessThan(5000);
		expect(result.exitCode).toBe(1);
	});

	it("text-mode failures write Error:/Repair failed:/Flagged pool error: to stderr only", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const opencodeDir = join(tempHome, ".opencode");
		await mkdir(opencodeDir, { recursive: true });
		await writeFile(join(opencodeDir, "oc-codex-multi-auth-accounts.json"), "{ broken", "utf-8");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		const result = await runInstaller(["status"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		expect(result.exitCode).toBe(1);
		const stdout = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
		const stderr = errSpy.mock.calls.map((call) => String(call[0])).join("\n");
		expect(stdout).not.toMatch(/Error:|Repair failed:|Flagged pool error:/);
		expect(stderr).toMatch(/Error:/);
	});

	it("diag --json reports command:\"diag\", not doctor", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		await seedPool(tempHome, []);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		const result = await runInstaller(["diag", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		expect(result.exitCode).toBe(0);
		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.command).toBe("diag");
		expect(output.deep).toBe(true);
	});

	it("an argument-parse failure under --json sends usage to stderr, keeping stdout clean", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["status", "--json", "--bogus"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).rejects.toThrow(/Unknown option/);

		const stdout = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
		const stderr = errSpy.mock.calls.map((call) => String(call[0])).join("\n");
		expect(stdout).not.toContain("Usage:");
		expect(stderr).toContain("Usage:");
	});

	it.each([
		[["status", "--config-path"], /--config-path/],
		[["status", "--config-path", "--json"], /--config-path/],
		[["status", "--tag"], /--tag/],
		[["status", "--sort"], /--sort/],
	])("a flag that requires a value errors clearly: %s", async (args, pattern) => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(args, {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).rejects.toThrow(pattern);
	});

	it("--config-path \"\" is refused rather than resolving the default pool", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["status", "--config-path", "", "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).rejects.toThrow(/--config-path/);
	});

	it("warm masks refresh-error bodies like limits does", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		await seedPool(tempHome, [
			{
				accountId: "acct1234567890",
				email: "warm-user@example.com",
				refreshToken: "rt-leak-candidate",
				accountLabel: "Warm",
			},
		]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		const leakedBody = "upstream said refresh_token=rt-leak-candidate for warm-user@example.com";
		const result = await runInstaller(["warm", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			loadWarmRuntime: async () => {
				const loggerMod = await import("../lib/logger.js");
				return {
					storageMod: {
						setStoragePathDirect: vi.fn(),
						setStoragePath: vi.fn(),
						loadAccounts: async () => ({
							version: 3,
							activeIndex: 0,
							accounts: [
								{
									accountId: "acct1234567890",
									email: "warm-user@example.com",
									refreshToken: "rt-leak-candidate",
								},
							],
						}),
					},
					usageMod: {
						ensureCodexUsageAccessToken: async () => {
							throw new Error(leakedBody);
						},
						resolveCodexUsageAccountId: vi.fn(),
					},
					warmReqMod: { warmAccountWindow: vi.fn() },
					warmMod: {
						warmAccounts: async (
							accounts: unknown[],
							warmOne: (account: unknown) => Promise<{ status: string; detail?: string }>,
						) => {
							const results = [];
							for (let index = 0; index < accounts.length; index += 1) {
								try {
									results.push({ index, ...(await warmOne(accounts[index])) });
								} catch (error) {
									results.push({
										index,
										status: "failed",
										detail: error instanceof Error ? error.message : String(error),
									});
								}
							}
							return {
								total: accounts.length,
								warmedCount: 0,
								failedCount: 1,
								skippedCount: 0,
								results,
							};
						},
					},
					shutdownMod: { setShutdownOwnsProcess: vi.fn() },
					recoveryMod: { recoverWarmedAccount: vi.fn() },
					loggerMod,
				};
			},
		});

		expect(result.exitCode).toBe(1);
		const raw = JSON.stringify(logSpy.mock.calls);
		expect(raw).not.toContain("rt-leak-candidate");
		expect(raw).not.toContain("warm-user@example.com");
	});
});
