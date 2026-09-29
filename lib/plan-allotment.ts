/**
 * How much Codex capacity one ChatGPT plan carries relative to another.
 *
 * A pool of accounts on different plans has no single "percent used": one
 * Pro seat spent to 50% has given up far more capacity than a Business
 * Standard seat spent to 50%, so averaging the two percentages unweighted
 * reports a pool that does not exist. Every plan here therefore carries a
 * {@link PlanAllotment.weight} - its allotment relative to a 1x seat - and the
 * pool total is the weighted mean.
 *
 * The weights are OpenAI's own published per-seat ratios, taken from the
 * plan's monthly price against the 1x Plus/Business Standard seat: Pro is
 * $200 against $20, and is marketed as 20x. They describe the *subscription*,
 * not a measured token allowance, which is the only ratio OpenAI states and
 * the same one the seat is sold on.
 *
 * `plan_type` is what the `/wham/usage` endpoint and the `chatgpt_plan_type`
 * access-token claim report. Two of its slugs are not derivable from their
 * text - `team` is the slug still emitted for what OpenAI now calls Business,
 * and `self_serve_business_prolite` is the premium Business seat rather than
 * the personal Pro Lite tier that shares the `prolite` token - so both are
 * matched explicitly below.
 *
 * This module is deliberately a leaf (no imports). The prompt status line
 * depends on it, and naming a plan is a separate concern that already has an
 * owner in `lib/auth/plan-tier.ts`; pulling that in here would drag JWT
 * decoding into the TUI's render path for a number that needs none of it.
 */

export type PlanAllotment = {
	/**
	 * Allotment relative to a 1x seat, or `undefined` when the plan states no
	 * ratio. `undefined` is not 1: a plan we cannot place must not be
	 * silently averaged as though it were the baseline.
	 */
	weight?: number;
	/** Marketing badge for the same ratio, e.g. `5x`. */
	multiplier?: string;
	/** Per-seat monthly price in USD, as listed by OpenAI. */
	monthlyUsd?: number;
};

const UNKNOWN_ALLOTMENT: PlanAllotment = {};

/**
 * Weight used for a plan that states no ratio, so one unplaceable account
 * cannot remove every other account from the pool total. It is the baseline
 * seat rather than a guess at something larger: under-weighting an unknown
 * plan understates one account, while over-weighting it would let a plan we
 * failed to recognize dominate the number the whole pool is judged by.
 */
export const DEFAULT_PLAN_WEIGHT = 1;

/**
 * Reduce a `plan_type` to the form the matchers below expect.
 *
 * The admin roster spells a tier as one token (`chatgptteamplan`) while the
 * usage endpoint reports the bare word (`team`), and the premium Business
 * seat arrives underscored (`self_serve_business_prolite`). All three have to
 * land on the same normalized text or one seat is weighted differently
 * depending on which surface named it.
 */
export function normalizePlanSlug(value: string | null | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	// Case is folded before anything else is stripped, so every pattern below
	// can be written once in lower case. Stripping first would leave the
	// trailing-`plan` rule matching `teamplan` but not `Team_Plan`, and the
	// same seat would then weigh differently depending on which surface spelled
	// it.
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/^chatgpt[\s_-]*/, "")
		.replace(/[\s_-]+/g, " ")
		.replace(/\s?plan$/, "")
		.trim();
	return normalized || undefined;
}

/**
 * A `business` seat's ratio, which depends on the qualifier beside it.
 *
 * `self_serve_business_prolite` normalizes to `self serve business prolite`,
 * so `business` is matched as a whole word anywhere in the text rather than
 * as a prefix. A bare `business` names the workspace rather than the seat,
 * and the two seats inside it are 5x apart, so it states no ratio at all.
 */
function describeBusinessSeat(plan: string): PlanAllotment | undefined {
	if (!/(^| )business( |$)/.test(plan)) return undefined;
	if (
		plan.includes("prolite") ||
		plan.includes("pro lite") ||
		plan.includes("premium")
	) {
		return { weight: 5, multiplier: "5x", monthlyUsd: 125 };
	}
	if (plan.includes("standard")) {
		return { weight: 1, multiplier: "1x", monthlyUsd: 25 };
	}
	return UNKNOWN_ALLOTMENT;
}

/**
 * The $100 Pro that predates the $200 one. Both report a `pro` family slug,
 * and they are 4x apart, so the legacy spellings are matched before the
 * current tier claims the bare word.
 */
function isLegacyProPlan(plan: string): boolean {
	return (
		plan === "pro 5x" ||
		plan === "pro 100" ||
		plan === "pro legacy" ||
		plan === "legacy pro" ||
		plan === "legacy pro 5x" ||
		plan === "pro legacy 5x"
	);
}

function isCurrentProPlan(plan: string): boolean {
	return plan === "pro" || plan === "pro 20x" || plan === "pro 200";
}

/**
 * Resolve a `plan_type` to its allotment. An unrecognized plan returns an
 * empty allotment rather than a guess, so callers can tell "1x" apart from
 * "we do not know".
 */
export function describePlanAllotment(
	planType: string | null | undefined,
): PlanAllotment {
	const plan = normalizePlanSlug(planType);
	if (!plan) return UNKNOWN_ALLOTMENT;
	if (plan === "plus") return { weight: 1, multiplier: "1x", monthlyUsd: 20 };
	// `team` is the slug OpenAI still emits for Business; a qualified
	// `team premium` / `team standard` is handled by the business matcher.
	if (plan === "team") return { weight: 1, multiplier: "1x", monthlyUsd: 25 };
	const business = describeBusinessSeat(plan);
	if (business) return business;
	if (isLegacyProPlan(plan)) return { weight: 5, multiplier: "5x", monthlyUsd: 100 };
	if (isCurrentProPlan(plan)) return { weight: 20, multiplier: "20x", monthlyUsd: 200 };
	if (plan === "prolite" || plan === "pro lite") {
		return { weight: 5, multiplier: "5x", monthlyUsd: 100 };
	}
	// `promax` is the "Pro (Max)" tier added to upstream PlanType on
	// 2026-09-25 (openai/codex #47971) and already present in model-catalog
	// `available_in_plans` lists. Reported at ~$500/mo; OpenAI has not
	// published a seat ratio for it, so it carries a price but no weight —
	// same treatment as Enterprise, not a guess.
	if (plan === "promax" || plan === "pro max") {
		return { monthlyUsd: 500 };
	}
	// Go, Free and Enterprise all reach here. The first two carry no Codex
	// allotment worth weighting, and Enterprise is negotiated per contract, so
	// none of them states a ratio this code could apply.
	return UNKNOWN_ALLOTMENT;
}

/**
 * The weight to average an account by, falling back to
 * {@link DEFAULT_PLAN_WEIGHT} for a plan that states no ratio.
 */
export function getPlanWeight(planType: string | null | undefined): number {
	return describePlanAllotment(planType).weight ?? DEFAULT_PLAN_WEIGHT;
}

/** `5x`, or `undefined` when the plan states no ratio. */
export function formatPlanMultiplier(
	planType: string | null | undefined,
): string | undefined {
	return describePlanAllotment(planType).multiplier;
}
