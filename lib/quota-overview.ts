/**
 * One constant line describing the whole account pool.
 *
 * The prompt status line names whichever account served the most recent
 * request, so on a pool of several accounts it changes identity as rotation
 * moves - and a reader who wants to know where the pool stands has to watch it
 * long enough to see every account go past. This module renders the pool
 * instead: every account at once, in a fixed order, so the line only changes
 * when the underlying quota does.
 *
 * ```text
 * 24%: #1 5x 13%, #2 20x 100% 3d 1r, #3 1x 12%
 * ```
 *
 * The leading figure is the pool total, and it is a WEIGHTED mean rather than
 * a plain one. A Pro seat spent to 50% has given up twenty times the capacity
 * a Business Standard seat does at 50%, so averaging the percentages
 * unweighted describes a pool nobody has; `lib/plan-allotment.ts` supplies the
 * per-plan ratio the mean is taken over.
 *
 * Percentages follow `quotaDisplay` like every other surface, so the same pool
 * reads `24%` as headroom or `76%` as consumption. Only the wording changes:
 * every decision here - which window governs an account, which account is
 * closest to recovering, whether a reset time is worth the characters - stays
 * keyed on the percentage remaining.
 *
 * Everything below is pure string work over already-gathered readings, so the
 * whole rendering can be exercised without a network, a clock or a terminal.
 */

import { maskEmailForDisplay } from "./account-display.js";
import {
	creditsSortValue,
	formatCreditsBalance,
	formatCreditsBalanceCompact,
	hasSpendableCredits,
	type CreditsBalance,
} from "./codex-credits.js";
import { sanitizeDisplayText } from "./ui/display-text.js";
import { computeWeightedLeftPercent, resolveGoverningWindow } from "./quota-capacity.js";
import { resolveNextQuotaRecovery, resolveQuotaRecoveryEvents } from "./quota-recovery.js";
export { computeWeightedLeftPercent, resolveGoverningWindow } from "./quota-capacity.js";
import { formatPlanMultiplier, getPlanWeight } from "./plan-allotment.js";
import {
	formatQuotaPercent,
	toQuotaDisplayPercent,
	type QuotaDisplayMode,
} from "./quota-display.js";

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Under `resetTimes: "low"`, only an account at or below this headroom gets
 * its reset time printed.
 *
 * Every account has a reset, and printing all of them triples the length of
 * the line to say "this account you are not waiting on recovers at some point
 * too". The threshold matches the one the single-account status line already
 * uses to decide the same question, so an account near exhaustion reads the
 * same way in either mode. `resetTimes: "always"` opts out of the threshold,
 * because 90% spent with an hour to go and 90% spent with six days to go are
 * not the same situation.
 */
export const OVERVIEW_RESET_LEFT_PERCENT = 25;

export type QuotaOverviewWindow = {
	/** Percentage of this window still free, 0-100. */
	leftPercent?: number;
	/** Unrounded headroom retained for threshold decisions, not display. */
	exactLeftPercent?: number;
	resetAtMs?: number;
};

export type QuotaOverviewAccount = {
	/** 1-based position, as `codex-list` and `codex-switch` number accounts. */
	index: number;
	/**
	 * The account's own name for itself: a `codex-label` label when one is
	 * set, otherwise whatever identity the account storage carries. May be an
	 * email address, which is why every rendering of it goes through
	 * {@link resolveAccountName} rather than printing it directly.
	 */
	label?: string;
	/** ChatGPT email, used by the reset-credit line and as a label fallback. */
	email?: string;
	/** `plan_type` as reported by `/wham/usage`, used for the weighting only. */
	planType?: string;
	windows: readonly QuotaOverviewWindow[];
	/** Banked rate-limit resets redeemable now, rendered as `1r`. */
	resetCredits?: number;
	/** Explicit applicability; null is unknown, absence identifies a legacy cache. */
	resetCreditsApplicable?: number | null;
	/** Codex credit balance, listed by the `credits` screen. */
	credits?: CreditsBalance;
};

/** How the accounts are arranged on the line. */
export type QuotaOverviewLayout =
	/** One segment per account: `#1 13%, #2 100% 3d`. */
	| "accounts"
	/** Accounts sharing a percentage collapse: `100% 3d 4d 5d`. */
	| "aggregate"
	/** No accounts at all, just how many there are: `3 accounts`. */
	| "count"
	| "total";

/** What identifies an account on the line. */
export type QuotaOverviewNames =
	/** `#1`, the number `codex-switch` takes. */
	| "number"
	/** The account's label, or its email's local part: `damian`, `work`. */
	| "label"
	/** Nothing; the accounts are told apart by position alone. */
	| "none";

/** The order accounts appear in. */
export type QuotaOverviewOrder =
	| "number"
	/** Least headroom first - the accounts rotation is about to stop using. */
	| "most-used"
	/** Most headroom first - the accounts with work left in them. */
	| "least-used"
	/** Soonest reset first. Accounts with no known reset sort last. */
	| "renewing-earliest"
	/** Latest reset first, which is redemption order for a banked reset. */
	| "renewing-latest";

/** Which accounts get a reset countdown printed beside them. */
export type QuotaOverviewResetTimes =
	| "never"
	/** Only accounts at or below {@link OVERVIEW_RESET_LEFT_PERCENT}. */
	| "low"
	| "always";

export type QuotaOverviewOptions = {
	mode: QuotaDisplayMode;
	layout: QuotaOverviewLayout;
	names: QuotaOverviewNames;
	order: QuotaOverviewOrder;
	/** `5x` / `20x` allotment badges beside each account. */
	multipliers: boolean;
	/** `66% of 65x`: what the pool the percentage is taken over adds up to. */
	allotment: boolean;
	resetTimes: QuotaOverviewResetTimes;
	/** `1r` for redeemable banked resets. */
	resetCredits: boolean;
	/** `true`: next signed movement; `all`: positive incremental capacity returns. */
	recovery: boolean | "all";
	/** Masks any email this line would otherwise print in full. */
	maskEmail?: boolean;
	now?: number;
};

export type QuotaOverviewRecovery = {
	/**
	 * Pool-total movement at {@link atMs}, in percentage points, always
	 * positive - it is capacity returning. Legacy `recovery: true` follows the
	 * display-direction sign; `all` always renders capacity with a plus sign.
	 */
	deltaPercent: number;
	atMs: number;
};

function isPercent(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * Render a duration the way a countdown reads: the largest unit that fits,
 * floored, so `2d` never claims more time remains than actually does. A gap
 * under a minute still reads `1m` rather than `0m`, because a reset that has
 * not happened yet is not zero away.
 */
export function formatCompactDuration(ms: number): string | undefined {
	if (!Number.isFinite(ms) || ms <= 0) return undefined;
	if (ms >= MS_PER_DAY) return `${Math.floor(ms / MS_PER_DAY)}d`;
	if (ms >= MS_PER_HOUR) return `${Math.floor(ms / MS_PER_HOUR)}h`;
	return `${Math.max(1, Math.floor(ms / MS_PER_MINUTE))}m`;
}

/**
 * What the pool the percentage is taken over adds up to, in 1x seats.
 *
 * Deliberately the same sum {@link computeWeightedLeftPercent} divides by, and
 * over the same accounts, so `66% of 65x` is one statement rather than two
 * that can disagree. An account whose plan states no ratio therefore
 * contributes its fallback weight here exactly as it does to the mean.
 */
export function computePoolAllotment(
	accounts: readonly QuotaOverviewAccount[],
): number | undefined {
	let total = 0;
	for (const account of accounts) {
		const governing = resolveGoverningWindow(account);
		if (!governing || !isPercent(governing.leftPercent)) continue;
		const weight = getPlanWeight(account.planType);
		if (!Number.isFinite(weight) || weight <= 0) continue;
		total += weight;
	}
	return total > 0 ? total : undefined;
}

/**
 * The next moment the pool gets capacity back, and how much.
 *
 * Only the window that actually resets is refilled, and the account's
 * governing window is then resolved again: an account whose 5-hour window
 * resets while its weekly window is still spent gains nothing, and reporting
 * the 5-hour refill as pool recovery would promise headroom that does not
 * arrive. Movement below one point is dropped rather than rendered as `+0%`.
 */
export function resolveQuotaOverviewRecovery(
	accounts: readonly QuotaOverviewAccount[],
	now: number = Date.now(),
): QuotaOverviewRecovery | undefined {
	return resolveNextQuotaRecovery(accounts, now);
}

/**
 * Whether nothing in the pool has capacity left.
 *
 * This is the condition the reset-credit line exists for: while any account
 * can still serve a request, which one recovers when is a detail, and once
 * none can it is the only question left. Accounts whose quota could not be
 * read do not count either way - an unknown reading is not evidence of
 * exhaustion, but it is not capacity either, so a pool of nothing but
 * unreadable accounts is reported as not spent rather than as dead.
 */
export function isPoolFullySpent(
	accounts: readonly QuotaOverviewAccount[],
): boolean {
	let readable = 0;
	for (const account of accounts) {
		const governing = resolveGoverningWindow(account);
		if (!governing || !isPercent(governing.leftPercent)) continue;
		readable += 1;
		if (governing.leftPercent > 0) return false;
	}
	return readable > 0;
}

/**
 * Sort key for the reset-time orders.
 *
 * An account with no known reset sorts after every account that has one, in
 * both directions. Not knowing when something returns is a different statement
 * from knowing it returns soon, and a different statement from knowing it
 * returns last.
 */
function governingResetAtMs(
	account: QuotaOverviewAccount,
): number | undefined {
	const governing = resolveGoverningWindow(account);
	return governing && isPercent(governing.resetAtMs)
		? governing.resetAtMs
		: undefined;
}

function governingLeftPercent(
	account: QuotaOverviewAccount,
): number | undefined {
	const governing = resolveGoverningWindow(account);
	return governing && isPercent(governing.leftPercent)
		? governing.leftPercent
		: undefined;
}

/**
 * Arrange the accounts for display.
 *
 * Every comparison falls back to the account number, so two accounts reading
 * the same percentage never trade places between renders. An order that let
 * them would reintroduce exactly the movement this mode exists to remove.
 */
export function orderOverviewAccounts(
	accounts: readonly QuotaOverviewAccount[],
	order: QuotaOverviewOrder,
): QuotaOverviewAccount[] {
	const sorted = [...accounts];
	if (order === "most-used" || order === "least-used") {
		const direction = order === "most-used" ? 1 : -1;
		return sorted.sort((left, right) => {
			const leftPercent = governingLeftPercent(left);
			const rightPercent = governingLeftPercent(right);
			if (leftPercent === undefined && rightPercent === undefined) {
				return left.index - right.index;
			}
			if (leftPercent === undefined) return 1;
			if (rightPercent === undefined) return -1;
			if (leftPercent !== rightPercent) {
				return direction * (leftPercent - rightPercent);
			}
			return left.index - right.index;
		});
	}
	if (order === "renewing-earliest" || order === "renewing-latest") {
		const direction = order === "renewing-earliest" ? 1 : -1;
		return sorted.sort((left, right) => {
			const leftReset = governingResetAtMs(left);
			const rightReset = governingResetAtMs(right);
			if (leftReset === undefined && rightReset === undefined) {
				return left.index - right.index;
			}
			if (leftReset === undefined) return 1;
			if (rightReset === undefined) return -1;
			if (leftReset !== rightReset) return direction * (leftReset - rightReset);
			return left.index - right.index;
		});
	}
	// `number` and anything unrecognized: an order nobody asked for must not
	// silently become one of the sorted ones, which would move accounts around
	// under a reader who configured nothing.
	return sorted.sort((left, right) => left.index - right.index);
}

const EMAIL_LIKE = /^[^\s@]+@[^\s@]+$/;

/**
 * The local part of an email, which is what a person calls the account.
 *
 * `damian@nowaker.net` -> `damian`. Masking is applied to the local part
 * rather than to the whole address, because the domain is what
 * {@link maskEmailForDisplay} keeps and there is no room for it here.
 */
function formatEmailLocalPart(
	email: string,
	maskEmail: boolean,
): string | undefined {
	const trimmed = sanitizeDisplayText(email);
	if (!trimmed) return undefined;
	const local = trimmed.split("@")[0]?.trim();
	if (!local) return undefined;
	if (!maskEmail) return local;
	return `${Array.from(local).slice(0, 2).join("")}***`;
}

/**
 * What this account is called on the line.
 *
 * Under `label` a user-set label wins, because it is the one name the user
 * chose; an account that only knows its email falls back to that email's local
 * part, and an account with neither falls back to its number rather than
 * rendering nothing - a nameless segment in a named line reads as a missing
 * account.
 */
export function resolveAccountName(
	account: QuotaOverviewAccount,
	names: QuotaOverviewNames,
	maskEmail = false,
): string | undefined {
	if (names === "none") return undefined;
	if (names === "number") return `#${account.index}`;
	// Labels and emails come from account storage and `/wham` responses —
	// untrusted text that is interpolated straight onto the status line, so
	// control characters, escapes, and bidi marks are stripped first.
	const label = sanitizeDisplayText(account.label);
	if (label && !EMAIL_LIKE.test(label)) return label;
	const email = label && EMAIL_LIKE.test(label) ? label : account.email;
	const local = email ? formatEmailLocalPart(email, maskEmail) : undefined;
	return local ?? `#${account.index}`;
}

/** The full email for the reset-credit line, masked when asked. */
function resolveAccountEmail(
	account: QuotaOverviewAccount,
	maskEmail: boolean,
): string | undefined {
	const label = sanitizeDisplayText(account.label);
	const email =
		sanitizeDisplayText(account.email) ??
		(label && EMAIL_LIKE.test(label) ? label : undefined);
	if (!email) return undefined;
	return maskEmail ? maskEmailForDisplay(email) : email;
}

function resolveResetCredits(account: QuotaOverviewAccount): number {
	const credits = account.resetCredits;
	return typeof credits === "number" && Number.isFinite(credits) && credits > 0
		? Math.trunc(credits)
		: 0;
}

function resolveApplicableResetCredits(account: QuotaOverviewAccount): number {
	const applicable = account.resetCreditsApplicable;
	if (applicable === null) return 0;
	if (applicable !== undefined) return Math.min(resolveResetCredits(account), applicable);
	return (governingLeftPercent(account) ?? 100) <= 0 ? resolveResetCredits(account) : 0;
}

/** How much of an account's segment is annotation rather than percentage. */
type AnnotationRung = {
	names: QuotaOverviewNames;
	multipliers: boolean;
	resetTimes: QuotaOverviewResetTimes;
	resetCredits: boolean;
};

type SegmentOptions = AnnotationRung & {
	mode: QuotaDisplayMode;
	maskEmail: boolean;
	now: number;
};

function shouldPrintReset(
	leftPercent: number,
	resetTimes: QuotaOverviewResetTimes,
): boolean {
	if (resetTimes === "never") return false;
	if (resetTimes === "always") return true;
	return leftPercent <= OVERVIEW_RESET_LEFT_PERCENT;
}

/** The part of a segment that is not the account's name or its percentage. */
function formatAccountAnnotations(
	account: QuotaOverviewAccount,
	governing: QuotaOverviewWindow,
	options: SegmentOptions,
): string[] {
	const parts: string[] = [];
	const leftPercent = governing.leftPercent;
	if (
		isPercent(leftPercent) &&
		shouldPrintReset(leftPercent, options.resetTimes) &&
		isPercent(governing.resetAtMs)
	) {
		const reset = formatCompactDuration(governing.resetAtMs - options.now);
		if (reset) parts.push(reset);
	}
	if (options.resetCredits) {
		const credits = resolveResetCredits(account);
		if (credits > 0) parts.push(`${credits}r`);
	}
	return parts;
}

function formatAccountSegment(
	account: QuotaOverviewAccount,
	options: SegmentOptions,
): string | undefined {
	const governing = resolveGoverningWindow(account);
	if (!governing || !isPercent(governing.leftPercent)) return undefined;
	const parts: string[] = [];
	const name = resolveAccountName(account, options.names, options.maskEmail);
	if (name) parts.push(name);
	if (options.multipliers) {
		const multiplier = formatPlanMultiplier(account.planType);
		if (multiplier) parts.push(multiplier);
	}
	parts.push(formatQuotaPercent(governing.leftPercent, options.mode));
	parts.push(...formatAccountAnnotations(account, governing, options));
	return parts.join(" ");
}

/**
 * Accounts reading the same percentage, collapsed into one segment.
 *
 * On a pool where several accounts are fully spent, `100% 3d, 100% 4d,
 * 100% 5d` spends two thirds of its characters repeating a number that is the
 * same every time. Grouping prints it once and keeps what differs:
 *
 * ```text
 * 100% 3d 1r 4d 5d
 * ```
 *
 * The group's size is stated explicitly - `100% x3 3d` - only when the
 * annotations do not already reveal it, so a group of three accounts where one
 * has no reset time to print cannot read as a group of two. A group of one is
 * never counted, because there is nothing to count.
 *
 * Grouping discards identity by construction, so `names` has no effect here.
 */
function formatAggregateSegments(
	accounts: readonly QuotaOverviewAccount[],
	options: SegmentOptions,
): string[] {
	const groups = new Map<
		string,
		{ percent: string; size: number; annotations: string[] }
	>();
	for (const account of accounts) {
		const governing = resolveGoverningWindow(account);
		if (!governing || !isPercent(governing.leftPercent)) continue;
		const percent = formatQuotaPercent(governing.leftPercent, options.mode);
		const group = groups.get(percent) ?? {
			percent,
			size: 0,
			annotations: [],
		};
		group.size += 1;
		const annotations = formatAccountAnnotations(account, governing, options);
		if (annotations.length > 0) group.annotations.push(annotations.join(" "));
		groups.set(percent, group);
	}
	return [...groups.values()].map((group) => {
		const parts = [group.percent];
		if (group.size > 1 && group.annotations.length < group.size) {
			parts.push(`x${group.size}`);
		}
		parts.push(...group.annotations);
		return parts.join(" ");
	});
}

/**
 * `+12% in 3d` / `-12% 3d`.
 *
 * The sign describes the direction the number beside it moves, not the
 * direction of the user's fortunes: under `used` the pool total falls as
 * capacity returns, and a `+` there would contradict the figure it annotates.
 * The word `in` is the first thing dropped when the line is short, because it
 * is the only part of the clause a reader can supply themselves.
 */
function formatRecovery(
	recovery: QuotaOverviewRecovery,
	options: { mode: QuotaDisplayMode; now: number; words: boolean },
): string | undefined {
	const at = formatCompactDuration(recovery.atMs - options.now);
	if (!at) return undefined;
	const sign = options.mode === "used" ? "-" : "+";
	return `${sign}${recovery.deltaPercent}% ${options.words ? "in " : ""}${at}`;
}

function formatRecoveryEventForms(
	events: readonly QuotaOverviewRecovery[],
	now: number,
): string[] {
	const buckets = new Map<string, number>();
	for (const event of events) {
		const duration = formatCompactDuration(event.atMs - now);
		if (duration) buckets.set(duration, (buckets.get(duration) ?? 0) + event.deltaPercent);
	}
	if (buckets.size === 0) return [];
	const long = [...buckets].map(([duration, delta]) => `+${delta}% in ${duration}`);
	const short = [...buckets].map(([duration, delta]) => `+${delta}% ${duration}`);
	const forms = [long.join(", ")];
	for (let count = short.length; count > 0; count -= 1) {
		forms.push(short.slice(0, count).join(", "));
	}
	return forms;
}

/** `3 accounts` -> `3 acct.` -> `3`, in the order they are given up. */
export type QuotaOverviewCountStyle = "long" | "short" | "bare";

function formatAccountCount(
	count: number,
	style: QuotaOverviewCountStyle,
): string {
	if (style === "bare") return `${count}`;
	if (style === "short") return `${count} acct.`;
	return `${count} account${count === 1 ? "" : "s"}`;
}

/**
 * Every annotation level to try, most informative first.
 *
 * One dimension is given up per rung and never restored within the ladder, so
 * each rung is strictly shorter than the one above it. The order is by what a
 * reader loses: the plan badge says nothing the account's own numbers do not,
 * a long label can be replaced by the number that selects the same account,
 * banked resets only matter once something is spent, and a reset countdown on
 * a healthy account is the detail `resetTimes: "always"` opted into.
 *
 * Dropping the account's name entirely is the last rung, and it is offered
 * only when position still identifies an account: under a sorted order, or
 * with any account missing from the line, `39%, 8%, 91%` names nothing at all
 * and a reader would attach those figures to the wrong seats.
 */
function annotationRungs(
	options: QuotaOverviewOptions,
	positionsAreComplete: boolean,
): AnnotationRung[] {
	const rungs: AnnotationRung[] = [];
	let current: AnnotationRung = {
		names: options.names,
		multipliers: options.multipliers,
		resetTimes: options.resetTimes,
		resetCredits: options.resetCredits,
	};
	rungs.push(current);
	const step = (next: Partial<AnnotationRung>): void => {
		current = { ...current, ...next };
		rungs.push(current);
	};
	if (current.multipliers) step({ multipliers: false });
	if (current.names === "label") step({ names: "number" });
	if (current.resetCredits) step({ resetCredits: false });
	if (current.resetTimes === "always") step({ resetTimes: "low" });
	if (current.resetTimes !== "never") step({ resetTimes: "never" });
	if (current.names !== "none" && positionsAreComplete) step({ names: "none" });
	return rungs;
}

/**
 * Every rendering of this pool, longest first.
 *
 * The caller takes the first that fits its width. Detail is dropped in the
 * order that costs a reader the least: the recovery clause and then the
 * annotations (badges, banked resets) that sit beside a figure which stays
 * either way, then the per-account breakdown, leaving the pool total - the one
 * thing the line exists to say - as the last to go.
 *
 * Order is preference, NOT length: a stripped-down rung is occasionally a
 * character or two longer than the rung above it. Sorting by length instead
 * would let a form win or lose by two characters as a percentage crosses from
 * `9%` to `10%`, and the line would change shape while the reader watches -
 * the flicker this whole mode exists to remove.
 *
 * Candidates never exceed what {@link QuotaOverviewOptions} asked for, so a
 * switch left off cannot reappear because the terminal happened to be wide.
 */
export function formatQuotaOverviewCandidates(
	accounts: readonly QuotaOverviewAccount[],
	options: QuotaOverviewOptions,
): string[] {
	const now = options.now ?? Date.now();
	const maskEmail = options.maskEmail ?? false;
	const total = computeWeightedLeftPercent(accounts);
	if (total === undefined) return [];
	const totalText = formatQuotaPercent(total, options.mode);

	const ordered = orderOverviewAccounts(accounts, options.order);
	const usable = ordered.filter((account) => resolveGoverningWindow(account));
	const recovery = options.recovery === true
		? resolveQuotaOverviewRecovery(accounts, now)
		: undefined;
	const recoveryForms = options.recovery === "all"
		? formatRecoveryEventForms(resolveQuotaRecoveryEvents(accounts, now), now)
		: recovery
		? [true, false]
				.map((words) =>
					formatRecovery(recovery, { mode: options.mode, now, words }),
				)
				.filter((form): form is string => Boolean(form))
		: [];

	const bodies: string[] = [];
	if (options.layout !== "count" && options.layout !== "total") {
		// Position identifies an account only when the accounts are in number
		// order, none of them is missing from the line, and the numbers run
		// 1..n with no gap - a deduplicated or disabled account leaves indices
		// like #1, #3, where the second percentage is NOT account #2's.
		const positionsAreComplete =
			options.order === "number" &&
			usable.length === accounts.length &&
			usable.every((account, position) => account.index === position + 1);
		for (const rung of annotationRungs(options, positionsAreComplete)) {
			const segmentOptions: SegmentOptions = {
				...rung,
				mode: options.mode,
				maskEmail,
				now,
			};
			const segments =
				options.layout === "aggregate"
					? formatAggregateSegments(usable, segmentOptions)
					: usable
							.map((account) => formatAccountSegment(account, segmentOptions))
							.filter((segment): segment is string => Boolean(segment));
			if (segments.length === 0) continue;
			const text = segments.join(", ");
			if (!bodies.includes(text)) bodies.push(text);
		}
	}

	// `66% of 65x` before `66%`: the allotment is a small, near-static
	// annotation, so it is given up early - but not before any account detail,
	// which is what the line is read for.
	const heads: string[] = [];
	if (options.allotment) {
		const allotment = computePoolAllotment(accounts);
		if (allotment !== undefined) heads.push(`${totalText} of ${allotment}x`);
	}
	if (!heads.includes(totalText)) heads.push(totalText);
	if (options.layout === "total") {
		return heads.flatMap((head) => [
			...recoveryForms.map((form) => `${head} ${form}`), head,
		]);
	}

	const candidates: string[] = [];
	const push = (head: string, ...tail: Array<string | undefined>): void => {
		const body = tail.filter((part): part is string => Boolean(part));
		const text = body.length > 0 ? `${head}: ${body.join(", ")}` : head;
		if (!candidates.includes(text)) candidates.push(text);
	};

	for (const body of bodies) {
		for (const head of heads) {
			for (const form of recoveryForms) push(head, body, form);
			push(head, body);
		}
	}
	for (const head of heads) {
		// The count word is grammar, the recovery clause is information, so the
		// word goes first. The count is the pool's size, not the number of
		// accounts that could be read - `40%: 1 account` on a three-account
		// pool would say a pool exists that does not.
		if (recoveryForms.length > 0) {
			for (const form of recoveryForms) push(head, formatAccountCount(accounts.length, "long"), form);
			const shortest = recoveryForms[recoveryForms.length - 1];
			push(head, formatAccountCount(accounts.length, "short"), shortest);
			push(head, formatAccountCount(accounts.length, "bare"), shortest);
		}
		push(head, formatAccountCount(accounts.length, "long"));
		push(head, formatAccountCount(accounts.length, "short"));
		push(head, formatAccountCount(accounts.length, "bare"));
	}
	for (const head of heads) push(head);
	return candidates;
}

/** The fullest rendering, for surfaces with a line to themselves. */
export function formatQuotaOverviewText(
	accounts: readonly QuotaOverviewAccount[],
	options: QuotaOverviewOptions,
): string {
	return formatQuotaOverviewCandidates(accounts, options)[0] ?? "";
}

/**
 * Every rendering of the banked reset credits, longest first.
 *
 * ```text
 * Free resets: 6d 1r damian@nowaker.net, 4d 2r work@example.com
 * ```
 *
 * Sorted by the LATEST reset first, which is redemption order rather than
 * reading order: redeeming a credit on an account that renews by itself
 * tomorrow throws the credit away, while the account six days out is the one
 * worth spending it on.
 *
 * Returns nothing unless the weighted-usage threshold is met and a credit is
 * known to be applicable. The default threshold preserves full exhaustion.
 */
export function formatQuotaResetsCandidates(
	accounts: readonly QuotaOverviewAccount[],
	options: Pick<QuotaOverviewOptions, "maskEmail"> & {
		names?: QuotaOverviewNames;
		now?: number;
		minUsedPercent?: number;
	},
): string[] {
	if (!isPoolSpentEnough(accounts, options.minUsedPercent)) return [];
	const now = options.now ?? Date.now();
	const maskEmail = options.maskEmail ?? false;
	const redeemable = orderOverviewAccounts(accounts, "renewing-latest").filter(
		(account) => resolveApplicableResetCredits(account) > 0,
	);
	if (redeemable.length === 0) return [];

	const durations = redeemable.map((account) => {
		const resetAtMs = governingResetAtMs(account);
		return resetAtMs === undefined
			? undefined
			: formatCompactDuration(resetAtMs - now);
	});
	const credits = redeemable.map((account) => resolveApplicableResetCredits(account));
	const everyAccountHasOneCredit = credits.every((count) => count === 1);

	// The identity follows `accountNames` like the pool line does: the full
	// address is the longest form of the `label` name and appears only there,
	// `number` gives `#n`, and `none` names no account at all.
	const names = options.names ?? "label";
	const unnamed = redeemable.map(() => undefined);
	const identities: Array<Array<string | undefined>> =
		names === "none"
			? [unnamed]
			: names === "number"
				? [
						redeemable.map((account) =>
							resolveAccountName(account, "number", maskEmail),
						),
					]
				: [
						redeemable.map((account) =>
							resolveAccountEmail(account, maskEmail),
						),
						redeemable.map((account) =>
							resolveAccountName(account, "label", maskEmail),
						),
						redeemable.map((account) =>
							resolveAccountName(account, "number", maskEmail),
						),
					];

	const candidates: string[] = [];
	const add = (text: string): void => {
		if (!candidates.includes(text)) candidates.push(text);
	};
	const push = (
		prefix: string,
		identity: Array<string | undefined>,
		withDuration: boolean,
		withCredits: boolean,
	): void => {
		const segments = redeemable.map((_account, position) => {
			const parts: string[] = [];
			const duration = durations[position];
			if (withDuration && duration) parts.push(duration);
			if (withCredits) parts.push(`${credits[position]}r`);
			const name = identity[position];
			if (name) parts.push(name);
			return parts.join(" ");
		});
		// A form that would render one account as an empty segment is not a
		// shorter rendering of this line, it is a different and wrong one.
		if (segments.some((segment) => segment.length === 0)) return;
		add(`${prefix} ${segments.join(", ")}`);
	};

	// The word `Free` is given up before any account detail is, and the
	// identity then shortens from the fullest configured form - the full
	// address under `label` - down to the number `codex-reset` takes.
	push("Free resets:", identities[0] ?? unnamed, true, true);
	for (const identity of identities) push("Resets:", identity, true, true);
	// Only once every identity form has been tried does the line start giving
	// up facts: the countdown is the reason one account is a better redemption
	// than another, and the credit count stops being news when every account
	// holds exactly one.
	for (const identity of identities) {
		if (everyAccountHasOneCredit) push("Resets:", identity, true, false);
		push("Resets:", identity, false, true);
		push("Resets:", identity, false, false);
	}
	add(`Resets: ${redeemable.length}`);
	return candidates;
}

/**
 * Whether the pool is used up far enough for the resets and credits screens
 * to have something to say. The default keeps the rule on the DISPLAYED
 * headroom: an account at 99.6% used reads `0%` left and counts as spent.
 */
function isPoolSpentEnough(
	accounts: readonly QuotaOverviewAccount[],
	minUsedPercent = 100,
): boolean {
	if (minUsedPercent >= 100) return isPoolFullySpent(accounts);
	const total = computeWeightedLeftPercent(accounts, "exact");
	return total !== undefined && 100 - total >= minUsedPercent;
}

/**
 * Every rendering of the accounts that still hold Codex credits, largest
 * balance first - the counterpart of {@link formatQuotaResetsCandidates} for
 * the other way out of a spent pool.
 *
 * ```text
 * Codex credits: 62,500 damian@nowaker.net, 1,200 work@example.com
 * ```
 *
 * Largest balance first, which is the order `spendCredits` draws on them.
 * Shown under the same threshold as the resets screen, and only for accounts
 * with a balance to spend.
 */
export function formatQuotaCreditsCandidates(
	accounts: readonly QuotaOverviewAccount[],
	options: Pick<QuotaOverviewOptions, "maskEmail"> & {
		names?: QuotaOverviewNames;
		minUsedPercent?: number;
	},
): string[] {
	if (!isPoolSpentEnough(accounts, options.minUsedPercent)) return [];
	const holders = accounts
		.filter((account): account is QuotaOverviewAccount & { credits: CreditsBalance } =>
			hasSpendableCredits(account.credits))
		.sort((left, right) =>
			creditsSortValue(right.credits) - creditsSortValue(left.credits) || left.index - right.index);
	if (holders.length === 0) return [];

	const maskEmail = options.maskEmail ?? false;
	const names = options.names ?? "label";
	const identities: Array<Array<string | undefined>> =
		names === "none"
			? []
			: names === "number"
				? [holders.map((account) => resolveAccountName(account, "number", maskEmail))]
				: [
						holders.map((account) => resolveAccountEmail(account, maskEmail)),
						holders.map((account) => resolveAccountName(account, "label", maskEmail)),
						holders.map((account) => resolveAccountName(account, "number", maskEmail)),
					];

	const candidates: string[] = [];
	const push = (
		prefix: string,
		identity: Array<string | undefined> | undefined,
		amount: ((balance: CreditsBalance) => string) | undefined,
	): void => {
		const segments = holders.map((account, position) =>
			[amount?.(account.credits), identity?.[position]].filter(Boolean).join(" "));
		if (segments.some((segment) => segment.length === 0)) return;
		const text = `${prefix} ${segments.join(", ")}`;
		if (!candidates.includes(text)) candidates.push(text);
	};

	for (const identity of identities) push("Codex credits:", identity, formatCreditsBalance);
	if (identities.length === 0) push("Codex credits:", undefined, formatCreditsBalance);
	for (const identity of identities) push("Credits:", identity, formatCreditsBalanceCompact);
	if (identities.length === 0) push("Credits:", undefined, formatCreditsBalanceCompact);
	for (const identity of identities) push("Credits:", identity, undefined);
	const count = `Credits: ${holders.length} account${holders.length === 1 ? "" : "s"}`;
	if (!candidates.includes(count)) candidates.push(count);
	return candidates;
}

/**
 * Headroom of the account with the most room left, for the caller that
 * colours the line.
 *
 * Deliberately the best account rather than the worst: a pool is only in
 * trouble when nothing in it has room left, and keying on the worst account
 * would paint the line red for one spent seat that rotation has already
 * stopped selecting while every other account serves requests normally.
 */
export function resolveQuotaOverviewTonePercent(
	accounts: readonly QuotaOverviewAccount[],
): number | undefined {
	let best: number | undefined;
	for (const account of accounts) {
		const governing = resolveGoverningWindow(account);
		if (!governing || !isPercent(governing.leftPercent)) continue;
		if (best === undefined || governing.leftPercent > best) {
			best = governing.leftPercent;
		}
	}
	return best;
}

/** Re-exported so callers rendering a bare total need only this module. */
export { toQuotaDisplayPercent };
