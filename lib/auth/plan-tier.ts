/**
 * ChatGPT subscription tier, read from the OAuth access token.
 *
 * The `chatgpt_plan_type` claim is the only plan signal the credential itself
 * carries. It agrees with the `plan_type` field the Codex `/wham/usage`
 * endpoint returns for the same account, so the tier is available without a
 * network round trip and stays correct while offline.
 */

import { decodeJWT } from "./auth.js";
import { JWT_CLAIM_PATH } from "../constants.js";

/**
 * `chatgpt_plan_type` slug to the subscription name OpenAI shows for it.
 *
 * `team` is the slug still emitted for what OpenAI now calls Business, and
 * `self_serve_business_prolite` is the premium Business seat - neither name is
 * derivable from its slug, so both are pinned here rather than reformatted.
 */
const PLAN_TYPE_LABELS: ReadonlyMap<string, string> = new Map([
	["free", "Free"],
	["plus", "Plus"],
	// Upstream Codex (openai/codex #47971, merged 2026-09-25) relabels the Pro
	// ladder as "Pro" (`prolite`), "Pro (More)" (`pro`) and "Pro (Max)"
	// (`promax`, ~$500/mo). `promax` already appears in model-catalog plan
	// lists (e.g. gpt-6.1-sol's `available_in_plans`), so tokens will start
	// carrying it.
	["prolite", "Pro"],
	["pro", "Pro (More)"],
	["promax", "Pro (Max)"],
	["team", "Business"],
	["business", "Business"],
	["self_serve_business_prolite", "Business Premium"],
	["enterprise", "Enterprise"],
]);

export function extractPlanType(accessToken?: string): string | undefined {
	if (!accessToken) return undefined;
	const planType = decodeJWT(accessToken)?.[JWT_CLAIM_PATH]?.chatgpt_plan_type;
	if (typeof planType !== "string") return undefined;
	const normalized = planType.trim().toLowerCase();
	return normalized ? normalized : undefined;
}

/**
 * Longest name this maps to is "Business Premium" (16) and the longest slug it
 * knows is `self_serve_business_prolite` (27), so this bounds an unrecognized
 * slug without truncating anything real.
 */
const MAX_PLAN_LABEL_LENGTH = 32;

/**
 * Make a slug safe to interpolate into a rendered line.
 *
 * `plan_type` is read straight off `/wham/usage`, which `fetchCodexUsage` casts
 * without validating and which `OPENAI_BASE_URL` lets a user put an arbitrary
 * gateway in front of; `x-codex-plan-type` is a response header from the same
 * place. Every renderer interpolates the result into a line, and two of them
 * (`codex-limits`, the TUI quota pane) have no width bound at all, so a control
 * character travels straight through: `pro\nPlan: Enterprise` splits a
 * `codex-list` row in two and the second half reads as output the tool emitted.
 *
 * Control characters are dropped rather than escaped, and the result is bounded.
 * Neither changes how a real plan reads.
 */
function sanitizePlanLabel(value: string): string | undefined {
	let cleaned = "";
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		// C0, DEL, and C1: covers CR/LF/TAB and the ESC that starts an ANSI
		// sequence. Replaced with a space so two words do not fuse into one.
		cleaned += (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) ? " " : char;
	}
	const collapsed = cleaned.replace(/\s+/g, " ").trim();
	if (!collapsed) return undefined;
	return collapsed.length > MAX_PLAN_LABEL_LENGTH
		? `${collapsed.slice(0, MAX_PLAN_LABEL_LENGTH - 1)}…`
		: collapsed;
}

/**
 * An unrecognized slug is returned verbatim: a plan we cannot name is still
 * worth showing, and inventing a name for it would misreport the subscription.
 * "Verbatim" means not renamed, not un-sanitized — see {@link sanitizePlanLabel}.
 *
 * Accepts `null` so the live `/wham/usage` and `x-codex-plan-type` readings —
 * which type their absent plan as `null`, not `undefined` — go through the same
 * naming as the copy stored at login. Without that, one seat printed "Business"
 * in `codex-list` and `team` in `codex-limits` and the TUI.
 */
export function formatPlanType(planType: string | null | undefined): string | undefined {
	// Declared `string` but read unvalidated off `/wham/usage`.
	if (typeof planType !== "string") return undefined;
	const normalized = planType.trim().toLowerCase();
	if (!normalized) return undefined;
	const known = PLAN_TYPE_LABELS.get(normalized);
	if (known) return known;
	return sanitizePlanLabel(planType);
}
