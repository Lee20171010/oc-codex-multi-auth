import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	registerCleanup,
	unregisterCleanup,
	runCleanup,
	getCleanupCount,
} from "../lib/shutdown.js";
import { AccountManager } from "../lib/accounts.js";

vi.mock("../lib/storage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/storage.js")>();
	const saveAccounts = vi.fn().mockResolvedValue(undefined);
	return {
		...actual,
		saveAccounts,
		withAccountStorageTransaction: vi.fn(
			async (
				handler: (
					current: null,
					persist: (storage: unknown) => Promise<void>,
				) => Promise<unknown>,
			) => handler(null, saveAccounts as (storage: unknown) => Promise<void>),
		),
	};
});

describe("Graceful shutdown", () => {
	beforeEach(async () => {
		await runCleanup();
	});

	it("registers and runs cleanup functions", async () => {
		const fn = vi.fn();
		registerCleanup(fn);
		expect(getCleanupCount()).toBe(1);
		await runCleanup();
		expect(fn).toHaveBeenCalledTimes(1);
		expect(getCleanupCount()).toBe(0);
	});

	it("unregisters cleanup functions", async () => {
		const fn = vi.fn();
		registerCleanup(fn);
		unregisterCleanup(fn);
		expect(getCleanupCount()).toBe(0);
		await runCleanup();
		expect(fn).not.toHaveBeenCalled();
	});

	it("runs multiple cleanup functions in order", async () => {
		const order: number[] = [];
		registerCleanup(() => { order.push(1); });
		registerCleanup(() => { order.push(2); });
		registerCleanup(() => { order.push(3); });
		await runCleanup();
		expect(order).toEqual([1, 2, 3]);
	});

	it("handles async cleanup functions", async () => {
		const fn = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
		registerCleanup(fn);
		await runCleanup();
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("continues cleanup even if one function throws", async () => {
		const fn1 = vi.fn(() => { throw new Error("fail"); });
		const fn2 = vi.fn();
		registerCleanup(fn1);
		registerCleanup(fn2);
		await runCleanup();
		expect(fn1).toHaveBeenCalled();
		expect(fn2).toHaveBeenCalled();
	});

	it("clears cleanup list after running", async () => {
		registerCleanup(() => {});
		registerCleanup(() => {});
		expect(getCleanupCount()).toBe(2);
		await runCleanup();
		expect(getCleanupCount()).toBe(0);
	});

	it("unregister is no-op for non-registered function", () => {
		const fn = vi.fn();
		unregisterCleanup(fn);
		expect(getCleanupCount()).toBe(0);
	});

	describe("runCleanup re-entrancy", () => {
		it("dedupes concurrent drains into a single pass", async () => {
			let release!: () => void;
			const slow = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
			registerCleanup(slow);

			const first = runCleanup();
			const second = runCleanup();
			expect(second).toBe(first);

			release();
			await Promise.all([first, second]);
			expect(slow).toHaveBeenCalledTimes(1);
		});

		it("does not drop a cleanup registered while a drain is in flight", async () => {
			let release!: () => void;
			const slow = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
			registerCleanup(slow);

			const drain = runCleanup();
			const late = vi.fn();
			registerCleanup(late);

			release();
			await drain;
			expect(late).not.toHaveBeenCalled();
			expect(getCleanupCount()).toBe(1);

			await runCleanup();
			expect(late).toHaveBeenCalledTimes(1);
		});

		it("re-drains on each sequential call once the previous one settles", async () => {
			const first = vi.fn();
			registerCleanup(first);
			await runCleanup();

			const second = vi.fn();
			registerCleanup(second);
			await runCleanup();

			expect(first).toHaveBeenCalledTimes(1);
			expect(second).toHaveBeenCalledTimes(1);
		});
	});

	describe("process signal integration", () => {
		type ProcEvent = "SIGINT" | "SIGTERM" | "beforeExit";
		type ProcListener = (...args: unknown[]) => void;
		const SIGNAL_EVENTS: readonly ProcEvent[] = ["SIGINT", "SIGTERM", "beforeExit"];

		/**
		 * Park the runner's own signal listeners for the duration of a test, so a
		 * synthetic `process.emit("SIGINT")` drives only the listeners we care
		 * about and never asks vitest to tear itself down. Restoring also strips
		 * whatever the freshly imported shutdown module attached.
		 */
		function detachProcessListeners(events: readonly ProcEvent[]): () => void {
			const saved = new Map<ProcEvent, ProcListener[]>();
			for (const event of events) {
				saved.set(event, process.listeners(event) as unknown as ProcListener[]);
				process.removeAllListeners(event);
			}
			return () => {
				for (const event of events) {
					process.removeAllListeners(event);
					for (const listener of saved.get(event) ?? []) {
						process.on(event, listener);
					}
				}
			};
		}

		/**
		 * Re-imports the module. The shutdown state is process-level
		 * (`Symbol.for` on globalThis), so this returns a module generation
		 * sharing the same queue and handlers — the detach in `beforeEach`
		 * stripped them, so the next `registerCleanup` re-attaches.
		 */
		async function freshShutdown() {
			vi.resetModules();
			const mod = await import("../lib/shutdown.js");
			await mod.runCleanup();
			return mod;
		}

		const settle = () => new Promise((r) => setTimeout(r, 10));

		let restoreListeners: () => void;
		let processExitSpy: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			restoreListeners = detachProcessListeners(SIGNAL_EVENTS);
			processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		});

		afterEach(() => {
			processExitSpy.mockRestore();
			restoreListeners();
		});

		// Regression lock for #187: as a guest in the opencode host process we run
		// cleanup but must leave termination — and the session-id print — to the host.
		it("does not exit on SIGINT when it does not own the process", async () => {
			const { registerCleanup: freshRegister } = await freshShutdown();
			const cleanupFn = vi.fn();
			freshRegister(cleanupFn);

			process.emit("SIGINT", "SIGINT");
			await settle();

			expect(cleanupFn).toHaveBeenCalled();
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it("does not exit on SIGTERM when it does not own the process", async () => {
			const { registerCleanup: freshRegister } = await freshShutdown();
			const cleanupFn = vi.fn();
			freshRegister(cleanupFn);

			process.emit("SIGTERM", "SIGTERM");
			await settle();

			expect(cleanupFn).toHaveBeenCalled();
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it("lets a host SIGINT listener registered earlier still run", async () => {
			const hostHandler = vi.fn();
			process.on("SIGINT", hostHandler);

			const { registerCleanup: freshRegister } = await freshShutdown();
			const cleanupFn = vi.fn();
			freshRegister(cleanupFn);

			process.emit("SIGINT", "SIGINT");
			await settle();

			expect(hostHandler).toHaveBeenCalledTimes(1);
			expect(cleanupFn).toHaveBeenCalledTimes(1);
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it("SIGINT runs cleanup then exits 130 when it owns the process", async () => {
			const { registerCleanup: freshRegister, setShutdownOwnsProcess } = await freshShutdown();
			setShutdownOwnsProcess(true);

			const cleanupFn = vi.fn();
			freshRegister(cleanupFn);

			process.emit("SIGINT", "SIGINT");
			await settle();

			expect(cleanupFn).toHaveBeenCalled();
			expect(processExitSpy).toHaveBeenCalledWith(130);
		});

		it("SIGTERM runs cleanup then exits 143 when it owns the process", async () => {
			const { registerCleanup: freshRegister, setShutdownOwnsProcess } = await freshShutdown();
			setShutdownOwnsProcess(true);

			const cleanupFn = vi.fn();
			freshRegister(cleanupFn);

			process.emit("SIGTERM", "SIGTERM");
			await settle();

			expect(cleanupFn).toHaveBeenCalled();
			expect(processExitSpy).toHaveBeenCalledWith(143);
		});

		// `ownsProcess` is read at signal time, not captured when the handlers are
		// installed, so an entrypoint may opt in after the first registerCleanup.
		// A refactor that caches the flag at registration time would fail here.
		it("honours ownership claimed after the signal handlers are installed", async () => {
			const { registerCleanup: freshRegister, setShutdownOwnsProcess } = await freshShutdown();

			const cleanupFn = vi.fn();
			freshRegister(cleanupFn); // installs the handlers while still a guest
			setShutdownOwnsProcess(true);

			process.emit("SIGINT", "SIGINT");
			await settle();

			expect(cleanupFn).toHaveBeenCalled();
			expect(processExitSpy).toHaveBeenCalledWith(130);
		});

		it("awaits cleanup before exiting on the owning path", async () => {
			const { registerCleanup: freshRegister, setShutdownOwnsProcess } = await freshShutdown();
			setShutdownOwnsProcess(true);

			let release!: () => void;
			const slow = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
			freshRegister(slow);

			process.emit("SIGINT", "SIGINT");
			await settle();
			expect(slow).toHaveBeenCalled();
			expect(processExitSpy).not.toHaveBeenCalled();

			release();
			await settle();
			expect(processExitSpy).toHaveBeenCalledWith(130);
		});

		// Ownership is process-level state: the standalone `warm` CLI's claim
		// must survive a host re-evaluating the module graph, not silently reset
		// to guest-mode because a younger module generation exists.
		it("ownership claimed by an older module generation still applies", async () => {
			const owning = await freshShutdown();
			owning.setShutdownOwnsProcess(true);

			const { registerCleanup: freshRegister } = await freshShutdown();
			freshRegister(vi.fn());

			process.emit("SIGINT", "SIGINT");
			await settle();

			expect(processExitSpy).toHaveBeenCalledWith(130);
		});

		// The shared queue is what makes process-level handlers safe: a cleanup
		// registered by a re-evaluated module drains through the handler trio the
		// first generation attached, not through a second stacked set.
		it("drains cleanups registered by a re-evaluated module instance", async () => {
			await freshShutdown();

			const second = await freshShutdown();
			const cleanupFn = vi.fn();
			second.registerCleanup(cleanupFn);

			process.emit("SIGINT", "SIGINT");
			await settle();

			expect(cleanupFn).toHaveBeenCalled();
		});

		it("beforeExit handler runs cleanup without calling exit", async () => {
			const { registerCleanup: freshRegister } = await freshShutdown();
			const cleanupFn = vi.fn();
			freshRegister(cleanupFn);

			process.emit("beforeExit", 0);
			await settle();

			expect(cleanupFn).toHaveBeenCalled();
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		// The latch is the listeners' presence on `process`, not a module flag:
		// re-registering must not stack a second trio, and re-evaluating the
		// module (a host plugin reload) must not add another set either.
		it("does not stack signal handlers across re-registration or module re-evaluation", async () => {
			const { registerCleanup: freshRegister } = await freshShutdown();

			freshRegister(() => {});
			freshRegister(() => {});
			expect(process.listenerCount("SIGINT")).toBe(1);
			expect(process.listenerCount("SIGTERM")).toBe(1);
			expect(process.listenerCount("beforeExit")).toBe(1);

			const second = await freshShutdown();
			second.registerCleanup(() => {});
			expect(process.listenerCount("SIGINT")).toBe(1);
			expect(process.listenerCount("SIGTERM")).toBe(1);
			expect(process.listenerCount("beforeExit")).toBe(1);
		});

		// A host that strips every listener (removeAllListeners) must not strand
		// the queue: the next registration re-attaches the shared handlers.
		it("re-attaches handlers a host stripped", async () => {
			const { registerCleanup: freshRegister } = await freshShutdown();
			const cleanupFn = vi.fn();
			freshRegister(cleanupFn);

			process.removeAllListeners("SIGINT");
			freshRegister(vi.fn());
			expect(process.listenerCount("SIGINT")).toBe(1);

			process.emit("SIGINT", "SIGINT");
			await settle();
			expect(cleanupFn).toHaveBeenCalled();
		});
	});

	describe("AccountManager integration (Phase 1 reliability)", () => {
		beforeEach(async () => {
			await runCleanup();
			const { saveAccounts } = await import("../lib/storage.js");
			vi.mocked(saveAccounts).mockClear();
			vi.mocked(saveAccounts).mockResolvedValue();
		});

		it("shutdown flushes pending AccountManager save before exit", async () => {
			const { saveAccounts } = await import("../lib/storage.js");
			const mockSaveAccounts = vi.mocked(saveAccounts);
			const now = Date.now();
			const manager = new AccountManager(undefined, {
				version: 3,
				activeIndex: 0,
				accounts: [{ refreshToken: "t1", addedAt: now, lastUsed: now }],
			});

			// Schedule a save well beyond the window of any realistic test run;
			// if the shutdown handler is wired up, it must flush immediately.
			manager.saveToDiskDebounced(10_000);
			expect(mockSaveAccounts).not.toHaveBeenCalled();
			expect(getCleanupCount()).toBeGreaterThan(0);

			await runCleanup();

			expect(mockSaveAccounts).toHaveBeenCalledTimes(1);
			expect(getCleanupCount()).toBe(0);

			manager.disposeShutdownHandler();
		});

		it("is a no-op when no debounced save is pending", async () => {
			const { saveAccounts } = await import("../lib/storage.js");
			const mockSaveAccounts = vi.mocked(saveAccounts);
			const now = Date.now();
			const manager = new AccountManager(undefined, {
				version: 3,
				activeIndex: 0,
				accounts: [{ refreshToken: "t1", addedAt: now, lastUsed: now }],
			});

			manager.saveToDiskDebounced(10_000);
			await manager.flushPendingSave();
			mockSaveAccounts.mockClear();

			await runCleanup();

			expect(mockSaveAccounts).not.toHaveBeenCalled();
			manager.disposeShutdownHandler();
		});

		it("disposeShutdownHandler removes the cleanup registration", async () => {
			const { saveAccounts } = await import("../lib/storage.js");
			const mockSaveAccounts = vi.mocked(saveAccounts);
			const now = Date.now();
			const manager = new AccountManager(undefined, {
				version: 3,
				activeIndex: 0,
				accounts: [{ refreshToken: "t1", addedAt: now, lastUsed: now }],
			});

			manager.saveToDiskDebounced(10_000);
			const countWithHandler = getCleanupCount();
			expect(countWithHandler).toBeGreaterThan(0);

			manager.disposeShutdownHandler();
			expect(getCleanupCount()).toBe(countWithHandler - 1);

			await runCleanup();
			expect(mockSaveAccounts).not.toHaveBeenCalled();
		});

		it("survives a flushPendingSave rejection without blocking other cleanup", async () => {
			const { saveAccounts } = await import("../lib/storage.js");
			const mockSaveAccounts = vi.mocked(saveAccounts);
			mockSaveAccounts.mockRejectedValueOnce(new Error("disk full"));

			const now = Date.now();
			const manager = new AccountManager(undefined, {
				version: 3,
				activeIndex: 0,
				accounts: [{ refreshToken: "t1", addedAt: now, lastUsed: now }],
			});
			const secondCleanup = vi.fn();
			registerCleanup(secondCleanup);

			manager.saveToDiskDebounced(10_000);

			await runCleanup();

			expect(mockSaveAccounts).toHaveBeenCalledTimes(1);
			expect(secondCleanup).toHaveBeenCalledTimes(1);

			manager.disposeShutdownHandler();
		});
	});
});
