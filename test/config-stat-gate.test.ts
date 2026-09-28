/**
 * Stat gate for the per-request config read and `__proto__`-key safety in
 * lib/config.ts:
 *
 * - `loadPluginConfig` pays one `statSync` for an unchanged file — no
 *   `readFileSync`, no re-validation — while still noticing real edits,
 *   keeping the last usable config during deletion/mid-write, and surfacing
 *   the same warn+fallback on non-ENOENT failures as before.
 * - Records accumulated with caller-controlled keys use null-prototype
 *   objects so a `__proto__` key stays inert data instead of mutating a
 *   prototype chain.
 */
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => ({ path: "" }));
vi.mock("node:os", async (original) => ({
	...(await original<typeof import("node:os")>()),
	homedir: () => home.path,
}));

const fsCalls = vi.hoisted(() => ({
	readFileSync: 0,
	statSync: 0,
}));

// Count the sync entry points lib/config.ts uses while keeping the real
// implementations — the assertions are on call counts, not on faked data.
vi.mock("node:fs", async (original) => {
	const actual = await original<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => {
			fsCalls.readFileSync += 1;
			return actual.readFileSync(...args);
		}),
		statSync: vi.fn((...args: Parameters<typeof actual.statSync>) => {
			fsCalls.statSync += 1;
			return actual.statSync(...args);
		}),
	};
});

vi.mock("../lib/logger.js", () => ({ logWarn: vi.fn() }));

describe("loadPluginConfig stat gate", () => {
	let configPath: string;

	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		fsCalls.readFileSync = 0;
		fsCalls.statSync = 0;
		home.path = mkdtempSync(join(tmpdir(), "config-stat-gate-"));
		mkdirSync(join(home.path, ".opencode"));
		configPath = join(home.path, ".opencode", "openai-codex-auth-config.json");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home.path, { recursive: true, force: true });
	});

	it("skips readFileSync while the file stat is unchanged", async () => {
		writeFileSync(configPath, '{"rotationStrategy":"sticky"}');
		const { loadPluginConfig } = await import("../lib/config.js");

		const first = loadPluginConfig();
		expect(fsCalls.readFileSync).toBe(1);
		expect(loadPluginConfig()).toBe(first);
		expect(fsCalls.readFileSync).toBe(1);
		// ...but the file is still probed every call, so an edit can never hide.
		expect(fsCalls.statSync).toBeGreaterThanOrEqual(2);
	});

	it("re-reads and re-validates when the file changes", async () => {
		writeFileSync(configPath, '{"rotationStrategy":"sticky"}');
		const { loadPluginConfig } = await import("../lib/config.js");
		expect(loadPluginConfig().rotationStrategy).toBe("sticky");

		writeFileSync(configPath, '{"rotationStrategy":"round-robin"}');
		const reloaded = loadPluginConfig();
		expect(reloaded.rotationStrategy).toBe("round-robin");
		expect(fsCalls.readFileSync).toBe(2);
	});

	it("does not re-read content it already parsed", async () => {
		writeFileSync(configPath, '{"rotationStrategy":"sticky"}');
		const { loadPluginConfig } = await import("../lib/config.js");
		const first = loadPluginConfig();
		expect(fsCalls.readFileSync).toBe(1);

		// Touch the file with identical content: stat changes, content does not.
		writeFileSync(configPath, '{"rotationStrategy":"sticky"}');
		expect(loadPluginConfig()).toBe(first);
		expect(fsCalls.readFileSync).toBe(2);
	});

	it("answers from the cache while the file is missing without extra reads", async () => {
		const { loadPluginConfig } = await import("../lib/config.js");

		const defaults = loadPluginConfig();
		expect(fsCalls.readFileSync).toBe(0);
		expect(loadPluginConfig()).toBe(defaults);
		expect(fsCalls.readFileSync).toBe(0);

		writeFileSync(configPath, '{"rotationStrategy":"sticky"}');
		expect(loadPluginConfig().rotationStrategy).toBe("sticky");

		unlinkSync(configPath);
		expect(loadPluginConfig().rotationStrategy).toBe("sticky");
		expect(fsCalls.readFileSync).toBe(1);
	});

	it("keeps the error path for non-ENOENT failures: warn + last usable config", async () => {
		writeFileSync(configPath, '{"rotationStrategy":"sticky"}');
		const { loadPluginConfig } = await import("../lib/config.js");
		const { logWarn } = await import("../lib/logger.js");
		const sticky = loadPluginConfig();

		// A directory satisfies statSync but fails readFileSync with EISDIR,
		// which is exactly the non-ENOENT branch a permission fault takes.
		rmSync(configPath);
		mkdirSync(configPath);
		expect(loadPluginConfig()).toBe(sticky);
		expect(logWarn).toHaveBeenCalledWith(
			expect.stringContaining("Failed to read config"),
		);
	});
});

describe("__proto__-keyed config and pool keys stay inert", () => {
	let configPath: string;

	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		fsCalls.readFileSync = 0;
		fsCalls.statSync = 0;
		home.path = mkdtempSync(join(tmpdir(), "config-proto-gate-"));
		mkdirSync(join(home.path, ".opencode"));
		configPath = join(home.path, ".opencode", "openai-codex-auth-config.json");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home.path, { recursive: true, force: true });
	});

	it("a top-level __proto__ key cannot mutate Object.prototype or the config", async () => {
		writeFileSync(
			configPath,
			'{"__proto__":{"polluted":true},"codexMode":false}',
		);
		const { loadPluginConfig } = await import("../lib/config.js");
		const config = loadPluginConfig();

		expect(config.codexMode).toBe(false);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(Object.getPrototypeOf(config)).toBe(Object.prototype);
	});

	it("the salvage path drops a __proto__ key instead of writing it", async () => {
		// Whole-file validation fails (codexMode is not a boolean), which routes
		// every key — including `__proto__` — through salvageValidKeys.
		writeFileSync(
			configPath,
			'{"codexMode":"nope","__proto__":{"polluted":true},"rotationStrategy":"sticky"}',
		);
		const { loadPluginConfig } = await import("../lib/config.js");
		const config = loadPluginConfig();

		expect(config.rotationStrategy).toBe("sticky");
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(Object.getPrototypeOf(config)).toBe(Object.prototype);
		expect(Object.hasOwn(config, "__proto__")).toBe(false);
	});

	it("a __proto__ model pool key persists as data, not a prototype write", async () => {
		const { updateModelAccountPool } = await import("../lib/config.js");
		const result = await updateModelAccountPool("__proto__", "set", ["acc-1"]);

		expect(result.changed).toBe(true);
		expect(({} as Record<string, unknown>).acc).toBeUndefined();
		const protoKeyProbe: Record<string, unknown> = {};
		expect(protoKeyProbe.constructor).toBe(Object);

		const { readFileSync } = await import("node:fs");
		const saved = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
			string,
			unknown
		>;
		const pools = saved.modelAccountPools as Record<string, unknown>;
		expect(Object.hasOwn(pools, "__proto__")).toBe(true);
		expect(Object.getPrototypeOf(pools)).toBe(Object.prototype);
	});
});
