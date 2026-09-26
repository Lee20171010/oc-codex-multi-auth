/// <reference lib="es2022.array" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../scripts/install-oc-codex-multi-auth-core.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../scripts/install-oc-codex-multi-auth-core.js")>();
	return { ...actual, runInstaller: async (...args: Parameters<typeof actual.runInstaller>) => {
		const [argv, options] = args;
		return actual.runInstaller(argv, {
			loadWarmRuntime: async () => {
				const [storageMod, usageMod, warmReqMod, warmMod, recoveryMod] = await Promise.all([
					import("../lib/storage.js"), import("../lib/codex-usage.js"), import("../lib/accounts/warm-request.js"),
					import("../lib/accounts/warm.js"), import("../lib/accounts/warm-recovery.js"),
				]);
				return { storageMod, usageMod, warmReqMod, warmMod, recoveryMod };
			},
			loadLimitsRuntime: async () => {
				const [storageMod, usageMod, loggerMod, configMod, planMod, planTierMod] = await Promise.all([
					import("../lib/storage.js"), import("../lib/codex-usage.js"), import("../lib/logger.js"),
					import("../lib/config.js"), import("../lib/plan-allotment.js"), import("../lib/auth/plan-tier.js"),
				]);
				return { storageMod, usageMod, loggerMod, configMod, planMod, planTierMod };
			},
			...options,
		});
	} };
});

// Exercise the shipped import boundary with source implementations, not stale dist.
async function loadSourceDoctorRuntime() {
	return Promise.all([
		import("../lib/storage.js"),
		import("../lib/tools/doctor-repair.js"),
		import("../lib/shutdown.js"),
	]);
}

async function createTempHome() {
	return mkdtemp(join(tmpdir(), "oc-codex-standalone-"));
}

// The identity group is the last `(…)` before the trailing `enabled=` flags.
// Slicing between the first `(` and the first `)` instead would grab
// `(role:owner)` out of any label that carries parentheses of its own.
function extractIdentity(line: string) {
	const head = line.slice(0, line.indexOf(" enabled="));
	const open = head.lastIndexOf("(");
	return open === -1 ? "" : head.slice(open);
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

const QUOTA_DISPLAY_ENV = "CODEX_AUTH_QUOTA_DISPLAY";

describe("standalone oc-codex-multi-auth CLI commands", () => {
	let tempHome: string | null = null;
	let previousQuotaDisplay: string | undefined;

	// These cases load the real `dist/lib/config.js`, whose config path is the
	// developer's own `~/.opencode`, not the temp home handed to `runInstaller`.
	// Pinning the env override - which outranks the file - keeps a machine that
	// has opted into `used` from failing every `% left` assertion below.
	beforeEach(() => {
		previousQuotaDisplay = process.env[QUOTA_DISPLAY_ENV];
		process.env[QUOTA_DISPLAY_ENV] = "free";
	});

	afterEach(async () => {
		if (previousQuotaDisplay === undefined) delete process.env[QUOTA_DISPLAY_ENV];
		else process.env[QUOTA_DISPLAY_ENV] = previousQuotaDisplay;
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		if (tempHome) {
			await rm(tempHome, { recursive: true, force: true });
			tempHome = null;
		}
	});

	it("runs status as JSON without installer writes", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		const opencodeDir = join(tempHome, ".opencode");
		await mkdir(opencodeDir, { recursive: true });
		await writeFile(
			join(opencodeDir, "oc-codex-multi-auth-accounts.json"),
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				accounts: [
					{
						accountLabel: "Personal",
						email: "user@example.com",
						accountId: "acct_123456789",
						accountIdSource: "token",
						refreshToken: "refresh-token",
						accessToken: "access-token",
						addedAt: Date.now(),
						lastUsed: Date.now(),
					},
				],
			}, null, 2),
			"utf-8",
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(runInstaller(["status", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		})).resolves.toMatchObject({ action: "status", exitCode: 0 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.totalAccounts).toBe(1);
		expect(output.accounts[0].email).toBe("user....com");
	});

	it("status: the masked id suffix reveals no more than the masked accountId beside it", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await seedPool(tempHome, [
			{
				email: "user@example.com",
				accountId: "acct_123456789",
				accountIdSource: "token",
				refreshToken: "refresh-token",
				addedAt: 1000,
				lastUsed: 2000,
			},
		]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(runInstaller(["status", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		})).resolves.toMatchObject({ exitCode: 0 });

		const account = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).accounts[0];
		expect(account.accountId).toBe("acct...6789");
		expect(account.idSuffix).toBe("6789");
	});

	it("status: --include-sensitive keeps the six-character id suffix the other surfaces print", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await seedPool(tempHome, [
			{
				email: "user@example.com",
				accountId: "acct_123456789",
				accountIdSource: "token",
				refreshToken: "refresh-token",
				addedAt: 1000,
				lastUsed: 2000,
			},
		]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(runInstaller(["status", "--json", "--include-sensitive"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		})).resolves.toMatchObject({ exitCode: 0 });

		const account = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).accounts[0];
		expect(account.accountId).toBe("acct_123456789");
		expect(account.idSuffix).toBe("456789");
	});

	it("list: the masked id suffix still separates two accounts that share an email", async () => {
		// A masked row must still say which account it is. One subscription can
		// hold several workspaces under a single email, so with no suffix at
		// all these two rows read identically.
		vi.resetModules();
		tempHome = await createTempHome();
		await seedPool(tempHome, [
			{
				email: "dup@example.com",
				accountId: "acct_0000000000aaaa",
				accountIdSource: "token",
				refreshToken: "refresh-a",
				addedAt: 1000,
				lastUsed: 2000,
			},
			{
				email: "dup@example.com",
				accountId: "acct_0000000000bbbb",
				accountIdSource: "token",
				refreshToken: "refresh-b",
				addedAt: 1000,
				lastUsed: 2000,
			},
		]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(runInstaller(["list"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		})).resolves.toMatchObject({ exitCode: 0 });

		const identities = logSpy.mock.calls
			.map((call) => String(call[0]))
			.filter((line) => line.startsWith("- ["))
			.map(extractIdentity);

		expect(identities).toHaveLength(2);
		expect(identities[0]).toBe("(dup@....com, id:aaaa)");
		expect(identities[1]).toBe("(dup@....com, id:bbbb)");
	});

	// This CLI keeps its own copy of the seat renderer, so it can drift from
	// `lib/account-display.ts` silently. The ids here are a SYNTHETIC
	// single-divergence shape - one distinguishing character, then the
	// workspace uuid - not what the backend issues; see the measured profile
	// below. No tail reaches a difference at the head, so a tail-based renderer
	// cannot separate them with fewer than all 39 characters.
	it("list: keeps the seat short for member ids that differ only at the head", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		const workspaceUuid = "05cd9f04-d56a-4256-9934-9cb827989a40";
		await seedPool(
			tempHome,
			["9", "X"].map((seat, position) => ({
				email: "shared@example.com",
				accountId: workspaceUuid,
				accountUserId: `${seat}__${workspaceUuid}`,
				accountIdSource: "token",
				refreshToken: `refresh-${position}`,
				addedAt: 1000,
				lastUsed: 2000,
			})),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(runInstaller(["list", "--include-sensitive"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		})).resolves.toMatchObject({ exitCode: 0 });

		const identities = logSpy.mock.calls
			.map((call) => String(call[0]))
			.filter((line) => line.startsWith("- ["))
			.map(extractIdentity);

		expect(identities).toHaveLength(2);
		// Matched exactly, not by prefix: the whole 39-character id starts with
		// the short rendering, so `toContain` would pass on the defect.
		const seats = identities.map((identity) => identity.match(/seat:([^,)]+)/)?.[1]);
		expect(seats).toEqual(["9__05c", "X__05c"]);
	});

	// The profile measured structurally against a real nine-seat Business pool:
	// 67-character ids, five shared leading characters, no shared tail, and
	// pairwise first divergences in clusters 26 characters apart. Asserted as
	// distinct and bounded rather than as a particular excerpt - which strategy
	// reaches it is an implementation detail, and pinning one is how the
	// fixture above came to encode a wrong reading of the data.
	it("list: keeps the seat distinct and bounded on the measured real-pool id shape", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		const workspaces = [
			"05cd9f04-d56a-4256-9934-9cb827989a40",
			"0ce0db3a-1111-2222-3333-444444ff8839",
			"15aaaaaa-2222-3333-4444-555555aa1111",
			"25bbbbbb-3333-4444-5555-666666bb2222",
			"35cccccc-4444-5555-6666-777777cc3333",
		];
		const pool: Array<[string, number]> = [
			["A", 0],
			["B", 0],
			["C", 0],
			["D", 0],
			["E", 1],
			["A", 1],
			["B", 2],
			["F", 3],
			["C", 4],
		];
		await seedPool(
			tempHome,
			pool.map(([head, workspaceIndex], position) => ({
				email: "shared@example.com",
				accountId: workspaces[workspaceIndex],
				accountUserId: `user_${head}0123456789abcdefghijklmno${workspaces[workspaceIndex]}`,
				accountIdSource: "token",
				refreshToken: `refresh-${position}`,
				addedAt: 1000,
				lastUsed: 2000,
			})),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(runInstaller(["list", "--include-sensitive"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		})).resolves.toMatchObject({ exitCode: 0 });

		const seats = logSpy.mock.calls
			.map((call) => String(call[0]))
			.filter((line) => line.startsWith("- ["))
			.map((line) => extractIdentity(line).match(/seat:([^,)]+)/)?.[1]);

		expect(seats).toHaveLength(9);
		expect(new Set(seats).size).toBe(9);
		for (const seat of seats) {
			expect(seat, String(seat)).toBeDefined();
			expect(String(seat).length, String(seat)).toBeLessThanOrEqual(32);
		}
		// Distinct and bounded is satisfied by a hash too, so it alone would not
		// notice this copy losing the joined-excerpt strategy the lib has. Every
		// piece has to be lifted from the id it names.
		pool.forEach(([head, workspaceIndex], position) => {
			const id = `user_${head}0123456789abcdefghijklmno${workspaces[workspaceIndex]}`;
			for (const piece of String(seats[position]).split("..")) {
				expect(piece.length, `"${piece}" of "${seats[position]}"`).toBeGreaterThan(0);
				expect(id, `"${piece}" of "${seats[position]}"`).toContain(piece);
			}
		});
	});

	// Two clusters of three adjacent divergences, 26 apart. At a two-character
	// window each cluster needs a window of its own and the join overflows the
	// cap; at three characters each cluster collapses into one window and the
	// join fits. A search that abandons the widths after the first overflow
	// prints a hash here, so this is where this copy would drift from the lib.
	it("list: excerpts clustered divergences rather than giving up on them", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		const base = "user_0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnop";
		const memberIds = [
			base,
			...[5, 6, 7, 31, 32, 33].map((at) => `${base.slice(0, at)}Z${base.slice(at + 1)}`),
		];
		await seedPool(
			tempHome,
			memberIds.map((accountUserId, position) => ({
				email: "shared@example.com",
				accountId: "05cd9f04-d56a-4256-9934-9cb827989a40",
				accountUserId,
				accountIdSource: "token",
				refreshToken: `refresh-${position}`,
				addedAt: 1000,
				lastUsed: 2000,
			})),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(runInstaller(["list", "--include-sensitive"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		})).resolves.toMatchObject({ exitCode: 0 });

		const seats = logSpy.mock.calls
			.map((call) => String(call[0]))
			.filter((line) => line.startsWith("- ["))
			.map((line) => extractIdentity(line).match(/seat:([^,)]+)/)?.[1]);

		expect(seats).toHaveLength(memberIds.length);
		expect(new Set(seats).size).toBe(memberIds.length);
		memberIds.forEach((id, position) => {
			const seat = String(seats[position]);
			expect(seat.length, seat).toBeLessThanOrEqual(32);
			for (const piece of seat.split("..")) {
				expect(piece.length, `"${piece}" of "${seat}"`).toBeGreaterThan(0);
				expect(id, `"${piece}" of "${seat}"`).toContain(piece);
			}
		});
	});

	it("list: drops the org-derived label the plugin no longer generates", async () => {
		// The standalone CLI reads the pool through its own normalizer, so
		// without a mirror of the drop it keeps printing the wrong
		// organization beside the very account id that label was misnaming.
		vi.resetModules();
		tempHome = await createTempHome();
		await seedPool(tempHome, [
			{
				email: "personal@example.com",
				accountId: "acct_9f21c487c4",
				accountLabel: "DreamHost API (role:owner) [id:c487c4]",
				accountIdSource: "token",
				refreshToken: "refresh-a",
				addedAt: 1000,
				lastUsed: 2000,
			},
			{
				// A name someone typed. The marker does not hold this
				// account's id suffix, so it is not the plugin's to delete.
				email: "work@example.com",
				accountId: "acct_0000abcdef",
				accountLabel: "Work [id:mine]",
				accountIdSource: "token",
				refreshToken: "refresh-b",
				addedAt: 1000,
				lastUsed: 2000,
			},
		]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(runInstaller(["list"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		})).resolves.toMatchObject({ exitCode: 0 });

		const rows = logSpy.mock.calls
			.map((call) => String(call[0]))
			.filter((line) => line.startsWith("- ["));

		expect(rows[0]).toContain("Account 1 (pers....com, id:87c4)");
		expect(rows[0]).not.toContain("DreamHost");
		expect(rows[1]).toContain("Work [id:mine] (work....com, id:cdef)");
	});

	it("list: replaces a value the head/tail mask cannot conceal", async () => {
		// `doctor` and friends share this printer and are what users paste
		// into issues. `first4...last4` conceals nothing below thirteen
		// characters, and padding must not clear the cutoff on its own.
		vi.resetModules();
		tempHome = await createTempHome();
		await seedPool(tempHome, [
			{
				email: "me@x.io",
				accountId: "acct_0000abcdef",
				accountIdSource: "token",
				refreshToken: "refresh-a",
				addedAt: 1000,
				lastUsed: 2000,
			},
			{
				email: "  me@x.io12  ",
				accountId: "acct_0000abcdef",
				accountIdSource: "token",
				refreshToken: "refresh-b",
				addedAt: 1000,
				lastUsed: 2000,
			},
		]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(runInstaller(["list"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		})).resolves.toMatchObject({ exitCode: 0 });

		const rows = logSpy.mock.calls
			.map((call) => String(call[0]))
			.filter((line) => line.startsWith("- ["));

		expect(rows[0]).toContain("(*****, id:cdef)");
		expect(rows[0]).not.toContain("me@x.io");
		expect(rows[1]).toContain("(*****, id:cdef)");
		expect(rows[1]).not.toContain("me@x");
	});

	it("status: omits the id suffix when the account id was masked outright", async () => {
		// The suffix is only safe because it reveals no more than the masked
		// `accountId` printed beside it. When that field is `*****`, four raw
		// characters of a short id can be the entire id.
		vi.resetModules();
		tempHome = await createTempHome();
		await seedPool(tempHome, [
			{
				email: "user@example.com",
				accountId: "ab12cd",
				accountIdSource: "token",
				refreshToken: "refresh-token",
				addedAt: 1000,
				lastUsed: 2000,
			},
		]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(runInstaller(["status", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		})).resolves.toMatchObject({ exitCode: 0 });

		const account = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).accounts[0];
		expect(account.accountId).toBe("*****");
		expect(account.idSuffix).toBeUndefined();
		expect(JSON.stringify(account)).not.toContain("12cd");
	});

	it("rejects unknown positional commands instead of installing", async () => {
		vi.resetModules();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(runInstaller(["wat"])).rejects.toThrow("Unknown command: wat");
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Commands:"));
	});

	async function writeAccounts(home: string, accounts: unknown[]) {
		const opencodeDir = join(home, ".opencode");
		await mkdir(opencodeDir, { recursive: true });
		await writeFile(
			join(opencodeDir, "oc-codex-multi-auth-accounts.json"),
			JSON.stringify({ version: 3, activeIndex: 0, accounts }, null, 2),
			"utf-8",
		);
	}

	const freshAccount = (over: Record<string, unknown> = {}) => ({
		email: "warm@example.com",
		accountId: "acct_warm",
		refreshToken: "rt-warm",
		accessToken: "at-warm",
		// Far-future expiry so ensureCodexUsageAccessToken skips a real refresh
		// and the warm path reaches the (mocked) fetch deterministically.
		expiresAt: Date.now() + 3_600_000,
		addedAt: Date.now(),
		lastUsed: Date.now(),
		...over,
	});

	it.each(["acct_warm", undefined])("doctor: repairs stale state and persists rotated credentials only in --config-path (%s)", async (accountId) => {
		// Given a selected pool distinct from both the home pool and runtime default.
		vi.resetModules();
		vi.stubEnv("CODEX_KEYCHAIN", "1");
		tempHome = await createTempHome();
		await seedPool(tempHome, [freshAccount({ refreshToken: "home-secret" })]);
		const homePath = join(tempHome, ".opencode", "oc-codex-multi-auth-accounts.json");
		const homeBefore = await readFile(homePath, "utf-8");
		const poolPath = join(tempHome, "selected-pool.json");
		const resetAt = Date.now() + 86_400_000;
		await writeFile(poolPath, JSON.stringify({ version: 3, activeIndex: 0, accounts: [
			freshAccount({ accountId, coolingDownUntil: resetAt, cooldownReason: "auth-failure", rateLimitResetTimes: { codex: resetAt } }),
		] }));
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
			access_token: "rotated-access-secret", refresh_token: "rotated-refresh-secret", expires_in: 3600,
		}), { status: 200 }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		// When explicitly repairing this pool, even an unexpired token is verified.
		const result = await runInstaller(["doctor", "--fix", "--json", "--config-path", poolPath], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			loadDoctorRuntime: loadSourceDoctorRuntime,
		});

		// Then the repair is durable, reported, and confined to the selected file.
		const stored = JSON.parse(await readFile(poolPath, "utf-8"));
		expect.soft(stored.accounts[0].rateLimitResetTimes).toEqual({});
		expect.soft(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).fixApplied).toBe(true);
		expect(stored.accounts[0]).toMatchObject({ accessToken: "rotated-access-secret", refreshToken: "rotated-refresh-secret" });
		expect(stored.accounts[0].coolingDownUntil).toBeUndefined();
		expect(stored.accounts[0].cooldownReason).toBeUndefined();
		expect(result).toMatchObject({ action: "doctor", exitCode: 0, storagePath: poolPath });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(String(fetchSpy.mock.calls[0]?.[1]?.body)).toContain("rt-warm");
		expect(await readFile(homePath, "utf-8")).toBe(homeBefore);
		expect(JSON.stringify(logSpy.mock.calls)).not.toMatch(/rotated-access-secret|rotated-refresh-secret|rt-warm|home-secret/);
	});

	it("doctor: repairs and summarizes the default keychain pool when no JSON file exists", async () => {
		// Given enabled keychain routing with accounts only in the injected backend.
		vi.resetModules();
		vi.stubEnv("CODEX_KEYCHAIN", "1");
		tempHome = await createTempHome();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const keychainRouting: (string | undefined)[] = [];
		const accounts = [freshAccount({ accountLabel: "Keychain account", rateLimitResetTimes: { codex: 123 } })];
		let snapshot = { accounts };
		const repairDoctorAccounts = vi.fn(async () => {
			keychainRouting.push(process.env.CODEX_KEYCHAIN);
			snapshot = { accounts: [freshAccount({ accountLabel: "Keychain account", rateLimitResetTimes: {} })] };
			return { appliedFixes: ["Cleared stale rate-limit markers."], fixErrors: [] };
		});

		// When repair uses injected runtime seams, never the real keychain.
		const result = await runInstaller(["doctor", "--fix", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			loadDoctorRuntime: async () => [
				{ setStoragePathDirect: vi.fn(), loadAccounts: async () => {
					keychainRouting.push(process.env.CODEX_KEYCHAIN);
					return snapshot;
				} },
				{ repairDoctorAccounts },
				{ setShutdownOwnsProcess: vi.fn() },
			],
		});

		// Then repair runs and the summary uses the post-repair backend snapshot.
		expect(repairDoctorAccounts).toHaveBeenCalledWith(accounts);
		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output).toMatchObject({
			totalAccounts: 1,
			fixApplied: true,
			accounts: [{ label: "Keychain account" }],
		});
		expect(output.accounts[0].rateLimitResetTimes).toEqual({});
		expect(keychainRouting).toEqual(["1", "1", "1"]);
		expect(process.env.CODEX_KEYCHAIN).toBe("1");
		expect(result).toMatchObject({ action: "doctor", exitCode: 0 });
	});

	it("doctor: recommends login without errors when the default runtime pool is empty", async () => {
		// Given a fresh installation with no JSON file or runtime accounts.
		vi.resetModules();
		vi.stubEnv("CODEX_KEYCHAIN", "1");
		tempHome = await createTempHome();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected OAuth request"));
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const repairMod = await import("../lib/tools/doctor-repair.js");
		const repairDoctorAccounts = vi.fn(repairMod.repairDoctorAccounts);
		const loadAccounts = vi.fn().mockResolvedValue(null);

		// When the real repair helper receives accounts from the injected empty backend.
		const result = await runInstaller(["doctor", "--fix", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			loadDoctorRuntime: async () => [
				{ setStoragePathDirect: vi.fn(), loadAccounts },
				{ repairDoctorAccounts },
				{ setShutdownOwnsProcess: vi.fn() },
			],
		});

		// Then null discovery and snapshot are successful, without OAuth requests.
		expect(result.exitCode).toBe(0);
		expect(repairDoctorAccounts).toHaveBeenCalledWith([]);
		expect(loadAccounts).toHaveBeenCalledTimes(2);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toMatchObject({
			totalAccounts: 0, accounts: [], fixApplied: false, fixErrors: [], error: null,
			nextAction: "Run opencode auth login.",
		});
		expect(process.env.CODEX_KEYCHAIN).toBe("1");
	});

	it("doctor: reports malformed explicit JSON without attempting repair", async () => {
		// Given an explicitly selected file that cannot be parsed as JSON.
		vi.resetModules();
		tempHome = await createTempHome();
		const poolPath = join(tempHome, "malformed-pool.json");
		await writeFile(poolPath, "{", "utf-8");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const repairDoctorAccounts = vi.fn().mockResolvedValue({ appliedFixes: [], fixErrors: [] });
		const loadDoctorRuntime = vi.fn(async () => [
			{ setStoragePathDirect: vi.fn(), loadAccounts: async () => null },
			{ repairDoctorAccounts },
			{ setShutdownOwnsProcess: vi.fn() },
		]);

		// When repair is requested for the malformed file.
		const result = await runInstaller(["doctor", "--fix", "--json", "--config-path", poolPath], {
			loadDoctorRuntime,
		});

		// Then parsing fails before runtime discovery or repair can run.
		expect(result.exitCode).toBe(1);
		expect(loadDoctorRuntime).not.toHaveBeenCalled();
		expect(repairDoctorAccounts).not.toHaveBeenCalled();
		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toMatchObject({
			error: expect.any(String), message: "Storage could not be parsed.", fixApplied: false, fixErrors: [],
		});
	});

	it("doctor: reports malformed default-path JSON as an error during --fix, not as success", async () => {
		// Given a corrupt default storage file while the runtime swallows the
		// parse failure (loadAccounts returns null instead of throwing).
		vi.resetModules();
		tempHome = await createTempHome();
		const accountsPath = join(tempHome, ".opencode", "oc-codex-multi-auth-accounts.json");
		await mkdir(join(tempHome, ".opencode"), { recursive: true });
		await writeFile(accountsPath, "{", "utf-8");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const repairDoctorAccounts = vi.fn().mockResolvedValue({ appliedFixes: [], fixErrors: [] });

		// When default-path repair discovers nothing because the file is unparseable.
		const result = await runInstaller(["doctor", "--fix", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			loadDoctorRuntime: async () => [
				{ setStoragePathDirect: vi.fn(), loadAccounts: async () => null },
				{ repairDoctorAccounts },
				{ setShutdownOwnsProcess: vi.fn() },
			],
		});

		// Then the parse error surfaces with a nonzero exit instead of
		// "No accounts configured" (exit 0), and no repair is attempted.
		expect(result.exitCode).toBe(1);
		expect(repairDoctorAccounts).not.toHaveBeenCalled();
		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toMatchObject({
			error: expect.any(String), message: "Storage could not be parsed.", fixApplied: false, fixErrors: [],
		});
	});

	it.each(["array", "scalar", "accounts-not-array"])("status: reports wrong-shape JSON (%s) as an error, not an empty pool", async (shape) => {
		// Given a file that parses as JSON but is not an accounts object.
		vi.resetModules();
		tempHome = await createTempHome();
		const accountsPath = join(tempHome, ".opencode", "oc-codex-multi-auth-accounts.json");
		await mkdir(join(tempHome, ".opencode"), { recursive: true });
		const contents =
			shape === "array" ? "[1, 2, 3]"
			: shape === "scalar" ? "\"hello\""
			: "{\"version\": 3, \"accounts\": \"oops\"}";
		await writeFile(accountsPath, contents, "utf-8");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		// When any pre-reading command reads the file.
		const result = await runInstaller(["status", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		// Then corruption is reported with a nonzero exit instead of a healthy
		// empty pool, matching the parse-error route.
		expect(result.exitCode).toBe(1);
		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.error).toContain("accounts array");
		expect(output.totalAccounts).toBe(0);
	});

	it("status: reports a newer-schema storage file instead of showing it as readable", async () => {
		// Given a file written by a newer plugin build (schema v4).
		vi.resetModules();
		tempHome = await createTempHome();
		const accountsPath = join(tempHome, ".opencode", "oc-codex-multi-auth-accounts.json");
		await mkdir(join(tempHome, ".opencode"), { recursive: true });
		await writeFile(accountsPath, JSON.stringify({ version: 4, activeIndex: 0, accounts: [] }), "utf-8");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		const result = await runInstaller(["status", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		// Then the pre-read refuses the newer schema with its own message
		// instead of diverging from the runtime (which throws on it).
		expect(result.exitCode).toBe(1);
		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.error).toContain("version 4");
	});

	it("doctor --fix: surfaces the typed newer-schema error instead of a generic repair failure", async () => {
		// Given a default-path v4 file, read through the SOURCE runtime so the
		// forward-compat StorageError is thrown by real loadAccounts code.
		vi.resetModules();
		tempHome = await createTempHome();
		const accountsPath = join(tempHome, ".opencode", "oc-codex-multi-auth-accounts.json");
		await mkdir(join(tempHome, ".opencode"), { recursive: true });
		await writeFile(accountsPath, JSON.stringify({ version: 4, activeIndex: 0, accounts: [] }), "utf-8");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		const result = await runInstaller(["doctor", "--fix", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			loadDoctorRuntime: loadSourceDoctorRuntime,
		});

		// Then the exact schema error (with upgrade hint) reaches the error
		// channel with exit 1, and no generic "could not complete" repair text
		// masks it.
		expect(result.exitCode).toBe(1);
		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.error).toContain("Unsupported account storage schema version 4");
		expect(output.error).toContain("Upgrade the plugin");
		expect(output.fixErrors).toEqual([]);
		expect(output.fixApplied).toBe(false);
	});

	it.each([
		["warm", "warm"],
		["limits", "limits"],
	])("%s: exits nonzero on a corrupt default storage file like status/doctor", async (command, action) => {
		// Given a corrupt default file that the runtime load swallows to null.
		vi.resetModules();
		tempHome = await createTempHome();
		const accountsPath = join(tempHome, ".opencode", "oc-codex-multi-auth-accounts.json");
		await mkdir(join(tempHome, ".opencode"), { recursive: true });
		await writeFile(accountsPath, "{", "utf-8");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network call"));
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		const result = await runInstaller([command, "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		// Then the corruption is reported with a nonzero exit and no network
		// call, instead of a silent "No accounts configured." exit 0.
		expect(result).toMatchObject({ exitCode: 1, action, storagePath: accountsPath });
		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.error).toEqual(expect.any(String));
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it.each(["discovery", "repair", "snapshot"])("doctor: redacts runtime %s failures without a JSON pool", async (stage) => {
		// Given an injected backend that fails at one repair boundary.
		vi.resetModules();
		vi.stubEnv("CODEX_KEYCHAIN", "1");
		tempHome = await createTempHome();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const failure = new Error("upstream-private-token-text");
		const loadAccounts = vi.fn().mockResolvedValue({ accounts: [freshAccount()] });
		if (stage === "discovery") loadAccounts.mockRejectedValue(failure);
		if (stage === "snapshot") loadAccounts.mockResolvedValueOnce({ accounts: [freshAccount()] }).mockRejectedValue(failure);
		const repairDoctorAccounts = vi.fn().mockResolvedValue({ appliedFixes: [], fixErrors: [] });
		if (stage === "repair") repairDoctorAccounts.mockRejectedValue(failure);

		// When default-path repair runs without reading any real credentials.
		const result = await runInstaller(["doctor", "--fix", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			loadDoctorRuntime: async () => [
				{ setStoragePathDirect: vi.fn(), loadAccounts },
				{ repairDoctorAccounts },
				{ setShutdownOwnsProcess: vi.fn() },
			],
		});

		// Then failure is nonzero and redacted, with keychain routing preserved.
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).fixErrors).toHaveLength(1);
		expect(JSON.stringify(logSpy.mock.calls)).not.toContain(failure.message);
		expect(process.env.CODEX_KEYCHAIN).toBe("1");
	});

	it("doctor: preserves failed and disabled accounts while reporting partial repair failure", async () => {
		// Given one recoverable, one failing, and one intentionally disabled account.
		vi.resetModules();
		tempHome = await createTempHome();
		const poolPath = join(tempHome, "selected-pool.json");
		const stale = { coolingDownUntil: Date.now() + 86_400_000, cooldownReason: "auth-failure", rateLimitResetTimes: { codex: Date.now() + 86_400_000 } };
		const failed = freshAccount({ ...stale, accountId: "acct_failed", refreshToken: "failed-refresh-secret" });
		const disabled = freshAccount({ ...stale, accountId: "acct_disabled", refreshToken: "disabled-refresh-secret", enabled: false });
		await writeFile(poolPath, JSON.stringify({ version: 3, activeIndex: 0, accounts: [freshAccount(stale), failed, disabled] }));
		const fetchSpy = vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "rotated-access-secret", refresh_token: "rotated-refresh-secret", expires_in: 3600 })))
			.mockRejectedValueOnce(new Error("failed-refresh-secret at-warm access_token=upstream-access-secret"));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		// When repair encounters a refresh failure, it continues but exits nonzero.
		const result = await runInstaller(["doctor", "--fix", "--json", "--config-path", poolPath], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			loadDoctorRuntime: loadSourceDoctorRuntime,
		});

		// Then only the verified account loses stale state and no secret is reported.
		expect(result).toMatchObject({ exitCode: 1 });
		const stored = JSON.parse(await readFile(poolPath, "utf-8"));
		expect(stored.accounts[0].rateLimitResetTimes).toEqual({});
		expect(stored.accounts[1]).toMatchObject(failed);
		expect(stored.accounts[2]).toMatchObject(disabled);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.fixApplied).toBe(true);
		expect(output.fixErrors).toEqual([expect.stringContaining("Account 2")]);
		expect(JSON.stringify(output)).not.toMatch(/failed-refresh-secret|at-warm|upstream-access-secret|rotated-access-secret|rotated-refresh-secret|disabled-refresh-secret/);
	});

	it("doctor: remains read-only without --fix", async () => {
		// Given a stale pool that would require verification to repair.
		vi.resetModules();
		tempHome = await createTempHome();
		await seedPool(tempHome, [freshAccount({ rateLimitResetTimes: { codex: Date.now() + 86_400_000 } })]);
		const poolPath = join(tempHome, ".opencode", "oc-codex-multi-auth-accounts.json");
		const before = await readFile(poolPath, "utf-8");
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		// When only diagnostics are requested.
		await runInstaller(["doctor", "--json", "--config-path", poolPath]);

		// Then neither credentials nor storage are touched.
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(await readFile(poolPath, "utf-8")).toBe(before);
	});

	it("warm: empty pool reports 0/0/0 and exits 0 (no network)", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, []);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["warm", "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "warm", exitCode: 0 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output).toMatchObject({ totalAccounts: 0, warmed: 0, failed: 0, skipped: 0 });
	});

	it.each(["warm", "limits"])("%s clears proven recovered blocks on disk", async (command) => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount({ quotaExhaustedUntil: 1234, rateLimitResetTimes: { codex: 5678 } })]);
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ rate_limit: {
			primary_window: { used_percent: 10, limit_window_seconds: 18_000 },
			secondary_window: { used_percent: 20, limit_window_seconds: 604_800 },
		} })));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const storageMod = await import("../lib/storage.js");
		const usageMod = await import("../lib/codex-usage.js");
		const warmReqMod = await import("../lib/accounts/warm-request.js");
		const warmMod = await import("../lib/accounts/warm.js");
		const recoveryMod = await import("../lib/accounts/warm-recovery.js");
		const loggerMod = await import("../lib/logger.js");
		const configMod = await import("../lib/config.js");
		const planMod = await import("../lib/plan-allotment.js");
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const result = await runInstaller([command, "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			loadWarmRuntime: async () => ({ storageMod, usageMod, warmReqMod, warmMod, recoveryMod }),
			loadLimitsRuntime: async () => ({ storageMod, usageMod, loggerMod, configMod, planMod }),
		});
		const stored = JSON.parse(await readFile(join(tempHome, ".opencode", "oc-codex-multi-auth-accounts.json"), "utf-8"));
		expect(result.exitCode).toBe(0);
		expect(stored.accounts[0].quotaExhaustedUntil).toBeUndefined();
		expect(stored.accounts[0].rateLimitResetTimes).toEqual({ codex: 5678 });
		if (command === "warm") expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).blocksCleared).toBe(1);
		storageMod.setStoragePathDirect(null);
	});

	it("warm: opens the window for an enabled account when upstream returns 200", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue({
				ok: true,
				status: 200,
				body: { cancel: async () => undefined },
				text: async () => "",
			} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["warm", "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "warm", exitCode: 0 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output).toMatchObject({ totalAccounts: 1, warmed: 1, failed: 0, skipped: 0 });
		expect(output.results[0]).toMatchObject({ index: 0, status: "warmed" });
		// Hit the real /codex/responses endpoint, not a usage GET.
		expect(String(fetchSpy.mock.calls.at(-1)?.[0])).toContain("/codex/responses");
		expect(fetchSpy.mock.calls.at(-1)?.[1]).toMatchObject({ method: "POST" });
	});

	it("warm: a quota-429 account is reported failed (NOT warmed) and exits 1", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: false,
			status: 429,
			body: { cancel: async () => undefined },
			text: async () => JSON.stringify({ error: { code: "usage_limit_reached" } }),
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["warm", "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "warm", exitCode: 1 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output).toMatchObject({ warmed: 0, failed: 1 });
		expect(output.results[0].detail).toMatch(/quota|usage/i);
	});

	it("warm: skips a disabled account without any upstream call", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount({ enabled: false })]);
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["warm", "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "warm", exitCode: 0 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output).toMatchObject({ warmed: 0, failed: 0, skipped: 1 });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("warm: masks emails by default in output", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount({ enabled: false })]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["warm", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.results[0].email).not.toBe("warm@example.com");
		expect(output.results[0].email).toContain("...");
	});

	const usagePayload = {
		plan_type: "plus",
		rate_limit: {
			primary_window: {
				used_percent: 18,
				limit_window_seconds: 18_000,
				reset_at: Math.floor(Date.now() / 1000) + 3_600,
			},
			secondary_window: {
				used_percent: 42,
				limit_window_seconds: 604_800,
				reset_at: Math.floor(Date.now() / 1000) + 86_400,
			},
		},
	};

	it("limits: empty pool reports no accounts and exits 0 (#209)", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, []);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["limits", "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "limits", exitCode: 0 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output).toMatchObject({ totalAccounts: 0, accounts: [], pool: null, poolSummary: null });
	});

	it("limits: reports live 5h and weekly windows per account (#209)", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => usagePayload,
			text: async () => JSON.stringify(usagePayload),
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["limits", "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "limits", exitCode: 0 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.totalAccounts).toBe(1);
		const names = output.accounts[0].limits.map((limit: { name: string }) => limit.name);
		expect(names).toContain("5h limit");
		expect(names).toContain("Weekly limit");
		expect(output.accounts[0].limits[0].leftPercent).toBe(82);
		expect(output.accounts[0].planType).toBe("plus");
		expect(String(fetchSpy.mock.calls.at(-1)?.[0])).toContain("/wham/usage");
	});

	it("limits: persists a spent weekly quota so rotation skips its Credits", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		const weeklyResetAt = Math.floor(Date.now() / 1000) + 86_400;
		const spentUsagePayload = {
			...usagePayload,
			rate_limit: {
				...usagePayload.rate_limit,
				secondary_window: {
					...usagePayload.rate_limit.secondary_window,
					used_percent: 100,
					reset_at: weeklyResetAt,
				},
			},
		};
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => spentUsagePayload,
			text: async () => JSON.stringify(spentUsagePayload),
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["limits", "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "limits", exitCode: 0 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.accounts[0]?.limits).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "Weekly limit", leftPercent: 0 })]),
		);
		const stored = JSON.parse(
			await readFile(
				join(tempHome, ".opencode", "oc-codex-multi-auth-accounts.json"),
				"utf-8",
			),
		);
		// The shared subscription quota is ONE account-wide fact, so it is stored
		// once and must not be forged into a per-family rate-limit block.
		expect(stored.accounts[0]?.quotaExhaustedUntil).toBe(weeklyResetAt * 1000);
		expect(stored.accounts[0]?.rateLimitResetTimes ?? {}).toEqual({});
	});

	it("limits: renders the windows in text output rather than a bare account list (#209)", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => usagePayload,
			text: async () => JSON.stringify(usagePayload),
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["limits"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		const printed = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
		expect(printed).toContain("5h limit: 82% left");
		expect(printed).toContain("Weekly limit: 58% left");
	});

	const mockUsageSequence = (payloads: unknown[]) => {
		let call = 0;
		return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			const body = payloads[Math.min(call++, payloads.length - 1)];
			return {
				ok: true,
				status: 200,
				json: async () => body,
				text: async () => JSON.stringify(body),
			} as unknown as Response;
		});
	};

	const weeklyPayload = (
		planType: string,
		usedPercent: number,
		resetInSeconds: number,
	) => ({
		plan_type: planType,
		rate_limit: {
			primary_window: {
				used_percent: usedPercent,
				limit_window_seconds: 604_800,
				reset_after_seconds: resetInSeconds,
				reset_at: Math.floor(Date.now() / 1000) + resetInSeconds,
			},
			secondary_window: null,
		},
	});

	const threeAccounts = () => [
		freshAccount({ refreshToken: "rt-a", accountId: "acct_a" }),
		freshAccount({ refreshToken: "rt-b", accountId: "acct_b" }),
		freshAccount({ refreshToken: "rt-c", accountId: "acct_c" }),
	];

	const printedAccountOrder = (printed: string) =>
		[...printed.matchAll(/^- \[(\d+)\]/gm)].map((match) => Number(match[1]));

	it("limits: prints each renewal as a timestamp with a countdown on its own line", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		mockUsageSequence([weeklyPayload("self_serve_business_prolite", 65, 5 * 86_400 + 3 * 3_600 + 600)]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["limits"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, NO_COLOR: "1" },
		});

		const printed = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
		expect(printed).toContain("Weekly limit: 35% left\n    Renews: ");
		expect(printed).toMatch(/Renews: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(in 5d 3h\)/);
		expect(printed).toContain("Plan: Business Premium (5x)");
		// Every entry and the pool total are set apart by a blank line.
		expect(printed).toMatch(/\n\n- \[0\]/);
		expect(printed).toMatch(/\n\nPool: /);
	});

	it("limits: says an untouched window has not started instead of inventing a renewal", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		mockUsageSequence([weeklyPayload("pro", 0, 604_800)]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["limits"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, NO_COLOR: "1" },
		});

		const printed = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
		expect(printed).toContain("Renews: not started");
		expect(printed).not.toMatch(/Renews: \d{4}-/);
		expect(printed).toContain("Plan: Pro (20x)");
	});

	it("limits: keeps a window used below one percent as started", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		mockUsageSequence([weeklyPayload("pro", 0, 604_000)]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["limits", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.accounts[0].limits[0].notStarted).toBe(false);
	});

	it("limits: sorts by account number by default", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, threeAccounts());
		mockUsageSequence([
			weeklyPayload("plus", 90, 3 * 86_400),
			weeklyPayload("plus", 10, 1 * 86_400),
			weeklyPayload("plus", 50, 2 * 86_400),
		]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["limits"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, NO_COLOR: "1" },
		});

		const printed = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
		expect(printedAccountOrder(printed)).toEqual([0, 1, 2]);
	});

	it.each([
		[["--sort", "reset"], [1, 2, 0]],
		[["--sort=reset", "--desc"], [0, 2, 1]],
		[["--sort", "usage"], [1, 2, 0]],
		[["--sort", "usage", "--desc"], [0, 2, 1]],
		[["--sort", "account", "--desc"], [2, 1, 0]],
	])("limits: %j orders the accounts %j", async (flags, expected) => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, threeAccounts());
		mockUsageSequence([
			weeklyPayload("plus", 90, 3 * 86_400),
			weeklyPayload("plus", 10, 1 * 86_400),
			weeklyPayload("plus", 50, 2 * 86_400),
		]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["limits", "--json", ...flags], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.accounts.map((account: { index: number }) => account.index)).toEqual(expected);
	});

	it("limits: sorts a window that has not started after every real renewal", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, threeAccounts());
		mockUsageSequence([
			weeklyPayload("plus", 0, 604_800),
			weeklyPayload("plus", 40, 2 * 86_400),
			weeklyPayload("plus", 40, 1 * 86_400),
		]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["limits", "--json", "--sort", "reset", "--desc"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.accounts.map((account: { index: number }) => account.index)).toEqual([1, 2, 0]);
	});

	it("limits: rejects an unknown --sort value", async () => {
		vi.resetModules();
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		await expect(runInstaller(["limits", "--sort", "vibes"])).rejects.toThrow(/Unknown --sort value/);
	});

	it("limits: colours the percentage by how much of the window is used", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [
			freshAccount({ refreshToken: "rt-a", accountId: "acct_a" }),
			freshAccount({ refreshToken: "rt-b", accountId: "acct_b" }),
			freshAccount({ refreshToken: "rt-c", accountId: "acct_c" }),
			freshAccount({ refreshToken: "rt-d", accountId: "acct_d" }),
		]);
		mockUsageSequence([
			weeklyPayload("plus", 59, 86_400),
			weeklyPayload("plus", 60, 86_400),
			weeklyPayload("plus", 98, 86_400),
			weeklyPayload("plus", 99, 86_400),
		]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const env: NodeJS.ProcessEnv = { ...process.env, HOME: tempHome, USERPROFILE: tempHome, FORCE_COLOR: "1" };
		delete env.NO_COLOR;

		await runInstaller(["limits"], { env });

		const printed = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
		expect(printed).toContain("\u001b[32m41% left\u001b[0m");
		expect(printed).toContain("\u001b[33m40% left\u001b[0m");
		expect(printed).toContain("\u001b[38;5;208m2% left\u001b[0m");
		expect(printed).toContain("\u001b[31m1% left\u001b[0m");
	});

	it("limits: names what a seat is worth and what the pool adds up to", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => usagePayload,
			text: async () => JSON.stringify(usagePayload),
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["limits"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		const printed = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
		expect(printed).toContain("Plan: Plus (1x)");
		// The weekly window governs at 58% left, so that is what the pool holds.
		expect(printed).toContain("Pool: 58% left of 1x across 1 account");
	});

	it("limits: weighs the pool total by plan rather than averaging seats", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [
			freshAccount({ refreshToken: "rt-pro", accountId: "acct_pro" }),
			freshAccount({ refreshToken: "rt-plus", accountId: "acct_plus" }),
		]);
		const payloadFor = (planType: string, usedPercent: number) => ({
			plan_type: planType,
			rate_limit: {
				secondary_window: {
					used_percent: usedPercent,
					limit_window_seconds: 604_800,
					reset_at: Math.floor(Date.now() / 1000) + 86_400,
				},
			},
		});
		// A spent 20x seat beside an untouched 1x seat. A plain mean would call
		// this pool half full; weighting reports the 5% it actually holds.
		const payloads = [payloadFor("pro", 100), payloadFor("plus", 0)];
		let call = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			const body = payloads[Math.min(call++, payloads.length - 1)];
			return {
				ok: true,
				status: 200,
				json: async () => body,
				text: async () => JSON.stringify(body),
			} as unknown as Response;
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["limits"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		const printed = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
		expect(printed).toContain("Plan: Pro (20x)");
		expect(printed).toContain("Plan: Plus (1x)");
		expect(printed).toContain("Pool: 5% left of 21x across 2 accounts");
	});

	it("limits: --json carries the pool figures and each seat's ratio", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => usagePayload,
			text: async () => JSON.stringify(usagePayload),
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["limits", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		// Both percentages are present regardless of `quotaDisplay`, so a
		// consumer never has to know which way the wording was pointing.
		expect(output.pool).toEqual({
			leftPercent: 58,
			usedPercent: 42,
			allotment: 1,
			countedAccounts: 1,
		});
		expect(output.accounts[0].planMultiplier).toBe("1x");
	});

	it("limits: a plan with no published ratio carries no badge", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		const freePayload = {
			plan_type: "free",
			rate_limit: {
				secondary_window: {
					used_percent: 40,
					limit_window_seconds: 2_592_000,
					reset_at: Math.floor(Date.now() / 1000) + 86_400,
				},
			},
		};
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => freePayload,
			text: async () => JSON.stringify(freePayload),
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["limits", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		// Free states no per-seat ratio, so the badge is withheld rather than
		// asserting a 1x baseline OpenAI never published. It still weighs 1.
		expect(output.accounts[0].planMultiplier).toBeNull();
		expect(output.pool.allotment).toBe(1);
	});

	it("limits: reports consumption instead of headroom when quotaDisplay is used", async () => {
		process.env[QUOTA_DISPLAY_ENV] = "used";
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => usagePayload,
			text: async () => JSON.stringify(usagePayload),
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["limits"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		const printed = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
		expect(printed).toContain("5h limit: 18% used");
		expect(printed).toContain("Weekly limit: 42% used");
		expect(printed).not.toContain("% left");
	});

	it("limits: --tag only contacts matching accounts", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [
			freshAccount({ email: "tagged@example.com", accountTags: ["work"] }),
			freshAccount({
				email: "untagged@example.com",
				accountId: "acct_other",
				refreshToken: "rt-other",
			}),
		]);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => usagePayload,
			text: async () => JSON.stringify(usagePayload),
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["limits", "--tag", "work", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		// The untagged account must not be fetched: that would bill it a usage
		// request and could persist refreshed credentials for it.
		expect(output.accounts).toHaveLength(1);
		expect(output.accounts[0].index).toBe(0);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("limits: --tag matches a workspace tagged on a deduplicated-away record", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		// Both records are the same workspace (same accountId), so dedupe keeps
		// only the later one — but the tag lives on the earlier record.
		await writeAccounts(tempHome, [
			freshAccount({ email: "old@example.com", accountTags: ["work"] }),
			freshAccount({ email: "new@example.com", refreshToken: "rt-newer" }),
		]);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => usagePayload,
			text: async () => JSON.stringify(usagePayload),
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["limits", "--tag", "work", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.accounts).toHaveLength(1);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("limits: redacts token material leaked by a failing refresh", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		// Expired, so ensureCodexUsageAccessToken actually performs the OAuth
		// refresh — a future expiry would skip it and only exercise /wham/usage.
		await writeAccounts(tempHome, [freshAccount({ expiresAt: Date.now() - 60_000 })]);
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: false,
			status: 401,
			json: async () => ({
				error: "invalid_grant",
				refresh_token: "rt-super-secret-value",
			}),
			text: async () =>
				'{"error":"invalid_grant","refresh_token":"rt-super-secret-value"}',
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["limits", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.accounts[0].error).not.toContain("rt-super-secret-value");
	});

	it("limits: an account whose usage fetch fails is reported and exits 1 (#209)", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: false,
			status: 500,
			text: async () => "upstream boom",
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["limits", "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "limits", exitCode: 1 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.accounts[0].error).toContain("500");
	});
});
