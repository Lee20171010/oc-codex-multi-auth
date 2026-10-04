import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRedeemRequestId } from "../lib/codex-reset.js";
import { createCodexResetTool } from "../lib/tools/codex-reset.js";
import type { ToolContext } from "../lib/tools/index.js";
import * as quotaCache from "../lib/tui-quota-cache.js";

vi.mock("../lib/storage.js", () => ({
	loadAccounts: vi.fn(),
	getStoragePath: () => join(tmpdir(), "FAKE_RESET_POOL", "accounts.json"),
	withAccountStorageTransaction: vi.fn(),
}));

import { loadAccounts, withAccountStorageTransaction } from "../lib/storage.js";

const CREDITS_URL =
	"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CONSUME_URL =
	"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

type ToolExecute = (args?: Record<string, unknown>) => Promise<string>;

function buildCtx(): ToolContext {
	return {
		resolveUiRuntime: () => ({
			v2Enabled: false,
			colorProfile: "ansi16",
			glyphMode: "ascii",
			theme: undefined,
		}),
		resolveMaskEmail: () => false,
		resolveActiveIndex: () => 0,
		formatCommandAccountLabel: (_account, index) => `Account ${index + 1}`,
		buildJsonAccountIdentity: (index) => ({ account: index + 1 }),
		invalidateAccountManagerCache: () => undefined,
	} as unknown as ToolContext;
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

const usagePayload = {
	plan_type: "team",
	rate_limit: {
		primary_window: {
			used_percent: 23,
			limit_window_seconds: 10080 * 60,
		},
		secondary_window: null,
	},
};

const creditsPayload = {
	available_count: 1,
	credits: [
		{
			id: "RateLimitResetCredit_1",
			status: "available",
			reset_type: "free",
			granted_at: "2026-06-12",
			expires_at: "2026-07-12",
			title: "One free rate limit reset",
		},
	],
};

/** Route the mocked fetch by URL so each endpoint's calls can be asserted. */
function mockCodexFetch(): ReturnType<typeof vi.spyOn> {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = String(input);
		if (url === CREDITS_URL) return jsonResponse(creditsPayload);
		if (url === USAGE_URL) return jsonResponse(usagePayload);
		if (url === CONSUME_URL) {
			return jsonResponse({
				code: "ok",
				windows_reset: ["primary"],
				credit: { redeemed_at: "2026-07-14T10:00:00Z" },
			});
		}
		throw new Error(`unexpected fetch: ${url}`);
	});
}

function callsTo(
	fetchMock: ReturnType<typeof mockCodexFetch>,
	url: string,
): unknown[][] {
	return fetchMock.mock.calls.filter((call) => String(call[0]) === url);
}

describe("codex-reset tool", () => {
	beforeEach(() => {
		vi.mocked(withAccountStorageTransaction).mockReset();
		vi.mocked(loadAccounts).mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: {},
			accounts: [
				{
					accountId: "acct-1",
					accessToken: "access-token",
					refreshToken: "refresh-token",
					expiresAt: Date.now() + 3_600_000,
					email: "user@example.com",
				},
			],
		} as unknown as Awaited<ReturnType<typeof loadAccounts>>);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("lists banked credits and current usage by default", async () => {
		mockCodexFetch();
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;

		const output = await execute();

		expect(output).toContain("banked credits: 1 available");
		expect(output).toContain("RateLimitResetCredit_1");
		expect(output).toContain("Weekly limit: 77% left");
		expect(output).toContain('codex-reset action="consume" confirm=true');
	});

	it("does not redeem when consume is called without confirmation", async () => {
		const fetchMock = mockCodexFetch();
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;

		const output = await execute({ action: "consume" });

		expect(callsTo(fetchMock, CONSUME_URL)).toHaveLength(0);
		expect(output).toContain("about to redeem");
		expect(output).toContain("confirm=true");
	});

	it("does not redeem on a dry run even when confirmed", async () => {
		const fetchMock = mockCodexFetch();
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;

		const output = await execute({
			action: "consume",
			confirm: true,
			dryRun: true,
		});

		expect(callsTo(fetchMock, CONSUME_URL)).toHaveLength(0);
		expect(output).toContain("dry run");
	});

	it("redeems the credit once when confirmed, and reports the new usage", async () => {
		const clearCaches = vi.spyOn(quotaCache, "clearTuiQuotaSnapshots").mockResolvedValue(undefined);
		const fetchMock = mockCodexFetch();
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;

		const output = await execute({ action: "consume", confirm: true });

		const consumeCalls = callsTo(fetchMock, CONSUME_URL);
		expect(consumeCalls).toHaveLength(1);
		const body = JSON.parse(
			String((consumeCalls[0]?.[1] as RequestInit).body),
		) as { credit_id: string; redeem_request_id: string };
		expect(body.credit_id).toBe("RateLimitResetCredit_1");
		expect(body.redeem_request_id).toBeTruthy();
		expect(output).toContain("redeemed RateLimitResetCredit_1");
		expect(output).toContain("new usage:");
		expect(clearCaches).toHaveBeenCalledOnce();
	});
	it("reports a completed redemption honestly when quota cache cleanup fails", async () => {
		const fetchMock = mockCodexFetch();
		vi.spyOn(quotaCache, "clearTuiQuotaSnapshots").mockRejectedValue(new Error("FAKE_CACHE_FAILURE"));
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;
		const result = JSON.parse(await execute({ action: "consume", confirm: true, format: "json" }));
		expect(result).toMatchObject({ redeemed: true, quotaCachesCleared: false,
			quotaCacheClearError: expect.stringContaining("limits --refresh") });
		expect(callsTo(fetchMock, CONSUME_URL)).toHaveLength(1);
	});
	it("preserves new limits recorded during redemption and retires only the markers actually cleared", async () => {
		const future = Date.now() + 3_600_000;
		const account = { accountId: "acct-1", refreshToken: "refresh-token", accessToken: "access-token",
			expiresAt: future, addedAt: 1, lastUsed: 1, quotaExhaustedUntil: future,
			quotaExhaustedStampAt: 100, rateLimitResetTimes: { codex: future, "gpt-5.1": future },
			coolingDownUntil: future, cooldownReason: "auth-failure" as const };
		const before = { version: 3 as const, activeIndex: 0, accounts: [account] };
		const current = structuredClone(before);
		vi.mocked(loadAccounts).mockResolvedValue(before);
		const persist = vi.fn();
		vi.mocked(withAccountStorageTransaction).mockImplementation(async (callback) => callback(current, persist));
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			if (String(input) === CREDITS_URL) return jsonResponse(creditsPayload);
			if (String(input) === USAGE_URL) return jsonResponse(usagePayload);
			if (String(input) === CONSUME_URL) {
				current.accounts[0].quotaExhaustedStampAt = 200;
				current.accounts[0].rateLimitResetTimes.codex = future + 60_000;
				return jsonResponse({ code: "ok", windows_reset: ["primary"] });
			}
			throw new Error("Unexpected test URL");
		});
		const ctx = buildCtx();
		const invalidate = vi.spyOn(ctx, "invalidateAccountManagerCache");
		const execute = createCodexResetTool(ctx).execute as ToolExecute;
		const output = JSON.parse(await execute({ action: "consume", confirm: true, format: "json" }));
		expect(output).toMatchObject({
			redeemed: true,
			blocksCleared: true,
			// Post-consume inventory: the spent credit must not still show as
			// available in the same payload that reports `redeemed: true`
			// (greptile P1 on PR #282 — stale inventory invites a re-redeem).
			availableCount: 0,
			credits: [],
		});
		expect(current.accounts[0].quotaExhaustedStampAt).toBe(200);
		expect(current.accounts[0].quotaExhaustedUntil).toBe(future);
		expect(current.accounts[0].rateLimitResetTimes).toEqual({ codex: future + 60_000 });
		expect(current.accounts[0].coolingDownUntil).toBeUndefined();
		expect(invalidate.mock.calls[0]?.[0]?.[0]).toMatchObject({
			rateLimitResetTimes: { "gpt-5.1": future }, quotaExhaustedUntil: undefined,
		});
	});

	it.each(["json", "text"])("clears persisted local blocks after successful consume (%s)", async (format) => {
		const actualStorage = await vi.importActual<typeof import("../lib/storage.js")>("../lib/storage.js");
		const directory = await mkdtemp(join(tmpdir(), "codex-reset-blocks-"));
		const path = join(directory, "accounts.json");
		const future = Date.now() + 3_600_000;
		const storage = {
			version: 3 as const,
			activeIndex: 0,
			activeIndexByFamily: {},
			accounts: [{
				accountId: "acct-1", refreshToken: "refresh-token", accessToken: "access-token",
				expiresAt: future, addedAt: 1, lastUsed: 1,
				quotaExhaustedUntil: future, rateLimitResetTimes: { codex: future },
				coolingDownUntil: future, cooldownReason: "auth-failure" as const,
			}],
		};
		actualStorage.setStoragePathDirect(path);
		try {
			await writeFile(path, JSON.stringify(storage));
			vi.mocked(loadAccounts).mockResolvedValue(storage);
			vi.mocked(withAccountStorageTransaction).mockImplementation(actualStorage.withAccountStorageTransaction);
			mockCodexFetch();
			const ctx = buildCtx();
			const invalidate = vi.spyOn(ctx, "invalidateAccountManagerCache");
			const execute = createCodexResetTool(ctx).execute as ToolExecute;

			const output = await execute({ action: "consume", confirm: true, format });

			const persisted = JSON.parse(await readFile(path, "utf8"));
			expect(persisted.accounts[0].quotaExhaustedUntil).toBeUndefined();
			expect(persisted.accounts[0].coolingDownUntil).toBeUndefined();
			expect(persisted.accounts[0].cooldownReason).toBeUndefined();
			expect(persisted.accounts[0].rateLimitResetTimes).toEqual({});
			expect(invalidate).toHaveBeenCalledOnce();
			if (format === "json") expect(JSON.parse(output)).toMatchObject({ redeemed: true, blocksCleared: true });
			else expect(output).toContain("cleared local rate-limit/quota markers");
		} finally {
			actualStorage.setStoragePathDirect(null);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each(["json", "text"])("preserves successful redemption when local cleanup fails (%s)", async (format) => {
		mockCodexFetch();
		vi.mocked(withAccountStorageTransaction).mockRejectedValue(new Error("secret-refresh-token"));
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;

		const output = await execute({ action: "consume", confirm: true, format });

		if (format === "json") {
			expect(JSON.parse(output)).toMatchObject({
				redeemed: true, blocksCleared: false, blocksClearError: expect.any(String),
			});
		} else {
			expect(output).toContain("redeemed RateLimitResetCredit_1");
			expect(output).toContain("could not clear local rate-limit/quota markers");
		}
		expect(output).not.toContain("secret-refresh-token");
	});

	it("still reports the redemption when the usage re-read fails afterwards", async () => {
		// The POST succeeds and the credit is spent; only the courtesy usage read
		// that follows it fails. Reporting redeemed=false here would push the user
		// to spend a second credit for a redemption that already happened.
		let consumed = false;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url === CREDITS_URL) return jsonResponse(creditsPayload);
			if (url === CONSUME_URL) {
				consumed = true;
				return jsonResponse({ code: "ok" });
			}
			if (url === USAGE_URL) {
				if (consumed) throw new TypeError("network down");
				return jsonResponse(usagePayload);
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;

		const parsed = JSON.parse(
			await execute({ action: "consume", confirm: true, format: "json" }),
		) as { redeemed: boolean; usageError: string | null; error?: string };

		expect(parsed.redeemed).toBe(true);
		expect(parsed.usageError).toContain("network down");
		// The consume schema is stable: `error` is always present, null here.
		expect(parsed.error).toBeNull();
	});

	it("sends a stable idempotency key derived from the credit id", async () => {
		// A retry of the same logical redemption must present the same
		// redeem_request_id, or the backend cannot dedupe it and a lost
		// response could turn into a second spent credit.
		const fetchMock = mockCodexFetch();
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;

		await execute({ action: "consume", confirm: true });
		await execute({ action: "consume", confirm: true });

		const consumeCalls = callsTo(fetchMock, CONSUME_URL);
		expect(consumeCalls).toHaveLength(2);
		const keys = consumeCalls.map(
			(call) =>
				(
					JSON.parse(String((call[1] as RequestInit).body)) as {
						redeem_request_id: string;
					}
				).redeem_request_id,
		);
		expect(keys[0]).toBe(createRedeemRequestId("RateLimitResetCredit_1"));
		expect(keys[1]).toBe(keys[0]);
	});

	it("reports an unknown outcome when the consume request itself fails", async () => {
		// The POST may have reached the backend before the connection died, so
		// the tool must not claim redeemed=false — that would send the user to
		// spend a second credit for a redemption that may already be done.
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url === CREDITS_URL) return jsonResponse(creditsPayload);
			if (url === CONSUME_URL) throw new TypeError("socket hang up");
			if (url === USAGE_URL) return jsonResponse(usagePayload);
			throw new Error(`unexpected fetch: ${url}`);
		});
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;

		const parsed = JSON.parse(
			await execute({ action: "consume", confirm: true, format: "json" }),
		) as {
			redeemed: boolean | null;
			reason?: string;
			ok?: boolean;
			tool?: string;
			error?: string;
			message?: string;
			retryable?: boolean;
			nextAction?: string | null;
			path?: string | null;
		};
		expect(parsed.redeemed).toBeNull();
		expect(parsed.reason).toBe("consume-failed");
		// Shared-envelope semantics (greptile P2 on PR #282): `error` is the
		// machine code — a TypeError has none, so the generic code applies —
		// and `message` carries the masked prose plus the recovery guidance.
		expect(parsed.error).toBe("CODEX_TOOL_ERROR");
		expect(parsed.message).toContain("socket hang up");
		expect(parsed.message).toContain("RateLimitResetCredit_1");
		// The advertised envelope discriminator must be present (greptile P1
		// on PR #282): a caller reading `ok` alone cannot miss the uncertain
		// outcome and treat the pre-consume inventory as current.
		expect(parsed.ok).toBe(false);
		expect(parsed.tool).toBe("codex-reset");
		expect(parsed.retryable).toBe(false);
		expect(parsed).toHaveProperty("nextAction");
		expect(parsed).toHaveProperty("path");

		const text = await execute({ action: "consume", confirm: true });
		expect(text).toContain("redemption outcome unknown");
		expect(text).toContain("RateLimitResetCredit_1");
	});

	it("subtracts exactly one credit when the upstream lists the same id twice", async () => {
		// A malformed upstream payload can carry repeated ids — one redemption
		// spends ONE credit, so availableCount drops by one, not by the number
		// of removed rows (greptile P2 on PR #282).
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url === CREDITS_URL) {
				return jsonResponse({
					available_count: 3,
					credits: [
						{ ...creditsPayload.credits[0] },
						{ ...creditsPayload.credits[0] },
					],
				});
			}
			if (url === USAGE_URL) return jsonResponse(usagePayload);
			if (url === CONSUME_URL) {
				return jsonResponse({ code: "ok", windows_reset: ["primary"] });
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;

		const parsed = JSON.parse(
			await execute({ action: "consume", confirm: true, format: "json" }),
		) as { availableCount: number; credits: Array<{ id: string }> };

		expect(parsed.availableCount).toBe(2);
		expect(parsed.credits).toHaveLength(0);
	});

	it("does not read usage before deciding whether to redeem", async () => {
		const fetchMock = mockCodexFetch();
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;

		await execute({ action: "consume" });

		// An unconfirmed consume never redeems, so it must not spend a round-trip
		// on the usage endpoint either.
		expect(callsTo(fetchMock, USAGE_URL)).toHaveLength(0);
		expect(callsTo(fetchMock, CONSUME_URL)).toHaveLength(0);
	});

	it("refuses to redeem an unavailable credit id", async () => {
		const fetchMock = mockCodexFetch();
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;

		const output = await execute({
			action: "consume",
			confirm: true,
			creditId: "RateLimitResetCredit_missing",
		});

		expect(callsTo(fetchMock, CONSUME_URL)).toHaveLength(0);
		expect(output).toContain("No available credit with id");
	});

	it("emits machine-readable status output", async () => {
		mockCodexFetch();
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;

		const parsed = JSON.parse(await execute({ format: "json" })) as {
			availableCount: number;
			credits: Array<{ id: string; isAvailable: boolean }>;
		};

		expect(parsed.availableCount).toBe(1);
		expect(parsed.credits[0]).toMatchObject({
			id: "RateLimitResetCredit_1",
			isAvailable: true,
		});
	});

	it("rejects an unknown action", async () => {
		mockCodexFetch();
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;

		await expect(execute({ action: "redeem" })).rejects.toThrow(
			/Invalid action "redeem"/,
		);
	});

	it("reports when no accounts are configured", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(null);
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;

		expect(await execute()).toContain("No Codex accounts configured");
	});
});
