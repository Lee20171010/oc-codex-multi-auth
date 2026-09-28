type CleanupFn = () => void | Promise<void>;

/**
 * Process-level shutdown state shared by every evaluation of this module.
 *
 * The queue and handler latch used to be module-scope: a plugin reload (or a
 * test's `vi.resetModules()`) that re-evaluated this file reset
 * `shutdownRegistered` and stacked another trio of `process.once` listeners,
 * so reloaded instances accumulated +3 listeners each and their cleanups only
 * ran through whichever handler generation still happened to be attached.
 * Keyed on `globalThis` via `Symbol.for`, one handler set and one cleanup
 * queue now serve the process regardless of how many module generations are
 * live — a cleanup registered by a later generation still drains on signal.
 */
interface ShutdownState {
	cleanupFunctions: CleanupFn[];
	/**
	 * Whether this process is ours to terminate.
	 *
	 * Defaults to false: the package normally runs as a plugin *inside* the
	 * opencode host process, where calling `process.exit` from a signal handler
	 * preempts opencode's own shutdown (#187). Only an entrypoint that IS the
	 * process — the standalone `warm` CLI — opts in. Read lazily at signal
	 * time, so the opt-in may happen after handlers are installed, and shared
	 * process-wide so a module re-evaluation cannot lose the claim.
	 */
	ownsProcess: boolean;
	/**
	 * The in-flight drain, if one is running. Concurrent callers (a signal
	 * handler and `beforeExit` firing in the same shutdown) share it rather
	 * than racing on an already-emptied queue. Cleared once settled, so
	 * *sequential* calls each drain freshly — `AccountManager` re-registers
	 * its flush handler after an external `runCleanup()`, and the test suites
	 * depend on that.
	 */
	inFlight: Promise<void> | null;
	onSigint: () => void;
	onSigterm: () => void;
	onBeforeExit: () => void;
}

const SHUTDOWN_STATE_KEY = Symbol.for("oc-codex-multi-auth:shutdown");

function handleSignal(signal: "SIGINT" | "SIGTERM"): void {
	const drained = runCleanup();
	// A guest in someone else's process: run cleanup, then let the host
	// finish its own shutdown. Exiting here is what broke #187.
	if (!state.ownsProcess) return;
	void drained.finally(() => {
		process.exit(signal === "SIGTERM" ? 143 : 130);
	});
}

const state: ShutdownState = (() => {
	const holder = globalThis as Record<PropertyKey, unknown>;
	const existing = holder[SHUTDOWN_STATE_KEY];
	if (existing) return existing as ShutdownState;
	const created: ShutdownState = {
		cleanupFunctions: [],
		ownsProcess: false,
		inFlight: null,
		onSigint: () => handleSignal("SIGINT"),
		onSigterm: () => handleSignal("SIGTERM"),
		onBeforeExit: () => {
			void runCleanup();
		},
	};
	holder[SHUTDOWN_STATE_KEY] = created;
	return created;
})();

export function setShutdownOwnsProcess(owns: boolean): void {
	state.ownsProcess = owns;
}

export function registerCleanup(fn: CleanupFn): void {
	state.cleanupFunctions.push(fn);
	ensureShutdownHandler();
}

export function unregisterCleanup(fn: CleanupFn): void {
	const index = state.cleanupFunctions.indexOf(fn);
	if (index !== -1) {
		state.cleanupFunctions.splice(index, 1);
	}
}

export function runCleanup(): Promise<void> {
	if (state.inFlight) return state.inFlight;

	const fns = [...state.cleanupFunctions];
	state.cleanupFunctions.length = 0;

	state.inFlight = (async () => {
		for (const fn of fns) {
			try {
				await fn();
			} catch {
				// Ignore cleanup errors during shutdown
			}
		}
	})().finally(() => {
		state.inFlight = null;
	});

	return state.inFlight;
}

function ensureShutdownHandler(): void {
	// `process.once` wraps the listener but `process.listeners` unwraps it, so
	// identity comparison against the stored originals tells whether each
	// handler is still attached. A host or test that stripped them
	// (removeAllListeners) gets them re-attached here instead of deduped away
	// behind a stale boolean.
	if (!process.listeners("SIGINT").includes(state.onSigint)) {
		process.once("SIGINT", state.onSigint);
	}
	if (!process.listeners("SIGTERM").includes(state.onSigterm)) {
		process.once("SIGTERM", state.onSigterm);
	}
	if (!process.listeners("beforeExit").includes(state.onBeforeExit)) {
		process.once("beforeExit", state.onBeforeExit);
	}
}

export function getCleanupCount(): number {
	return state.cleanupFunctions.length;
}
