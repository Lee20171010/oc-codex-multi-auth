import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOpencodeClient } from "@opencode-ai/sdk";
import type { ToolContext } from "../lib/tools/index.js";

const captured = vi.hoisted((): {
	context?: ToolContext;
	listener?: () => void;
	onWatch?: () => void;
	onQuotaProbe?: () => Promise<void>;
	reads: Promise<unknown>[];
	maxRetries?: number;
} => ({ reads: [] }));
vi.mock("node:fs", async (original) => ({
	...await original<typeof import("node:fs")>(),
	watchFile: vi.fn((_path, _options, listener) => { captured.listener = listener; captured.onWatch?.(); }),
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
	createQuotaMonitor: () => ({
		start() {},
		dispose() {},
		runNow: async () => { await captured.onQuotaProbe?.(); },
	}),
}));
vi.mock("../lib/auto-update-checker.js", () => ({ checkAndNotify: vi.fn(async () => {}) }));
vi.mock("../lib/config.js", async (original) => ({
	...await original<typeof import("../lib/config.js")>(),
	loadPluginConfig: () => ({ perProjectAccounts: false, startupPrewarm: false, startupPreflight: false,
		retryAllAccountsMaxRetries: captured.maxRetries }),
}));
vi.mock("../lib/storage.js", async (original) => ({
	...await original<typeof import("../lib/storage.js")>(),
	setStoragePath: vi.fn(),
}));

import { OpenAIOAuthPlugin } from "../index.js";
import { AccountManager } from "../lib/accounts.js";
import * as logger from "../lib/logger.js";
import { saveAccounts, setStoragePathDirect } from "../lib/storage.js";
import { unwatchFile, watchFile } from "node:fs";

describe("accounts live reload", () => {
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
	const nextReload = () => {
		return new Promise<void>((resolve) => {
			vi.spyOn(logger, "logDebug").mockImplementation((message) => {
				if (message === "Reloaded cached account manager after external accounts file change") resolve();
			});
		});
	};
	beforeEach(async () => {
		vi.useFakeTimers();
		// This file exercises the wait-and-wake machinery (external quota
		// clears, upstream re-probes, mid-sleep logins) with waits far past
		// the interactive ceiling, so it opts into truly unbounded waits
		// instead of the bounded-by-default production behavior.
		vi.stubEnv("CODEX_RETRY_ALL_UNBOUNDED", "1");
		directory = await fs.mkdtemp(join(tmpdir(), "accounts-live-reload-"));
		path = join(directory, "accounts.json");
		setStoragePathDirect(path);
		await fs.writeFile(path, JSON.stringify(storage(true)));
		captured.listener = undefined;
		captured.onWatch = undefined;
		captured.onQuotaProbe = undefined;
		captured.reads.length = 0;
		captured.maxRetries = undefined;
		plugin = await Reflect.apply(OpenAIOAuthPlugin, undefined, [{
			client: createOpencodeClient({ baseUrl: "http://localhost" }),
		}]);
		const loader = plugin.auth?.loader;
		if (!loader) throw new Error("Missing auth loader");
		const sdk = await Reflect.apply(loader, undefined, [async () => ({ type: "api", key: "test" }), {}]);
		request = sdk.fetch;
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
	it("reloads cached account state when an external writer changes the file", async () => {
		const previous = captured.context?.cachedAccountManagerRef.current;
		const reloaded = nextReload();
		await fs.writeFile(path, JSON.stringify(storage(false)));
		await tick();
		await settle();
		await reloaded;
		expect(captured.context?.cachedAccountManagerRef.current).not.toBe(previous);
		expect(captured.context?.cachedAccountManagerRef.current?.getAccountsSnapshot()[0]?.enabled).toBe(false);
	});
	it("ignores content written by this process", async () => {
		const load = vi.spyOn(AccountManager, "loadFromDisk");
		await saveAccounts(storage(false));
		await tick();
		await settle();
		expect(load).not.toHaveBeenCalled();
	});
	it("reloads an external restore of content that this process wrote earlier", async () => {
		await saveAccounts(storage(true));
		const original = await fs.readFile(path, "utf8");
		await tick();
		await settle();
		const changed = nextReload();
		await fs.writeFile(path, JSON.stringify(storage(false)));
		await tick();
		await settle();
		await changed;
		expect(captured.context?.cachedAccountManagerRef.current?.getAccountsSnapshot()[0]?.enabled).toBe(false);
		vi.mocked(logger.logDebug).mockRestore();
		const restored = nextReload();
		await fs.writeFile(path, original);
		await tick();
		await settle();
		await restored;
		expect(captured.context?.cachedAccountManagerRef.current?.getAccountsSnapshot()[0]?.enabled).toBe(true);
	});
	it("retries a transient reload failure even when no further file change occurs", async () => {
		const load = vi.spyOn(AccountManager, "loadFromDisk").mockRejectedValueOnce(new Error("transient read failure"));
		const reloaded = nextReload();
		await fs.writeFile(path, JSON.stringify(storage(false)));
		await tick();
		await settle();
		expect(load).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1500);
		await drainReads();
		await reloaded;
		expect(load).toHaveBeenCalledTimes(2);
		expect(captured.context?.cachedAccountManagerRef.current?.getAccountsSnapshot()[0]?.enabled).toBe(false);
	});
	it("keeps retrying bounded and cancels a pending retry on disposal", async () => {
		const load = vi.spyOn(AccountManager, "loadFromDisk").mockRejectedValue(new Error("read failure"));
		await fs.writeFile(path, JSON.stringify(storage(false)));
		await tick();
		await settle();
		await plugin.event?.({ event: { type: "server.instance.disposed", properties: { directory } } });
		await vi.advanceTimersByTimeAsync(10000);
		expect(load).toHaveBeenCalledTimes(1);
	});
	it("retires only cleared account markers while retaining unrelated pending 429s", async () => {
		const seeded = { ...storage(true), accounts: [storage(true).accounts[0],
			{ ...storage(true).accounts[0], accountId: "other-account", refreshToken: "other-refresh" }] };
		await saveAccounts(seeded);
		const manager = new AccountManager(undefined, seeded);
		const first = manager.setActiveIndex(0);
		const other = manager.setActiveIndex(1);
		if (!first || !other || !captured.context) throw new Error("Missing fixture accounts");
		captured.context.cachedAccountManagerRef.current = manager;
		manager.markRateLimited(first, 60_000, "codex");
		manager.markRateLimited(other, 120_000, "codex");
		const cleared = manager.getAccountsSnapshot()[0];
		manager.saveToDiskDebounced(10_000);
		let flushed: Promise<void> | undefined;
		const flush = manager.flushPendingSave.bind(manager);
		vi.spyOn(manager, "flushPendingSave").mockImplementation(() => {
			const pending = flush(); flushed = pending; return pending;
		});
		captured.context.invalidateAccountManagerCache([cleared]);
		await flushed;
		const stored = JSON.parse(await fs.readFile(path, "utf8"));
		expect(stored.accounts[0].rateLimitResetTimes ?? {}).toEqual({});
		expect(stored.accounts[1].rateLimitResetTimes.codex).toBe(Date.now() + 120_000);
	});
	it("flushes unpublished rate limits without dropping newly imported accounts on invalidation", async () => {
		const manager = captured.context?.cachedAccountManagerRef.current;
		if (!manager) throw new Error("Missing manager");
		const account = manager.getCurrentAccount();
		if (!account) throw new Error("Missing account");
		manager.markRateLimited(account, 60_000, "codex");
		manager.saveToDiskDebounced(10_000);
		let flushed: Promise<void> | undefined;
		const flush = manager.flushPendingSave.bind(manager);
		vi.spyOn(manager, "flushPendingSave").mockImplementation(() => {
			const pending = flush();
			flushed = pending;
			return pending;
		});
		await fs.writeFile(path, JSON.stringify({ ...storage(true), accounts: [
			...storage(true).accounts,
			{ accountId: "new-import", refreshToken: "new-import-refresh", addedAt: 2, lastUsed: 2 },
		] }));
		captured.context?.invalidateAccountManagerCache();
		await flushed;
		const stored = JSON.parse(await fs.readFile(path, "utf8"));
		expect(stored.accounts[0].rateLimitResetTimes.codex).toBe(Date.now() + 60_000);
		expect(stored.accounts).toHaveLength(2);
		expect(stored.accounts[1].accountId).toBe("new-import");
	});
	it("does not reset a bounded retry budget when a peer writes an unchanged quota block", async () => {
		captured.maxRetries = 1;
		const manager = captured.context?.cachedAccountManagerRef.current;
		if (!manager) throw new Error("Missing manager");
		const account = manager.getCurrentAccount();
		if (!account) throw new Error("Missing account");
		const until = Date.now() + 86_400_000;
		manager.markQuotaExhausted(account, until, "gpt-5.1");
		let enteredWait: () => void = () => {};
		const waiting = new Promise<void>((resolve) => { enteredWait = resolve; });
		const minWait = manager.getMinWaitTimeForFamily.bind(manager);
		vi.spyOn(manager, "getMinWaitTimeForFamily").mockImplementation((...args) => {
			enteredWait();
			return minWait(...args);
		});
		const controller = new AbortController();
		let status: number | undefined;
		const response = request("https://api.openai.com/v1/responses", {
			method: "POST", signal: controller.signal,
			body: JSON.stringify({ model: "gpt-5.1", stream: true, input: [] }),
		}).then((result) => { status = result.status; }, (error: unknown) => {
			if (!(error instanceof Error && error.name === "AbortError")) throw error;
		});
		try {
			await waiting;
			const reloaded = nextReload();
			await fs.writeFile(path, JSON.stringify({ ...storage(true), accounts: [{ ...storage(true).accounts[0],
				quotaExhaustedUntil: until, lastUsed: 2,
			}] }));
			await tick();
			await settle();
			await reloaded;
			await vi.advanceTimersByTimeAsync(5000);
			expect(status).toBe(429);
		} finally {
			controller.abort();
			await response;
		}
	});
	it("resumes an already waiting request after an external quota clear", async () => {
		const manager = captured.context?.cachedAccountManagerRef.current;
		if (!manager) throw new Error("Missing manager");
		const account = manager.getCurrentAccount();
		if (!account) throw new Error("Missing account");
		manager.markQuotaExhausted(account, Date.now() + 86_400_000, "gpt-5.1");
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("data: [DONE]\n\n", {
			status: 200, headers: { "content-type": "text/event-stream" },
		}));
		let enteredWait: () => void = () => {};
		const waiting = new Promise<void>((resolve) => { enteredWait = resolve; });
		const minWait = manager.getMinWaitTimeForFamily.bind(manager);
		vi.spyOn(manager, "getMinWaitTimeForFamily").mockImplementation((...args) => {
			enteredWait();
			return minWait(...args);
		});
		const response = request("https://api.openai.com/v1/responses", {
			method: "POST", body: JSON.stringify({ model: "gpt-5.1", stream: true, input: [] }),
		});
		await waiting;
		const reloaded = nextReload();
		await fs.writeFile(path, JSON.stringify({ ...storage(true), activeIndexByFamily: {} }));
		await tick();
		await settle();
		await reloaded;
		await vi.advanceTimersByTimeAsync(5000);
		expect((await response).status).toBe(200);
	});
	it("wakes a long wait when an upstream re-probe finds the block lifted", async () => {
		const manager = captured.context?.cachedAccountManagerRef.current;
		if (!manager) throw new Error("Missing manager");
		const account = manager.getCurrentAccount();
		if (!account) throw new Error("Missing account");
		manager.markQuotaExhausted(account, Date.now() + 86_400_000, "gpt-5.1");
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("data: [DONE]\n\n", {
			status: 200, headers: { "content-type": "text/event-stream" },
		}));
		let enteredWait: () => void = () => {};
		const waiting = new Promise<void>((resolve) => { enteredWait = resolve; });
		const minWait = manager.getMinWaitTimeForFamily.bind(manager);
		vi.spyOn(manager, "getMinWaitTimeForFamily").mockImplementation((...args) => {
			enteredWait();
			return minWait(...args);
		});
		let probes = 0;
		captured.onQuotaProbe = async () => {
			probes += 1;
			// What a server-side grant looks like: usage reports the quota back,
			// the recovery is persisted, and the cached manager is dropped. The
			// accounts file is never written by another process, so the watcher
			// has nothing to fire on - this is the wake-up it cannot provide.
			captured.context?.invalidateAccountManagerCache();
		};
		const response = request("https://api.openai.com/v1/responses", {
			method: "POST", body: JSON.stringify({ model: "gpt-5.1", stream: true, input: [] }),
		});
		await waiting;
		for (let elapsed = 0; elapsed < 120_000 && probes === 0; elapsed += 5000) {
			await vi.advanceTimersByTimeAsync(5000);
		}
		expect(probes).toBe(1);
		await vi.advanceTimersByTimeAsync(5000);
		expect((await response).status).toBe(200);
	});
	it("wakes a waiting request when a login adds an account mid-sleep", async () => {
		const manager = captured.context?.cachedAccountManagerRef.current;
		if (!manager) throw new Error("Missing manager");
		const account = manager.getCurrentAccount();
		if (!account) throw new Error("Missing account");
		const blockedUntil = Date.now() + 86_400_000;
		manager.markQuotaExhausted(account, blockedUntil, "gpt-5.1");
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("data: [DONE]\n\n", {
			status: 200, headers: { "content-type": "text/event-stream" },
		}));
		let enteredWait: () => void = () => {};
		const waiting = new Promise<void>((resolve) => { enteredWait = resolve; });
		const minWait = manager.getMinWaitTimeForFamily.bind(manager);
		vi.spyOn(manager, "getMinWaitTimeForFamily").mockImplementation((...args) => {
			enteredWait();
			return minWait(...args);
		});
		const response = request("https://api.openai.com/v1/responses", {
			method: "POST", body: JSON.stringify({ model: "gpt-5.1", stream: true, input: [] }),
		});
		await waiting;
		const reloaded = nextReload();
		// The incumbent account stays blocked on disk, so the only thing that can
		// end this wait is the account the login added.
		await fs.writeFile(path, JSON.stringify({ ...storage(true), accounts: [
			{ ...storage(true).accounts[0], quotaExhaustedUntil: blockedUntil },
			{ accountId: "fresh-login", refreshToken: "fresh-refresh", accessToken: "fresh-access",
				expiresAt: Date.now() + 86_400_000, enabled: true, addedAt: 2, lastUsed: 2 },
		] }));
		await tick();
		await settle();
		await reloaded;
		await vi.advanceTimersByTimeAsync(5000);
		expect((await response).status).toBe(200);
	});
	it("keeps the loaded pool when an external change loads as empty", async () => {
		const previous = captured.context?.cachedAccountManagerRef.current;
		if (!previous) throw new Error("Missing manager");
		expect(previous.getAccountCount()).toBe(1);
		const empty = new AccountManager(undefined, { ...storage(true), accounts: [] });
		const load = vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValueOnce(empty);
		await fs.writeFile(path, JSON.stringify(storage(false)));
		await tick();
		await settle();
		expect(load).toHaveBeenCalledTimes(1);
		expect(captured.context?.cachedAccountManagerRef.current).toBe(previous);
		expect(captured.context?.cachedAccountManagerRef.current?.getAccountCount()).toBe(1);
		const reloaded = nextReload();
		await vi.advanceTimersByTimeAsync(1500);
		await drainReads();
		await reloaded;
		expect(load).toHaveBeenCalledTimes(2);
		expect(captured.context?.cachedAccountManagerRef.current?.getAccountsSnapshot()[0]?.enabled).toBe(false);
	});
	it("keeps serving the incumbent when a mid-request reload loads as empty", async () => {
		const manager = captured.context?.cachedAccountManagerRef.current;
		if (!manager) throw new Error("Missing manager");
		const account = manager.getCurrentAccount();
		if (!account) throw new Error("Missing account");
		manager.markQuotaExhausted(account, Date.now() + 86_400_000, "gpt-5.1");
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("data: [DONE]\n\n", {
			status: 200, headers: { "content-type": "text/event-stream" },
		}));
		let enteredWait: () => void = () => {};
		const waiting = new Promise<void>((resolve) => { enteredWait = resolve; });
		const minWait = manager.getMinWaitTimeForFamily.bind(manager);
		vi.spyOn(manager, "getMinWaitTimeForFamily").mockImplementation((...args) => {
			enteredWait();
			return minWait(...args);
		});
		const response = request("https://api.openai.com/v1/responses", {
			method: "POST", body: JSON.stringify({ model: "gpt-5.1", stream: true, input: [] }),
		});
		await waiting;
		// What a re-probe leaves behind mid-wait: the cache invalidated, then a
		// loadAccounts() read that loses a cross-process race resolves as an
		// empty manager. Installing it would poison the pool for every request.
		captured.context?.invalidateAccountManagerCache();
		const empty = new AccountManager(undefined, { ...storage(true), accounts: [] });
		vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValueOnce(empty);
		await vi.advanceTimersByTimeAsync(5000);
		await drainReads();
		expect((await response).status).toBe(200);
		const installed = captured.context?.cachedAccountManagerRef.current;
		expect(installed).not.toBe(empty);
		expect(installed?.getAccountCount()).toBe(1);
	});
	it("adopts an external change that genuinely removes the last account", async () => {
		const previous = captured.context?.cachedAccountManagerRef.current;
		const reloaded = nextReload();
		await fs.writeFile(path, JSON.stringify({ ...storage(true), accounts: [] }));
		await tick();
		await settle();
		await reloaded;
		expect(captured.context?.cachedAccountManagerRef.current).not.toBe(previous);
		expect(captured.context?.cachedAccountManagerRef.current?.getAccountCount()).toBe(0);
	});
	it("keeps externally cleared blocks cleared despite queued and late saves from the old manager", async () => {
		const previous = captured.context?.cachedAccountManagerRef.current;
		if (!previous) throw new Error("Missing manager");
		const account = previous.getCurrentAccount();
		if (!account) throw new Error("Missing account");
		previous.markQuotaExhausted(account, Date.now() + 86_400_000, "codex");
		previous.markRateLimited(account, 60_000, "codex");
		previous.saveToDiskDebounced(10_000);
		const reloaded = nextReload();
		await fs.writeFile(path, JSON.stringify({ ...storage(true), activeIndexByFamily: {} }));
		await tick();
		await settle();
		await reloaded;
		await previous.saveToDisk();
		const after = JSON.parse(await fs.readFile(path, "utf8"));
		expect(after.accounts[0].quotaExhaustedUntil).toBeUndefined();
		expect(after.accounts[0].rateLimitResetTimes ?? {}).toEqual({});
		expect(captured.context?.cachedAccountManagerRef.current?.getSelectionExplainability("codex")[0]?.eligible).toBe(true);
		// New server evidence from an in-flight request must still survive retirement.
		previous.markRateLimited(account, 90_000, "codex");
		await previous.saveToDisk();
		const fresh = JSON.parse(await fs.readFile(path, "utf8"));
		expect(fresh.accounts[0].rateLimitResetTimes.codex).toBe(Date.now() + 90_000);
	});
	it("debounces two external changes into one reload", async () => {
		const load = vi.spyOn(AccountManager, "loadFromDisk");
		const reloaded = nextReload();
		await fs.writeFile(path, JSON.stringify(storage(false)));
		await tick();
		await vi.advanceTimersByTimeAsync(250);
		await fs.writeFile(path, JSON.stringify({ ...storage(false), activeIndexByFamily: {} }));
		await tick();
		await settle();
		await reloaded;
		expect(load).toHaveBeenCalledTimes(1);
	});
	it("skips partial JSON without reloading or throwing", async () => {
		const load = vi.spyOn(AccountManager, "loadFromDisk");
		await fs.writeFile(path, '{"version":');
		await tick();
		await settle();
		expect(load).not.toHaveBeenCalled();
	});
	it("repoints the watcher when the resolved storage path changes", async () => {
		const nextPath = join(directory, "next-accounts.json");
		await fs.writeFile(nextPath, JSON.stringify(storage(true)));
		const registered = new Promise<void>((resolve) => {
			captured.onWatch = resolve;
		});
		setStoragePathDirect(nextPath);
		await registered;
		expect(unwatchFile).toHaveBeenCalledWith(path, expect.any(Function));
		expect(watchFile).toHaveBeenLastCalledWith(nextPath, { interval: 1500, persistent: false }, expect.any(Function));
	});
	it("installs no watcher for the keychain backend", async () => {
		const keychainPath = join(directory, "keychain-accounts.json");
		await fs.writeFile(keychainPath, JSON.stringify(storage(true)));
		const watchCalls = vi.mocked(watchFile).mock.calls.length;
		vi.stubEnv("CODEX_KEYCHAIN", "1");
		setStoragePathDirect(keychainPath);
		await drainReads();
		expect(unwatchFile).toHaveBeenCalledWith(path, expect.any(Function));
		expect(watchFile).toHaveBeenCalledTimes(watchCalls);
	});
	it("unwatches and cancels a pending reload when disposed", async () => {
		await fs.writeFile(path, JSON.stringify(storage(false)));
		await tick();
		await plugin.event?.({ event: { type: "server.instance.disposed", properties: { directory } } });
		expect(unwatchFile).toHaveBeenCalledWith(path, expect.any(Function));
		expect(vi.getTimerCount()).toBe(0);
		expect(watchFile).toHaveBeenCalledWith(path, { interval: 1500, persistent: false }, expect.any(Function));
	});
	it("dedupes concurrent manager reloads after cache invalidation", async () => {
		const manager = captured.context?.cachedAccountManagerRef.current;
		if (!manager) throw new Error("Missing manager");
		const account = manager.getCurrentAccount();
		if (!account) throw new Error("Missing account");
		manager.markQuotaExhausted(account, Date.now() + 86_400_000, "gpt-5.1");
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("data: [DONE]\n\n", {
			status: 200, headers: { "content-type": "text/event-stream" },
		}));
		let enteredWait: () => void = () => {};
		const waiting = new Promise<void>((resolve) => { enteredWait = resolve; });
		const minWait = manager.getMinWaitTimeForFamily.bind(manager);
		vi.spyOn(manager, "getMinWaitTimeForFamily").mockImplementation((...args) => {
			enteredWait();
			return minWait(...args);
		});
		const first = request("https://api.openai.com/v1/responses", {
			method: "POST", body: JSON.stringify({ model: "gpt-5.1", stream: true, input: [] }),
		});
		await waiting;
		// Park every load behind one gate so both reload paths are observed
		// before either completes.
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const realLoad = AccountManager.loadFromDisk.bind(AccountManager);
		const load = vi.spyOn(AccountManager, "loadFromDisk").mockImplementation(async () => {
			await gate;
			return realLoad();
		});
		captured.context?.invalidateAccountManagerCache();
		const second = request("https://api.openai.com/v1/responses", {
			method: "POST", body: JSON.stringify({ model: "gpt-5.1", stream: true, input: [] }),
		});
		await vi.advanceTimersByTimeAsync(5000);
		// The waiting request resumed into the rotation loop and must reuse the
		// in-flight load instead of starting a second one whose loser would be
		// an unretired manager that can still write full membership saves.
		expect(load).toHaveBeenCalledTimes(1);
		release();
		await vi.advanceTimersByTimeAsync(5000);
		expect((await first).status).toBe(200);
		expect((await second).status).toBe(200);
	});
	it("retires an incumbent installed while an external reload retries", async () => {
		const replacement = new AccountManager(undefined, storage(true));
		const dispose = vi.spyOn(replacement, "disposeShutdownHandler");
		const load = vi.spyOn(AccountManager, "loadFromDisk");
		load.mockRejectedValueOnce(new Error("transient read failure"));
		const reloaded = nextReload();
		await fs.writeFile(path, JSON.stringify(storage(false)));
		await tick();
		await settle();
		// A concurrent actor installs a fresh manager while the watcher's
		// bounded retry is still pending.
		captured.context!.cachedAccountManagerRef.current = replacement;
		await vi.advanceTimersByTimeAsync(1500);
		await reloaded;
		const installed = captured.context?.cachedAccountManagerRef.current;
		expect(installed).not.toBe(replacement);
		// The replaced incumbent must be retired, or its queued membership
		// save can clobber the external change the reload just adopted.
		expect(dispose).toHaveBeenCalled();
		expect(installed?.getAccountsSnapshot()[0]?.enabled).toBe(false);
	});
});
