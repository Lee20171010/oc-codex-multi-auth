import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountStorageV3 } from "../lib/storage.js";
import type { ToolContext } from "../lib/tools/index.js";
import { createCodexPoolTool } from "../lib/tools/codex-pool.js";

vi.mock("../lib/storage.js", () => ({
	loadAccounts: vi.fn(),
}));

vi.mock("../lib/config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/config.js")>();
	return {
		...actual,
		getModelAccountPoolMode: vi.fn((config, model) =>
			config.modelAccountPoolModes?.[model] ?? "preferred",
		),
		loadPluginConfig: vi.fn(),
		updateModelAccountPool: vi.fn(),
	};
});

import { loadPluginConfig, updateModelAccountPool } from "../lib/config.js";
import { ConfigLockContentionError } from "../lib/errors.js";
import { loadAccounts } from "../lib/storage.js";

const storage: AccountStorageV3 = {
	version: 3,
	activeIndex: 0,
	accounts: [
		{
			email: "one@example.com",
			accountId: "account-one",
			accountLabel: "Primary",
			refreshToken: "refresh-one",
			addedAt: 1,
			lastUsed: 1,
		},
		{
			email: "two@example.com",
			accountId: "account-two",
			refreshToken: "refresh-two",
			addedAt: 2,
			lastUsed: 2,
			enabled: false,
		},
	],
};

const businessStorage: AccountStorageV3 = {
	version: 3,
	activeIndex: 0,
	accounts: [
		{
			email: "owner@example.com",
			accountId: "business-account",
			accountUserId: "member-owner",
			refreshToken: "refresh-owner",
			addedAt: 1,
			lastUsed: 1,
		},
		{
			email: "member@example.com",
			accountId: "business-account",
			accountUserId: "member-invited",
			refreshToken: "refresh-invited",
			addedAt: 2,
			lastUsed: 2,
		},
	],
};

function buildCtx(): ToolContext {
	return {
		resolveMaskEmail: () => true,
		formatCommandAccountLabel: (account, index) =>
			`Account ${index + 1}${account?.accountLabel ? ` (${account.accountLabel})` : ""}`,
		buildJsonAccountIdentity: (index, options) => ({
			index: index + 1,
			zeroBasedIndex: index,
			...(options?.includeSensitive
				? { accountId: options.account?.accountId ?? null }
				: {}),
		}),
	} satisfies Pick<
		ToolContext,
		"resolveMaskEmail" | "formatCommandAccountLabel" | "buildJsonAccountIdentity"
	> as unknown as ToolContext;
}

describe("codex-pool tool", () => {
	beforeEach(() => {
		vi.mocked(loadAccounts).mockReset();
		vi.mocked(loadPluginConfig).mockReset();
		vi.mocked(updateModelAccountPool).mockReset();
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		vi.mocked(loadPluginConfig).mockReturnValue({
			modelAccountPools: {
				"gpt-5.6-sol": ["account-one", "missing-account"],
			},
			modelAccountPoolModes: { "gpt-5.6-sol": "strict" },
		});
	});

	it("reports configured and unresolved accounts without exposing IDs", async () => {
		const output = await createCodexPoolTool(buildCtx()).execute(
			{ action: "status", format: "json" },
			{} as never,
		);
		const parsed = JSON.parse(output as string) as {
			pools: Array<{
				configuredCount: number;
				poolMode: string;
				accounts: Array<Record<string, unknown>>;
				unresolvedCount: number;
				unresolvedAccountIds?: string[];
			}>;
		};

		expect(parsed.pools[0]).toMatchObject({
			configuredCount: 2,
			poolMode: "strict",
			unresolvedCount: 1,
		});
		expect(parsed.pools[0]?.accounts[0]).toMatchObject({ index: 1 });
		expect(parsed.pools[0]?.accounts[0]).not.toHaveProperty("accountId");
		expect(parsed.pools[0]).not.toHaveProperty("unresolvedAccountIds");
	});

	it("includes stable IDs only when sensitive JSON is requested", async () => {
		const output = await createCodexPoolTool(buildCtx()).execute(
			{ format: "json", includeSensitive: true },
			{} as never,
		);
		const parsed = JSON.parse(output as string) as {
			pools: Array<{
				accounts: Array<Record<string, unknown>>;
				unresolvedAccountIds: string[];
			}>;
		};

		expect(parsed.pools[0]?.accounts[0]).toMatchObject({
			accountId: "account-one",
		});
		expect(parsed.pools[0]?.unresolvedAccountIds).toEqual(["missing-account"]);
	});

	it("resolves unique 1-based account numbers to stable IDs", async () => {
		vi.mocked(updateModelAccountPool).mockResolvedValue({
			model: "gpt-5.6-sol",
			previousAccountIds: [],
			accountIds: ["account-two", "account-one"],
			previousPoolMode: "preferred",
			poolMode: "preferred",
			changed: true,
			dryRun: false,
		});

		const output = await createCodexPoolTool(buildCtx()).execute(
			{
				action: "set",
				model: " GPT-5.6-SOL ",
				accounts: [2, 1, 2],
			},
			{} as never,
		);

		expect(updateModelAccountPool).toHaveBeenCalledWith(
			"gpt-5.6-sol",
			"set",
			["account-two", "account-one"],
			{ dryRun: undefined, poolMode: undefined },
		);
		// Pools hot-reload per request via loadPluginConfig(), so the message
		// points at the next request rather than a restart.
		expect(output).toContain("next request");
		expect(output).not.toContain("Restart OpenCode");
	});

	it("persists distinct keys for Business seats in one workspace", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(businessStorage);
		vi.mocked(updateModelAccountPool).mockResolvedValue({
			model: "gpt-5.6-sol",
			previousAccountIds: [],
			accountIds: [
				'seat:["business-account","member-owner"]',
				'seat:["business-account","member-invited"]',
			],
			changed: true,
			dryRun: false,
		});

		await createCodexPoolTool(buildCtx()).execute(
			{ action: "set", model: "gpt-5.6-sol", accounts: [1, 2] },
			{} as never,
		);

		expect(updateModelAccountPool).toHaveBeenCalledWith(
			"gpt-5.6-sol",
			"set",
			[
				'seat:["business-account","member-owner"]',
				'seat:["business-account","member-invited"]',
			],
			{ dryRun: undefined },
		);
	});

	it("shows every Business seat matched by a legacy workspace ID", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(businessStorage);
		vi.mocked(loadPluginConfig).mockReturnValue({
			modelAccountPools: { "gpt-5.6-sol": ["business-account"] },
		});

		const output = await createCodexPoolTool(buildCtx()).execute(
			{ action: "status", format: "json" },
			{} as never,
		);
		const parsed = JSON.parse(output as string) as {
			pools: Array<{ accounts: Array<{ index: number }> }>;
		};

		expect(parsed.pools[0]?.accounts.map((account) => account.index)).toEqual([1, 2]);
	});

	it("passes dry runs through without requesting a restart", async () => {
		vi.mocked(updateModelAccountPool).mockResolvedValue({
			model: "gpt-5.6-sol",
			previousAccountIds: ["account-one"],
			accountIds: ["account-one", "account-two"],
			previousPoolMode: "preferred",
			poolMode: "preferred",
			changed: true,
			dryRun: true,
		});

		const output = await createCodexPoolTool(buildCtx()).execute(
			{
				action: "add",
				model: "gpt-5.6-sol",
				accounts: [2],
				dryRun: true,
			},
			{} as never,
		);

		expect(updateModelAccountPool).toHaveBeenCalledWith(
			"gpt-5.6-sol",
			"add",
			["account-two"],
			expect.objectContaining({ dryRun: true, poolMode: undefined }),
		);
		const options = vi.mocked(updateModelAccountPool).mock.calls[0]?.[3];
		expect(options?.normalizeExistingAccountIds?.(["account-one"])).toEqual([
			"account-one",
		]);
		expect(output).not.toContain("Restart OpenCode");
		expect(output).not.toContain("next request");
	});

	it("clears a pool without requiring account storage", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(null);
		vi.mocked(updateModelAccountPool).mockResolvedValue({
			model: "gpt-5.6-sol",
			previousAccountIds: ["account-one"],
			accountIds: [],
			previousPoolMode: "strict",
			poolMode: "preferred",
			changed: true,
			dryRun: false,
		});

		await createCodexPoolTool(buildCtx()).execute(
			{ action: "clear", model: "gpt-5.6-sol" },
			{} as never,
		);

		expect(updateModelAccountPool).toHaveBeenCalledWith(
			"gpt-5.6-sol",
			"clear",
			[],
			{ dryRun: undefined, poolMode: undefined },
		);
	});

	it("switches an existing pool between preferred and strict", async () => {
		vi.mocked(updateModelAccountPool).mockResolvedValue({
			model: "gpt-5.6-sol",
			previousAccountIds: ["account-one"],
			accountIds: ["account-one"],
			previousPoolMode: "preferred",
			poolMode: "strict",
			changed: true,
			dryRun: false,
		});

		const output = await createCodexPoolTool(buildCtx()).execute(
			{
				action: "set-mode",
				model: "gpt-5.6-sol",
				poolMode: "strict",
			},
			{} as never,
		);

		expect(updateModelAccountPool).toHaveBeenCalledWith(
			"gpt-5.6-sol",
			"set-mode",
			[],
			{ dryRun: undefined, poolMode: "strict" },
		);
		expect(output).toContain("Pool mode: strict");
	});

	it("rejects invalid account numbers before writing", async () => {
		await expect(
			createCodexPoolTool(buildCtx()).execute(
				{ action: "remove", model: "gpt-5.6-sol", accounts: [3] },
				{} as never,
			),
		).rejects.toThrow("Expected 1-2");
		expect(updateModelAccountPool).not.toHaveBeenCalled();
	});

	it("rejects accounts that do not have a stable ID", async () => {
		vi.mocked(loadAccounts).mockResolvedValue({
			...storage,
			accounts: [{ ...storage.accounts[0], accountId: undefined }],
		});

		await expect(
			createCodexPoolTool(buildCtx()).execute(
				{ action: "set", model: "gpt-5.6-sol", accounts: [1] },
				{} as never,
			),
		).rejects.toThrow("has no stable account ID");
	});

	it("returns retry guidance when configuration lock acquisition is exhausted", async () => {
		vi.mocked(updateModelAccountPool).mockRejectedValue(
			new ConfigLockContentionError("/tmp/config.json"),
		);

		const output = await createCodexPoolTool(buildCtx()).execute(
			{ action: "set", model: "gpt-5.6-sol", accounts: [1] },
			{} as never,
		);

		expect(output).toContain("locked by another process");
		expect(output).toContain("No change was made");
	});

	it("returns structured retryable lock contention in JSON", async () => {
		vi.mocked(updateModelAccountPool).mockRejectedValue(
			new ConfigLockContentionError("/tmp/config.json"),
		);

		const output = await createCodexPoolTool(buildCtx()).execute(
			{
				action: "set",
				model: "gpt-5.6-sol",
				accounts: [1],
				format: "json",
			},
			{} as never,
		);
		const parsed = JSON.parse(output as string) as Record<string, unknown>;

		expect(parsed).toMatchObject({
			action: "set",
			model: "gpt-5.6-sol",
			changed: false,
			applied: false,
			dryRun: false,
			restartRequired: false,
			// Nothing was mutated, so the payload reports the pool still on disk.
			previousConfiguredCount: 2,
			previousPoolMode: "strict",
			// Same token as the class name and the ErrorCode used in logs, so a
			// caller that greps for what it saw in tool JSON finds something.
			error: "CODEX_CONFIG_LOCK_CONTENTION",
			retryable: true,
		});
		expect(parsed.pool).toMatchObject({ poolMode: "strict" });
	});

	// ---------- finding 4: the degrade path must not break strict consumers ----------
	it("keeps the contention payload shape identical to a successful mutation", async () => {
		vi.mocked(updateModelAccountPool).mockResolvedValue({
			model: "gpt-5.6-sol",
			accountIds: ["account-one"],
			changed: true,
			dryRun: false,
			previousAccountIds: ["account-one", "missing-account"],
			previousPoolMode: "strict",
			poolMode: "strict",
		});
		const okPayload = JSON.parse(
			(await createCodexPoolTool(buildCtx()).execute(
				{ action: "set", model: "gpt-5.6-sol", accounts: [1], format: "json" },
				{} as never,
			)) as string,
		) as Record<string, unknown>;

		// An applied mutation hot-reloads on the next request, so the wire
		// field reports false rather than asking for a restart.
		expect(okPayload.applied).toBe(true);
		expect(okPayload.restartRequired).toBe(false);

		vi.mocked(updateModelAccountPool).mockRejectedValue(
			new ConfigLockContentionError("/tmp/config.json"),
		);
		const lockedPayload = JSON.parse(
			(await createCodexPoolTool(buildCtx()).execute(
				{ action: "set", model: "gpt-5.6-sol", accounts: [1], format: "json" },
				{} as never,
			)) as string,
		) as Record<string, unknown>;

		// A consumer reading parsed.pool.accounts must not start throwing just
		// because the tool degraded.
		expect(Object.keys(lockedPayload)).toEqual(
			expect.arrayContaining(Object.keys(okPayload)),
		);
		expect(Array.isArray((lockedPayload.pool as { accounts?: unknown }).accounts)).toBe(
			true,
		);
	});

	it("rethrows non-contention persistence failures", async () => {
		vi.mocked(updateModelAccountPool).mockRejectedValue(new Error("disk failed"));

		await expect(
			createCodexPoolTool(buildCtx()).execute(
				{ action: "set", model: "gpt-5.6-sol", accounts: [1] },
				{} as never,
			),
		).rejects.toThrow("disk failed");
	});
});
