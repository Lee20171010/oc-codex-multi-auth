import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	autoRedeemResetCredit,
	getWeeklyLeftPercent,
	resetAutoRedeemAttempts,
} from "../lib/codex-reset.js";
import { parseCodexUsagePayload } from "../lib/codex-usage.js";
import { getQuotaNotifications } from "../lib/config.js";

const request = { accountId: "acct-1", accessToken: "access-token", organizationId: undefined };

function usageWith(options: {
	fiveUsed?: number;
	weeklyUsed?: number;
	applicable?: number;
	available?: number;
}) {
	return parseCodexUsagePayload({
		rate_limit: {
			primary_window: { used_percent: options.fiveUsed ?? 10, limit_window_seconds: 18_000 },
			secondary_window: { used_percent: options.weeklyUsed ?? 100, limit_window_seconds: 604_800 },
		},
		rate_limit_reset_credits: {
			available_count: options.available ?? 1,
			applicable_available_count: options.applicable ?? 1,
		},
	});
}

const creditsBody = {
	available_count: 1,
	credits: [{ id: "RateLimitResetCredit_1", status: "available", reset_type: "codex_rate_limits" }],
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("autoRedeemResetCredit", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		resetAutoRedeemAttempts();
		fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
			init?.method === "POST"
				? jsonResponse({ code: "reset", credit: { redeemed_at: "2026-09-29T18:00:00Z" } })
				: jsonResponse(creditsBody),
		);
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const run = (usage: ReturnType<typeof usageWith>, belowPercent = 10) =>
		autoRedeemResetCredit({ usage, request, belowPercent, label: "account abc123" });

	const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");

	it("spends a credit when the weekly quota is spent and the server says it applies", async () => {
		expect(await run(usageWith({ weeklyUsed: 100 }))).toBe(true);
		expect(posts()).toHaveLength(1);
		expect(JSON.parse(posts()[0]![1].body as string).credit_id).toBe("RateLimitResetCredit_1");
	});

	it("spends at exactly the threshold and not above it", async () => {
		expect(await run(usageWith({ weeklyUsed: 89 }))).toBe(false);
		expect(await run(usageWith({ weeklyUsed: 90 }))).toBe(true);
	});

	it("ignores a spent 5-hour window while the weekly quota is healthy", async () => {
		expect(await run(usageWith({ fiveUsed: 100, weeklyUsed: 30 }))).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does nothing when the server reports no applicable credit", async () => {
		expect(await run(usageWith({ weeklyUsed: 100, applicable: 0 }))).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reads the weekly window even when it is the only one reported", async () => {
		const usage = parseCodexUsagePayload({
			rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 604_800 } },
			rate_limit_reset_credits: { available_count: 1, applicable_available_count: 1 },
		});
		expect(getWeeklyLeftPercent(usage)).toBe(0);
		expect(await run(usage)).toBe(true);
	});

	it("does not retry a credit it already tried, even after a failure", async () => {
		fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
			init?.method === "POST" ? jsonResponse({ error: "nope" }, 500) : jsonResponse(creditsBody),
		);
		expect(await run(usageWith({}))).toBe(false);
		expect(posts()).toHaveLength(1);
		expect(await run(usageWith({}))).toBe(false);
		expect(posts()).toHaveLength(1);
	});

	it("reports false instead of throwing when the credit list cannot be read", async () => {
		fetchMock.mockRejectedValue(new Error("network down"));
		await expect(run(usageWith({}))).resolves.toBe(false);
	});
});

describe("auto-redeem settings", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("is off by default with a 10% threshold", () => {
		const config = getQuotaNotifications({});
		expect(config.autoRedeemResets).toBe(false);
		expect(config.autoRedeemResetsBelowPercent).toBe(10);
	});

	it("reads config, clamps the threshold and honours the environment", () => {
		expect(
			getQuotaNotifications({
				quotaNotifications: { autoRedeemResets: true, autoRedeemResetsBelowPercent: 25 },
			}),
		).toMatchObject({ autoRedeemResets: true, autoRedeemResetsBelowPercent: 25 });
		vi.stubEnv("CODEX_AUTH_AUTO_REDEEM_RESETS", "0");
		vi.stubEnv("CODEX_AUTH_AUTO_REDEEM_RESETS_BELOW_PERCENT", "500");
		expect(
			getQuotaNotifications({ quotaNotifications: { autoRedeemResets: true } }),
		).toMatchObject({ autoRedeemResets: false, autoRedeemResetsBelowPercent: 100 });
	});
});
