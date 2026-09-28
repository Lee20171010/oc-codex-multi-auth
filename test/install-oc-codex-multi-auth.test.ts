import { afterEach, describe, expect, it, vi } from "vitest";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type OpenAiTemplate = {
	provider: {
		openai: {
			models: Record<string, unknown>;
		};
	};
};

async function createTempHome() {
	// macOS reaches os.tmpdir() through the /var -> /private/var symlink; the
	// cache guard refuses a cache root that resolves through a symlink, so the
	// fake home has to be canonical for eviction tests to exercise it.
	return realpathSync(await mkdtemp(join(tmpdir(), "oc-codex-install-")));
}

describe("install-oc-codex-multi-auth script", () => {
	let tempHome: string | null = null;

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.doUnmock("node:fs/promises");
		if (tempHome) {
			await rm(tempHome, { recursive: true, force: true });
			tempHome = null;
		}
	});

	it("shows help even when conflicting mode flags are present", async () => {
		vi.resetModules();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(runInstaller(["--modern", "--full", "--legacy", "--help"])).resolves.toMatchObject({
			action: "help",
			exitCode: 0,
		});

		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Usage: oc-codex-multi-auth"));
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it("registers V2 using native plugin entries and preserves a local checkout and provider config", async () => {
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");
		const checkout = join(tempHome, "checkout");
		await mkdir(checkout, { recursive: true });
		await writeFile(join(checkout, "package.json"), JSON.stringify({ name: "oc-codex-multi-auth" }));
		await mkdir(configDir, { recursive: true });
		const providers = { openai: { models: { custom: { name: "Keep me" } } } };
		await writeFile(configPath, JSON.stringify({ providers, plugins: [{ package: checkout, options: { enabled: true } }, "another-plugin"] }));
		await runInstaller(["--v2"], { env: { HOME: tempHome, USERPROFILE: tempHome } });
		const result = JSON.parse(await readFile(configPath, "utf8"));
		expect(result.providers).toEqual(providers);
		expect(result.plugin).toBeUndefined();
		expect(result.plugins).toEqual([{ package: checkout, options: { enabled: true } }, "another-plugin"]);
		expect(await readdir(configDir)).not.toContain("tui.json");
		expect(await readdir(configDir)).not.toContain("cli.json");
	});

	it("refuses to remove an existing V1 registration during V2 install", async () => {
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");
		await mkdir(configDir, { recursive: true });
		const original = JSON.stringify({ plugin: ["oc-codex-multi-auth"], provider: { openai: {} } });
		await writeFile(configPath, original);
		await expect(runInstaller(["--v2"], { env: { HOME: tempHome } })).rejects.toThrow("will not remove your V1 registration");
		expect(await readFile(configPath, "utf8")).toBe(original);
	});

	it("refuses to create a second V2 config beside an existing JSONC file", async () => {
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const configDir = join(tempHome, ".config", "opencode");
		await mkdir(configDir, { recursive: true });
		const original = '{ "plugins": ["another-plugin"] }';
		await writeFile(join(configDir, "opencode.jsonc"), original);
		await expect(runInstaller(["--v2", "--dry-run"], { env: { HOME: tempHome } })).rejects.toThrow("edit its plugins list directly");
		expect(await readdir(configDir)).toEqual(["opencode.jsonc"]);
		expect(await readFile(join(configDir, "opencode.jsonc"), "utf8")).toBe(original);
	});

	it("does not write V2 config during a dry run", async () => {
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		await runInstaller(["--v2", "--dry-run"], { env: { HOME: tempHome, USERPROFILE: tempHome } });
		expect(await readdir(tempHome)).toEqual([]);
	});

	it("detects direct CLI execution after path normalization", async () => {
		vi.resetModules();
		const { isDirectRunPath } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const scriptPath = resolve("scripts", "install-oc-codex-multi-auth.js");
		const symlinkedScriptPath = join(
			process.cwd(),
			"global",
			"node_modules",
			"oc-codex-multi-auth",
			"install-oc-codex-multi-auth.js",
		);
		const resolveRealPath = (path: string) => path === symlinkedScriptPath ? scriptPath : path;

		expect(isDirectRunPath(symlinkedScriptPath, scriptPath, resolveRealPath)).toBe(true);
		expect(
			isDirectRunPath(resolve("scripts", "install-oc-codex-multi-auth-core.js"), scriptPath),
		).toBe(false);
		expect(isDirectRunPath(undefined, scriptPath)).toBe(false);
	});

	it("writes compact UI catalog with --modern, preserves user model entries, and normalizes plugin entries", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");

		await mkdir(configDir, { recursive: true });
		await writeFile(
			configPath,
			JSON.stringify({
				plugin: [
					"existing-plugin",
					"oc-chatgpt-multi-auth@old",
					"file:///C:/Users/neil/DevTools/pkg/npm-global/node_modules/oc-codex-multi-auth",
					"C:\\Users\\neil\\DevTools\\pkg\\npm-global\\node_modules\\oc-chatgpt-multi-auth\\dist",
				],
				provider: {
					anthropic: { baseURL: "https://example.invalid" },
					openai: {
						models: {
							old: { name: "old" },
							"gpt-5.4": { name: "stale base model" },
							"gpt-5.5-high": { name: "stale explicit preset" },
							"gpt-5.5-fast-medium": { name: "stale explicit preset" },
							// Retired ids an earlier template shipped.
							"gpt-5-codex": { name: "retired base" },
							"gpt-5.4-mini": { name: "retired base" },
							"gpt-5.1-codex-max-high": { name: "retired explicit preset" },
						},
					},
				},
				customSetting: true,
			}, null, 2),
			"utf-8",
		);

		await expect(
			runInstaller(["--modern", "--no-cache-clear"], {
				env: {
					...process.env,
					HOME: tempHome,
					USERPROFILE: tempHome,
				},
			}),
		).resolves.toMatchObject({
			action: "install",
			configMode: "modern",
			exitCode: 0,
		});

		const saved = JSON.parse(await readFile(configPath, "utf-8")) as {
			customSetting: boolean;
			plugin: string[];
			provider: {
				anthropic: { baseURL: string };
				openai: { models: Record<string, unknown> };
			};
		};

		expect(saved.customSetting).toBe(true);
		expect(saved.plugin).toEqual(["existing-plugin", "oc-codex-multi-auth"]);
		expect(saved.provider.anthropic).toEqual({ baseURL: "https://example.invalid" });
		const modernTemplate = JSON.parse(
			await readFile(new URL("../config/opencode-modern.json", import.meta.url), "utf-8"),
		) as OpenAiTemplate;
		// Template catalog ids plus the user's preserved `old` entry (deep-merge).
		// Explicit preset ids from earlier full installs are managed installer
		// output, so compact mode prunes them instead of treating them as custom.
		const expectedCount = Object.keys(modernTemplate.provider.openai.models).length + 1;
		expect(Object.keys(saved.provider.openai.models)).toHaveLength(expectedCount);
		expect(saved.provider.openai.models["gpt-5.5"]).toBeDefined();
		expect(saved.provider.openai.models["gpt-5.5-fast"]).toBeDefined();
		expect(saved.provider.openai.models["gpt-5.4"]).toBeUndefined();
		expect(saved.provider.openai.models["gpt-5.5-high"]).toBeUndefined();
		expect(saved.provider.openai.models["gpt-5.5-fast-medium"]).toBeUndefined();
		expect(saved.provider.openai.models["gpt-5-codex"]).toBeUndefined();
		expect(saved.provider.openai.models["gpt-5.4-mini"]).toBeUndefined();
		expect(saved.provider.openai.models["gpt-5.1-codex-max-high"]).toBeUndefined();
		// User-added model survives deep-merge without overriding template ids.
		expect(saved.provider.openai.models["old"]).toEqual({ name: "old" });
		const configEntries = await readdir(configDir);
		expect(configEntries).toEqual(
			expect.arrayContaining([
				"opencode.json",
				expect.stringMatching(/^opencode\.json\.bak-/),
			]),
		);
	});

	it("default install registers plugin entries without changing provider.openai", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");
		const openai = {
			baseURL: "https://example.invalid/v1",
			apiKey: "{env:OPENAI_API_KEY}",
			options: { store: true, customOption: "keep" },
			models: { custom: { name: "Custom model" } },
		};

		await mkdir(configDir, { recursive: true });
		await writeFile(
			configPath,
			JSON.stringify({ plugin: ["existing-plugin"], provider: { openai } }, null, 2),
			"utf-8",
		);

		await expect(
			runInstaller(["--no-cache-clear"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({
			action: "install",
			configMode: "plugin-only",
			pluginOnly: true,
			exitCode: 0,
		});

		const saved = JSON.parse(await readFile(configPath, "utf-8")) as {
			plugin: string[];
			provider: { openai: typeof openai };
		};
		expect(saved.plugin).toEqual(["existing-plugin", "oc-codex-multi-auth"]);
		expect(saved.provider.openai).toEqual(openai);
	});

	it("writes the merged full catalog when --full is requested", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");

		await mkdir(configDir, { recursive: true });
		await writeFile(configPath, JSON.stringify({ plugin: [] }, null, 2), "utf-8");

		await expect(
			runInstaller(["--full", "--no-cache-clear"], {
				env: {
					...process.env,
					HOME: tempHome,
					USERPROFILE: tempHome,
				},
			}),
		).resolves.toMatchObject({
			action: "install",
			configMode: "full",
			exitCode: 0,
		});

		const saved = JSON.parse(await readFile(configPath, "utf-8")) as OpenAiTemplate;
		const modernTemplate = JSON.parse(
			await readFile(new URL("../config/opencode-modern.json", import.meta.url), "utf-8"),
		) as OpenAiTemplate;
		const legacyTemplate = JSON.parse(
			await readFile(new URL("../config/opencode-legacy.json", import.meta.url), "utf-8"),
		) as OpenAiTemplate;
		const expectedCount = Object.keys(modernTemplate.provider.openai.models).length
			+ Object.keys(legacyTemplate.provider.openai.models).length;

		expect(Object.keys(saved.provider.openai.models)).toHaveLength(expectedCount);
		expect(saved.provider.openai.models["gpt-5.5"]).toBeDefined();
		expect(saved.provider.openai.models["gpt-5.5-high"]).toBeDefined();
		expect(saved.provider.openai.models["gpt-5.5-fast"]).toBeDefined();
		expect(saved.provider.openai.models["gpt-5.5-fast-medium"]).toBeDefined();
	});

	it("merges tui.json plugin entries without clobbering plugin_enabled", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");
		const tuiConfigPath = join(configDir, "tui.json");

		await mkdir(configDir, { recursive: true });
		await writeFile(configPath, JSON.stringify({ plugin: [] }, null, 2), "utf-8");
		await writeFile(
			tuiConfigPath,
			JSON.stringify(
				{
					plugin: [
						"other-tui-plugin",
						"oc-chatgpt-multi-auth@old",
						"file:///C:/Users/neil/pkg/node_modules/oc-codex-multi-auth",
					],
					plugin_enabled: {
						"other.id": false,
					},
				},
				null,
				2,
			),
			"utf-8",
		);

		await expect(
			runInstaller(["--no-cache-clear"], {
				env: {
					...process.env,
					HOME: tempHome,
					USERPROFILE: tempHome,
				},
			}),
		).resolves.toMatchObject({
			action: "install",
			tuiConfigPath,
		});

		const saved = JSON.parse(await readFile(tuiConfigPath, "utf-8")) as {
			$schema: string;
			plugin: string[];
			plugin_enabled: Record<string, boolean>;
		};
		expect(saved.$schema).toBe("https://opencode.ai/tui.json");
		expect(saved.plugin).toEqual(["other-tui-plugin", "oc-codex-multi-auth"]);
		expect(saved.plugin_enabled).toEqual({ "other.id": false });
		const configEntries = await readdir(configDir);
		expect(configEntries).toEqual(
			expect.arrayContaining([
				"tui.json",
				expect.stringMatching(/^tui\.json\.bak-/),
			]),
		);
	});

	it("parses BOM-prefixed existing config and preserves custom keys on merge", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");

		await mkdir(configDir, { recursive: true });
		const existing = {
			plugin: ["some-other-plugin"],
			provider: {
				openai: {
					myCustomKey: "preserve-me",
					models: {
						"user-only-model": { name: "User Only Model" },
					},
				},
			},
		};
		await writeFile(configPath, `\uFEFF${JSON.stringify(existing, null, 2)}`, "utf-8");

		await expect(
			runInstaller(["--modern", "--no-cache-clear"], {
				env: {
					...process.env,
					HOME: tempHome,
					USERPROFILE: tempHome,
				},
			}),
		).resolves.toMatchObject({
			action: "install",
			exitCode: 0,
		});

		const saved = JSON.parse(await readFile(configPath, "utf-8")) as {
			plugin: string[];
			provider: {
				openai: {
					myCustomKey?: string;
					models: Record<string, unknown>;
				};
			};
		};

		expect(saved.plugin).toEqual(expect.arrayContaining(["some-other-plugin", "oc-codex-multi-auth"]));
		expect(saved.provider.openai.myCustomKey).toBe("preserve-me");
		expect(saved.provider.openai.models["user-only-model"]).toBeDefined();
		expect(saved.provider.openai.models["gpt-5.5"]).toBeDefined();
	});

	it("parses BOM-less existing config and preserves custom keys on merge", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");

		await mkdir(configDir, { recursive: true });
		await writeFile(
			configPath,
			JSON.stringify(
				{
					plugin: ["some-other-plugin"],
					provider: {
						openai: {
							myCustomKey: "preserve-me",
							models: {
								"user-only-model": { name: "User Only Model" },
							},
						},
					},
				},
				null,
				2,
			),
			"utf-8",
		);

		await expect(
			runInstaller(["--modern", "--no-cache-clear"], {
				env: {
					...process.env,
					HOME: tempHome,
					USERPROFILE: tempHome,
				},
			}),
		).resolves.toMatchObject({
			action: "install",
			exitCode: 0,
		});

		const saved = JSON.parse(await readFile(configPath, "utf-8")) as {
			provider: {
				openai: {
					myCustomKey?: string;
					models: Record<string, unknown>;
				};
			};
		};

		expect(saved.provider.openai.myCustomKey).toBe("preserve-me");
		expect(saved.provider.openai.models["user-only-model"]).toBeDefined();
		expect(saved.provider.openai.models["gpt-5.5"]).toBeDefined();
	});

	it("deep-merges provider.openai preserving user customizations while overwriting managed keys", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");

		await mkdir(configDir, { recursive: true });
		await writeFile(
			configPath,
			JSON.stringify({
				provider: {
					openai: {
						baseURL: "https://legacy.example.com",
						apiKey: "{env:OPENAI_API_KEY}",
						myCustomKey: "preserved",
						nested: { foo: "bar" },
						options: { textVerbosity: "low" },
						models: {
							"gpt-5.5": { name: "user override" },
							"my-fine-tune": { name: "custom user model" },
						},
					},
				},
			}, null, 2),
			"utf-8",
		);

		await expect(
			runInstaller(["--modern", "--no-cache-clear"], {
				env: {
					...process.env,
					HOME: tempHome,
					USERPROFILE: tempHome,
				},
			}),
		).resolves.toMatchObject({
			action: "install",
			exitCode: 0,
		});

		const saved = JSON.parse(await readFile(configPath, "utf-8")) as {
			provider: {
				openai: Record<string, unknown> & {
					options?: Record<string, unknown>;
					models?: Record<string, unknown>;
				};
			};
		};

		// Managed keys overwritten: baseURL / apiKey removed (template does not set
		// them), options replaced with template value, models.gpt-5.5 reset to template.
		expect(saved.provider.openai.baseURL).toBeUndefined();
		expect(saved.provider.openai.apiKey).toBeUndefined();
		expect(saved.provider.openai.options).not.toEqual({ textVerbosity: "low" });
		expect(saved.provider.openai.models?.["gpt-5.5"]).not.toEqual({ name: "user override" });

		// Non-managed keys preserved as-is.
		expect(saved.provider.openai.myCustomKey).toBe("preserved");
		expect(saved.provider.openai.nested).toEqual({ foo: "bar" });

		// User-added model surviving deep-merge.
		expect(saved.provider.openai.models?.["my-fine-tune"]).toEqual({ name: "custom user model" });
	});

	it("dry-run does not write and prints a diff to stdout", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");

		await mkdir(configDir, { recursive: true });
		await writeFile(
			configPath,
			JSON.stringify({
				plugin: ["existing-plugin"],
				secretToken: "do-not-print-this-token",
				accountEmail: "private@example.com",
				rawPrompt: "do not print this prompt",
				provider: {
					openai: {
						apiKey: "do-not-print-this-api-key",
						models: { "pre-existing": { name: "pre-existing" } },
					},
				},
			}, null, 2),
			"utf-8",
		);

		const result = await runInstaller(["--modern", "--dry-run", "--no-cache-clear"], {
			env: {
				...process.env,
				HOME: tempHome,
				USERPROFILE: tempHome,
			},
		});

		expect(result).toMatchObject({ action: "install", dryRun: true, wrote: false, exitCode: 0 });

		const stdout = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
		expect(stdout).toContain("[dry-run] Diff for");
		expect(stdout).toContain("$.provider");
		expect(stdout).not.toContain("do-not-print-this-token");
		expect(stdout).not.toContain("private@example.com");
		expect(stdout).not.toContain("do not print this prompt");
		expect(stdout).not.toContain("do-not-print-this-api-key");

		// Disk state must remain the literal prior contents (no overwrite, no backup write).
		const onDisk = JSON.parse(await readFile(configPath, "utf-8")) as {
			plugin: string[];
			provider: { openai: { models: Record<string, unknown> } };
		};
		expect(onDisk.plugin).toEqual(["existing-plugin"]);
		expect(onDisk.provider.openai.models["pre-existing"]).toBeDefined();
		const entries = await readdir(configDir);
		expect(entries).toEqual(["opencode.json"]);
	});

	it("formatConfigDiff unit: emits proposed markers when there is no existing config", async () => {
		vi.resetModules();
		const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const diff = __test.formatConfigDiff(undefined, { provider: { openai: { models: {} } } });
		expect(diff).toContain("--- existing");
		expect(diff).toContain("+++ proposed");
		expect(diff).toContain("- (no existing config)");
		expect(diff).toContain("+ ");
		expect(diff).toContain("provider");
	});

	it("update clears bare and latest cache layouts without reading or writing config", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");
		const tuiConfigPath = join(configDir, "tui.json");
		const cacheDir = join(tempHome, ".cache", "opencode", "packages");
		const bareCache = join(cacheDir, "oc-codex-multi-auth");
		const latestCache = join(cacheDir, "oc-codex-multi-auth@latest");
		const invalidConfig = "{ this is intentionally invalid json";
		const invalidTuiConfig = "{ this is also intentionally invalid json";

		await mkdir(configDir, { recursive: true });
		await mkdir(bareCache, { recursive: true });
		await mkdir(latestCache, { recursive: true });
		await writeFile(configPath, invalidConfig, "utf-8");
		await writeFile(tuiConfigPath, invalidTuiConfig, "utf-8");
		await writeFile(join(bareCache, "package.json"), "{}", "utf-8");
		await writeFile(join(latestCache, "package.json"), "{}", "utf-8");

		await expect(
			runInstaller(["update"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "update", dryRun: false, exitCode: 0 });

		await expect(readFile(configPath, "utf-8")).resolves.toBe(invalidConfig);
		await expect(readFile(tuiConfigPath, "utf-8")).resolves.toBe(invalidTuiConfig);
		await expect(readdir(cacheDir)).resolves.toEqual([]);
		await expect(readdir(configDir)).resolves.toEqual(["opencode.json", "tui.json"]);
	});

	it("install --plugin-only preserves provider.openai while registering the plugin", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");
		const openai = {
			baseURL: "https://example.invalid/v1",
			apiKey: "{env:OPENAI_API_KEY}",
			options: { store: true, customOption: "keep" },
			models: { custom: { name: "Custom model" } },
		};

		await mkdir(configDir, { recursive: true });
		await writeFile(
			configPath,
			JSON.stringify({ plugin: ["existing-plugin"], provider: { openai } }, null, 2),
			"utf-8",
		);

		await expect(
			runInstaller(["install", "--plugin-only", "--no-cache-clear"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({
			action: "install",
			pluginOnly: true,
			exitCode: 0,
		});

		const saved = JSON.parse(await readFile(configPath, "utf-8")) as {
			plugin: string[];
			provider: { openai: typeof openai };
		};
		expect(saved.plugin).toEqual(["existing-plugin", "oc-codex-multi-auth"]);
		expect(saved.provider.openai).toEqual(openai);
	});

	it("does not rewrite or back up semantically unchanged plugin-only config", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");
		const tuiConfigPath = join(configDir, "tui.json");
		const configText = '{"plugin":["oc-codex-multi-auth"],"provider":{"openai":{"custom":true}}}';
		const tuiText = '{"$schema":"https://opencode.ai/tui.json","plugin":["oc-codex-multi-auth"]}';

		await mkdir(configDir, { recursive: true });
		await writeFile(configPath, configText, "utf-8");
		await writeFile(tuiConfigPath, tuiText, "utf-8");

		await expect(
			runInstaller(["install", "--plugin-only", "--no-cache-clear"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ wrote: false, pluginOnly: true, exitCode: 0 });

		await expect(readFile(configPath, "utf-8")).resolves.toBe(configText);
		await expect(readFile(tuiConfigPath, "utf-8")).resolves.toBe(tuiText);
		await expect(readdir(configDir)).resolves.toEqual(["opencode.json", "tui.json"]);
	});

	it("install --plugin-only refuses to replace malformed config", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");
		const invalidConfig = "{ invalid";

		await mkdir(configDir, { recursive: true });
		await writeFile(configPath, invalidConfig, "utf-8");

		await expect(
			runInstaller(["install", "--plugin-only"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).rejects.toThrow("Could not parse existing config");
		await expect(readFile(configPath, "utf-8")).resolves.toBe(invalidConfig);
		await expect(readdir(configDir)).resolves.toEqual(["opencode.json"]);
	});

	it.each([
		{ label: "null", content: "null" },
		{ label: "array", content: "[]" },
		{ label: "string", content: '"invalid"' },
		{ label: "number", content: "42" },
	])("default install refuses structurally invalid $label config", async ({ content }) => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");

		await mkdir(configDir, { recursive: true });
		await writeFile(configPath, content, "utf-8");

		await expect(
			runInstaller([], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).rejects.toThrow("config root must be a JSON object");
		await expect(readFile(configPath, "utf-8")).resolves.toBe(content);
		await expect(readdir(configDir)).resolves.toEqual(["opencode.json"]);
	});

	it("install --plugin-only refuses to replace malformed TUI config", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");
		const tuiConfigPath = join(configDir, "tui.json");
		const configText = '{"plugin":["oc-codex-multi-auth"]}';
		const invalidTuiConfig = "{ invalid";

		await mkdir(configDir, { recursive: true });
		await writeFile(configPath, configText, "utf-8");
		await writeFile(tuiConfigPath, invalidTuiConfig, "utf-8");

		await expect(
			runInstaller(["install", "--plugin-only"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).rejects.toThrow("Could not parse existing TUI config");
		await expect(readFile(configPath, "utf-8")).resolves.toBe(configText);
		await expect(readFile(tuiConfigPath, "utf-8")).resolves.toBe(invalidTuiConfig);
		await expect(readdir(configDir)).resolves.toEqual(["opencode.json", "tui.json"]);
	});

	it("default install refuses structurally invalid TUI config", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");
		const tuiConfigPath = join(configDir, "tui.json");
		const configText = '{"plugin":["oc-codex-multi-auth"]}';
		const invalidTuiConfig = "[]";

		await mkdir(configDir, { recursive: true });
		await writeFile(configPath, configText, "utf-8");
		await writeFile(tuiConfigPath, invalidTuiConfig, "utf-8");

		await expect(
			runInstaller([], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).rejects.toThrow("TUI config root must be a JSON object");
		await expect(readFile(configPath, "utf-8")).resolves.toBe(configText);
		await expect(readFile(tuiConfigPath, "utf-8")).resolves.toBe(invalidTuiConfig);
		await expect(readdir(configDir)).resolves.toEqual(["opencode.json", "tui.json"]);
	});

	it("mergeOpenaiProvider unit: strips unknown managed keys even when template omits them", async () => {
		vi.resetModules();
		const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const merged = __test.mergeOpenaiProvider(
			{
				baseURL: "https://legacy.example.com",
				apiKey: "user-secret",
				options: { textVerbosity: "low" },
				myCustomKey: "keep",
				models: {
					shared: { name: "user-shared" },
					userOnly: { name: "user-only" },
				},
			},
			{
				options: { textVerbosity: "medium" },
				models: {
					shared: { name: "template-shared" },
					templateOnly: { name: "template-only" },
				},
			},
		);
		expect(merged.baseURL).toBeUndefined();
		expect(merged.apiKey).toBeUndefined();
		expect(merged.options).toEqual({ textVerbosity: "medium" });
		expect(merged.myCustomKey).toBe("keep");
		expect(merged.models).toEqual({
			shared: { name: "template-shared" },
			userOnly: { name: "user-only" },
			templateOnly: { name: "template-only" },
		});
	});

	it("mergeOpenaiProvider unit: prunes known managed model keys while preserving custom models", async () => {
		vi.resetModules();
		const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const merged = __test.mergeOpenaiProvider(
			{
				models: {
					"gpt-5.5-high": { name: "stale explicit preset" },
					"userOnly": { name: "custom user model" },
				},
			},
			{
				models: {
					"gpt-5.5": { name: "compact base model" },
				},
			},
			{
				modelKeysToRemove: new Set(["gpt-5.5-high"]),
			},
		);

		expect(merged.models).toEqual({
			userOnly: { name: "custom user model" },
			"gpt-5.5": { name: "compact base model" },
		});
	});

	it("keeps cache files when --no-cache-clear is set but still unpins the cached package entry", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");
		const cacheDir = join(tempHome, ".cache", "opencode");
		const legacyCacheNodeModules = join(cacheDir, "node_modules", "oc-chatgpt-multi-auth");
		const cacheNodeModules = join(cacheDir, "node_modules", "oc-codex-multi-auth");
		const cacheBunLock = join(cacheDir, "bun.lock");
		const cachePackageJson = join(cacheDir, "package.json");

		await mkdir(configDir, { recursive: true });
		await mkdir(cacheNodeModules, { recursive: true });
		await mkdir(legacyCacheNodeModules, { recursive: true });
		await writeFile(configPath, JSON.stringify({ plugin: [] }, null, 2), "utf-8");
		await writeFile(cacheBunLock, "lockfile", "utf-8");
		await writeFile(
			cachePackageJson,
			JSON.stringify(
				{
					dependencies: {
						"oc-chatgpt-multi-auth": "file:../pinned-plugin.tgz",
						"oc-codex-multi-auth": "file:../new-plugin.tgz",
						other: "^1.0.0",
					},
				},
				null,
				2,
			),
			"utf-8",
		);

		await expect(
			runInstaller(["--no-cache-clear"], {
				env: {
					...process.env,
					HOME: tempHome,
					USERPROFILE: tempHome,
				},
			}),
		).resolves.toMatchObject({
			action: "install",
			configMode: "plugin-only",
			exitCode: 0,
		});

		await expect(readFile(cacheBunLock, "utf-8")).resolves.toBe("lockfile");
		await expect(readdir(cacheNodeModules)).resolves.toEqual([]);
		await expect(readdir(legacyCacheNodeModules)).resolves.toEqual([]);
		const cachePackage = JSON.parse(await readFile(cachePackageJson, "utf-8")) as {
			dependencies: Record<string, string>;
		};
		expect(cachePackage.dependencies["oc-chatgpt-multi-auth"]).toBeUndefined();
		expect(cachePackage.dependencies["oc-codex-multi-auth"]).toBeUndefined();
		expect(cachePackage.dependencies.other).toBe("^1.0.0");
	});

	it("clears OpenCode node_modules and package cache layouts", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");
		const cacheDir = join(tempHome, ".cache", "opencode");
		const legacyCacheNodeModules = join(cacheDir, "node_modules", "oc-chatgpt-multi-auth");
		const cacheNodeModules = join(cacheDir, "node_modules", "oc-codex-multi-auth");
		const legacyCachePackage = join(cacheDir, "packages", "oc-chatgpt-multi-auth@latest");
		const cachePackage = join(cacheDir, "packages", "oc-codex-multi-auth@latest");
		const cacheBunLock = join(cacheDir, "bun.lock");
		const cachePackageJson = join(cacheDir, "package.json");

		await mkdir(configDir, { recursive: true });
		await mkdir(cacheNodeModules, { recursive: true });
		await mkdir(legacyCacheNodeModules, { recursive: true });
		await mkdir(cachePackage, { recursive: true });
		await mkdir(legacyCachePackage, { recursive: true });
		await writeFile(configPath, JSON.stringify({ plugin: [] }, null, 2), "utf-8");
		await writeFile(join(cacheNodeModules, "package.json"), "{}", "utf-8");
		await writeFile(join(legacyCacheNodeModules, "package.json"), "{}", "utf-8");
		await writeFile(join(cachePackage, "package.json"), "{}", "utf-8");
		await writeFile(join(legacyCachePackage, "package.json"), "{}", "utf-8");
		await writeFile(cacheBunLock, "lockfile", "utf-8");
		await writeFile(
			cachePackageJson,
			JSON.stringify(
				{
					dependencies: {
						"oc-chatgpt-multi-auth": "file:../pinned-plugin.tgz",
						"oc-codex-multi-auth": "file:../new-plugin.tgz",
						other: "^1.0.0",
					},
				},
				null,
				2,
			),
			"utf-8",
		);

		await expect(
			runInstaller([], {
				env: {
					...process.env,
					HOME: tempHome,
					USERPROFILE: tempHome,
				},
			}),
		).resolves.toMatchObject({
			action: "install",
			configMode: "plugin-only",
			exitCode: 0,
		});

		await expect(readdir(cacheNodeModules)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readdir(legacyCacheNodeModules)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readdir(cachePackage)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readdir(legacyCachePackage)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readFile(cacheBunLock, "utf-8")).rejects.toMatchObject({ code: "ENOENT" });

		const cachedPackageJson = JSON.parse(await readFile(cachePackageJson, "utf-8")) as {
			dependencies: Record<string, string>;
		};
		expect(cachedPackageJson.dependencies["oc-chatgpt-multi-auth"]).toBeUndefined();
		expect(cachedPackageJson.dependencies["oc-codex-multi-auth"]).toBeUndefined();
		expect(cachedPackageJson.dependencies.other).toBe("^1.0.0");
	});

	it("refuses to clear cache targets when the OpenCode cache directory resolves through a symlink", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const configDir = join(tempHome, ".config", "opencode");
		const realCacheDir = join(tempHome, "real-opencode-cache");
		const cacheDirLink = join(tempHome, ".cache", "opencode");
		const managedCache = join(realCacheDir, "node_modules", "oc-codex-multi-auth");
		const realBunLock = join(realCacheDir, "bun.lock");

		await mkdir(configDir, { recursive: true });
		await mkdir(managedCache, { recursive: true });
		await mkdir(dirname(cacheDirLink), { recursive: true });
		await writeFile(join(managedCache, "keep.txt"), "keep", "utf-8");
		await writeFile(realBunLock, "lockfile", "utf-8");
		await symlink(realCacheDir, cacheDirLink, "dir");

		await expect(
			runInstaller(["update"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "update", exitCode: 0 });

		// The recursive delete must not follow the link into the real directory.
		expect(await readFile(join(managedCache, "keep.txt"), "utf-8")).toBe("keep");
		expect(await readFile(realBunLock, "utf-8")).toBe("lockfile");
		const stdout = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
		expect(stdout).toContain("does not resolve inside the OpenCode cache");
	});

	it("rejects full-mode merges when modern and legacy templates overlap", async () => {
		vi.resetModules();
		const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		const modernTemplate = {
			provider: {
				openai: {
					models: {
						"gpt-5.4": { name: "base" },
					},
				},
			},
		};
		const legacyTemplate = {
			provider: {
				openai: {
					models: {
						"gpt-5.4": { name: "preset" },
					},
				},
			},
		};

		expect(() => __test.mergeFullTemplate(modernTemplate, legacyTemplate)).toThrow(
			/Full config template collision/,
		);
	});

	it("retries backup copies after transient Windows lock errors", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const sourcePath = join(tempHome, "opencode.json");
		const copyFileMock = vi.fn()
			.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }))
			.mockResolvedValue(undefined);

		vi.doMock("node:fs/promises", async () => {
			const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
			return {
				...actual,
				copyFile: copyFileMock,
			};
		});

		const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const backupPath = await __test.backupConfig(sourcePath, false);

		expect(copyFileMock).toHaveBeenCalledTimes(2);
		expect(copyFileMock).toHaveBeenNthCalledWith(1, sourcePath, backupPath);
		expect(copyFileMock).toHaveBeenNthCalledWith(2, sourcePath, backupPath);
		expect(backupPath).toMatch(/opencode\.json\.bak-/);
	});

	it("retries atomic rename after transient Windows lock errors", async () => {
		vi.resetModules();
		const renameMock = vi.fn()
			.mockRejectedValueOnce(Object.assign(new Error("locked"), { code: "EPERM" }))
			.mockResolvedValue(undefined);

		vi.doMock("node:fs/promises", async () => {
			const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
			return {
				...actual,
				rename: renameMock,
			};
		});

		const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		await expect(__test.renameWithWindowsRetry("from.tmp", "to.json")).resolves.toBeUndefined();
		expect(renameMock).toHaveBeenCalledTimes(2);
		expect(renameMock).toHaveBeenNthCalledWith(1, "from.tmp", "to.json");
		expect(renameMock).toHaveBeenNthCalledWith(2, "from.tmp", "to.json");
	});

	it.each(["EPERM", "EBUSY"])("retries update cache removal after transient Windows %s errors", async (code) => {
		vi.resetModules();
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const firstCachePath = join(tempHome, ".cache", "opencode", "node_modules", "oc-codex-multi-auth");
		await mkdir(firstCachePath, { recursive: true });
		const rmMock = vi.fn()
			.mockRejectedValueOnce(Object.assign(new Error("locked"), { code }))
			.mockResolvedValue(undefined);

		vi.doMock("node:fs/promises", async () => {
			const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
			return {
				...actual,
				rm: rmMock,
			};
		});

		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		await expect(
			runInstaller(["update"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "update", exitCode: 0 });

		expect(rmMock).toHaveBeenNthCalledWith(1, firstCachePath, { recursive: true, force: true });
		expect(rmMock).toHaveBeenNthCalledWith(2, firstCachePath, { recursive: true, force: true });
	});

	describe("plugin entry registration", () => {
		async function createCheckout(root: string, packageName: string, directoryName: string) {
			const directory = join(root, directoryName);
			await mkdir(directory, { recursive: true });
			await writeFile(
				join(directory, "package.json"),
				JSON.stringify({ name: packageName, version: "1.0.0" }),
				"utf-8",
			);
			return directory;
		}

		it("keeps a local checkout however it is spelled and does not add the published name", async () => {
			vi.resetModules();
			tempHome = await createTempHome();
			vi.stubEnv("HOME", tempHome);
			vi.stubEnv("USERPROFILE", tempHome);
			const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");
			const checkout = await createCheckout(tempHome, "oc-codex-multi-auth", "oc-codex-multi-auth");
			const buildOutput = join(checkout, "dist");
			await mkdir(buildOutput, { recursive: true });
			const forkInDifferentlyNamedDirectory = await createCheckout(
				tempHome,
				"oc-codex-multi-auth",
				"my-codex-fork",
			);
			const monorepoCheckout = await createCheckout(
				join(tempHome, "workspace", "packages"),
				"oc-codex-multi-auth",
				"oc-codex-multi-auth",
			);

			for (const entry of [
				checkout,
				pathToFileURL(checkout).href,
				buildOutput,
				forkInDifferentlyNamedDirectory,
				monorepoCheckout,
			]) {
				expect(__test.normalizePluginList(["other-plugin", entry])).toEqual([
					"other-plugin",
					entry,
				]);
			}
		});

		it("retires package-manager references while leaving a published-name entry in place", async () => {
			vi.resetModules();
			const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");

			expect(
				__test.normalizePluginList([
					"oc-codex-multi-auth",
					"other-plugin",
					"oc-chatgpt-multi-auth@1.2.3",
					"/absent/node_modules/oc-codex-multi-auth",
					// pathToFileURL, not a literal: Windows rejects a drive-less file URL.
					pathToFileURL(resolve("/absent/node_modules/oc-chatgpt-multi-auth/dist")).href,
					"/absent/.cache/opencode/packages/oc-codex-multi-auth@latest",
				]),
			).toEqual(["oc-codex-multi-auth", "other-plugin"]);
		});

		it("preserves a path it cannot resolve unless the path is package-manager output", async () => {
			vi.resetModules();
			const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");
			const unmountedCheckout = "/absent/projects/oc-codex-multi-auth";

			expect(__test.normalizePluginList([unmountedCheckout])).toEqual([unmountedCheckout]);
		});

		it("never rewrites an entry that carries plugin options", async () => {
			vi.resetModules();
			tempHome = await createTempHome();
			vi.stubEnv("HOME", tempHome);
			vi.stubEnv("USERPROFILE", tempHome);
			const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");
			const checkout = await createCheckout(tempHome, "oc-codex-multi-auth", "oc-codex-multi-auth");
			const configuredCheckout = [checkout, { debug: true }];
			const configuredUnrelated = ["other-plugin", { debug: true }];

			expect(__test.normalizePluginList([configuredCheckout])).toEqual([configuredCheckout]);
			expect(__test.normalizePluginList([configuredUnrelated])).toEqual([
				configuredUnrelated,
				"oc-codex-multi-auth",
			]);
		});

		it("registers the published name without touching an unrelated local plugin", async () => {
			vi.resetModules();
			tempHome = await createTempHome();
			vi.stubEnv("HOME", tempHome);
			vi.stubEnv("USERPROFILE", tempHome);
			const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");
			const unrelated = await createCheckout(tempHome, "some-other-plugin", "some-other-plugin");

			expect(__test.normalizePluginList([unrelated])).toEqual([unrelated, "oc-codex-multi-auth"]);
		});

		it("leaves a config that already registers a local checkout untouched", async () => {
			vi.resetModules();
			tempHome = await createTempHome();
			vi.stubEnv("HOME", tempHome);
			vi.stubEnv("USERPROFILE", tempHome);
			const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
			const checkout = await createCheckout(tempHome, "oc-codex-multi-auth", "oc-codex-multi-auth");
			const entry = pathToFileURL(checkout).href;
			const configDir = join(tempHome, ".config", "opencode");
			const configPath = join(configDir, "opencode.json");
			const tuiConfigPath = join(configDir, "tui.json");
			const configText = `${JSON.stringify({ plugin: [entry] }, null, 2)}\n`;
			const tuiText = `${JSON.stringify(
				{ $schema: "https://opencode.ai/tui.json", plugin: [entry] },
				null,
				2,
			)}\n`;

			await mkdir(configDir, { recursive: true });
			await writeFile(configPath, configText, "utf-8");
			await writeFile(tuiConfigPath, tuiText, "utf-8");

			await expect(
				runInstaller(["install", "--plugin-only", "--no-cache-clear"], {
					env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
				}),
			).resolves.toMatchObject({ wrote: false, pluginOnly: true, exitCode: 0 });

			await expect(readFile(configPath, "utf-8")).resolves.toBe(configText);
			await expect(readFile(tuiConfigPath, "utf-8")).resolves.toBe(tuiText);
			await expect(readdir(configDir)).resolves.toEqual(["opencode.json", "tui.json"]);
		});

		async function writeOriginHistory(home: string, sightings: unknown[]) {
			const historyPath = join(home, ".opencode", "oc-codex-multi-auth-origin.json");
			await mkdir(join(home, ".opencode"), { recursive: true });
			await writeFile(historyPath, JSON.stringify({ version: 1, sightings }), "utf-8");
			return historyPath;
		}

		function sightingFor(root: string) {
			return {
				name: "oc-codex-multi-auth",
				version: "6.21.0",
				root,
				isLocalCheckout: true,
				firstSeen: "2026-01-01T00:00:00.000Z",
				lastSeen: "2026-02-01T00:00:00.000Z",
			};
		}

		it("reports a checkout the plugin ran from that the config no longer registers", async () => {
			vi.resetModules();
			tempHome = await createTempHome();
			vi.stubEnv("HOME", tempHome);
			vi.stubEnv("USERPROFILE", tempHome);
			const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");
			const checkout = await createCheckout(tempHome, "oc-codex-multi-auth", "oc-codex-multi-auth");
			const historyPath = await writeOriginHistory(tempHome, [sightingFor(checkout)]);

			expect(__test.findUnregisteredLocalCheckout(["oc-codex-multi-auth"], historyPath)).toMatchObject({
				root: checkout,
			});
			expect(__test.findUnregisteredLocalCheckout([checkout], historyPath)).toBeNull();
		});

		it("stays silent when the recorded checkout is gone or was never recorded", async () => {
			vi.resetModules();
			tempHome = await createTempHome();
			vi.stubEnv("HOME", tempHome);
			vi.stubEnv("USERPROFILE", tempHome);
			const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");
			const absent = join(tempHome, "deleted-checkout");
			const historyPath = await writeOriginHistory(tempHome, [sightingFor(absent)]);

			expect(__test.findUnregisteredLocalCheckout(["oc-codex-multi-auth"], historyPath)).toBeNull();
			expect(
				__test.findUnregisteredLocalCheckout(
					["oc-codex-multi-auth"],
					join(tempHome, ".opencode", "absent.json"),
				),
			).toBeNull();
		});

		it("stays silent when the recorded directory now holds a different package", async () => {
			vi.resetModules();
			tempHome = await createTempHome();
			vi.stubEnv("HOME", tempHome);
			vi.stubEnv("USERPROFILE", tempHome);
			const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");
			const reusedRoot = await createCheckout(tempHome, "oc-codex-multi-auth", "reused-root");
			const historyPath = await writeOriginHistory(tempHome, [sightingFor(reusedRoot)]);

			expect(
				__test.findUnregisteredLocalCheckout(["oc-codex-multi-auth"], historyPath)?.root,
			).toBe(reusedRoot);

			// Same path, cloned over with something else since it was recorded.
			await writeFile(
				join(reusedRoot, "package.json"),
				JSON.stringify({ name: "some-unrelated-project", version: "1.0.0" }),
				"utf-8",
			);

			expect(
				__test.findUnregisteredLocalCheckout(["oc-codex-multi-auth"], historyPath),
			).toBeNull();
		});

		it("names the replaced checkout without restoring it to the config", async () => {
			vi.resetModules();
			tempHome = await createTempHome();
			vi.stubEnv("HOME", tempHome);
			vi.stubEnv("USERPROFILE", tempHome);
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
			const checkout = await createCheckout(tempHome, "oc-codex-multi-auth", "oc-codex-multi-auth");
			await writeOriginHistory(tempHome, [sightingFor(checkout)]);
			const configDir = join(tempHome, ".config", "opencode");
			const configPath = join(configDir, "opencode.json");

			await mkdir(configDir, { recursive: true });
			await writeFile(
				configPath,
				JSON.stringify({ plugin: ["oc-codex-multi-auth"] }, null, 2),
				"utf-8",
			);

			await expect(
				runInstaller(["install", "--plugin-only", "--no-cache-clear"], {
					env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
				}),
			).resolves.toMatchObject({ exitCode: 0 });

			const stdout = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
			expect(stdout).toContain(checkout);
			expect(stdout).toContain("last loaded from a checkout");

			const saved = JSON.parse(await readFile(configPath, "utf-8")) as { plugin: string[] };
			expect(saved.plugin).toEqual(["oc-codex-multi-auth"]);
		});

		it("keeps a local checkout when a catalog mode rewrites provider.openai", async () => {
			vi.resetModules();
			tempHome = await createTempHome();
			vi.stubEnv("HOME", tempHome);
			vi.stubEnv("USERPROFILE", tempHome);
			const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
			const checkout = await createCheckout(tempHome, "oc-codex-multi-auth", "oc-codex-multi-auth");
			const entry = pathToFileURL(checkout).href;
			const configDir = join(tempHome, ".config", "opencode");
			const configPath = join(configDir, "opencode.json");

			await mkdir(configDir, { recursive: true });
			await writeFile(configPath, JSON.stringify({ plugin: [entry] }, null, 2), "utf-8");

			await expect(
				runInstaller(["--modern", "--no-cache-clear"], {
					env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
				}),
			).resolves.toMatchObject({ action: "install", configMode: "modern", exitCode: 0 });

			const saved = JSON.parse(await readFile(configPath, "utf-8")) as { plugin: string[] };
			expect(saved.plugin).toEqual([entry]);
		});

		it("recognizes a relative checkout through the config directory that declares it", async () => {
			vi.resetModules();
			tempHome = await createTempHome();
			vi.stubEnv("HOME", tempHome);
			vi.stubEnv("USERPROFILE", tempHome);
			const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");
			const configDir = join(tempHome, ".config", "opencode");
			await mkdir(configDir, { recursive: true });
			await createCheckout(tempHome, "oc-codex-multi-auth", "my-codex-fork");
			const relativeEntry = "../../my-codex-fork";
			const relativeBuildOutput = "../../my-codex-fork/dist";

			for (const entry of [relativeEntry, relativeBuildOutput]) {
				expect(
					__test.normalizePluginList(["other-plugin", entry], undefined, {
						baseDirectory: configDir,
					}),
				).toEqual(["other-plugin", entry]);
			}

			// Without a declaring directory the same spelling names nowhere in
			// particular, so it stays put rather than being retired on a guess.
			expect(__test.normalizePluginList([relativeEntry])).toEqual([
				relativeEntry,
				"oc-codex-multi-auth",
			]);
		});

		it("drops a published entry left beside a registered checkout", async () => {
			vi.resetModules();
			tempHome = await createTempHome();
			vi.stubEnv("HOME", tempHome);
			vi.stubEnv("USERPROFILE", tempHome);
			const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");
			const checkout = await createCheckout(tempHome, "oc-codex-multi-auth", "my-codex-fork");

			expect(
				__test.normalizePluginList(["other-plugin", checkout, "oc-codex-multi-auth"]),
			).toEqual(["other-plugin", checkout]);
			expect(
				__test.normalizePluginList(["oc-codex-multi-auth", "other-plugin", checkout]),
			).toEqual(["other-plugin", checkout]);
		});

		it("keeps every checkout of this package that a config registers", async () => {
			vi.resetModules();
			tempHome = await createTempHome();
			vi.stubEnv("HOME", tempHome);
			vi.stubEnv("USERPROFILE", tempHome);
			const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");
			const first = await createCheckout(tempHome, "oc-codex-multi-auth", "fork-one");
			const second = await createCheckout(tempHome, "oc-codex-multi-auth", "fork-two");

			expect(__test.normalizePluginList([first, second])).toEqual([first, second]);
		});

		it("registers the current package beside a checkout of the former one", async () => {
			vi.resetModules();
			tempHome = await createTempHome();
			vi.stubEnv("HOME", tempHome);
			vi.stubEnv("USERPROFILE", tempHome);
			const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");
			const legacyCheckout = await createCheckout(
				tempHome,
				"oc-chatgpt-multi-auth",
				"my-legacy-fork",
			);

			expect(__test.normalizePluginList([legacyCheckout])).toEqual([
				legacyCheckout,
				"oc-codex-multi-auth",
			]);
		});

		it("treats package-manager path segments case-insensitively only on Windows", async () => {
			vi.resetModules();
			const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");
			const uppercased = "C:/Users/dev/NODE_MODULES/oc-codex-multi-auth";

			expect(
				__test.classifyPluginEntry(uppercased, { platform: "win32" }),
			).toMatchObject({ kind: "managed-package", name: "oc-codex-multi-auth" });
			expect(
				__test.classifyPluginEntry(uppercased, { platform: "linux" }),
			).toMatchObject({ kind: "local-checkout", name: "oc-codex-multi-auth" });
		});

		it("leaves a config registering a relative checkout untouched end to end", async () => {
			vi.resetModules();
			tempHome = await createTempHome();
			vi.stubEnv("HOME", tempHome);
			vi.stubEnv("USERPROFILE", tempHome);
			const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
			await createCheckout(tempHome, "oc-codex-multi-auth", "my-codex-fork");
			const entry = "../../my-codex-fork";
			const configDir = join(tempHome, ".config", "opencode");
			const configPath = join(configDir, "opencode.json");
			const tuiConfigPath = join(configDir, "tui.json");
			const configText = `${JSON.stringify({ plugin: [entry] }, null, 2)}\n`;
			const tuiText = `${JSON.stringify(
				{ $schema: "https://opencode.ai/tui.json", plugin: [entry] },
				null,
				2,
			)}\n`;

			await mkdir(configDir, { recursive: true });
			await writeFile(configPath, configText, "utf-8");
			await writeFile(tuiConfigPath, tuiText, "utf-8");

			await expect(
				runInstaller(["install", "--plugin-only", "--no-cache-clear"], {
					env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
				}),
			).resolves.toMatchObject({ wrote: false, pluginOnly: true, exitCode: 0 });

			await expect(readFile(configPath, "utf-8")).resolves.toBe(configText);
			await expect(readFile(tuiConfigPath, "utf-8")).resolves.toBe(tuiText);
			await expect(readdir(configDir)).resolves.toEqual(["opencode.json", "tui.json"]);
		});

		it("retires a cache copy this installer deletes, versioned or not", async () => {
			vi.resetModules();
			tempHome = await createTempHome();
			vi.stubEnv("HOME", tempHome);
			vi.stubEnv("USERPROFILE", tempHome);
			const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");
			const cacheDirectory = join(tempHome, ".cache", "opencode");
			const packagesDirectory = join(cacheDirectory, "packages");
			const unversioned = await createCheckout(
				packagesDirectory,
				"oc-codex-multi-auth",
				"oc-codex-multi-auth",
			);
			const versioned = await createCheckout(
				packagesDirectory,
				"oc-codex-multi-auth",
				"oc-codex-multi-auth@latest",
			);

			for (const entry of [unversioned, versioned]) {
				expect(__test.normalizePluginList([entry], undefined, { cacheDirectory })).toEqual([
					"oc-codex-multi-auth",
				]);
			}
		});

		it("keeps a monorepo checkout that merely spells its directory like the cache", async () => {
			vi.resetModules();
			tempHome = await createTempHome();
			vi.stubEnv("HOME", tempHome);
			vi.stubEnv("USERPROFILE", tempHome);
			const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");
			const cacheDirectory = join(tempHome, ".cache", "opencode");
			const monorepoCheckout = await createCheckout(
				join(tempHome, "workspace", "packages"),
				"oc-codex-multi-auth",
				"oc-codex-multi-auth",
			);

			expect(
				__test.normalizePluginList([monorepoCheckout], undefined, { cacheDirectory }),
			).toEqual([monorepoCheckout]);
		});

		it("never leaves the config pointing at the cache copy it just deleted", async () => {
			vi.resetModules();
			tempHome = await createTempHome();
			vi.stubEnv("HOME", tempHome);
			vi.stubEnv("USERPROFILE", tempHome);
			const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
			const cachePackage = await createCheckout(
				join(tempHome, ".cache", "opencode", "packages"),
				"oc-codex-multi-auth",
				"oc-codex-multi-auth",
			);
			const configDir = join(tempHome, ".config", "opencode");
			const configPath = join(configDir, "opencode.json");

			await mkdir(configDir, { recursive: true });
			await writeFile(
				configPath,
				JSON.stringify({ plugin: [pathToFileURL(cachePackage).href] }, null, 2),
				"utf-8",
			);

			await expect(
				runInstaller([], {
					env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
				}),
			).resolves.toMatchObject({ action: "install", exitCode: 0 });

			const saved = JSON.parse(await readFile(configPath, "utf-8")) as { plugin: string[] };
			expect(saved.plugin).toEqual(["oc-codex-multi-auth"]);
			await expect(readdir(cachePackage)).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("does not let a foreign specifier spelling this package's name retire the published entry", async () => {
			vi.resetModules();
			const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");

			// Scoped and URL spellings are registry specifiers, not paths: they
			// compare by exact canonical name, never by their last segment.
			expect(
				__test.normalizePluginList(["oc-codex-multi-auth", "@evil/oc-codex-multi-auth"]),
			).toEqual(["oc-codex-multi-auth", "@evil/oc-codex-multi-auth"]);
			expect(
				__test.normalizePluginList(["https://github.com/example/oc-codex-multi-auth"]),
			).toEqual(["https://github.com/example/oc-codex-multi-auth", "oc-codex-multi-auth"]);
			expect(
				__test.normalizePluginList(["oc-codex-multi-auth", "npm:oc-codex-multi-auth"]),
			).toEqual(["oc-codex-multi-auth", "npm:oc-codex-multi-auth"]);
		});

		it("treats a slash-bearing specifier as a checkout only when it resolves on disk", async () => {
			vi.resetModules();
			tempHome = await createTempHome();
			vi.stubEnv("HOME", tempHome);
			vi.stubEnv("USERPROFILE", tempHome);
			const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");
			const configDir = join(tempHome, ".config", "opencode");
			await mkdir(configDir, { recursive: true });
			await createCheckout(configDir, "oc-codex-multi-auth", join("vendor", "oc-codex-multi-auth"));
			const emptyDir = join(tempHome, "elsewhere", "opencode");
			await mkdir(emptyDir, { recursive: true });

			expect(
				__test.normalizePluginList(["vendor/oc-codex-multi-auth"], undefined, {
					baseDirectory: configDir,
				}),
			).toEqual(["vendor/oc-codex-multi-auth"]);
			expect(
				__test.normalizePluginList(["vendor/oc-codex-multi-auth"], undefined, {
					baseDirectory: emptyDir,
				}),
			).toEqual(["vendor/oc-codex-multi-auth", "oc-codex-multi-auth"]);
		});

		it("warns that a preserved checkout path does not resolve on disk", async () => {
			vi.resetModules();
			const { __test } = await import("../scripts/install-oc-codex-multi-auth-core.js");
			const gone = "/definitely-absent/oc-codex-multi-auth";
			const notices: string[] = [];

			expect(
				__test.normalizePluginList(["oc-codex-multi-auth", gone], (notice) =>
					notices.push(notice),
				),
			).toEqual([gone]);
			expect(notices.join("\n")).toContain("does not resolve on disk");
			expect(notices.join("\n")).toContain("may not load until the path exists again");
		});

		it("suppresses the published name in tui.json when only opencode.json registers a checkout", async () => {
			vi.resetModules();
			tempHome = await createTempHome();
			vi.stubEnv("HOME", tempHome);
			vi.stubEnv("USERPROFILE", tempHome);
			const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
			const checkout = await createCheckout(tempHome, "oc-codex-multi-auth", "my-codex-fork");
			const configDir = join(tempHome, ".config", "opencode");
			const configPath = join(configDir, "opencode.json");
			const tuiConfigPath = join(configDir, "tui.json");

			await mkdir(configDir, { recursive: true });
			await writeFile(
				configPath,
				JSON.stringify({ plugin: [checkout] }, null, 2),
				"utf-8",
			);
			await writeFile(
				tuiConfigPath,
				JSON.stringify({ plugin: ["oc-codex-multi-auth"] }, null, 2),
				"utf-8",
			);

			await expect(
				runInstaller(["install", "--plugin-only", "--no-cache-clear"], {
					env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
				}),
			).resolves.toMatchObject({ action: "install", exitCode: 0 });

			const savedConfig = JSON.parse(await readFile(configPath, "utf-8")) as {
				plugin: string[];
			};
			const savedTui = JSON.parse(await readFile(tuiConfigPath, "utf-8")) as {
				plugin: string[];
			};
			expect(savedConfig.plugin).toEqual([checkout]);
			expect(savedTui.plugin).toEqual([]);
		});

		it("does not add the published name to tui.json when a checkout is registered in opencode.json", async () => {
			vi.resetModules();
			tempHome = await createTempHome();
			vi.stubEnv("HOME", tempHome);
			vi.stubEnv("USERPROFILE", tempHome);
			const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
			const checkout = await createCheckout(tempHome, "oc-codex-multi-auth", "my-codex-fork");
			const configDir = join(tempHome, ".config", "opencode");
			const configPath = join(configDir, "opencode.json");
			const tuiConfigPath = join(configDir, "tui.json");

			await mkdir(configDir, { recursive: true });
			await writeFile(
				configPath,
				JSON.stringify({ plugin: [checkout] }, null, 2),
				"utf-8",
			);

			await expect(
				runInstaller(["install", "--plugin-only", "--no-cache-clear"], {
					env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
				}),
			).resolves.toMatchObject({ action: "install", exitCode: 0 });

			const savedConfig = JSON.parse(await readFile(configPath, "utf-8")) as {
				plugin: string[];
			};
			const savedTui = JSON.parse(await readFile(tuiConfigPath, "utf-8")) as {
				plugin: string[];
			};
			expect(savedConfig.plugin).toEqual([checkout]);
			expect(savedTui.plugin).toEqual([]);
		});
	});
});
