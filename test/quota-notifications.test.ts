import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCodexUsagePayload, type CodexUsageSummary } from "../lib/codex-usage.js";
import {
	aggregateQuotaUsage,
	createQuotaMonitor,
	formatQuotaNotification,
	transitionQuotaState,
	type AccountQuotaSummary,
} from "../lib/quota-notifications.js";
import {
	getQuotaNotificationStatePath,
	readQuotaNotificationState,
	updateQuotaNotificationState,
} from "../lib/quota-notification-state.js";
import { getCleanupCount } from "../lib/shutdown.js";
import { setStoragePathDirect } from "../lib/storage/state.js";

function usage(options: {
	fiveHourUsed?: number;
	weeklyUsed?: number;
	fiveHourReset?: number;
	weeklyReset?: number;
	fiveHourWindowSeconds?: number;
	weeklyWindowSeconds?: number;
}): CodexUsageSummary {
	return parseCodexUsagePayload({
		rate_limit: {
			primary_window: {
				used_percent: options.fiveHourUsed,
				limit_window_seconds: options.fiveHourWindowSeconds ?? 18_000,
				reset_at: options.fiveHourReset,
			},
			secondary_window: {
				used_percent: options.weeklyUsed,
				limit_window_seconds: options.weeklyWindowSeconds ?? 604_800,
				reset_at: options.weeklyReset,
			},
		},
	});
}

function accountUsage(options: Parameters<typeof usage>[0]): AccountQuotaSummary {
	return { usage: usage(options) };
}

describe("quota notification aggregation", () => {
	it("pairs the most headroom with that same account's reset and reports the pool's earliest separately", () => {
		const result = aggregateQuotaUsage(
			[
				accountUsage({
					fiveHourUsed: 80,
					weeklyUsed: 30,
					fiveHourReset: 2_000,
					weeklyReset: 3_000,
				}),
				accountUsage({
					fiveHourUsed: 40,
					weeklyUsed: 90,
					fiveHourReset: 1_500,
					weeklyReset: 2_500,
				}),
			],
			1_000_000,
		);
		expect(result).toEqual({
			// Second account holds both the best quota and the earliest reset, so
			// there is no second reset to report.
			fiveHour: {
				remainingPercent: 60,
				resetAtMs: 1_500_000,
			},
			// First account has the best quota and recovers at its own 3_000_000.
			// The second account recovers earlier, at 2_500_000, but it is the
			// 90%-used one: folding its reset into `resetAtMs` would describe a
			// 70% quota that recovers at a time no account recovers at.
			weekly: {
				remainingPercent: 70,
				resetAtMs: 3_000_000,
				earliestResetAtMs: 2_500_000,
			},
		});
	});

	it("skips windows the plan has switched off instead of scoring them as full", () => {
		const result = aggregateQuotaUsage(
			[
				// Disabled 5-hour window: reports used_percent 0 with a zero-length
				// window, which would otherwise read as 100% remaining.
				accountUsage({
					fiveHourUsed: 0,
					fiveHourWindowSeconds: 0,
					weeklyUsed: 10,
				}),
				accountUsage({ fiveHourUsed: 98, weeklyUsed: 20 }),
			],
			1_000_000,
		);
		expect(result.fiveHour.remainingPercent).toBe(2);
		expect(result.weekly.remainingPercent).toBe(90);
	});

	it("reports nothing for a window that is disabled on every account", () => {
		const result = aggregateQuotaUsage(
			[accountUsage({ fiveHourUsed: 0, fiveHourWindowSeconds: 0, weeklyUsed: 40 })],
			1_000_000,
		);
		expect(result.fiveHour).toEqual({});
		expect(result.weekly.remainingPercent).toBe(60);
	});

	it("keeps a lower account's earlier reset out of the headline pair", () => {
		const result = aggregateQuotaUsage(
			[
				accountUsage({ fiveHourUsed: 20, fiveHourReset: 3_000 }),
				accountUsage({ fiveHourUsed: 50, fiveHourReset: 1_500 }),
			],
			1_000_000,
		);
		expect(result.fiveHour).toEqual({
			remainingPercent: 80,
			resetAtMs: 3_000_000,
			earliestResetAtMs: 1_500_000,
		});
	});

	it("prefers the earliest reset when two accounts tie on headroom", () => {
		const result = aggregateQuotaUsage(
			[
				accountUsage({ fiveHourUsed: 50, fiveHourReset: 3_000 }),
				accountUsage({ fiveHourUsed: 50, fiveHourReset: 1_500 }),
			],
			1_000_000,
		);
		// The tie-break already took the earliest, so nothing is left to report
		// as a separate pool reset.
		expect(result.fiveHour).toEqual({ remainingPercent: 50, resetAtMs: 1_500_000 });
	});

	it("ignores reset timestamps from windows without valid usage", () => {
		const result = aggregateQuotaUsage(
			[
				accountUsage({ fiveHourUsed: 50, fiveHourReset: 3_000 }),
				accountUsage({ fiveHourReset: 1_500 }),
			],
			1_000_000,
		);
		expect(result.fiveHour).toEqual({ remainingPercent: 50, resetAtMs: 3_000_000 });
	});

	it("ignores expired reset timestamps", () => {
		const result = aggregateQuotaUsage(
			[accountUsage({
				fiveHourUsed: 50,
				weeklyUsed: 50,
				fiveHourReset: 500,
				weeklyReset: 2_000,
			})],
			1_000_000,
		);
		expect(result.fiveHour.resetAtMs).toBeUndefined();
		expect(result.weekly.resetAtMs).toBe(2_000_000);
	});
});

describe("quota notification content", () => {
	it("shows a compact 5-hour summary and weekly best", () => {
		const aggregate = {
			fiveHour: {
				remainingPercent: 8,
				resetAtMs: Date.now() + 60_000,
			},
			weekly: {
				remainingPercent: 72,
				resetAtMs: Date.now() + 120_000,
			},
		};
		const lines = formatQuotaNotification(aggregate).split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/^5h: 8% left \| resets [^|]+$/);
		expect(lines[1]).toMatch(/^Weekly: 72% left \| resets [^|]+$/);
	});

	it("labels the pool's earlier reset instead of pairing it with the percentage", () => {
		const lines = formatQuotaNotification({
			fiveHour: {
				remainingPercent: 60,
				resetAtMs: Date.now() + 120_000,
				earliestResetAtMs: Date.now() + 60_000,
			},
			weekly: { remainingPercent: 72, resetAtMs: Date.now() + 120_000 },
		}).split("\n");
		expect(lines[0]).toMatch(/^5h: 60% left \| resets .+ \| another account resets .+$/);
		// No second reset in the pool, so no second clause.
		expect(lines[1]).not.toContain("another account");
	});

	it("handles a missing quota window", () => {
		expect(formatQuotaNotification({
			fiveHour: {},
			weekly: { remainingPercent: 20 },
		})).toBe("5h: unavailable\nWeekly: 20% left | resets unavailable");
	});
});

describe("quota threshold transitions", () => {
	const thresholds = [25, 10, 0];

	it("triggers 25%, 10%, and 0% as separate downward crossings", () => {
		const first = transitionQuotaState(
			undefined,
			{ fiveHour: { remainingPercent: 20 }, weekly: { remainingPercent: 100 } },
			thresholds,
		);
		expect(first.crossings.map((crossing) => crossing.threshold)).toEqual([25]);

		const second = transitionQuotaState(
			first.state,
			{ fiveHour: { remainingPercent: 9 }, weekly: { remainingPercent: 100 } },
			thresholds,
		);
		expect(second.crossings.map((crossing) => crossing.threshold)).toEqual([10]);

		const third = transitionQuotaState(
			second.state,
			{ fiveHour: { remainingPercent: 0 }, weekly: { remainingPercent: 100 } },
			thresholds,
		);
		expect(third.crossings.map((crossing) => crossing.threshold)).toEqual([0]);
	});

	it("selects the most severe threshold when usage jumps across bands", () => {
		const baseline = transitionQuotaState(
			undefined,
			{ fiveHour: { remainingPercent: 50 }, weekly: {} },
			thresholds,
		).state;
		const result = transitionQuotaState(
			baseline,
			{ fiveHour: { remainingPercent: 5 }, weekly: {} },
			thresholds,
		);
		expect(result.crossings[0]?.threshold).toBe(10);
	});

	it("tracks 5-hour and weekly windows independently", () => {
		const first = transitionQuotaState(
			undefined,
			{ fiveHour: { remainingPercent: 20 }, weekly: { remainingPercent: 50 } },
			thresholds,
		);
		const second = transitionQuotaState(
			first.state,
			{ fiveHour: { remainingPercent: 20 }, weekly: { remainingPercent: 20 } },
			thresholds,
		);
		expect(second.crossings).toMatchObject([
			{ window: "weekly", threshold: 25, remainingPercent: 20 },
		]);
	});

	it("preserves valid observations when a window is missing", () => {
		const first = transitionQuotaState(
			undefined,
			{ fiveHour: { remainingPercent: 20 }, weekly: { remainingPercent: 40 } },
			thresholds,
		);
		const second = transitionQuotaState(first.state, { fiveHour: {}, weekly: {} }, thresholds);
		expect(second.state.fiveHour).toEqual(first.state.fiveHour);
		expect(second.state.weekly).toEqual(first.state.weekly);
		expect(second.crossings).toEqual([]);
	});

	it("suppresses duplicates and re-arms after a reset", () => {
		const low = transitionQuotaState(
			undefined,
			{ fiveHour: { remainingPercent: 20 }, weekly: {} },
			thresholds,
		);
		const duplicate = transitionQuotaState(
			low.state,
			{ fiveHour: { remainingPercent: 15 }, weekly: {} },
			thresholds,
		);
		expect(duplicate.crossings).toEqual([]);

		const reset = transitionQuotaState(
			duplicate.state,
			{ fiveHour: { remainingPercent: 100 }, weekly: {} },
			thresholds,
		);
		const lowAgain = transitionQuotaState(
			reset.state,
			{ fiveHour: { remainingPercent: 20 }, weekly: {} },
			thresholds,
		);
		expect(lowAgain.crossings[0]?.threshold).toBe(25);
	});

	it("re-arms only when the window rises strictly above the threshold", () => {
		// A partial recovery to exactly 25 does not re-arm the 25% alert, which
		// is the documented contract: the window must rise *above* it. The user
		// was already told about 25 on the way down, and the more severe
		// thresholds below it still fire normally.
		const low = transitionQuotaState(
			undefined,
			{ fiveHour: { remainingPercent: 20 }, weekly: {} },
			thresholds,
		);
		expect(low.crossings[0]?.threshold).toBe(25);

		const partialRecovery = transitionQuotaState(
			low.state,
			{ fiveHour: { remainingPercent: 25 }, weekly: {} },
			thresholds,
		);
		expect(partialRecovery.crossings).toEqual([]);

		const dropAgain = transitionQuotaState(
			partialRecovery.state,
			{ fiveHour: { remainingPercent: 20 }, weekly: {} },
			thresholds,
		);
		expect(dropAgain.crossings).toEqual([]);

		const deeper = transitionQuotaState(
			dropAgain.state,
			{ fiveHour: { remainingPercent: 9 }, weekly: {} },
			thresholds,
		);
		expect(deeper.crossings[0]?.threshold).toBe(10);
	});

	it("picks the most severe crossing without assuming the thresholds are sorted", () => {
		const result = transitionQuotaState(
			undefined,
			{ fiveHour: { remainingPercent: 5 }, weekly: {} },
			[0, 25, 10],
		);
		expect(result.crossings[0]?.threshold).toBe(10);
	});

	it("never alerts when thresholds are explicitly empty", () => {
		const result = transitionQuotaState(
			undefined,
			{ fiveHour: { remainingPercent: 0 }, weekly: { remainingPercent: 0 } },
			[],
		);
		expect(result.crossings).toEqual([]);
		expect(result.state.fiveHour).toEqual({ lastPercent: 0 });
	});
});

describe("quota monitor lifecycle", () => {
	const tempDirectories: string[] = [];

	beforeEach(() => {
		vi.stubEnv("CODEX_AUTH_QUOTA_DISPLAY", "free");
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		vi.useRealTimers();
		setStoragePathDirect(null);
		await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
	});

	it("does not poll accounts while disabled and starts only one timer", async () => {
		vi.useFakeTimers();
		const loadStorage = vi.fn().mockResolvedValue(null);
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: false, autoProtectCredits: false, intervalMs: 1_000, notifyEveryCheck: false, thresholds: [25, 10, 0] }),
			loadStorage,
			initialDelayMs: 10,
		});
		monitor.start();
		monitor.start();
		await vi.advanceTimersByTimeAsync(10);
		expect(loadStorage).not.toHaveBeenCalled();
		monitor.dispose();
	});

	it("stops rescheduling once it sees the feature switched off", async () => {
		vi.useFakeTimers();
		const loadConfig = vi.fn(() => ({
			enabled: false,
			autoProtectCredits: false,
			intervalMs: 1_000,
			notifyEveryCheck: false,
			thresholds: [25, 10, 0],
		}));
		const monitor = createQuotaMonitor({ loadConfig, initialDelayMs: 10 });

		monitor.start();
		await vi.advanceTimersByTimeAsync(10_000);

		// One tick, then no standing timer: a disabled feature must not wake the
		// host every interval for the life of the process.
		expect(vi.getTimerCount()).toBe(0);
		monitor.dispose();
	});

	it("does not poll a configuration that can never deliver", async () => {
		vi.useFakeTimers();
		const loadStorage = vi.fn().mockResolvedValue(null);
		const monitor = createQuotaMonitor({
			// Enabled, but with no thresholds and no every-check alert there is
			// nothing any check could produce.
			loadConfig: () => ({ enabled: true, autoProtectCredits: false, intervalMs: 1_000, notifyEveryCheck: false, thresholds: [] }),
			loadStorage,
			notificationsSupported: () => true,
			initialDelayMs: 10,
		});

		// Driven through the scheduled poll rather than `runNow()`, which is
		// forced by design for the on-demand caller.
		monitor.start();
		await vi.advanceTimersByTimeAsync(10);

		expect(loadStorage).not.toHaveBeenCalled();
		monitor.dispose();
	});

	it("keeps polling on the configured interval while enabled", async () => {
		vi.useFakeTimers();
		const loadStorage = vi.fn().mockResolvedValue(null);
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, notifyEveryCheck: false, thresholds: [25, 10, 0] }),
			loadStorage,
			notificationsSupported: () => true,
			initialDelayMs: 10,
		});

		monitor.start();
		await vi.advanceTimersByTimeAsync(10);
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.advanceTimersByTimeAsync(1_000);

		expect(loadStorage).toHaveBeenCalledTimes(3);
		monitor.dispose();
	});

	it("cancels a scheduled check on disposal", async () => {
		vi.useFakeTimers();
		const loadStorage = vi.fn().mockResolvedValue(null);
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, notifyEveryCheck: false, thresholds: [25, 10, 0] }),
			loadStorage,
			initialDelayMs: 10,
		});
		monitor.start();
		monitor.dispose();
		await vi.advanceTimersByTimeAsync(20);
		expect(loadStorage).not.toHaveBeenCalled();
	});

	// Both switches govern the UNATTENDED poll, an invariant the two scheduling
	// tests above already hold. `runNow()` is the on-demand path, and its one
	// production caller is the all-accounts rate-limit wait, which is blocked
	// until it learns whether upstream capacity has returned. Honouring the
	// switches here left that wait asleep through a server-side reset, since
	// nothing local changes when a reset is granted.
	it("polls on demand even when notifications and credit protection are disabled", async () => {
		const loadStorage = vi.fn().mockResolvedValue({
			version: 3 as const,
			accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
			activeIndex: 0,
		});
		const fetchSummary = vi.fn().mockResolvedValue(accountUsage({
			fiveHourUsed: 10,
			weeklyUsed: 10,
		}));
		const notify = vi.fn();
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: false, autoProtectCredits: false, intervalMs: 1_000, notifyEveryCheck: false, thresholds: [25, 10, 0] }),
			loadStorage,
			fetchSummary,
			notify,
			notificationsSupported: () => false,
		});

		await monitor.runNow();

		expect(fetchSummary).toHaveBeenCalledOnce();
		// Forcing the probe must not deliver an alert the user switched off.
		expect(notify).not.toHaveBeenCalled();
	});

	it("polls to protect Credits even when desktop notifications are unavailable", async () => {
		const loadStorage = vi.fn().mockResolvedValue({
			version: 3 as const,
			accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
			activeIndex: 0,
		});
		const fetchSummary = vi.fn().mockResolvedValue(accountUsage({
			fiveHourUsed: 10,
			weeklyUsed: 10,
		}));
		const notify = vi.fn();
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, autoProtectCredits: true, intervalMs: 1_000, notifyEveryCheck: false, thresholds: [] }),
			loadStorage,
			fetchSummary,
			notify,
			notificationsSupported: () => false,
		});

		await monitor.runNow();

		expect(fetchSummary).toHaveBeenCalledOnce();
		expect(notify).not.toHaveBeenCalled();
	});

	it("fetches on demand without delivering, leaving a crossing for the poll to announce", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quota-monitor-"));
		tempDirectories.push(directory);
		const storagePath = join(directory, "accounts.json");
		setStoragePathDirect(storagePath);
		const notify = vi.fn().mockResolvedValue(true);
		const fetchSummary = vi.fn().mockResolvedValue(accountUsage({
			fiveHourUsed: 50,
			weeklyUsed: 80,
		}));
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 60_000, notifyEveryCheck: true, thresholds: [25, 10, 0] }),
			loadStorage: async () => ({
				version: 3,
				accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
				activeIndex: 0,
			}),
			fetchSummary,
			notify,
			notificationsSupported: () => true,
			initialDelayMs: 0,
		});

		// The request-path re-probe (probeUpstreamBlockLifted) calls runNow()
		// inside a wait that can run for days. notifyEveryCheck opts into the
		// POLL's cadence, so the probe must refresh usage and nothing else: no
		// alert, and no state write that would consume the crossing the next
		// scheduled check is meant to announce.
		await monitor.runNow();

		expect(fetchSummary).toHaveBeenCalledOnce();
		expect(notify).not.toHaveBeenCalled();
		expect(await readQuotaNotificationState(getQuotaNotificationStatePath(storagePath))).toBeUndefined();

		monitor.start();
		try {
			await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
		} finally {
			monitor.dispose();
		}
	});

	it.each([
		["free", "50% left", "20% left"],
		["used", "50% used", "80% used"],
	])("notifies in %s mode when only the weekly window crosses a threshold", async (mode, fiveHourPercent, weeklyPercent) => {
		vi.stubEnv("CODEX_AUTH_QUOTA_DISPLAY", mode);
		const directory = await mkdtemp(join(tmpdir(), "quota-monitor-"));
		tempDirectories.push(directory);
		const storagePath = join(directory, "accounts.json");
		setStoragePathDirect(storagePath);
		const notify = vi.fn().mockResolvedValue(true);
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 60_000, notifyEveryCheck: false, thresholds: [25, 10, 0] }),
			loadStorage: async () => ({
				version: 3,
				accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
				activeIndex: 0,
			}),
			fetchSummary: async () => accountUsage({
				fiveHourUsed: 50,
				weeklyUsed: 80,
			}),
			notify,
			notificationsSupported: () => true,
			initialDelayMs: 0,
		});
		// Seed the prior observation at 50% so the poll sees the weekly window
		// cross 25 downward rather than reading 20% for the first time.
		await updateQuotaNotificationState(getQuotaNotificationStatePath(storagePath), () => ({
			state: { fiveHour: { lastPercent: 50 }, weekly: { lastPercent: 50 }, updatedAt: 0 },
			result: undefined,
		}));

		monitor.start();
		try {
			await vi.waitFor(() => {
				expect(notify).toHaveBeenCalledWith(
					"Codex quota status",
					`5h: ${fiveHourPercent} | resets unavailable\nWeekly: ${weeklyPercent} | resets unavailable`,
				);
			});
		} finally {
			monitor.dispose();
		}
	});

	it("notifies after every successful check when configured", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quota-monitor-"));
		tempDirectories.push(directory);
		setStoragePathDirect(join(directory, "accounts.json"));
		const notify = vi.fn().mockResolvedValue(true);
		let now = 1_000;
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 100, notifyEveryCheck: true, thresholds: [25, 10, 0] }),
			loadStorage: async () => ({
				version: 3,
				accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
				activeIndex: 0,
			}),
			fetchSummary: async () => accountUsage({
				fiveHourUsed: 50,
				weeklyUsed: 50,
			}),
			notify,
			notificationsSupported: () => true,
			now: () => now,
			initialDelayMs: 0,
		});

		monitor.start();
		try {
			await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
			now += 100;
			await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
		} finally {
			monitor.dispose();
		}
	});

	it("delivers only once per interval across monitor instances", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quota-monitor-"));
		tempDirectories.push(directory);
		setStoragePathDirect(join(directory, "accounts.json"));
		const notify = vi.fn().mockResolvedValue(true);
		const loadStorage = vi.fn().mockResolvedValue({
			version: 3 as const,
			accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
			activeIndex: 0,
		});
		const dependencies = {
			loadConfig: () => ({ enabled: true, intervalMs: 60_000, notifyEveryCheck: true, thresholds: [25, 10, 0] }),
			loadStorage,
			fetchSummary: async () => accountUsage({
				fiveHourUsed: 50,
				weeklyUsed: 50,
			}),
			notify,
			notificationsSupported: () => true,
			now: () => 1_000,
			initialDelayMs: 0,
		};
		const first = createQuotaMonitor(dependencies);
		const second = createQuotaMonitor(dependencies);

		first.start();
		second.start();
		try {
			await vi.waitFor(() => expect(loadStorage).toHaveBeenCalledTimes(2));
			await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
			// The losing monitor's claim must still settle: it has to observe the
			// winner's lastDeliveredAt instead of delivering a second alert.
			await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
		} finally {
			first.dispose();
			second.dispose();
		}
		expect(notify).toHaveBeenCalledOnce();
	});

	it("does not notify every check when no quota fetch succeeds", async () => {
		const notify = vi.fn().mockResolvedValue(true);
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, notifyEveryCheck: true, thresholds: [25, 10, 0] }),
			loadStorage: async () => ({
				version: 3,
				accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
				activeIndex: 0,
			}),
			fetchSummary: async () => null,
			notify,
			notificationsSupported: () => true,
		});

		await monitor.runNow();

		expect(notify).not.toHaveBeenCalled();
	});

	it("invalidates the account cache when a refresh rotated a credential", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quota-monitor-"));
		tempDirectories.push(directory);
		setStoragePathDirect(join(directory, "accounts.json"));
		const onCredentialsPersisted = vi.fn();
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, notifyEveryCheck: false, thresholds: [25, 10, 0] }),
			loadStorage: async () => ({
				version: 3,
				accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
				activeIndex: 0,
			}),
			// A rotation that is durable on disk even though the usage fetch then
			// fails: the stale cached AccountManager still has to be dropped.
			fetchSummary: async (_storage, _account, credentialsPersisted) => {
				credentialsPersisted();
				return null;
			},
			notify: vi.fn().mockResolvedValue(true),
			notificationsSupported: () => true,
		});

		await monitor.runNow();

		expect(onCredentialsPersisted).not.toHaveBeenCalled();

		const withCallback = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, notifyEveryCheck: false, thresholds: [25, 10, 0] }),
			loadStorage: async () => ({
				version: 3,
				accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
				activeIndex: 0,
			}),
			fetchSummary: async (_storage, _account, credentialsPersisted) => {
				credentialsPersisted();
				return null;
			},
			onCredentialsPersisted,
			notify: vi.fn().mockResolvedValue(true),
			notificationsSupported: () => true,
		});

		await withCallback.runNow();

		expect(onCredentialsPersisted).toHaveBeenCalledOnce();
	});

	it("delivers the notification outside the cross-process state lease", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quota-monitor-"));
		tempDirectories.push(directory);
		const storagePath = join(directory, "accounts.json");
		setStoragePathDirect(storagePath);
		const statePath = getQuotaNotificationStatePath(storagePath);
		let leaseWasFree: boolean | undefined;

		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 1_000, notifyEveryCheck: true, thresholds: [25, 10, 0] }),
			loadStorage: async () => ({
				version: 3,
				accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
				activeIndex: 0,
			}),
			fetchSummary: async () => accountUsage({ fiveHourUsed: 50, weeklyUsed: 50 }),
			// Stands in for the ~10s osascript call. Another process must be able
			// to take the lease while this runs.
			notify: async () => {
				leaseWasFree = await updateQuotaNotificationState(statePath, (persisted) => ({
					state: persisted ?? { fiveHour: {}, weekly: {}, updatedAt: 1 },
					result: true,
				})).catch(() => false);
				return true;
			},
			notificationsSupported: () => true,
			initialDelayMs: 0,
		});

		monitor.start();
		try {
			await vi.waitFor(() => expect(leaseWasFree).toBe(true));
		} finally {
			monitor.dispose();
		}
	});

	it("re-arms a crossed threshold when delivery fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quota-monitor-"));
		tempDirectories.push(directory);
		setStoragePathDirect(join(directory, "accounts.json"));
		const notify = vi.fn().mockResolvedValue(false);
		const dependencies = {
			loadConfig: () => ({ enabled: true, intervalMs: 500, notifyEveryCheck: false, thresholds: [25, 10, 0] }),
			loadStorage: async () => ({
				version: 3 as const,
				accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
				activeIndex: 0,
			}),
			fetchSummary: async () => accountUsage({ fiveHourUsed: 50, weeklyUsed: 80 }),
			notify,
			notificationsSupported: () => true,
			now: () => 1_000,
			initialDelayMs: 0,
		};
		const monitor = createQuotaMonitor(dependencies);

		monitor.start();
		try {
			// Both checks see weekly at 20%: the first crossing was never
			// delivered, so the second must try again rather than treat it as
			// already alerted.
			await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
		} finally {
			monitor.dispose();
		}
		// The claim release can still be in flight when the second attempt
		// returns, so wait for the reverted state to land on disk.
		await vi.waitFor(async () => {
			expect(await readQuotaNotificationState(getQuotaNotificationStatePath(join(directory, "accounts.json"))))
				.toMatchObject({ weekly: {}, lastDeliveredAt: undefined });
		});
	});

	it("writes state beside the accounts file the check actually read", async () => {
		const projectA = await mkdtemp(join(tmpdir(), "quota-monitor-a-"));
		const projectB = await mkdtemp(join(tmpdir(), "quota-monitor-b-"));
		tempDirectories.push(projectA, projectB);
		const accountsA = join(projectA, "accounts.json");
		const accountsB = join(projectB, "accounts.json");
		setStoragePathDirect(accountsA);

		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 60_000, notifyEveryCheck: true, thresholds: [25, 10, 0] }),
			loadStorage: async () => ({
				version: 3,
				accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
				activeIndex: 0,
			}),
			fetchSummary: async () => {
				// The host switched projects while the fetches were in flight.
				setStoragePathDirect(accountsB);
				return accountUsage({ fiveHourUsed: 50, weeklyUsed: 50 });
			},
			notify: vi.fn().mockResolvedValue(true),
			notificationsSupported: () => true,
			initialDelayMs: 0,
		});

		monitor.start();
		try {
			await vi.waitFor(async () => {
				expect(await readQuotaNotificationState(getQuotaNotificationStatePath(accountsA))).toBeTruthy();
			});
		} finally {
			monitor.dispose();
		}
		expect(await readQuotaNotificationState(getQuotaNotificationStatePath(accountsB))).toBeUndefined();
	});

	it("tears the timer down through the shared shutdown drain", () => {
		vi.useFakeTimers();
		const before = getCleanupCount();
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: false, intervalMs: 1_000, notifyEveryCheck: false, thresholds: [25, 10, 0] }),
			initialDelayMs: 10,
		});

		monitor.start();
		expect(getCleanupCount()).toBe(before + 1);

		monitor.dispose();
		expect(getCleanupCount()).toBe(before);
	});
});

describe("quota monitor delivery dedup vs clock skew", () => {
	const tempDirectories: string[] = [];

	afterEach(async () => {
		setStoragePathDirect(null);
		await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
	});

	function everyCheckMonitor(storagePath: string, notify: ReturnType<typeof vi.fn>, now: () => number) {
		return createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 60_000, notifyEveryCheck: true, thresholds: [25, 10, 0] }),
			loadStorage: async () => ({
				version: 3,
				accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
				activeIndex: 0,
			}),
			fetchSummary: async () => accountUsage({ fiveHourUsed: 50, weeklyUsed: 50 }),
			notify,
			notificationsSupported: () => true,
			now,
			initialDelayMs: 0,
		});
	}

	it("delivers when the persisted lastDeliveredAt is in the future, and self-heals the stamp", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quota-monitor-"));
		tempDirectories.push(directory);
		const storagePath = join(directory, "accounts.json");
		setStoragePathDirect(storagePath);
		const statePath = getQuotaNotificationStatePath(storagePath);
		// A clock rollback, or a file written by a host whose clock ran ahead:
		// `now - prev` is negative, which must not suppress delivery until wall
		// time reaches stamp+interval.
		await updateQuotaNotificationState(statePath, () => ({
			state: { fiveHour: {}, weekly: {}, lastDeliveredAt: 5_000, updatedAt: 4_900 },
			result: undefined,
		}));

		const notify = vi.fn().mockResolvedValue(true);
		const monitor = everyCheckMonitor(storagePath, notify, () => 1_000);

		monitor.start();
		try {
			await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
		} finally {
			monitor.dispose();
		}
		// Delivering once re-dates the stamp to now — the corrupted file heals
		// itself instead of suppressing alerts forever.
		const persisted = await readQuotaNotificationState(statePath);
		expect(persisted?.lastDeliveredAt).toBe(1_000);
	});

	it("still delivers when a rollback makes the interval diff negative", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quota-monitor-"));
		tempDirectories.push(directory);
		const storagePath = join(directory, "accounts.json");
		setStoragePathDirect(storagePath);
		const statePath = getQuotaNotificationStatePath(storagePath);
		// Delivered at 60_000 under a clock that has since rolled back to 1_000.
		await updateQuotaNotificationState(statePath, () => ({
			state: { fiveHour: {}, weekly: {}, lastDeliveredAt: 60_000, updatedAt: 59_900 },
			result: undefined,
		}));

		const notify = vi.fn().mockResolvedValue(true);
		const monitor = everyCheckMonitor(storagePath, notify, () => 1_000);

		monitor.start();
		try {
			await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
		} finally {
			monitor.dispose();
		}
	});

	it.each([
		// now - prev === intervalMs: exactly due (>= boundary).
		{ lastDeliveredAt: 1_000, now: 61_000, expectDelivery: true },
		// now - prev === intervalMs - 1: one tick short, still suppressed.
		{ lastDeliveredAt: 1_001, now: 61_000, expectDelivery: false },
	])("interval boundary: prev=$lastDeliveredAt now=$now -> delivered=$expectDelivery", async ({ lastDeliveredAt, now, expectDelivery }) => {
		const directory = await mkdtemp(join(tmpdir(), "quota-monitor-"));
		tempDirectories.push(directory);
		const storagePath = join(directory, "accounts.json");
		setStoragePathDirect(storagePath);
		const statePath = getQuotaNotificationStatePath(storagePath);
		await updateQuotaNotificationState(statePath, () => ({
			state: {
				fiveHour: { lastPercent: 50 },
				weekly: { lastPercent: 50 },
				lastDeliveredAt,
				updatedAt: lastDeliveredAt,
			},
			result: undefined,
		}));

		const notify = vi.fn().mockResolvedValue(true);
		const loadStorage = vi.fn().mockResolvedValue({
			version: 3 as const,
			accounts: [{ refreshToken: "token", addedAt: 0, lastUsed: 0 }],
			activeIndex: 0,
		});
		const monitor = createQuotaMonitor({
			loadConfig: () => ({ enabled: true, intervalMs: 60_000, notifyEveryCheck: true, thresholds: [25, 10, 0] }),
			loadStorage,
			fetchSummary: async () => accountUsage({ fiveHourUsed: 50, weeklyUsed: 50 }),
			notify,
			notificationsSupported: () => true,
			now: () => now,
			initialDelayMs: 0,
		});

		monitor.start();
		try {
			// The claim write lands before the delivery decision: `updatedAt`
			// flipping to `now` proves the check ran to completion, so the
			// non-delivery assertion needs no arbitrary sleep.
			await vi.waitFor(async () => {
				const persisted = await readQuotaNotificationState(statePath);
				expect(persisted?.updatedAt).toBe(now);
			});
			if (expectDelivery) {
				await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
			} else {
				expect(notify).not.toHaveBeenCalled();
				const persisted = await readQuotaNotificationState(statePath);
				expect(persisted?.lastDeliveredAt).toBe(lastDeliveredAt);
			}
		} finally {
			monitor.dispose();
		}
	});
});
