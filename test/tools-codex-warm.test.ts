import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ToolContext } from "../lib/tools/index.js";
import {
	createCodexWarmTool,
	createWarmOne,
} from "../lib/tools/codex-warm.js";
import { resolveDisplayEmail } from "../lib/account-display.js";
import type { AccountStorageV3 } from "../lib/storage.js";

vi.mock("../lib/storage.js", () => ({
	loadAccounts: vi.fn(),
	getStoragePath: () => join(process.env.HOME ?? tmpdir(), "FAKE_WARM_POOL", "accounts.json"),
	withAccountStorageTransaction: vi.fn(),
}));

vi.mock("../lib/codex-usage.js", async (original) => ({
	...await original<typeof import("../lib/codex-usage.js")>(),
	fetchCodexUsage: vi.fn(async () => ({ rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18000 }, secondary_window: null } })),
	ensureCodexUsageAccessToken: vi.fn(async () => ({
		accessToken: "access-token",
		refreshed: false,
		persisted: false,
	})),
	resolveCodexUsageAccountId: vi.fn(() => "acct-123"),
}));

vi.mock("../lib/accounts/warm-request.js", () => ({
	warmAccountWindow: vi.fn(async () => ({ status: "opened", model: "gpt-5.5" })),
}));

import { loadAccounts, withAccountStorageTransaction } from "../lib/storage.js";
import {
	ensureCodexUsageAccessToken,
	resolveCodexUsageAccountId,
} from "../lib/codex-usage.js";
import { warmAccountWindow } from "../lib/accounts/warm-request.js";

function formatCommandAccountLabel(
	account: { email?: string } | undefined,
	index: number,
	options: { maskEmail?: boolean } = {},
): string {
	const email = resolveDisplayEmail(account?.email, options.maskEmail ?? false);
	return email ? `Account ${index + 1} (${email})` : `Account ${index + 1}`;
}

function buildCtx(): ToolContext {
	const ctx = {
		resolveUiRuntime: () => ({
			v2Enabled: false,
			colorProfile: "ansi16",
			glyphMode: "ascii",
			theme: undefined,
		}),
		resolveMaskEmail: () => false,
		formatCommandAccountLabel,
		getStatusMarker: (_ui: unknown, status: string) => `[${status}]`,
		cachedAccountManagerRef: { current: null },
		accountManagerPromiseRef: { current: null },
		invalidateAccountManagerCache: vi.fn(),
		reloadCachedAccountManager: vi.fn(),
	};
	return ctx as unknown as ToolContext;
}

const storageWith = (accounts: unknown[]): AccountStorageV3 =>
	({ version: 3, activeIndex: 0, accounts } as unknown as AccountStorageV3);

beforeEach(() => {
	vi.mocked(loadAccounts).mockReset();
	vi.mocked(withAccountStorageTransaction).mockReset();
	vi.mocked(withAccountStorageTransaction).mockResolvedValue(0);
	vi.mocked(ensureCodexUsageAccessToken).mockClear();
	vi.mocked(resolveCodexUsageAccountId).mockClear();
	vi.mocked(warmAccountWindow).mockClear();
	vi.mocked(ensureCodexUsageAccessToken).mockResolvedValue({
		accessToken: "access-token",
		refreshed: false,
		persisted: false,
	} as never);
	vi.mocked(resolveCodexUsageAccountId).mockReturnValue("acct-123");
	vi.mocked(warmAccountWindow).mockResolvedValue({ status: "opened", model: "gpt-5.5" } as never);
});

describe("codex-warm tool (#182)", () => {
	it("does not clear blocks when warm only confirms an active window through a transient 429", async () => {
		const blocked = { quotaExhaustedUntil: 1234, rateLimitResetTimes: { codex: 5678 } };
		const storage = storageWith([{ ...blocked, refreshToken: "rate-limited-refresh" }]);
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		const persist = vi.fn();
		vi.mocked(withAccountStorageTransaction).mockImplementation(async (callback) => callback(storage, persist));
		vi.mocked(warmAccountWindow).mockResolvedValue({ status: "opened", rateLimited: true });
		await createCodexWarmTool(buildCtx()).execute({}, {} as never);
		expect(storage.accounts[0]).toMatchObject(blocked);
		expect(persist).not.toHaveBeenCalled();
	});
	it("clears blocks only for successfully warmed enabled accounts", async () => {
		const blocked = { coolingDownUntil: 1234, cooldownReason: "auth-failure", quotaExhaustedUntil: 1234, rateLimitResetTimes: { codex: 5678 } };
		const storage = storageWith([0, 1, 2].map((index) => ({ ...blocked, refreshToken: `r${index}`, enabled: index !== 2 })));
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		const persist = vi.fn();
		vi.mocked(withAccountStorageTransaction).mockImplementation(async (callback) => callback(storage, persist));
		vi.mocked(warmAccountWindow).mockResolvedValueOnce({ status: "opened", model: "gpt-5.5" }).mockRejectedValueOnce(new Error("upstream failure"));
		const output = await createCodexWarmTool(buildCtx()).execute({}, {} as never);
		expect(storage.accounts[0]).toMatchObject({ rateLimitResetTimes: blocked.rateLimitResetTimes });
		expect(storage.accounts[0]?.quotaExhaustedUntil).toBeUndefined();
		expect(storage.accounts[0]?.coolingDownUntil).toBeUndefined();
		for (const account of storage.accounts.slice(1)) expect(account).toMatchObject(blocked);
		expect(persist).toHaveBeenCalledTimes(2);
		expect(output).toContain("1 blocks cleared");
	});

	it("preserves warmed JSON results when clearing blocks fails", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(storageWith([{ refreshToken: "private-refresh", enabled: true }]));
		vi.mocked(withAccountStorageTransaction).mockRejectedValue(new Error("private-refresh"));
		const output = await createCodexWarmTool(buildCtx()).execute({ format: "json" }, {} as never);
		expect(JSON.parse(typeof output === "string" ? output : output.output)).toMatchObject({ warmedCount: 1, failedCount: 0, blocksCleared: 0, blockClearError: expect.any(String) });
		expect(output).not.toContain("private-refresh");
	});
	it.each([
		["first cleanup fails", true],
		["second cleanup fails", false],
	])("continues independent recovery when %s", async (_label, firstFails) => {
		const blocked = { coolingDownUntil: 5678, cooldownReason: "rate-limit", rateLimitResetTimes: { codex: 9 } };
		const storage = storageWith([0, 1].map((index) => ({ ...blocked, refreshToken: `recovery-${index}` })));
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		const persist = vi.fn();
		const transaction = vi.mocked(withAccountStorageTransaction);
		if (firstFails) {
			transaction.mockRejectedValueOnce(new Error("private cleanup failure"));
			transaction.mockImplementationOnce(async (callback) => callback(storage, persist));
		} else {
			transaction.mockImplementationOnce(async (callback) => callback(storage, persist));
			transaction.mockRejectedValueOnce(new Error("private cleanup failure"));
		}
		vi.mocked(warmAccountWindow).mockResolvedValue({ status: "opened", model: "gpt-5.5" });
		const output = await createCodexWarmTool(buildCtx()).execute({ format: "json" }, {} as never);
		const payload = JSON.parse(typeof output === "string" ? output : output.output);
		expect(payload).toMatchObject({ warmedCount: 2, failedCount: 0, blocksCleared: 1 });
		expect(persist).toHaveBeenCalledTimes(1);
	});

	it("keeps a concurrently disabled account disabled while reconciling confirmed shared quota", async () => {
		const storage = storageWith([{ refreshToken: "disabled-later", quotaExhaustedUntil: 1234 }]);
		const current = storageWith([{ refreshToken: "disabled-later", enabled: false, quotaExhaustedUntil: 1234,
			rateLimitResetTimes: { codex: 5678 }, coolingDownUntil: 9999 }]);
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		const persist = vi.fn();
		vi.mocked(withAccountStorageTransaction).mockImplementation(async (callback) => callback(current, persist));
		await createCodexWarmTool(buildCtx()).execute({}, {} as never);
		expect(current.accounts[0]?.quotaExhaustedUntil).toBeUndefined();
		expect(current.accounts[0]).toMatchObject({ enabled: false, rateLimitResetTimes: { codex: 5678 }, coolingDownUntil: 9999 });
		expect(persist).toHaveBeenCalledOnce();
	});
	it("reports no accounts when storage is empty", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(null as never);
		const tool = createCodexWarmTool(buildCtx());
		const output = (await tool.execute({}, {} as never)) as string;
		expect(output).toContain("No Codex accounts configured");
		expect(warmAccountWindow).not.toHaveBeenCalled();
	});

	it("warms every enabled account and summarizes", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(
			storageWith([
				{ email: "a@example.com", refreshToken: "r1" },
				{ email: "b@example.com", refreshToken: "r2" },
			]) as never,
		);
		const tool = createCodexWarmTool(buildCtx());
		const output = (await tool.execute({}, {} as never)) as string;

		expect(warmAccountWindow).toHaveBeenCalledTimes(2);
		expect(output).toContain("a@example.com): Window started");
		expect(output).toContain("b@example.com): Window started");
		expect(output).toContain("Summary: 2 warmed, 0 failed, 0 skipped");
	});

	it("skips disabled accounts and never calls upstream for them", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(
			storageWith([
				{ email: "a@example.com", refreshToken: "r1" },
				{ email: "b@example.com", refreshToken: "r2", enabled: false },
			]) as never,
		);
		const tool = createCodexWarmTool(buildCtx());
		const output = (await tool.execute({}, {} as never)) as string;

		expect(warmAccountWindow).toHaveBeenCalledTimes(1);
		expect(output).toContain("b@example.com): Skipped (disabled)");
		expect(output).toContain("Summary: 1 warmed, 0 failed, 1 skipped");
	});

	it("records upstream failures without aborting the batch", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(
			storageWith([
				{ email: "a@example.com", refreshToken: "r1" },
				{ email: "b@example.com", refreshToken: "r2" },
			]) as never,
		);
		// Second account's upstream call throws.
		vi.mocked(warmAccountWindow)
			.mockResolvedValueOnce({ status: "opened" } as never)
			.mockRejectedValueOnce(new Error("429 too many requests"));

		const tool = createCodexWarmTool(buildCtx());
		const output = (await tool.execute({}, {} as never)) as string;

		expect(output).toMatch(/Failed - 429 too many requests/);
		expect(output).toContain("Summary: 1 warmed, 1 failed, 0 skipped");
	});
});

describe("createWarmOne adapter (#182)", () => {
	it("maps an exhausted (quota-429) account to failed, NOT warmed", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(
			storageWith([{ email: "a@example.com", refreshToken: "r1" }]) as never,
		);
		vi.mocked(warmAccountWindow).mockResolvedValue({
			status: "exhausted",
			detail: "quota/usage limit reached",
		} as never);
		const tool = createCodexWarmTool(buildCtx());
		const output = (await tool.execute({}, {} as never)) as string;
		expect(output).toMatch(/Failed - quota\/usage limit reached/);
		expect(output).toContain("Summary: 0 warmed, 1 failed, 0 skipped");
	});

	it("composes refresh -> resolve id -> warm and returns warmed", async () => {
		const storage = storageWith([]);
		const account = { email: "a@example.com", refreshToken: "r1" } as never;
		const warmOne = createWarmOne(storage);

		const outcome = await warmOne(account);

		expect(ensureCodexUsageAccessToken).toHaveBeenCalledWith({ storage, account });
		expect(resolveCodexUsageAccountId).toHaveBeenCalledWith({
			account,
			accessToken: "access-token",
		});
		expect(warmAccountWindow).toHaveBeenCalledWith({
			accountId: "acct-123",
			accessToken: "access-token",
			organizationId: undefined,
		});
		expect(outcome.status).toBe("warmed");
	});

	it("fails cleanly when the account id cannot be resolved", async () => {
		vi.mocked(resolveCodexUsageAccountId).mockReturnValueOnce(undefined as never);
		const warmOne = createWarmOne(storageWith([]));
		const outcome = await warmOne({ refreshToken: "r1" } as never);
		expect(outcome.status).toBe("failed");
		expect(outcome.detail).toMatch(/account id/i);
		expect(warmAccountWindow).not.toHaveBeenCalled();
	});
});
