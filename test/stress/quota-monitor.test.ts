/**
 * Quota monitor under load (promoted stress harness).
 *
 *  A) N overlapping runNow() calls perform one check, with fetch concurrency capped.
 *  B) fetchSummary concurrency is capped at MAX_CONCURRENCY=2.
 *  C) dispose() mid-check suppresses the stale check's deliveries.
 */
import { describe, it, expect, vi } from "vitest";
import { createQuotaMonitor } from "../../lib/quota-notifications.js";

vi.mock("../../lib/config.js", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../../lib/config.js")>();
	return {
		...orig,
		loadPluginConfig: vi.fn(() => ({})),
		getQuotaNotifications: vi.fn(() => ({
			enabled: false,
			intervalMs: 60_000,
			thresholds: [],
			notifyEveryCheck: false,
			autoProtectCredits: true,
		})),
		getQuotaDisplay: vi.fn(() => ({ mode: "left" })),
	};
});
vi.mock("../../lib/logger.js", () => ({
	createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
	logInfo: vi.fn(), logWarn: vi.fn(), logDebug: vi.fn(), logError: vi.fn(),
}));
vi.mock("../../lib/desktop-notifications.js", () => ({
	isDesktopNotificationSupported: () => false,
	sendDesktopNotification: vi.fn(async () => false),
}));
vi.mock("../../lib/codex-usage.js", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../../lib/codex-usage.js")>();
	return { ...orig };
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("A) concurrent runNow coalescing", () => {
	it("10 overlapping runNow calls -> exactly ONE check's worth of fetches", async () => {
		const ACCOUNTS = 20;
		let fetches = 0;
		let inFlight = 0;
		let maxInFlight = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const monitor = createQuotaMonitor({
			loadConfig: () => ({
				enabled: false,
				intervalMs: 60_000,
				thresholds: [],
				notifyEveryCheck: false,
				autoProtectCredits: true,
			} as never),
			loadStorage: async () => ({
				version: 3,
				activeIndex: 0,
				accounts: Array.from({ length: ACCOUNTS }, (_, i) => ({
					refreshToken: `r-${i}`,
					accountId: `acct-${i}`,
					accountUserId: `user-${i}`,
				})),
			} as never),
			fetchSummary: async () => {
				fetches++;
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await gate;
				inFlight--;
				return { usage: { primary: null, secondary: null, codeReview: null, additionalLimits: [], limits: [], planType: null, credits: null, resetCredits: 0 } } as never;
			},
			notify: async () => false,
			notificationsSupported: () => false,
			initialDelayMs: 999_999_999, // never poll on its own
		});

		let completed = 0;
		const callers = Array.from({ length: 10 }, async () => {
			await monitor.runNow();
			completed++;
		});
		try {
			await Promise.all(callers.slice(1));
			await vi.waitFor(() => expect(fetches).toBe(2));
			expect(completed).toBe(9);
			release();
			await Promise.all(callers);
			expect(completed).toBe(10);
			expect(fetches).toBe(ACCOUNTS);
			expect(maxInFlight).toBeLessThanOrEqual(2);
		} finally {
			release();
			monitor.dispose();
			await Promise.all(callers);
		}
	}, 30_000);
});

describe("B) a caller that arrives AFTER the check pays a full new check", () => {
	it("sequential runNow x3 -> 3 checks (dedup only covers overlap)", async () => {
		let fetches = 0;
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: false, intervalMs: 60_000, thresholds: [], notifyEveryCheck: false, autoProtectCredits: true } as never),
			loadStorage: async () => ({
				version: 3, activeIndex: 0,
				accounts: [{ refreshToken: "r-0", accountId: "a-0", accountUserId: "u-0" }],
			} as never),
			fetchSummary: async () => {
				fetches++;
				await sleep(30);
				return { usage: {} } as never;
			},
			notificationsSupported: () => false,
			initialDelayMs: 999_999_999,
		});
		await monitor.runNow();
		await monitor.runNow();
		await monitor.runNow();
		expect(fetches).toBe(3);
		monitor.dispose();
	});
});

describe("C) dispose mid-check suppresses stale deliveries", () => {
	it("a runNow whose generation is killed by dispose() does not notify", async () => {
		let delivered = 0;
		let releaseFetch: (() => void) | undefined;
		const gate = new Promise<void>((r) => { releaseFetch = r; });
		const monitor = createQuotaMonitor({
			loadConfig: () => ({
				enabled: true,
				intervalMs: 60_000,
				thresholds: [{ window: "primary", belowPercent: 50 } as never],
				notifyEveryCheck: true,
				autoProtectCredits: true,
			} as never),
			loadStorage: async () => ({
				version: 3, activeIndex: 0,
				accounts: [{ refreshToken: "r-0", accountId: "a-0", accountUserId: "u-0" }],
			} as never),
			fetchSummary: async () => {
				await gate; // hold the check open so dispose lands mid-flight
				return { usage: {} } as never;
			},
			notify: async () => { delivered++; return true; },
			notificationsSupported: () => true,
			statePathForTest: undefined as never,
			initialDelayMs: 999_999_999,
		});
		const pending = monitor.runNow();
		await sleep(10);
		monitor.dispose(); // kills the generation the in-flight check belongs to
		releaseFetch!();
		await pending;
		expect(delivered).toBe(0);
	});
});
