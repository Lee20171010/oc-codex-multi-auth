/**
 * Manager lifecycle after the plugin invalidates its account-manager cache.
 *
 * Invariants under test:
 * - A manager created by an in-flight load must never be installed as the
 *   active cache with a snapshot older than disk, and must never run a
 *   full-membership save that deletes an externally imported account.
 * - Concurrent requests after an invalidation converge on exactly one load.
 * - An external change noticed while the cache is null is adopted by the next
 *   fresh load (benign counterpart of the bail in reloadForExternalAccountsChange).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOpencodeClient } from "@opencode-ai/sdk";
import type { ToolContext } from "../lib/tools/index.js";

const captured = vi.hoisted((): {
	context?: ToolContext;
	listener?: () => void;
	reads: Promise<unknown>[];
} => ({ reads: [] }));
vi.mock("node:fs", async (original) => ({
	...await original<typeof import("node:fs")>(),
	watchFile: vi.fn((_path, _options, listener) => { captured.listener = listener; }),
	unwatchFile: vi.fn(),
}));
vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return {
		...actual,
		readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => {
			const pending = actual.readFile(...args);
			captured.reads.push(pending.catch(() => undefined));
			return pending;
		}),
	};
});
vi.mock("../lib/tools/index.js", () => ({
	createToolRegistry: (context: ToolContext) => { captured.context = context; return {}; },
}));
vi.mock("../lib/quota-notifications.js", () => ({
	createQuotaMonitor: () => ({ start() {}, dispose() {} }),
}));
vi.mock("../lib/auto-update-checker.js", () => ({ checkAndNotify: vi.fn(async () => {}) }));
vi.mock("../lib/config.js", async (original) => ({
	...await original<typeof import("../lib/config.js")>(),
	loadPluginConfig: () => ({ perProjectAccounts: false, startupPrewarm: false, startupPreflight: false,
		retryAllAccountsMaxRetries: undefined }),
}));
vi.mock("../lib/storage.js", async (original) => ({
	...await original<typeof import("../lib/storage.js")>(),
	setStoragePath: vi.fn(),
}));

import { OpenAIOAuthPlugin } from "../index.js";
import { AccountManager } from "../lib/accounts.js";
import { setStoragePathDirect } from "../lib/storage.js";

describe("manager lifecycle after cache invalidation", () => {
	let directory: string;
	let path: string;
	let plugin: Awaited<ReturnType<typeof OpenAIOAuthPlugin>>;
	let request: typeof fetch;
	const storage = (enabled: boolean) => ({
		version: 3 as const,
		accounts: [{ accountId: "test-account", refreshToken: "test-refresh", accessToken: "test-access",
			expiresAt: Date.now() + 86_400_000, enabled, addedAt: 1, lastUsed: 1 }],
		activeIndex: 0,
	});
	const withImport = () => ({ ...storage(true), accounts: [...storage(true).accounts,
		{ accountId: "new-import", refreshToken: "new-import-refresh", accessToken: "import-access",
			expiresAt: Date.now() + 86_400_000, addedAt: 2, lastUsed: 2 }] });
	const drainReads = async () => {
		while (captured.reads.length > 0) {
			await Promise.allSettled(captured.reads.splice(0));
		}
	};
	const tick = async () => {
		expect(captured.listener).toBeTypeOf("function");
		captured.listener?.();
		await drainReads();
	};
	const settle = async () => {
		await vi.advanceTimersByTimeAsync(500);
		await drainReads();
	};

	beforeEach(async () => {
		vi.useFakeTimers();
		directory = await fs.mkdtemp(join(tmpdir(), "accounts-invalidation-"));
		path = join(directory, "accounts.json");
		setStoragePathDirect(path);
		await fs.writeFile(path, JSON.stringify(storage(true)));
		captured.listener = undefined;
		captured.reads.length = 0;
		plugin = await Reflect.apply(OpenAIOAuthPlugin, undefined, [{
			client: createOpencodeClient({ baseUrl: "http://localhost" }),
		}]);
		const loader = plugin.auth?.loader;
		if (!loader) throw new Error("Missing auth loader");
		const sdk = await Reflect.apply(loader, undefined, [async () => ({ type: "api", key: "test" }), {}]);
		request = sdk.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("data: [DONE]\n\n", {
			status: 200, headers: { "content-type": "text/event-stream" },
		}));
	});

	afterEach(async () => {
		await plugin?.event?.({ event: { type: "server.instance.disposed", properties: { directory } } });
		await captured.context?.cachedAccountManagerRef.current?.flushPendingSave();
		captured.context?.cachedAccountManagerRef.current?.disposeShutdownHandler();
		setStoragePathDirect(null);
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.useRealTimers();
		await fs.rm(directory, { recursive: true, force: true });
	});

	const staleInstall = async () => {
		const realLoad = AccountManager.loadFromDisk.bind(AccountManager);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let markLoaded: () => void = () => {};
		const loaded = new Promise<void>((resolve) => { markLoaded = resolve; });
		let markReloaded: () => void = () => {};
		const reloaded = new Promise<void>((resolve) => { markReloaded = resolve; });
		let loadCount = 0;
		const load = vi.spyOn(AccountManager, "loadFromDisk").mockImplementation(async (...args: Parameters<typeof AccountManager.loadFromDisk>) => {
			const firstLoad = loadCount++ === 0;
			const manager = await realLoad(...args);
			if (firstLoad) markLoaded();
			else markReloaded();
			await gate;
			return manager;
		});

		captured.context?.invalidateAccountManagerCache();
		const pending = request("https://api.openai.com/v1/responses", {
			method: "POST", body: JSON.stringify({ model: "gpt-5.1", stream: true, input: [] }),
		});
		await loaded;

		await fs.writeFile(path, JSON.stringify(withImport()));
		await tick();
		await settle();

		// Wait for the external reload's real I/O, not an arbitrary number of
		// event-loop turns. Both snapshots are held at the gate until loaded.
		await reloaded;
		release();
		await Promise.all(load.mock.results.map((result) => result.value));
		await vi.advanceTimersByTimeAsync(5000);
		await pending;
	};

	it("an in-flight load orphaned by a mid-load invalidation is installed as the active cache with a pre-import snapshot", async () => {
		await staleInstall();

		const installed = captured.context?.cachedAccountManagerRef.current;
		expect(installed).toBeTruthy();
		expect(installed?.getAccountsSnapshot().some((account) => account.accountId === "new-import")).toBe(true);
	});

	it("the stale installed manager's full-membership save deletes an externally imported account", async () => {
		await staleInstall();

		const installed = captured.context?.cachedAccountManagerRef.current;
		const account = installed?.getCurrentAccount();
		if (!account) throw new Error("Missing account on installed manager");
		installed?.markRateLimited(account, 60_000, "gpt-5-codex");
		installed?.saveToDiskDebounced();
		await installed?.flushPendingSave();
		const stored = JSON.parse(await fs.readFile(path, "utf8")) as { accounts: Array<{ accountId?: string }> };
		expect(stored.accounts.some((entry) => entry.accountId === "new-import")).toBe(true);
	});

	it("concurrent requests after an invalidation converge on exactly one load", async () => {
		const realLoad = AccountManager.loadFromDisk.bind(AccountManager);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const load = vi.spyOn(AccountManager, "loadFromDisk").mockImplementation(async (...args: Parameters<typeof AccountManager.loadFromDisk>) => {
			await gate;
			return realLoad(...args);
		});

		captured.context?.invalidateAccountManagerCache();
		const requests = [0, 1, 2, 3, 4].map(() => request("https://api.openai.com/v1/responses", {
			method: "POST", body: JSON.stringify({ model: "gpt-5.1", stream: true, input: [] }),
		}));
		await vi.advanceTimersByTimeAsync(0);
		expect(load).toHaveBeenCalledTimes(1);
		release();
		await vi.advanceTimersByTimeAsync(5000);
		const statuses = await Promise.all(requests.map((pending) => pending.then((response) => response.status)));
		expect(statuses).toEqual([200, 200, 200, 200, 200]);
	});

	it("an external change noticed while the cache is null is adopted by the next fresh load", async () => {
		captured.context?.invalidateAccountManagerCache();
		await fs.writeFile(path, JSON.stringify(withImport()));
		await tick();
		await settle();

		const pending = request("https://api.openai.com/v1/responses", {
			method: "POST", body: JSON.stringify({ model: "gpt-5.1", stream: true, input: [] }),
		});
		await vi.advanceTimersByTimeAsync(5000);
		await pending;

		const installed = captured.context?.cachedAccountManagerRef.current;
		expect(installed?.getAccountsSnapshot().some((account) => account.accountId === "new-import")).toBe(true);
		const stored = JSON.parse(await fs.readFile(path, "utf8")) as { accounts: unknown[] };
		expect(stored.accounts).toHaveLength(2);
	});
});
