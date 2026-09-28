/**
 * Quota monitor under load (promoted stress harness).
 *
 *  A) N concurrent runNow() calls coalesce through the `running` flag: only
 *     ONE check actually fetches; the others return early WITHOUT awaiting it
 *     (callers see the pre-check state, not fresh — pinned behavior).
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
				await sleep(15);
				inFlight--;
				return { usage: { primary: null, secondary: null, codeReview: null, additionalLimits: [], limits: [], planType: null, credits: null, resetCredits: 0 } } as never;
			},
			notify: async () => false,
			notificationsSupported: () => false,
			initialDelayMs: 999_999_999, // never poll on its own
		});

		const runTimes: number[] = [];
		const t0 = Date.now();
		await Promise.all(
			Array.from({ length: 10 }, async () => {
				const s = Date.now();
				await monitor.runNow();
				runTimes.push(Date.now() - s);
			}),
		);
		const wallMs = Date.now() - t0;
		// ONE check ran (fetchSummary called once per account = 20).
		expect(fetches).toBe(ACCOUNTS);
		// The coalesced runNow callers did NOT await the check — they returned
		// early on the `running` flag. Measure: fastest runNow ~0ms vs check ~200ms.
		runTimes.sort((a, b) => a - b);
		console.log(
			`[quota-monitor] 10x runNow over 20 accts: wall=${wallMs}ms fetches=${fetches} ` +
			`maxFetchConcurrency=${maxInFlight} runNow times=${runTimes.join(",")}ms`,
		);
		expect(maxInFlight).toBeLessThanOrEqual(2); // MAX_CONCURRENCY cap
		// At least some runNow calls returned much faster than the full check —
		// proving they skipped rather than awaited (stale-read behavior).
		expect(runTimes[0]).toBeLessThan(50);
		monitor.dispose();
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
