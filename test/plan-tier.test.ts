import { describe, it, expect } from "vitest";

import { extractPlanType, formatPlanType } from "../lib/auth/plan-tier.js";
import { JWT_CLAIM_PATH } from "../lib/constants.js";

/**
 * Builds an unsigned JWT whose payload decodes to `payload`. The signature is
 * never verified by `decodeJWT`, which only base64url-decodes the middle part.
 */
function makeToken(payload: Record<string, unknown>): string {
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
	return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

function makeAccessToken(planType: string | undefined): string {
	return makeToken({
		[JWT_CLAIM_PATH]: {
			chatgpt_account_id: "05cd9f04-d56a-4256-9934-9cb827989a40",
			...(planType === undefined ? {} : { chatgpt_plan_type: planType }),
		},
	});
}

describe("extractPlanType", () => {
	it("returns undefined without a token", () => {
		expect(extractPlanType(undefined)).toBeUndefined();
		expect(extractPlanType("")).toBeUndefined();
	});

	it("returns undefined for a token that is not a JWT", () => {
		expect(extractPlanType("not-a-jwt")).toBeUndefined();
	});

	it("returns undefined when the auth claim carries no plan type", () => {
		expect(extractPlanType(makeAccessToken(undefined))).toBeUndefined();
	});

	it("reads chatgpt_plan_type from the OpenAI auth claim", () => {
		expect(extractPlanType(makeAccessToken("pro"))).toBe("pro");
	});

	it("trims and lowercases the claim so casing never splits a tier", () => {
		expect(extractPlanType(makeAccessToken("  Pro  "))).toBe("pro");
	});
});

describe("formatPlanType", () => {
	it("returns undefined for an absent or blank plan type", () => {
		expect(formatPlanType(undefined)).toBeUndefined();
		expect(formatPlanType("   ")).toBeUndefined();
	});

	it("returns undefined for a non-string plan type read off the wire", () => {
		expect(formatPlanType(42 as unknown as string)).toBeUndefined();
	});

	/**
	 * Correlation table. Every `chatgpt_plan_type` below was read from a real
	 * ChatGPT OAuth access token and independently confirmed against the same
	 * account's `plan_type` from the live `/wham/usage` response, then matched
	 * to the subscription the account owner confirmed they hold.
	 */
	const OBSERVED: Array<{ planType: string; expected: string; groundTruth: string }> = [
		{ planType: "free", expected: "Free", groundTruth: "personal free" },
		{ planType: "pro", expected: "Pro", groundTruth: "personal $200/mo" },
		{ planType: "team", expected: "Business", groundTruth: "business seat, 1x allowance" },
		{
			planType: "self_serve_business_prolite",
			expected: "Business Premium",
			groundTruth: "business seat, premium, 5x allowance",
		},
	];

	for (const { planType, expected, groundTruth } of OBSERVED) {
		it(`maps ${planType} to ${expected} (${groundTruth})`, () => {
			expect(formatPlanType(planType)).toBe(expected);
		});
	}

	it("maps plus to Plus", () => {
		expect(formatPlanType("plus")).toBe("Plus");
	});

	it("passes an unrecognized plan type through verbatim rather than guessing", () => {
		expect(formatPlanType("some_future_plan")).toBe("some_future_plan");
	});

	// `plan_type` comes off /wham/usage, which fetchCodexUsage casts without
	// validating and which OPENAI_BASE_URL lets a user put a gateway in front
	// of; `x-codex-plan-type` is a header from the same place. Every renderer
	// interpolates the result into a line, and codex-limits and the TUI quota
	// pane have no width bound, so a control character travelled straight
	// through: a newline split a codex-list row in two and the second half read
	// as a line the tool had emitted.
	it("strips control characters out of an unrecognized plan type", () => {
		const LF = String.fromCharCode(10);
		const ESC = String.fromCharCode(27);
		expect(formatPlanType(`pro${LF}Plan: Enterprise`)).toBe("pro Plan: Enterprise");
		expect(formatPlanType(`${ESC}[31mred${ESC}[0m`)).toBe("[31mred [0m");
		expect(formatPlanType(`a${String.fromCharCode(0)}b`)).toBe("a b");
		expect(formatPlanType(LF)).toBeUndefined();
	});

	it("bounds an unrecognized plan type so an unbounded renderer cannot be flooded", () => {
		const named = formatPlanType("x".repeat(4096));
		expect(named).toBeDefined();
		expect(named!.length).toBeLessThanOrEqual(32);
		// The longest slug it knows is 27 chars, so nothing real is truncated.
		expect(formatPlanType("self_serve_business_prolite")).toBe("Business Premium");
	});
});
