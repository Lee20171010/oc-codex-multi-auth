import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolContext } from "../lib/tools/index.js";
import type { AccountStorageV3 } from "../lib/storage.js";
import { createCodexDiffTool } from "../lib/tools/codex-diff.js";
import { createCodexHealthTool } from "../lib/tools/codex-health.js";
import { createCodexListTool } from "../lib/tools/codex-list.js";
import { createCodexStatusTool } from "../lib/tools/codex-status.js";
import { createCodexWarmTool } from "../lib/tools/codex-warm.js";
import { resolveDisplayEmail } from "../lib/account-display.js";
import { createUiTheme } from "../lib/ui/theme.js";

vi.mock("../lib/storage.js", () => ({
	loadAccounts: vi.fn(),
	getStoragePath: vi.fn(() => "/tmp/accounts.json"),
}));

vi.mock("../lib/accounts/warm.js", () => ({
	warmAccounts: vi.fn(async (accounts: Array<{ enabled?: boolean }>) => ({
		results: accounts.map((account, index) => ({
			account,
			index,
			status: "warmed",
			detail: undefined,
		})),
		total: accounts.length,
		warmedCount: accounts.length,
		failedCount: 0,
		skippedCount: 0,
	})),
}));

import { loadAccounts } from "../lib/storage.js";

const TOOL_CONTEXT = {} as never;

function formatCommandAccountLabel(
	account: { email?: string; accountLabel?: string } | undefined,
	index: number,
	options: { maskEmail?: boolean } = {},
): string {
	const email = resolveDisplayEmail(account?.email, options.maskEmail ?? false);
	const label = account?.accountLabel?.trim();
	const details = [label, email].filter(Boolean);
	if (details.length === 0) return `Account ${index + 1}`;
	return `Account ${index + 1} (${details.join(", ")})`;
}

function buildCtx(overrides: Record<string, unknown> = {}): ToolContext {
	const ctx = {
		resolveUiRuntime: () => ({
			v2Enabled: false,
			colorProfile: "ansi16",
			glyphMode: "ascii",
			theme: createUiTheme({ profile: "ansi16", glyphMode: "ascii" }),
		}),
		resolveMaskEmail: () => false,
		resolveActiveIndex: () => 0,
		formatCommandAccountLabel,
		formatRateLimitEntry: () => null,
		formatQuotaExhaustionEntry: () => null,
		getRateLimitResetTimeForFamily: () => null,
		getStatusMarker: (_ui: unknown, status: string) => `[${status}]`,
		buildJsonAccountIdentity: (
			index: number,
			opts: { includeSensitive?: boolean; account?: { email?: string } } = {},
		) => ({
			index: index + 1,
			zeroBasedIndex: index,
			...(opts.includeSensitive
				? { email: opts.account?.email ?? null }
				: {}),
		}),
		buildRoutingVisibilitySnapshot: () => ({
			modelFamily: "codex",
			effectiveModel: null,
		}),
		appendRoutingVisibilityText: () => {},
		appendRoutingVisibilityUi: () => {},
		toBeginnerAccountSnapshots: () => [],
		getBeginnerRuntimeSnapshot: () => ({}),
		runtimeMetrics: {
			startedAt: 0,
			totalRequests: 0,
			successfulRequests: 0,
			cumulativeLatencyMs: 0,
			lastRequestAt: null,
			lastError: null,
			lastErrorCategory: null,
			lastSelectedAccountIndex: null,
			retryProfile: null,
			retryBudgetUsage: {},
		},
		cachedAccountManagerRef: { current: null },
		accountManagerPromiseRef: { current: null },
		invalidateAccountManagerCache: vi.fn(),
		reloadCachedAccountManager: vi.fn(),
		...overrides,
	};
	return ctx as unknown as ToolContext;
}

const ACCOUNT = {
	email: "alice@example.com",
	refreshToken: "r1",
	addedAt: 1,
	lastUsed: 1,
};

function storageWith(accounts: Array<Record<string, unknown>>): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		accounts: accounts as AccountStorageV3["accounts"],
	};
}

beforeEach(() => {
	vi.mocked(loadAccounts).mockReset();
});

describe("codex-diff contract", () => {
	it("rejects an invalid section through the shared JSON envelope", async () => {
		const tool = createCodexDiffTool(buildCtx());
		const output = (await tool.execute(
			{ left: "a.json", right: "b.json", section: "bogus" } as never,
			TOOL_CONTEXT,
		)) as string;
		const parsed = JSON.parse(output) as Record<string, unknown>;

		expect(parsed).toMatchObject({
			ok: false,
			tool: "codex-diff",
			error: "CODEX_VALIDATION_ERROR",
			retryable: false,
		});
		expect(parsed.message).toContain("section");
	});

	it("tags read failures with ok:false and the tool id", async () => {
		const tool = createCodexDiffTool(buildCtx());
		const output = (await tool.execute(
			{
				left: "/definitely/missing-left.json",
				right: "/definitely/missing-right.json",
			},
			TOOL_CONTEXT,
		)) as string;
		const parsed = JSON.parse(output) as Record<string, unknown>;

		expect(parsed).toMatchObject({
			ok: false,
			tool: "codex-diff",
			error: "cannot-read",
			side: "left",
		});
		expect(parsed.path).toBe("/definitely/missing-left.json");
	});
});

describe("codex-health contract", () => {
	it("emits all five *Slots arrays on the empty-store path", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(null);
		const tool = createCodexHealthTool(buildCtx());
		const parsed = JSON.parse(
			(await tool.execute({ format: "json" }, TOOL_CONTEXT)) as string,
		) as Record<string, unknown>;

		for (const key of [
			"staleRecoverableSlots",
			"quotaExhaustedSlots",
			"disabledDuplicateSlots",
			"businessMemberConflictSlots",
			"disabledWithFreshCredentialSlots",
		]) {
			expect(parsed[key], key).toEqual([]);
		}
	});
});

describe("codex-status contract", () => {
	it("emits pluginOrigin and selectionView on the empty-store path", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(null);
		const tool = createCodexStatusTool(buildCtx());
		const parsed = JSON.parse(
			(await tool.execute({ format: "json" }, TOOL_CONTEXT)) as string,
		) as Record<string, unknown>;

		expect(parsed).toHaveProperty("pluginOrigin");
		expect(parsed.selectionView).toMatchObject({
			modelFamily: "codex",
			effectiveModel: null,
			label: "codex",
		});
	});

	it("keeps pluginOrigin and selectionView on the populated path with the root redacted", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(storageWith([ACCOUNT]));
		const tool = createCodexStatusTool(buildCtx());
		const parsed = JSON.parse(
			(await tool.execute({ format: "json" }, TOOL_CONTEXT)) as string,
		) as {
			pluginOrigin: { root?: string } | null;
			selectionView: { modelFamily: string; label: string };
		};

		expect(parsed).toHaveProperty("pluginOrigin");
		expect(parsed.selectionView.modelFamily).toBe("codex");
		if (parsed.pluginOrigin) {
			expect(parsed.pluginOrigin.root).not.toContain("home");
			expect(parsed.pluginOrigin.root).not.toContain("neil");
		}
	});
});

describe("codex-list contract", () => {
	it("reports the full pool in totalAccounts and the filtered count in shownAccounts", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(
			storageWith([
				{ ...ACCOUNT, accountTags: ["work"] },
				{ ...ACCOUNT, email: "bob@example.com", accountTags: ["personal"] },
			]),
		);
		const tool = createCodexListTool(buildCtx());
		const parsed = JSON.parse(
			(await tool.execute(
				{ format: "json", tag: "work" },
				TOOL_CONTEXT,
			)) as string,
		) as Record<string, unknown>;

		expect(parsed.totalAccounts).toBe(2);
		expect(parsed.shownAccounts).toBe(1);
		expect(parsed.totalStoredAccounts).toBe(2);
		expect((parsed.accounts as unknown[]).length).toBe(1);
	});

	it("keeps the count fields stable when the filter matches nothing", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(storageWith([ACCOUNT]));
		const tool = createCodexListTool(buildCtx());
		const parsed = JSON.parse(
			(await tool.execute(
				{ format: "json", tag: "missing" },
				TOOL_CONTEXT,
			)) as string,
		) as Record<string, unknown>;

		expect(parsed.totalAccounts).toBe(1);
		expect(parsed.shownAccounts).toBe(0);
		expect(parsed.totalStoredAccounts).toBe(1);
	});
});

describe("codex-warm contract", () => {
	it("emits 1-based index and explicit zeroBasedIndex per result", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(
			storageWith([ACCOUNT, { ...ACCOUNT, refreshToken: "r2" }]),
		);
		const tool = createCodexWarmTool(buildCtx());
		const parsed = JSON.parse(
			(await tool.execute({ format: "json" }, TOOL_CONTEXT)) as string,
		) as {
			results: Array<{ index: number; zeroBasedIndex: number }>;
			blockClearError: string | null;
		};

		expect(parsed.results.map((r) => r.index)).toEqual([1, 2]);
		expect(parsed.results.map((r) => r.zeroBasedIndex)).toEqual([0, 1]);
		expect(parsed.blockClearError).toBeNull();
	});
});
