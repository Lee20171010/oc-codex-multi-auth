import {
	getQuotaDisplay,
	getQuotaNotifications,
	loadPluginConfig,
	type QuotaNotificationsConfig,
} from "./config.js";
import {
	DEFAULT_QUOTA_DISPLAY_MODE,
	formatNamedQuotaPercent,
	type QuotaDisplayMode,
} from "./quota-display.js";
import {
	deduplicateUsageAccountIndices,
	ensureCodexUsageAccessToken,
	fetchCodexUsage,
	formatUsageReset,
	getUsageLeftPercent,
	getUsageQuotaExhaustedResetAtMs,
	hasUsageWindow,
	parseCodexUsagePayload,
	persistUsageQuotaExhaustion,
	persistUsageQuotaRecovery,
	isUsageQuotaRecovered,
	resolveCodexUsageAccountId,
	type CodexUsageSummary,
} from "./codex-usage.js";
import { autoRedeemResetCredit } from "./codex-reset.js";
import { logDebug, logInfo, logWarn } from "./logger.js";
import {
	isDesktopNotificationSupported,
	sendDesktopNotification,
	type DesktopNotifier,
} from "./desktop-notifications.js";
import {
	getQuotaNotificationStatePath,
	updateQuotaNotificationState,
	type QuotaNotificationState,
	type QuotaWindowNotificationState,
} from "./quota-notification-state.js";
import { registerCleanup, unregisterCleanup } from "./shutdown.js";
import { loadAccounts, type AccountMetadataV3, type AccountStorageV3 } from "./storage.js";
import { getStoragePath } from "./storage/state.js";

const INITIAL_CHECK_DELAY_MS = 10_000;
const MAX_CONCURRENCY = 2;

export type QuotaWindowName = "fiveHour" | "weekly";

export interface AggregatedQuotaWindow {
	/** Headroom of the enabled account with the most room left in this window. */
	remainingPercent?: number;
	/**
	 * Reset time of the account `remainingPercent` was taken from. Always the
	 * same account, so the pair describes a quota one account actually has.
	 */
	resetAtMs?: number;
	/**
	 * Earliest reset across every enabled account with usable usage, set only
	 * when some other account recovers before {@link resetAtMs}. Reported as its
	 * own value rather than folded into `resetAtMs`, because a max-percent /
	 * min-reset pair describes a quota no account holds.
	 */
	earliestResetAtMs?: number;
}

export interface AggregatedQuotaUsage {
	fiveHour: AggregatedQuotaWindow;
	weekly: AggregatedQuotaWindow;
}

export interface QuotaThresholdCrossing {
	window: QuotaWindowName;
	threshold: number;
	remainingPercent: number;
	/** Reset of the account `remainingPercent` came from; never a different one. */
	resetAtMs?: number;
	/** Earliest reset in the pool, when it is not `resetAtMs`. */
	earliestResetAtMs?: number;
}

export interface AccountQuotaSummary {
	usage: CodexUsageSummary;
}

export interface QuotaMonitor {
	start(): void;
	dispose(): void;
	runNow(): Promise<void>;
}

type MonitorDependencies = {
	loadConfig: () => QuotaNotificationsConfig;
	loadStorage: () => Promise<AccountStorageV3 | null>;
	fetchSummary: (
		storage: AccountStorageV3,
		account: AccountMetadataV3 | undefined,
		onCredentialsPersisted: () => void,
		autoProtectCredits: boolean,
		autoRedeemBelowPercent?: number,
	) => Promise<AccountQuotaSummary | null>;
	notify: DesktopNotifier;
	notificationsSupported: () => boolean;
	/**
	 * Called once per check when refreshing an account rotated its single-use
	 * refresh token to disk. The host wires this to its account-manager cache
	 * invalidation; see {@link fetchUsageForAccount} for why it is mandatory.
	 */
	onCredentialsPersisted: () => void;
	now: () => number;
	initialDelayMs: number;
};

/**
 * Reduce one quota window across accounts to the single account that has the
 * most room left, reporting that account's own reset time, plus the earliest
 * reset anywhere in the pool.
 *
 * Three rules matter here:
 *
 *   - A window the plan has switched off is skipped via {@link hasUsageWindow}.
 *     Such a window still reports `used_percent: 0`, so counting it would score
 *     a disabled window as 100% remaining and mask every other account.
 *   - `remainingPercent` and `resetAtMs` are taken from the *same* account. A
 *     max-percent/min-reset pair describes a quota no account actually has: the
 *     reader waits for a reset that belongs to a different, exhausted account.
 *   - The pool's earliest reset is still worth reporting — it is when capacity
 *     next returns — so it is carried separately in `earliestResetAtMs` and
 *     rendered under its own label. Only windows with usable usage contribute,
 *     so a window with a reset but no readable `used_percent` cannot supply one.
 */
function aggregateWindow(
	summaries: readonly AccountQuotaSummary[],
	select: (summary: CodexUsageSummary) => CodexUsageSummary["primary"],
	now: number,
): AggregatedQuotaWindow {
	let best: { remainingPercent: number; resetAtMs?: number } | undefined;
	let earliestResetAtMs: number | undefined;
	for (const accountSummary of summaries) {
		const window = select(accountSummary.usage);
		if (!hasUsageWindow(window)) continue;
		const remaining = getUsageLeftPercent(window.usedPercent);
		if (remaining === undefined) continue;
		const resetAtMs =
			typeof window.resetAtMs === "number" &&
			Number.isFinite(window.resetAtMs) &&
			window.resetAtMs > now
				? window.resetAtMs
				: undefined;
		if (
			resetAtMs !== undefined &&
			(earliestResetAtMs === undefined || resetAtMs < earliestResetAtMs)
		) {
			earliestResetAtMs = resetAtMs;
		}
		if (best === undefined || remaining > best.remainingPercent) {
			best = { remainingPercent: remaining, resetAtMs };
			continue;
		}
		// Tie on headroom: prefer the account that recovers first, and prefer a
		// known reset over an unknown one.
		if (
			remaining === best.remainingPercent &&
			resetAtMs !== undefined &&
			(best.resetAtMs === undefined || resetAtMs < best.resetAtMs)
		) {
			best = { remainingPercent: remaining, resetAtMs };
		}
	}
	if (!best) return {};
	return {
		remainingPercent: best.remainingPercent,
		resetAtMs: best.resetAtMs,
		// Omitted when it is the same instant the best account already reports,
		// so the message carries one reset unless the pool really has two.
		...(earliestResetAtMs !== undefined && earliestResetAtMs !== best.resetAtMs
			? { earliestResetAtMs }
			: {}),
	};
}

export function aggregateQuotaUsage(
	summaries: readonly AccountQuotaSummary[],
	now = Date.now(),
): AggregatedQuotaUsage {
	return {
		fiveHour: aggregateWindow(summaries, (summary) => summary.primary, now),
		weekly: aggregateWindow(summaries, (summary) => summary.secondary, now),
	};
}

/**
 * Decide whether this observation crosses a threshold downward.
 *
 * A threshold fires when the window is at or below it *and* the previous
 * observation was strictly above it, which is the "rises above it after a
 * reset" contract in `docs/configuration.md`. The most severe matching
 * threshold wins, and the selection does not assume `thresholds` is sorted.
 */
export function transitionQuotaWindow(
	previous: QuotaWindowNotificationState,
	current: AggregatedQuotaWindow,
	thresholds: readonly number[],
): { state: QuotaWindowNotificationState; threshold?: number } {
	const remaining = current.remainingPercent;
	if (remaining === undefined) return { state: previous };

	const matching = thresholds.filter(
		(threshold) =>
			remaining <= threshold &&
			(previous.lastPercent === undefined || previous.lastPercent > threshold),
	);
	return {
		state: { lastPercent: remaining },
		threshold: matching.length > 0 ? Math.min(...matching) : undefined,
	};
}

export function transitionQuotaState(
	previous: QuotaNotificationState | undefined,
	usage: AggregatedQuotaUsage,
	thresholds: readonly number[],
	now = Date.now(),
): { state: QuotaNotificationState; crossings: QuotaThresholdCrossing[] } {
	const baseline = previous ?? { fiveHour: {}, weekly: {}, updatedAt: now };
	const fiveHour = transitionQuotaWindow(baseline.fiveHour, usage.fiveHour, thresholds);
	const weekly = transitionQuotaWindow(baseline.weekly, usage.weekly, thresholds);
	const crossings: QuotaThresholdCrossing[] = [];
	if (fiveHour.threshold !== undefined && usage.fiveHour.remainingPercent !== undefined) {
		crossings.push({
			window: "fiveHour",
			threshold: fiveHour.threshold,
			remainingPercent: usage.fiveHour.remainingPercent,
			resetAtMs: usage.fiveHour.resetAtMs,
			earliestResetAtMs: usage.fiveHour.earliestResetAtMs,
		});
	}
	if (weekly.threshold !== undefined && usage.weekly.remainingPercent !== undefined) {
		crossings.push({
			window: "weekly",
			threshold: weekly.threshold,
			remainingPercent: usage.weekly.remainingPercent,
			resetAtMs: usage.weekly.resetAtMs,
			earliestResetAtMs: usage.weekly.earliestResetAtMs,
		});
	}
	return {
		state: {
			fiveHour: fiveHour.state,
			weekly: weekly.state,
			lastDeliveredAt: baseline.lastDeliveredAt,
			updatedAt: now,
		},
		crossings,
	};
}

/**
 * Render one window. The percentage and the `resets` value come from one
 * account; the pool's earlier reset, when there is one, gets its own clause so
 * nothing reads as "this percentage recovers then".
 */
function formatQuotaWindow(
	label: string,
	window: AggregatedQuotaWindow,
	mode: QuotaDisplayMode,
): string {
	if (window.remainingPercent === undefined) return `${label}: unavailable`;
	const reset = formatUsageReset(window.resetAtMs) ?? "unavailable";
	const earliest = formatUsageReset(window.earliestResetAtMs);
	const poolClause = earliest ? ` | another account resets ${earliest}` : "";
	// Named, not bare: a notification is read without the line's context, so
	// `80%` alone cannot say whether it is headroom or consumption.
	const percent = formatNamedQuotaPercent(window.remainingPercent, mode);
	return `${label}: ${percent} | resets ${reset}${poolClause}`;
}

export function formatQuotaNotification(
	usage: AggregatedQuotaUsage,
	mode: QuotaDisplayMode = DEFAULT_QUOTA_DISPLAY_MODE,
): string {
	return `${formatQuotaWindow("5h", usage.fiveHour, mode)}\n${formatQuotaWindow("Weekly", usage.weekly, mode)}`;
}

interface DeliveryClaim {
	delivering: boolean;
	state: QuotaNotificationState;
	baseline: QuotaNotificationState | undefined;
	crossings: QuotaThresholdCrossing[];
	previousLastDeliveredAt: number;
}

export function createQuotaMonitor(overrides: Partial<MonitorDependencies> = {}): QuotaMonitor {
	const dependencies: MonitorDependencies = {
		loadConfig: () => getQuotaNotifications(loadPluginConfig()),
		loadStorage: loadAccounts,
		fetchSummary: fetchUsageForAccount,
		notify: sendDesktopNotification,
		notificationsSupported: isDesktopNotificationSupported,
		onCredentialsPersisted: () => undefined,
		now: Date.now,
		initialDelayMs: INITIAL_CHECK_DELAY_MS,
		...overrides,
	};
	let timer: NodeJS.Timeout | undefined;
	let started = false;
	let disposed = false;
	let running = false;
	let generation = 0;
	// Keyed by state path: the host flips `setStoragePath` at runtime, so one
	// project's threshold state must never be carried into another's file.
	const memoryStateByPath = new Map<string, QuotaNotificationState>();

	const schedule = (delayMs: number, expectedGeneration: number): void => {
		if (!started || disposed || expectedGeneration !== generation) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			void tick(expectedGeneration, true);
		}, delayMs);
		timer.unref();
	};

	const releaseUndeliveredClaim = async (
		statePath: string,
		claim: DeliveryClaim,
		claimedAt: number,
	): Promise<void> => {
		const reverted: QuotaNotificationState = {
			fiveHour: claim.state.fiveHour,
			weekly: claim.state.weekly,
			lastDeliveredAt: claim.previousLastDeliveredAt > 0 ? claim.previousLastDeliveredAt : undefined,
			updatedAt: dependencies.now(),
		};
		for (const crossing of claim.crossings) {
			reverted[crossing.window] = claim.baseline?.[crossing.window] ?? {};
		}
		try {
			const applied = await updateQuotaNotificationState<boolean>(statePath, (persisted) => {
				if (persisted?.updatedAt !== claimedAt) {
					// Someone else wrote after our claim; leave their state alone.
					return { state: persisted ?? claim.state, result: false };
				}
				return { state: reverted, result: true };
			});
			if (applied) memoryStateByPath.set(statePath, reverted);
		} catch (error) {
			logWarn(`Failed to release an undelivered quota notification claim: ${(error as Error).message}`);
		}
	};

	const check = async (
		config: QuotaNotificationsConfig,
		expectedGeneration: number,
		deliverNotifications = true,
	): Promise<void> => {
		const storage = await dependencies.loadStorage();
		if (!storage || storage.accounts.length === 0 || disposed || expectedGeneration !== generation) return;
		// Resolved next to the load that produced `storage`, not after the
		// fetches: the host flips `setStoragePath` when the project changes, and
		// this aggregate describes the accounts that were just read.
		const statePath = getQuotaNotificationStatePath(getStoragePath());

		const indices = deduplicateUsageAccountIndices(storage);
		const summaries: AccountQuotaSummary[] = [];
		// Fired at the moment of rotation, not at the end of the check. The
		// rotated refresh token is already durable on disk, and the host's
		// cached AccountManager has a 500ms debounced save still holding the old
		// one; a check over N accounts takes far longer than that, so deferring
		// this leaves exactly the lost-update window open that it exists to
		// close. Cheap to call more than once: it is a no-op with no cached
		// manager.
		const markCredentialsPersisted = (): void => {
			try {
				dependencies.onCredentialsPersisted();
			} catch (error) {
				logWarn(`Failed to invalidate account cache after a quota refresh: ${(error as Error).message}`);
			}
		};
		for (let offset = 0; offset < indices.length; offset += MAX_CONCURRENCY) {
			if (disposed || expectedGeneration !== generation) break;
			const chunk = indices.slice(offset, offset + MAX_CONCURRENCY);
			const results = await Promise.all(
				chunk.map((index) => dependencies.fetchSummary(
					storage,
					storage.accounts[index],
					markCredentialsPersisted,
					config.autoProtectCredits !== false,
					config.autoRedeemResets === true
						? (config.autoRedeemResetsBelowPercent ?? 10)
						: undefined,
				)),
			);
			for (const summary of results) {
				if (summary) summaries.push(summary);
			}
		}
		if (summaries.length === 0 || disposed || expectedGeneration !== generation) return;
		const canDeliver =
			deliverNotifications &&
			config.enabled &&
			(config.notifyEveryCheck || config.thresholds.length > 0) &&
			dependencies.notificationsSupported();
		// Credit protection has already persisted any exhausted accounts while
		// gathering summaries. Do not create notification-state files unless a
		// notification can actually be delivered. A forced check never delivers:
		// it is a request-driven probe, so writing the threshold/delivery state
		// would also consume a crossing the next scheduled poll is meant to
		// announce.
		if (!canDeliver) return;

		const now = dependencies.now();
		const usage = aggregateQuotaUsage(summaries, now);
		const memoryState = memoryStateByPath.get(statePath);

		let claim: DeliveryClaim;
		try {
			// Phase 1: claim the delivery slot under the cross-process lease. The
			// notifier is NOT called here — its 10s timeout is an order of
			// magnitude longer than the lease's ~660ms retry budget, so holding
			// the lease across delivery makes concurrent processes drop whole
			// checks with ELOCKED.
			claim = await updateQuotaNotificationState<DeliveryClaim>(statePath, (persisted) => {
				const baseline =
					memoryState && (!persisted || memoryState.updatedAt > persisted.updatedAt)
						? memoryState
						: persisted;
				const transition = transitionQuotaState(baseline, usage, config.thresholds, now);
				const previousLastDeliveredAt = Math.max(
					persisted?.lastDeliveredAt ?? 0,
					memoryState?.lastDeliveredAt ?? 0,
				);
				if (previousLastDeliveredAt > 0) {
					transition.state.lastDeliveredAt = previousLastDeliveredAt;
				}
				// A stamp in the FUTURE is treated as due, not as "wait until
				// stamp + interval": the state loader accepts any finite stamp >= 0,
				// so a clock rollback or a file written by a host whose clock ran
				// ahead would otherwise suppress every delivery until wall time
				// catches up. Delivering once re-dates the stamp to `now` below,
				// which is also what self-heals the file.
				const everyCheckDue =
					config.notifyEveryCheck &&
					(previousLastDeliveredAt === 0 ||
						previousLastDeliveredAt > now ||
						now - previousLastDeliveredAt >= config.intervalMs);
				const delivering = transition.crossings.length > 0 || everyCheckDue;
				if (delivering) transition.state.lastDeliveredAt = now;
				return {
					state: transition.state,
					result: {
						delivering,
						state: transition.state,
						baseline,
						crossings: transition.crossings,
						previousLastDeliveredAt,
					},
				};
			});
		} catch (error) {
			logWarn(`Failed to update quota notification state: ${(error as Error).message}`);
			return;
		}
		memoryStateByPath.set(statePath, claim.state);
		if (!claim.delivering) return;

		// Phase 2: deliver outside the lease.
		const delivered =
			disposed || expectedGeneration !== generation
				? false
				: await dependencies
					.notify(
						"Codex quota status",
						formatQuotaNotification(usage, getQuotaDisplay(loadPluginConfig())),
					)
					.catch((error: unknown) => {
						logDebug(`Failed to deliver quota notification: ${(error as Error).message}`);
						return false;
					});
		if (delivered) {
			logInfo("Quota notification delivered");
			return;
		}

		// Phase 3: delivery failed, so release the claim and re-arm the crossed
		// windows. Another process that claimed in the meantime keeps its claim.
		await releaseUndeliveredClaim(statePath, claim, now);
	};

	const scheduleNext = (expectedGeneration: number): void => {
		let intervalMs: number;
		try {
			intervalMs = dependencies.loadConfig().intervalMs;
		} catch (error) {
			// Reading the config is the only thing that can throw out here, and
			// `tick`'s catch cannot cover its own `finally`.
			logDebug(`Quota monitor could not schedule the next check: ${(error as Error).message}`);
			return;
		}
		schedule(intervalMs, expectedGeneration);
	};

	const tick = async (
		expectedGeneration: number,
		reschedule: boolean,
		force = false,
	): Promise<void> => {
		if (disposed || expectedGeneration !== generation) return;
		if (running) {
			if (reschedule) scheduleNext(expectedGeneration);
			return;
		}
		running = true;
		// Stays true when the config read throws, so a transient failure retries
		// on the next interval instead of killing the monitor for the session.
		let keepPolling = true;
		try {
			const config = dependencies.loadConfig();
			const canDeliver = config.notifyEveryCheck || config.thresholds.length > 0;
			const notificationsEnabled =
				config.enabled && canDeliver && dependencies.notificationsSupported();
			// The quota guard reuses this bounded, interval-based usage poll rather
			// than adding a request-path preflight. A failed or rate-limited usage
			// request simply retries on the next interval, so it cannot turn usage
			// endpoint throttling into a routing block.
			keepPolling = config.autoProtectCredits !== false || notificationsEnabled;
			// Both switches govern the UNATTENDED poll. A forced check is an
			// on-demand request from a caller that is blocked on the answer, so
			// honouring them here would let `runNow()` return without asking
			// upstream anything at all. For the same reason a forced check is a
			// probe, not an alert: `notifyEveryCheck` opts into the poll's
			// cadence, not one notification per re-probe during a long wait.
			if (force || keepPolling) await check(config, expectedGeneration, !force);
		} catch (error) {
			logDebug(`Quota monitor tick failed: ${(error as Error).message}`);
		} finally {
			running = false;
			// A feature that is switched off, or a platform without Notification
			// Center, stops polling rather than waking every interval forever.
			// Turning it on is a restart, which `docs/configuration.md` requires.
			if (reschedule && keepPolling) scheduleNext(expectedGeneration);
		}
	};

	const disposeMonitor = (): void => {
		if (disposed) return;
		disposed = true;
		started = false;
		generation += 1;
		if (timer) clearTimeout(timer);
		timer = undefined;
		unregisterCleanup(disposeMonitor);
	};

	return {
		start() {
			if (started && !disposed) return;
			started = true;
			disposed = false;
			generation += 1;
			// `server.instance.disposed` is not emitted on SIGINT/SIGTERM, nor by
			// every host, so the timer is also torn down by the shared drain.
			registerCleanup(disposeMonitor);
			schedule(dependencies.initialDelayMs, generation);
		},
		dispose: disposeMonitor,
		async runNow() {
			await tick(generation, false, true);
		},
	};
}

async function fetchUsageForAccount(
	storage: AccountStorageV3,
	account: AccountMetadataV3 | undefined,
	onCredentialsPersisted: () => void = () => undefined,
	autoProtectCredits = true,
	autoRedeemBelowPercent?: number,
): Promise<AccountQuotaSummary | null> {
	if (!account) return null;
	try {
		const credentials = await ensureCodexUsageAccessToken({ storage, account });
		// Signal BEFORE the usage fetch: the rotation is already durable, so a
		// later throw must not swallow the cache invalidation.
		if (credentials.persisted) onCredentialsPersisted();
		const accountId = resolveCodexUsageAccountId({ account, accessToken: credentials.accessToken });
		if (!accountId) return null;
		const usageRequest = {
			accountId,
			accessToken: credentials.accessToken,
			organizationId: account.organizationId,
		};
		const readUsage = async () => parseCodexUsagePayload(await fetchCodexUsage({
			...usageRequest,
			normalizeAccountErrors: true,
		}));
		let usage = await readUsage();
		// Opt-in: spend a banked reset while the weekly quota is nearly gone, then
		// re-read so the exhausted-quota handling below sees the refreshed windows.
		if (
			autoRedeemBelowPercent !== undefined &&
			(await autoRedeemResetCredit({
				usage,
				request: usageRequest,
				belowPercent: autoRedeemBelowPercent,
				label: `account …${accountId.slice(-6)}`,
			}))
		) {
			usage = await readUsage();
		}
		const quotaExhaustedResetAtMs = getUsageQuotaExhaustedResetAtMs([
			usage.primary,
			usage.secondary,
		]);
		if (autoProtectCredits && quotaExhaustedResetAtMs !== undefined) {
			try {
				await persistUsageQuotaExhaustion(account, quotaExhaustedResetAtMs);
				// A second process can already have written the same monotonic block.
				// This process must still discard its cached AccountManager so the next
				// selection observes that existing on-disk block.
				onCredentialsPersisted();
			} catch (error) {
				// The backend's usage observation remains useful for notifications;
				// only the proactive routing guard is unavailable until the next poll.
				logWarn(`Failed to persist exhausted usage quota: ${(error as Error).message}`);
			}
			// Clearing a stale block is not part of the credit guard.
			// `autoProtectCredits` opts out of BLOCKING rotation, while the request
			// path stamps a block from 429 headers regardless of it. Gating the
			// clear on it too left those accounts blocked with nothing able to
			// clear them, so the long-wait probe could never wake.
		} else if (
			quotaExhaustedResetAtMs === undefined &&
			isUsageQuotaRecovered([usage.primary, usage.secondary])
		) {
			try {
				if (await persistUsageQuotaRecovery(account)) onCredentialsPersisted();
			} catch {
				logWarn("Failed to persist recovered usage quota");
			}
		}
		return {
			usage,
		};
	} catch (error) {
		logDebug(`Failed to fetch quota for one account: ${(error as Error).message}`);
		return null;
	}
}
