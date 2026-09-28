/**
 * Gather every account's quota for the pool-wide status line.
 *
 * The single-account status the request path maintains cannot answer "where
 * does the pool stand" - it only ever describes the account that served the
 * last response. This reads `/wham/usage` for each distinct account instead,
 * on a bounded interval, and caches the result where every OpenCode window on
 * the machine can share it.
 *
 * The cache is what keeps this cheap. A reader takes a snapshot that is still
 * fresh rather than issuing its own requests, so N terminals open on the same
 * pool cost one round of requests between them rather than N, and a terminal
 * that has just started renders immediately instead of showing nothing while
 * seven accounts are queried one after another.
 */

import {
	createUsageAccountFingerprint,
	deduplicateUsageAccountIndices,
	ensureCodexUsageAccessToken,
	fetchCodexUsage,
	getUsageLeftPercent,
	hasUsageWindow,
	parseCodexUsagePayload,
	resolveCodexUsageAccountId,
	type CodexUsageSummary,
	type LimitWindow,
} from "./codex-usage.js";
import { logDebug } from "./logger.js";
import type { QuotaOverviewAccount } from "./quota-overview.js";
import { loadAccounts, type AccountStorageV3 } from "./storage.js";
import {
	isFreshTuiQuotaSnapshot,
	readTuiQuotaOverviewSnapshot,
	writeTuiQuotaOverviewSnapshot,
	TUI_QUOTA_CACHE_VERSION,
	type TuiQuotaOverviewAccount,
	type TuiQuotaOverviewSnapshot,
	type TuiQuotaSnapshot,
} from "./tui-quota-cache.js";

/**
 * Accounts queried at once. Matches the quota monitor's own limit: this talks
 * to the same endpoint with the same credentials, and a pool of a dozen seats
 * should not arrive as a dozen simultaneous requests.
 */
const MAX_CONCURRENCY = 2;

function toOverviewLimit(window: LimitWindow, label: string) {
	return {
		label,
		leftPercent: getUsageLeftPercent(window.usedPercent) ?? null,
		usedPercent: window.usedPercent,
		windowMinutes: window.windowMinutes,
		resetAtMs: window.resetAtMs,
	};
}

/**
 * Reduce one account's usage document to what the status line needs.
 *
 * Only the primary and secondary windows are kept. Code-review and the other
 * additional quotas do not govern ordinary model requests, so counting them
 * would let a spent code-review allowance report an account as unusable for
 * work it can still do.
 */
export function toOverviewAccount(params: {
	fingerprint: string;
	index: number;
	usage: CodexUsageSummary;
	email?: string;
	label?: string;
}): TuiQuotaOverviewAccount {
	const limits = [
		{ window: params.usage.primary, label: "5h" },
		{ window: params.usage.secondary, label: "weekly" },
	]
		.filter(({ window }) => hasUsageWindow(window))
		.map(({ window, label }) => toOverviewLimit(window, label));
	const resetCredits = params.usage.resetCredits;
	return {
		fingerprint: params.fingerprint,
		index: params.index,
		email: params.email?.trim() || undefined,
		// Only a label the user set, never the accountId/organizationId
		// fallbacks other surfaces use: those identify an account without
		// naming it, and a 36-character UUID on a status line names nothing.
		label: params.label?.trim() || undefined,
		planType: params.usage.planType ?? undefined,
		// `applicableNow` is the count that can be redeemed against a window
		// that is actually spent, which is the only one worth showing beside a
		// percentage. It falls back to the banked total only when the server
		// stated a count this build could not read.
		resetCredits:
			resetCredits?.applicableNow ?? resetCredits?.available ?? undefined,
		resetCreditsApplicable: resetCredits?.applicableNow ?? null,
		limits,
	};
}

async function fetchOverviewAccount(
	storage: AccountStorageV3,
	index: number,
): Promise<TuiQuotaOverviewAccount | undefined> {
	const account = storage.accounts[index];
	if (!account) return undefined;
	try {
		const credentials = await ensureCodexUsageAccessToken({ storage, account });
		const accountId = resolveCodexUsageAccountId({
			account,
			accessToken: credentials.accessToken,
		});
		if (!accountId) return undefined;
		const usage = parseCodexUsagePayload(
			await fetchCodexUsage({
				accountId,
				accessToken: credentials.accessToken,
				organizationId: account.organizationId,
				normalizeAccountErrors: true,
			}),
		);
		return toOverviewAccount({
			fingerprint: createUsageAccountFingerprint(account),
			index: index + 1,
			usage,
			email: account.email,
			label: account.accountLabel,
		});
	} catch (error) {
		logDebug(
			`Failed to fetch pool quota for one account: ${(error as Error).message}`,
		);
		return undefined;
	}
}

export async function fetchTuiQuotaOverview(params: {
	cachePath?: string;
	now?: number;
	loadStorage?: () => Promise<AccountStorageV3 | null>;
}): Promise<TuiQuotaOverviewSnapshot | undefined> {
	const now = params.now ?? Date.now();
	const cached = await readTuiQuotaOverviewSnapshot(params.cachePath);
	if (cached && isFreshTuiQuotaSnapshot(cached, now)) return cached;

	const storage = await (params.loadStorage ?? loadAccounts)();
	if (!storage || storage.accounts.length === 0) return undefined;

	const indices = deduplicateUsageAccountIndices(storage);
	const accounts: TuiQuotaOverviewAccount[] = [];
	// Set when an account this pass could not fetch keeps its previous
	// reading instead of dropping out of the snapshot.
	let carriedOver = false;
	for (let offset = 0; offset < indices.length; offset += MAX_CONCURRENCY) {
		const chunk = indices.slice(offset, offset + MAX_CONCURRENCY);
		const results = await Promise.all(
			chunk.map((index) => fetchOverviewAccount(storage, index)),
		);
		for (const [position, result] of results.entries()) {
			if (result) {
				accounts.push({ ...result, fetchedAt: now });
				continue;
			}
			// A failed fetch must not drop the account out of the snapshot: the
			// pool would be judged on a subset, and one transient error on the
			// only account with headroom would flip the line to "fully spent"
			// and surface the resets screen wrongly. The cached reading is reused
			// only for the SAME account - same pool position and same credential
			// fingerprint, so a pool that changed membership never inherits a
			// stranger's numbers - and the snapshot below keeps the older fetch
			// time so the reading is rendered stale rather than current.
			const index = chunk[position];
			const account =
				index === undefined ? undefined : storage.accounts[index];
			const previous =
				index === undefined || account === undefined
					? undefined
					: cached?.accounts.find(
							(candidate) =>
								candidate.index === index + 1 &&
								candidate.fingerprint ===
									createUsageAccountFingerprint(account),
						);
			if (previous) {
				accounts.push({
					...previous,
					fetchedAt: previous.fetchedAt ?? cached?.fetchedAt,
				});
				carriedOver = true;
			}
		}
	}
	// Every account failing means the pool was not observed at all, which is a
	// different statement from "the pool is empty". Keeping the previous
	// snapshot lets the line stay on the last thing known to be true rather
	// than blanking on one bad network moment.
	if (accounts.length === 0) return cached;

	accounts.sort((left, right) => left.index - right.index);
	const snapshot: TuiQuotaOverviewSnapshot = {
		version: TUI_QUOTA_CACHE_VERSION,
		// A snapshot carrying a reused reading is only as fresh as that
		// reading, so it keeps the previous fetch time - the stale flag is how
		// the line says "part of this is not new" without dropping it.
		fetchedAt:
			carriedOver && cached ? Math.min(cached.fetchedAt, now) : now,
		accounts,
	};
	try {
		await writeTuiQuotaOverviewSnapshot(snapshot, params.cachePath);
	} catch (error) {
		logDebug(
			`Failed to cache the pool quota snapshot: ${(error as Error).message}`,
		);
	}
	return snapshot;
}

/**
 * Fold the request path's live reading of one account into the polled pool.
 *
 * The pool is re-read on an interval, but the account currently serving
 * requests has its quota pushed from response headers after every single
 * response. Without this the line would show that account's numbers as they
 * were up to five minutes ago while the user watches their own requests spend
 * it - the one account whose figure a reader can check against their own
 * activity would be the one that looks wrong.
 *
 * Only a snapshot NEWER than the poll is merged, so a header reading left over
 * from before the poll cannot overwrite it with older numbers.
 */
export function mergeOverviewWithLatestAccount(
	snapshot: TuiQuotaOverviewSnapshot,
	latest: TuiQuotaSnapshot | undefined,
): TuiQuotaOverviewSnapshot {
	if (!latest || latest.fetchedAt <= snapshot.fetchedAt) return snapshot;
	if (latest.limits.length === 0) return snapshot;
	let merged = false;
	const accounts = snapshot.accounts.map((account) => {
		if (account.fingerprint !== latest.fingerprint) return account;
		// The snapshot's own time is its oldest reading, so the account's own
		// time is what the header reading has to beat.
		if (account.fetchedAt !== undefined && latest.fetchedAt <= account.fetchedAt) {
			return account;
		}
		merged = true;
		return {
			...account,
			planType: latest.planType ?? account.planType,
			email: account.email ?? (latest.accountEmail?.trim() || undefined),
			limits: latest.limits,
			fetchedAt: latest.fetchedAt,
		};
	});
	return merged ? { ...snapshot, accounts } : snapshot;
}

export function toQuotaOverviewAccounts(
	snapshot: TuiQuotaOverviewSnapshot,
): QuotaOverviewAccount[] {
	return snapshot.accounts.map((account) => ({
		index: account.index,
		email: account.email,
		label: account.label,
		planType: account.planType,
		resetCredits: account.resetCredits,
		resetCreditsApplicable: account.resetCreditsApplicable,
		windows: account.limits.map((limit) => ({
			leftPercent: limit.leftPercent ?? undefined,
			exactLeftPercent: typeof limit.usedPercent === "number" && Number.isFinite(limit.usedPercent)
				? Math.max(0, Math.min(100, 100 - limit.usedPercent)) : undefined,
			resetAtMs: limit.resetAtMs,
		})),
	}));
}
