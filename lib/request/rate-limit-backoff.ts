import type { RateLimitReason } from "../accounts.js";

export interface RateLimitBackoffResult {
	attempt: number;
	delayMs: number;
	isDuplicate: boolean;
	reason?: RateLimitReason;
}

/**
 * Rate limit state tracking with time-window deduplication.
 *
 * Matches the antigravity plugin behavior:
 * - Deduplicate concurrent 429s so parallel requests don't over-increment backoff.
 * - Reset backoff after a quiet period.
 */
const RATE_LIMIT_DEDUP_WINDOW_MS = 2000;
const RATE_LIMIT_STATE_RESET_MS = 120_000;
const MAX_BACKOFF_MS = 60_000;

// Bounded jitter: the computed exponential delay is scaled by
// [0.75, 1.25] so a fleet of accounts throttled together does not retry in
// lock-step on the next window edge. `() => 0.5` lands exactly on factor
// 1.0, which is what deterministic tests and the reason-adjusted inner call
// inject to keep the single jitter application on the outer layer.
const BACKOFF_JITTER_MIN_FACTOR = 0.75;
const BACKOFF_JITTER_SPREAD = 0.5;
const NO_JITTER = () => 0.5;

function applyBackoffJitter(delayMs: number, random: () => number): number {
	// Clamp the roll defensively: a broken injected RNG must not grow the
	// factor past the documented bound (or drive it negative).
	const roll = Math.min(Math.max(random(), 0), 1);
	return Math.floor(
		delayMs * (BACKOFF_JITTER_MIN_FACTOR + roll * BACKOFF_JITTER_SPREAD),
	);
}

export const RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS = 5000;

interface RateLimitState {
	consecutive429: number;
	lastAt: number;
	quotaKey: string;
}

const rateLimitStateByAccountQuota = new Map<string, RateLimitState>();

function normalizeDelayMs(value: number | null | undefined, fallback: number): number {
	const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback;
	return Math.max(0, Math.floor(candidate));
}

function pruneStaleRateLimitState(): void {
	const now = Date.now();
	for (const [key, state] of rateLimitStateByAccountQuota) {
		if (now - state.lastAt > RATE_LIMIT_STATE_RESET_MS) {
			rateLimitStateByAccountQuota.delete(key);
		}
	}
}

/**
 * Compute rate-limit backoff for an account+quota key.
 *
 * The exponential component is jittered (±25%) to decorrelate retries; the
 * server-provided `serverRetryAfterMs` stays an absolute floor applied AFTER
 * jitter, so honoring it can never be undercut by a low roll. The 60s cap is
 * enforced after jitter as well.
 *
 * @param random - RNG driving the jitter factor; inject `() => 0.5` for the
 *   deterministic pre-jitter values.
 */
export function getRateLimitBackoff(
	accountIndex: number,
	quotaKey: string,
	serverRetryAfterMs: number | null | undefined,
	random: () => number = Math.random,
): RateLimitBackoffResult {
	pruneStaleRateLimitState();
	const now = Date.now();
	const stateKey = `${accountIndex}:${quotaKey}`;
	const previous = rateLimitStateByAccountQuota.get(stateKey);

	const baseDelay = normalizeDelayMs(serverRetryAfterMs, 1000);

	if (previous && now - previous.lastAt < RATE_LIMIT_DEDUP_WINDOW_MS) {
		const backoffDelay = applyBackoffJitter(
			Math.min(
				baseDelay * Math.pow(2, previous.consecutive429 - 1),
				MAX_BACKOFF_MS,
			),
			random,
		);
		return {
			attempt: previous.consecutive429,
			delayMs: Math.max(baseDelay, Math.min(backoffDelay, MAX_BACKOFF_MS)),
			isDuplicate: true,
		};
	}

	const attempt =
		previous && now - previous.lastAt < RATE_LIMIT_STATE_RESET_MS
			? previous.consecutive429 + 1
			: 1;

	rateLimitStateByAccountQuota.set(stateKey, {
		consecutive429: attempt,
		lastAt: now,
		quotaKey,
	});

	const backoffDelay = applyBackoffJitter(
		Math.min(baseDelay * Math.pow(2, attempt - 1), MAX_BACKOFF_MS),
		random,
	);
	return {
		attempt,
		delayMs: Math.max(baseDelay, Math.min(backoffDelay, MAX_BACKOFF_MS)),
		isDuplicate: false,
	};
}

export function resetRateLimitBackoff(accountIndex: number, quotaKey: string): void {
	rateLimitStateByAccountQuota.delete(`${accountIndex}:${quotaKey}`);
}

/**
 * Re-key backoff state after the account at `removedIndex` is removed and the
 * survivors are reindexed in place. Without this, a surviving account inherits
 * the removed (or a shifted neighbor's) backoff schedule. Mirrors the tracker
 * remap in lib/rotation.ts. Kept self-contained to avoid a cross-layer import.
 */
export function remapRateLimitBackoffAfterRemoval(removedIndex: number): void {
	const entries = [...rateLimitStateByAccountQuota.entries()];
	rateLimitStateByAccountQuota.clear();
	for (const [key, value] of entries) {
		const colon = key.indexOf(":");
		const indexPart = colon === -1 ? key : key.slice(0, colon);
		const suffix = colon === -1 ? "" : key.slice(colon);
		const parsed = Number(indexPart);
		if (!Number.isInteger(parsed) || `${parsed}` !== indexPart) {
			rateLimitStateByAccountQuota.set(key, value);
			continue;
		}
		if (parsed === removedIndex) continue;
		const newIndex = parsed > removedIndex ? parsed - 1 : parsed;
		rateLimitStateByAccountQuota.set(`${newIndex}${suffix}`, value);
	}
}

export function clearRateLimitBackoffState(): void {
	rateLimitStateByAccountQuota.clear();
}

const BACKOFF_MULTIPLIERS: Record<RateLimitReason, number> = {
	quota: 3.0,
	tokens: 1.5,
	concurrent: 0.5,
	unknown: 1.0,
};

export function calculateBackoffMs(
	baseDelayMs: number,
	attempt: number,
	reason: RateLimitReason = "unknown",
	random: () => number = Math.random,
): number {
	const multiplier = BACKOFF_MULTIPLIERS[reason] ?? 1.0;
	const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
	return Math.min(
		applyBackoffJitter(exponentialDelay * multiplier, random),
		MAX_BACKOFF_MS,
	);
}

export function getRateLimitBackoffWithReason(
	accountIndex: number,
	quotaKey: string,
	serverRetryAfterMs: number | null | undefined,
	reason: RateLimitReason = "unknown",
	random: () => number = Math.random,
): RateLimitBackoffResult {
	// The inner call resolves dedup/state and the server floor; jitter lands
	// exactly once, inside calculateBackoffMs on the reason-adjusted value.
	const result = getRateLimitBackoff(
		accountIndex,
		quotaKey,
		serverRetryAfterMs,
		NO_JITTER,
	);
	const adjustedDelay = calculateBackoffMs(
		result.delayMs,
		result.attempt,
		reason,
		random,
	);
	return {
		...result,
		// Re-apply the server-mandated floor after reason jitter: Retry-After
		// is a minimum, and a low jitter roll must not schedule a retry before
		// it elapses. When no server delay was supplied the floor is zero and
		// jitter decorrelates freely.
		delayMs: Math.max(adjustedDelay, normalizeDelayMs(serverRetryAfterMs, 0)),
		reason,
	};
}
