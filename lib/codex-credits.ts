/**
 * Codex credits: the balance a ChatGPT account spends once its plan's
 * 5-hour/weekly windows are used up.
 *
 * Plus/Pro subscribers normally never touch it, but OpenAI grants credits
 * (and sells them), and the Codex backend draws on them by itself: an account
 * at 100% of its plan window that holds a balance keeps answering
 * `codex/responses` with 200 and bills the turn to the balance. codex-rs sends
 * no opt-in for that; the backend decides. This plugin's
 * `quotaExhaustedUntil` block exists to stop exactly that spend, so a balance
 * is only ever drawn on when the user turns `spendCredits` on.
 *
 * The balance is read from two places that report the same thing:
 *
 * - `/wham/usage` → `credits: { has_credits, unlimited, balance }`
 * - every `codex/responses` reply → `x-codex-credits-has-credits`,
 *   `x-codex-credits-unlimited`, `x-codex-credits-balance` (what codex-rs
 *   parses in `codex-api/src/rate_limits.rs`)
 *
 * The backend updates the balance lazily, so a reading can overstate what is
 * left; a refused credits turn is therefore remembered as "no credits" until
 * the window it names resets.
 */
import type { AccountSelectionExplainability } from "./accounts/state.js";

export type CreditsBalance = {
	hasCredits: boolean;
	unlimited: boolean;
	/** Numeric balance when the backend stated one this code can read. */
	balance: number | null;
};

/** How long a reading is trusted before a turn is billed to it without reading it again. */
export const CREDITS_READING_TTL_MS = 5 * 60_000;
/**
 * How old a reading may be and still be named in a message. Messages never
 * read the balance themselves: the quota poll reads every account on an
 * interval (30 minutes by default), so this spans a couple of polls.
 */
export const CREDITS_DISPLAY_MAX_AGE_MS = 2 * 60 * 60_000;
/** How long a refused credits turn keeps an account out when the refusal names no reset. */
export const CREDITS_REFUSAL_DEFAULT_MS = 10 * 60_000;
/** How long a backend "model not supported on this account" answer is remembered. */
export const MODEL_UNSUPPORTED_TTL_MS = 60 * 60_000;

/**
 * Read a balance the backend stated. It arrives as a string (`"62500"`,
 * `"1234.5"`, occasionally currency-formatted like `"$5.00"`), so separators
 * and a currency sign are dropped before parsing. Anything else, including a
 * negative number, is unreadable rather than zero.
 */
export function parseCreditsAmount(value: unknown): number | null {
	if (typeof value === "number") {
		return Number.isFinite(value) && value >= 0 ? value : null;
	}
	if (typeof value !== "string") return null;
	const cleaned = value.trim().replace(/^[^\d.-]+/, "").replace(/[,_\s]/g, "");
	if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
	const parsed = Number(cleaned);
	return Number.isFinite(parsed) ? parsed : null;
}

/** The `credits` object of a `/wham/usage` document, or null when it carries none. */
export function parseUsageCreditsBalance(
	source: { has_credits?: unknown; unlimited?: unknown; balance?: unknown } | null | undefined,
): CreditsBalance | null {
	if (typeof source !== "object" || source === null) return null;
	const balance = parseCreditsAmount(source.balance);
	const hasCredits = source.has_credits === true;
	const unlimited = source.unlimited === true;
	if (balance === null && source.has_credits === undefined && source.unlimited === undefined) {
		return null;
	}
	return { hasCredits, unlimited, balance };
}

function parseBooleanHeader(headers: Headers, name: string): boolean | undefined {
	const value = headers.get(name)?.trim().toLowerCase();
	if (value === "true" || value === "1") return true;
	if (value === "false" || value === "0") return false;
	return undefined;
}

/**
 * The balance a `codex/responses` reply reports, or null when it carries no
 * credits headers. Like codex-rs, both booleans must be present for the
 * reading to count.
 */
export function parseCreditsHeaders(headers: Headers): CreditsBalance | null {
	const hasCredits = parseBooleanHeader(headers, "x-codex-credits-has-credits");
	const unlimited = parseBooleanHeader(headers, "x-codex-credits-unlimited");
	if (hasCredits === undefined || unlimited === undefined) return null;
	return {
		hasCredits,
		unlimited,
		balance: parseCreditsAmount(headers.get("x-codex-credits-balance")),
	};
}

/**
 * Whether a reading says the account can pay for a turn with credits. A
 * stated balance decides; `has_credits` only speaks when no balance was
 * stated.
 */
export function hasSpendableCredits(balance: CreditsBalance | null | undefined): boolean {
	if (!balance) return false;
	if (balance.unlimited) return true;
	if (balance.balance !== null) return balance.balance > 0;
	return balance.hasCredits;
}

const CREDITS_NUMBER_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** `62,500`, `unlimited`, or `available` when the backend stated no number. */
export function formatCreditsBalance(balance: CreditsBalance): string {
	if (balance.unlimited) return "unlimited";
	if (balance.balance !== null) return CREDITS_NUMBER_FORMAT.format(balance.balance);
	return balance.hasCredits ? "available" : "0";
}

/** `62.5k`-style form for the one-line status screens. */
export function formatCreditsBalanceCompact(balance: CreditsBalance): string {
	if (balance.unlimited) return "∞";
	const amount = balance.balance;
	if (amount === null) return balance.hasCredits ? "some" : "0";
	if (amount >= 1_000_000) return `${trimFraction(amount / 1_000_000)}M`;
	if (amount >= 1_000) return `${trimFraction(amount / 1_000)}k`;
	return trimFraction(amount);
}

function trimFraction(value: number): string {
	return value >= 100 ? String(Math.floor(value)) : String(Math.floor(value * 10) / 10);
}

/** Sort key: unlimited first, then the largest balance. */
export function creditsSortValue(balance: CreditsBalance | null | undefined): number {
	if (!balance) return -1;
	if (balance.unlimited) return Number.POSITIVE_INFINITY;
	return balance.balance ?? (balance.hasCredits ? 0 : -1);
}

type CreditsAccountIdentity = {
	accountId?: string;
	organizationId?: string;
	accountUserId?: string;
	email?: string;
};

/**
 * Per-seat key for the in-memory readings below. Deliberately free of token
 * material: refresh tokens rotate, and a key derived from one would forget
 * every reading at the next refresh.
 */
export function getCreditsAccountKey(account: CreditsAccountIdentity): string {
	return JSON.stringify([
		account.accountId ?? null,
		account.organizationId ?? null,
		account.accountUserId ?? null,
		account.accountId || account.accountUserId ? null : (account.email ?? null),
	]);
}

/**
 * The latest credits reading per account, shared by every surface in this
 * process (request path, quota poll, `codex-limits`). A refused credits turn
 * overrides any reading until its reset: the backend's own balance can still
 * claim credits the backend will not spend.
 */
export class CreditsLedger {
	private readonly readings = new Map<string, { balance: CreditsBalance; at: number }>();
	private readonly refusedUntil = new Map<string, number>();

	constructor(
		private readonly now: () => number = Date.now,
		private readonly ttlMs = CREDITS_READING_TTL_MS,
	) {}

	record(key: string, balance: CreditsBalance | null): void {
		this.readings.set(key, {
			balance: balance ?? { hasCredits: false, unlimited: false, balance: null },
			at: this.now(),
		});
	}

	/** The reading taken within `maxAgeMs` (the time to live by default), if any. */
	get(key: string, maxAgeMs = this.ttlMs): CreditsBalance | undefined {
		const reading = this.readings.get(key);
		if (!reading || this.now() - reading.at > maxAgeMs) return undefined;
		return reading.balance;
	}

	markRefused(key: string, until: number): void {
		this.refusedUntil.set(key, until);
	}

	isRefused(key: string): boolean {
		const until = this.refusedUntil.get(key);
		if (until === undefined) return false;
		if (until <= this.now()) {
			this.refusedUntil.delete(key);
			return false;
		}
		return true;
	}

	/** Spendable as far as this process knows: a fresh reading with credits and no refusal. */
	isSpendable(key: string): boolean {
		return !this.isRefused(key) && hasSpendableCredits(this.get(key));
	}

	clear(): void {
		this.readings.clear();
		this.refusedUntil.clear();
	}
}

/** Process-wide ledger; every surface that reads a balance records it here. */
export const creditsLedger = new CreditsLedger();

/**
 * Accounts the backend told us cannot serve a model ("model not supported"),
 * remembered across requests. Without it a seat that is not entitled to the
 * requested model looks like a seat with plan quota left, and credits would
 * never be spent while it sits in the pool.
 */
export class ModelEntitlements {
	private readonly unsupportedUntil = new Map<string, number>();

	constructor(
		private readonly now: () => number = Date.now,
		private readonly ttlMs = MODEL_UNSUPPORTED_TTL_MS,
	) {}

	private static key(accountKey: string, model: string): string {
		return `${accountKey}\u0000${model.trim().toLowerCase()}`;
	}

	markUnsupported(accountKey: string, model: string): void {
		this.unsupportedUntil.set(ModelEntitlements.key(accountKey, model), this.now() + this.ttlMs);
	}

	isUnsupported(accountKey: string, model: string | undefined | null): boolean {
		if (!model) return false;
		const key = ModelEntitlements.key(accountKey, model);
		const until = this.unsupportedUntil.get(key);
		if (until === undefined) return false;
		if (until <= this.now()) {
			this.unsupportedUntil.delete(key);
			return false;
		}
		return true;
	}
}

type ExplainedAccount = Pick<AccountSelectionExplainability, "index" | "eligible" | "reasons">;

/**
 * Whether an account can still serve on its plan quota at some point without
 * spending credits. Only a spent subscription window (`quota-exhausted`) says
 * it cannot; a throttle, a token bucket, or a network cooldown only delays it,
 * so credits wait for it. A disabled account and one whose login failed serve
 * nothing at all, so they hold no plan quota worth waiting for.
 */
export function hasPlanQuota(entry: ExplainedAccount): boolean {
	if (entry.eligible) return true;
	return !entry.reasons.some(
		(reason) => reason === "quota-exhausted" || reason === "disabled" || reason === "cooldown:auth-failure",
	);
}

export type CreditsPlan =
	/** An entitled account still has plan quota (or none qualifies for credits). */
	| { kind: "plan-quota-left" }
	/** Accounts to try on credits, in order. Unknown balances still need a read. */
	| { kind: "credits"; indices: number[] };

/**
 * Decide whether this request may be served on credits, and by whom.
 *
 * Credits are only spent once no account that is entitled to the model (and
 * inside its per-model pool, when one is strict) has plan quota left. The
 * accounts offered are the ones held back by nothing but their spent window,
 * not yet tried this request, not refused, and not known to hold a zero
 * balance - preferred-pool members first, then the largest known balance,
 * then the unknown ones the caller has to read before using.
 */
export function planCreditsFallback(
	explainability: readonly ExplainedAccount[],
	options: {
		attempted: ReadonlySet<number>;
		inPool: (index: number) => boolean;
		preferred?: (index: number) => boolean;
		unsupported: (index: number) => boolean;
		refused: (index: number) => boolean;
		balance: (index: number) => CreditsBalance | undefined;
	},
): CreditsPlan {
	const pool = explainability.filter(
		(entry) => options.inPool(entry.index) && !options.unsupported(entry.index),
	);
	if (pool.some(hasPlanQuota)) return { kind: "plan-quota-left" };
	const candidates = pool.filter((entry) => {
		if (options.attempted.has(entry.index)) return false;
		if (entry.reasons.length !== 1 || entry.reasons[0] !== "quota-exhausted") return false;
		if (options.refused(entry.index)) return false;
		const balance = options.balance(entry.index);
		return balance === undefined || hasSpendableCredits(balance);
	});
	if (candidates.length === 0) return { kind: "plan-quota-left" };
	const preferred = (index: number): boolean => options.preferred?.(index) === true;
	const indices = candidates
		.map((entry) => entry.index)
		.sort((left, right) => {
			if (preferred(left) !== preferred(right)) return preferred(left) ? -1 : 1;
			const leftBalance = options.balance(left);
			const rightBalance = options.balance(right);
			if ((leftBalance === undefined) !== (rightBalance === undefined)) {
				return leftBalance === undefined ? 1 : -1;
			}
			const byBalance = creditsSortValue(rightBalance) - creditsSortValue(leftBalance);
			if (byBalance !== 0 && !Number.isNaN(byBalance)) return byBalance;
			return left - right;
		});
	return { kind: "credits", indices };
}

export type CreditsAccountSummary = {
	/** How the account is named in a message, e.g. `account 3 (o…@example.com)`. */
	label: string;
	balance: CreditsBalance;
};

/** `account 3 (62,500 credits), account 5 (unlimited credits)` */
export function formatCreditsAccountList(accounts: readonly CreditsAccountSummary[]): string {
	return [...accounts]
		.sort((left, right) => creditsSortValue(right.balance) - creditsSortValue(left.balance))
		.map((account) => `${account.label} (${formatCreditsBalance(account.balance)} credits)`)
		.join(", ");
}

/**
 * The sentence an all-accounts-out message ends with: where credits remain,
 * and how to use them when the setting is off. Empty when there is nothing
 * worth saying.
 */
export function formatCreditsOutOfQuotaHint(params: {
	spendCredits: boolean;
	accounts: readonly CreditsAccountSummary[];
}): string {
	if (params.accounts.length === 0) {
		return params.spendCredits ? " No account has Codex credits left to fall back on." : "";
	}
	const list = formatCreditsAccountList(params.accounts);
	return params.spendCredits
		? ` Codex credits remain on ${list}, but none of them could serve this request.`
		: ` Codex credits are still available on ${list}. Set \`"spendCredits": true\` in ~/.opencode/openai-codex-auth-config.json (or CODEX_AUTH_SPEND_CREDITS=1) to use them once plan quota runs out.`;
}

/** Toast shown when a turn is about to be paid with credits. */
export function formatServingOnCreditsToast(params: {
	label: string;
	balance: CreditsBalance | undefined;
}): string {
	const left = params.balance ? ` (${formatCreditsBalance(params.balance)} left)` : "";
	return `Plan quota used up on every account. Spending Codex credits on ${params.label}${left}.`;
}
