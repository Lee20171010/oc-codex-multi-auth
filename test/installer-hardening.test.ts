import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression coverage for installer hardening: JSONC truncation, non-list
// plugin values, provider shape guards, unsafe merge keys in tui.json/V2,
// the OpenCode 2.x npm/ cache layout, file-mode preservation, non-finite
// numerics, shadow tui.jsonc, special-file guards, and the HOME guard.

async function createTempHome() {
	return realpathSync(await mkdtemp(join(tmpdir(), "oc-codex-insthard-")));
}

type CoreModule = typeof import("../scripts/install-oc-codex-multi-auth-core.js");

async function importCore() {
	vi.resetModules();
	return import("../scripts/install-oc-codex-multi-auth-core.js") as Promise<CoreModule>;
}

function gatherStdout(logSpy: ReturnType<typeof vi.spyOn>) {
	return logSpy.mock.calls.map((call) => String(call[0])).join("\n");
}

async function makeFifo(path: string) {
	const { execFileSync } = await import("node:child_process");
	execFileSync("mkfifo", [path]);
}

describe("installer hardening (fuzz corpus regressions)", () => {
	let tempHome: string | null = null;

	beforeEach(() => {
		delete process.env.CODEX_AUTH_PER_PROJECT_ACCOUNTS;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		if (tempHome) {
			await rm(tempHome, { recursive: true, force: true });
			tempHome = null;
		}
	});

	it.each([
		["unterminated block comment", `{"a":1} /* never ends`],
		["unterminated string", `{"a": "never closed`],
		["string ending on a backslash", `{"a": "ends with escape\\`],
	])("parseJsonc refuses %s instead of silently truncating", async (_name, source) => {
		const { __test } = await importCore();
		expect(() => __test.parseJsonc(source)).toThrow(/Unterminated|JSON/i);
	});

	it("an unterminated block comment is never overwritten as a healthy config", async () => {
		// `{"keep":1} /* never ends` used to strip to a parseable prefix and the
		// installer then rewrote the file, destroying the bytes after `/*`.
		tempHome = await createTempHome();
		const { runInstaller } = await importCore();
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");
		await mkdir(configDir, { recursive: true });
		const truncated = `{"keep": "me", "plugin": ["other-plugin"]} /* never ends`;
		await writeFile(configPath, truncated, "utf-8");

		await expect(
			runInstaller(["--plugin-only", "--no-cache-clear"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).rejects.toThrow(/Could not parse existing config/);
		await expect(readFile(configPath, "utf-8")).resolves.toBe(truncated);
	});

	it.each([
		["string", "other-plugin", "a string"],
		["number", 42, "a number"],
		["object", { package: "other-plugin" }, "an object"],
	])(
		"a non-list plugin value (%s) is wrapped and warned, never dropped silently",
		async (_kind, pluginValue, description) => {
			tempHome = await createTempHome();
			const { __test } = await importCore();
			const notices: string[] = [];
			const merged = __test.normalizePluginList(pluginValue, (m: string) => notices.push(m));

			expect(merged).toContain(pluginValue);
			expect(merged).toContain("oc-codex-multi-auth");
			expect(notices.join("\n")).toContain(description);
			expect(notices.join("\n")).toMatch(/not a list/i);
		},
	);

	it("mergeTuiConfig drops __proto__/constructor/prototype own keys like the V1 merge", async () => {
		const { __test } = await importCore();
		const existing = JSON.parse(
			`{"plugin": [], "__proto__": {"polluted": true}, "constructor": "x", "prototype": 1, "theme": "dark"}`,
		);
		const merged = __test.mergeTuiConfig(existing, () => {});
		expect(Object.hasOwn(merged, "__proto__")).toBe(false);
		expect(Object.hasOwn(merged, "constructor")).toBe(false);
		expect(Object.hasOwn(merged, "prototype")).toBe(false);
		expect(merged.theme).toBe("dark");
		expect(merged.plugin).toContain("oc-codex-multi-auth");
	});

	it("install --v2 drops unsafe merge keys from the written config", async () => {
		tempHome = await createTempHome();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await importCore();
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");
		await mkdir(configDir, { recursive: true });
		await writeFile(
			configPath,
			`{"plugins": [], "__proto__": {"polluted": true}, "constructor": {"x": 1}, "keep": "yes"}`,
			"utf-8",
		);

		await expect(
			runInstaller(["install", "--v2"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ exitCode: 0 });

		const saved = JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>;
		expect(Object.hasOwn(saved, "__proto__")).toBe(false);
		expect(Object.hasOwn(saved, "constructor")).toBe(false);
		expect(saved.keep).toBe("yes");
		expect(saved.plugins).toContain("oc-codex-multi-auth");
		expect(gatherStdout(logSpy)).toContain("V2 plugin registered");
	});

	it("an array-valued provider is replaced wholesale instead of merged into {\"0\":…}", async () => {
		tempHome = await createTempHome();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await importCore();
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");
		await mkdir(configDir, { recursive: true });
		await writeFile(
			configPath,
			JSON.stringify({ plugin: [], provider: ["openai", "anthropic"] }),
			"utf-8",
		);

		await expect(
			runInstaller(["--modern", "--no-cache-clear"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ exitCode: 0 });

		const saved = JSON.parse(await readFile(configPath, "utf-8")) as {
			provider: Record<string, unknown>;
		};
		expect(Object.hasOwn(saved.provider, "0")).toBe(false);
		expect(Object.hasOwn(saved.provider, "1")).toBe(false);
		expect(saved.provider.openai).toBeDefined();
		expect(gatherStdout(logSpy)).toMatch(/provider.*not a JSON object/i);
	});

	it("warns about managed provider.openai keys but keeps custom user keys", async () => {
		tempHome = await createTempHome();
		const { runInstaller } = await importCore();
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");
		await mkdir(configDir, { recursive: true });
		await writeFile(
			configPath,
			JSON.stringify({
				plugin: [],
				provider: {
					openai: { apiKey: "user-secret-should-be-dropped", myCustomKey: "keep-me" },
					other: { keep: true },
				},
			}),
			"utf-8",
		);

		await expect(
			runInstaller(["--modern", "--no-cache-clear"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ exitCode: 0 });

		const saved = JSON.parse(await readFile(configPath, "utf-8")) as {
			provider: { openai: { myCustomKey?: string }; other?: { keep: boolean } };
		};
		expect(saved.provider.openai.myCustomKey).toBe("keep-me");
		expect(saved.provider.other).toEqual({ keep: true });
	});

	it("update clears the OpenCode 2.x npm/<name>@<spec> cache entries and keeps strangers", async () => {
		tempHome = await createTempHome();
		const { runInstaller } = await importCore();
		const cacheRoot = join(tempHome, ".cache", "opencode");
		const npmDir = join(cacheRoot, "npm");
		await mkdir(join(npmDir, "oc-codex-multi-auth@latest", "20260101000000"), { recursive: true });
		await writeFile(join(npmDir, "oc-codex-multi-auth@latest", "20260101000000", "marker.txt"), "x");
		await mkdir(join(npmDir, "oc-chatgpt-multi-auth@latest", "ts"), { recursive: true });
		await mkdir(join(npmDir, "unrelated-pkg@latest", "ts"), { recursive: true });
		await writeFile(join(npmDir, "unrelated-pkg@latest", "ts", "keep.txt"), "keep");
		vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(
			runInstaller(["update"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ exitCode: 0, action: "update" });

		const remaining = await readdir(npmDir);
		expect(remaining).toEqual(["unrelated-pkg@latest"]);
		await expect(
			readFile(join(npmDir, "unrelated-pkg@latest", "ts", "keep.txt"), "utf-8"),
		).resolves.toBe("keep");
	});

	it("update --dry-run lists npm cache entries without removing them", async () => {
		tempHome = await createTempHome();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await importCore();
		const npmEntry = join(tempHome, ".cache", "opencode", "npm", "oc-codex-multi-auth@latest");
		await mkdir(join(npmEntry, "ts1"), { recursive: true });

		await expect(
			runInstaller(["update", "--dry-run"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ exitCode: 0, dryRun: true });

		expect(gatherStdout(logSpy)).toContain("npm/oc-codex-multi-auth@latest");
		await expect(stat(npmEntry)).resolves.toBeDefined();
	});

	it("writeFileAtomic preserves an existing destination mode instead of forcing 0600", async () => {
		tempHome = await createTempHome();
		const { __test } = await importCore();
		const target = join(tempHome, "pinned.json");
		await writeFile(target, "{}", "utf-8");
		await chmod(target, 0o444);

		await __test.writeFileAtomic(target, `{"a":1}\n`);

		const mode = (await stat(target)).mode & 0o777;
		expect(mode).toBe(0o444);
		expect(await readFile(target, "utf-8")).toBe(`{"a":1}\n`);
	});

	it("writeFileAtomic creates new files at 0600", async () => {
		tempHome = await createTempHome();
		const { __test } = await importCore();
		const target = join(tempHome, "fresh.json");

		await __test.writeFileAtomic(target, `{"a":1}\n`);

		expect((await stat(target)).mode & 0o777).toBe(0o600);
	});

	it("warns when a non-finite number in the existing config would serialize as null", async () => {
		tempHome = await createTempHome();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await importCore();
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");
		await mkdir(configDir, { recursive: true });
		// `1e400` parses as Infinity — JSON.stringify would write null.
		await writeFile(configPath, `{"plugin": [], "provider": {"other": {"limit": 1e400}}}`, "utf-8");

		await expect(
			runInstaller(["--plugin-only", "--no-cache-clear"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ exitCode: 0 });

		expect(gatherStdout(logSpy)).toMatch(/not a finite number/);
		const saved = JSON.parse(await readFile(configPath, "utf-8")) as {
			provider: { other: { limit: number | null } };
		};
		expect(saved.provider.other.limit).toBeNull();
	});

	it("warns about a shadow tui.jsonc twin while writing tui.json", async () => {
		tempHome = await createTempHome();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await importCore();
		const configDir = join(tempHome, ".config", "opencode");
		await mkdir(configDir, { recursive: true });
		const jsoncPath = join(configDir, "tui.jsonc");
		const jsoncContent = `// hand-maintained\n{"theme": "dark"}`;
		await writeFile(jsoncPath, jsoncContent, "utf-8");

		await expect(
			runInstaller(["--plugin-only", "--no-cache-clear"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ exitCode: 0 });

		expect(gatherStdout(logSpy)).toMatch(/tui\.jsonc/);
		// The twin is never touched; tui.json carries the registration.
		expect(await readFile(jsoncPath, "utf-8")).toBe(jsoncContent);
		const tui = JSON.parse(await readFile(join(configDir, "tui.json"), "utf-8")) as {
			plugin: string[];
		};
		expect(tui.plugin).toContain("oc-codex-multi-auth");
	});

	it("a FIFO opencode.json fails fast instead of blocking the installer", async () => {
		tempHome = await createTempHome();
		const { runInstaller } = await importCore();
		const configDir = join(tempHome, ".config", "opencode");
		await mkdir(configDir, { recursive: true });
		await makeFifo(join(configDir, "opencode.json"));

		const started = Date.now();
		const outcome = await runInstaller(["--plugin-only", "--no-cache-clear"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		}).then(
			() => ({ ok: true as const }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		// A 30s vitest ceiling is the outer guard; the guard must refuse long
		// before a FIFO writer could ever arrive.
		expect(Date.now() - started).toBeLessThan(5000);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(String(outcome.error instanceof Error ? outcome.error.message : outcome.error)).toMatch(
				/named pipe|not a regular file|Could not parse existing config/,
			);
		}
	});

	it("a FIFO accounts file read through readStandaloneStorage fails fast", async () => {
		tempHome = await createTempHome();
		const { __test } = await importCore();
		const fifoPath = join(tempHome, "pool.fifo");
		await makeFifo(fifoPath);

		const result = await __test.readStandaloneStorage(fifoPath);
		expect(result.storage).toBeNull();
		expect(result.error).toMatch(/named pipe|not a regular file/);
	});

	it("a directory passed as a config path is refused, not parsed", async () => {
		tempHome = await createTempHome();
		const { __test } = await importCore();
		const dirPath = join(tempHome, "adir");
		await mkdir(dirPath, { recursive: true });

		await expect(__test.readJson(dirPath)).rejects.toThrow(/not a regular file/);
	});

	it("a relative HOME is rejected rather than writing ./.config into cwd", async () => {
		tempHome = await createTempHome();
		const { __test } = await importCore();
		// os.homedir() still resolves to a real absolute home, so the guard must
		// fall back to it — never to a cwd-relative ".config".
		const resolved = __test.resolveHomeDirectory({ HOME: "relative-home", USERPROFILE: undefined });
		expect(resolved).not.toBe("relative-home");
		expect(resolved.startsWith("/")).toBe(true);
	});

	it("an empty HOME with a valid USERPROFILE uses USERPROFILE", async () => {
		tempHome = await createTempHome();
		const { __test } = await importCore();
		const resolved = __test.resolveHomeDirectory({ HOME: "", USERPROFILE: tempHome });
		expect(resolved).toBe(tempHome);
	});
});
