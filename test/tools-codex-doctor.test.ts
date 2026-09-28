import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountManager } from "../lib/accounts.js";
import { MODEL_FAMILIES } from "../lib/prompts/codex.js";
import type { AccountMetadataV3, AccountStorageV3 } from "../lib/storage.js";
import {
	loadAccounts,
	withAccountStorageTransaction,
} from "../lib/storage.js";
import { clearTuiQuotaSnapshot } from "../lib/tui-quota-cache.js";
import { createCodexDoctorTool } from "../lib/tools/codex-doctor.js";
import { repairDoctorAccounts } from "../lib/tools/doctor-repair.js";
import type { ToolContext } from "../lib/tools/index.js";
import type { RuntimeMetrics } from "../lib/runtime.js";
import type {
	BeginnerAccountSnapshot,
	BeginnerRuntimeSnapshot,
} from "../lib/ui/beginner.js";
import type { UiRuntimeOptions } from "../lib/ui/runtime.js";

// Only the storage entry points the tool uses are replaced — the rest of the
// barrel (identity helpers, types re-exported through runtime.js) stays real.
vi.mock("../lib/storage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/storage.js")>();
	return {
		...actual,
		loadAccounts: vi.fn(),
		getStoragePath: vi.fn(() => "/tmp/codex-doctor-test/accounts.json"),
		withAccountStorageTransaction: vi.fn(),
	};
});

vi.mock("../lib/tools/doctor-repair.js", () => ({
	repairDoctorAccounts: vi.fn(),
}));

vi.mock("../lib/tui-quota-cache.js", () => ({
	clearTuiQuotaSnapshot: vi.fn(),
}));

// Keep the plugin-origin probe off the real filesystem.
vi.mock("../lib/plugin-origin.js", () => ({
	getPluginOrigin: vi.fn(() => null),
	describePluginOrigin: vi.fn(() => "test-origin"),
	findReplacedLocalCheckout: vi.fn(() => null),
	readPluginOriginHistory: vi.fn(() => []),
}));

function buildAccount(
	overrides: Partial<AccountMetadataV3> = {},
): AccountMetadataV3 {
	return {
		email: "user@example.com",
		accountId: "acct-default",
		refreshToken: "rt-default",
		addedAt: 1,
		lastUsed: 1,
		...overrides,
	};
}

const accountA = buildAccount({
	email: "a@example.com",
	accountId: "acct-a",
	refreshToken: "rt-a",
});
const accountB = buildAccount({
	email: "b@example.com",
	accountId: "acct-b",
	refreshToken: "rt-b",
});

function buildStorage(
	overrides: Partial<AccountStorageV3> = {},
): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		accounts: [accountA, accountB],
		...overrides,
	};
}

function buildRuntimeMetrics(): RuntimeMetrics {
	return {
		startedAt: Date.now() - 5000,
		totalRequests: 0,
		successfulRequests: 0,
		failedRequests: 0,
		rateLimitedResponses: 0,
		serverErrors: 0,
		networkErrors: 0,
		authRefreshFailures: 0,
		emptyResponseRetries: 0,
		accountRotations: 0,
		cumulativeLatencyMs: 0,
		retryBudgetExhaustions: 0,
		retryBudgetUsage: {
			authRefresh: 0,
			network: 0,
			server: 0,
			rateLimitShort: 0,
			rateLimitGlobal: 0,
			emptyResponse: 0,
		},
		retryBudgetLimits: {
			authRefresh: 3,
			network: 3,
			server: 3,
			rateLimitShort: 3,
			rateLimitGlobal: 3,
			emptyResponse: 3,
		},
		retryProfile: "standard",
		lastRetryBudgetExhaustedClass: null,
		lastRetryBudgetReason: null,
		lastRequestAt: null,
		lastError: null,
		lastErrorCategory: null,
		promptCacheEnabledRequests: 0,
		promptCacheMissingRequests: 0,
		lastPromptCacheKey: null,
		lastSelectedAccountIndex: null,
		lastQuotaKey: null,
		lastSelectionSnapshot: null,
	};
}

function buildBeginnerRuntime(): BeginnerRuntimeSnapshot {
	return {
		totalRequests: 0,
		failedRequests: 0,
		rateLimitedResponses: 0,
		authRefreshFailures: 0,
		serverErrors: 0,
		networkErrors: 0,
		lastErrorCategory: null,
		promptCacheEnabledRequests: 0,
		promptCacheMissingRequests: 0,
		lastPromptCacheKey: null,
	};
}

function toSnapshots(
	storage: AccountStorageV3,
	activeIndex: number,
): BeginnerAccountSnapshot[] {
	return storage.accounts.map((account, index) => ({
		index,
		label: account.accountLabel ?? `account-${index + 1}`,
		accountLabel: account.accountLabel,
		enabled: account.enabled !== false,
		isActive: index === activeIndex,
		rateLimitedUntil: null,
		coolingDownUntil: null,
	}));
}

interface CtxHandle {
	ctx: ToolContext;
	reloadCachedAccountManager: ReturnType<typeof vi.fn>;
}

function buildCtx(): CtxHandle {
	const reloadCachedAccountManager = vi.fn(async () => {});
	const ctx = {
		resolveUiRuntime: () =>
			({ v2Enabled: false }) as unknown as UiRuntimeOptions,
		resolveActiveIndex: (storage: { activeIndex: number }) =>
			storage.activeIndex,
		toBeginnerAccountSnapshots: (
			storage: AccountStorageV3,
			activeIndex: number,
			_now: number,
		) => toSnapshots(storage, activeIndex),
		getBeginnerRuntimeSnapshot: () => buildBeginnerRuntime(),
		buildRoutingVisibilitySnapshot: () => null,
		appendRoutingVisibilityText: vi.fn(),
		appendRoutingVisibilityUi: vi.fn(),
		formatDoctorSeverity: (_ui: UiRuntimeOptions, severity: string) =>
			`[${severity}]`,
		formatDoctorSeverityText: (severity: string) => `[${severity}]`,
		runtimeMetrics: buildRuntimeMetrics(),
		cachedAccountManagerRef: { current: null },
		reloadCachedAccountManager,
	};
	return { ctx: ctx as unknown as ToolContext, reloadCachedAccountManager };
}

interface ExplainabilityEntry {
	index: number;
	eligible: boolean;
	healthScore: number;
	tokensAvailable: number;
}

function buildManager(options: {
	explainability: ExplainabilityEntry[];
	accounts: AccountMetadataV3[];
}) {
	return {
		getSelectionExplainability: vi.fn(() =>
			options.explainability.map((entry) => ({
				index: entry.index,
				enabled: true,
				isCurrentForFamily: false,
				eligible: entry.eligible,
				reasons: [],
				healthScore: entry.healthScore,
				tokensAvailable: entry.tokensAvailable,
				lastUsed: 1,
			})),
		),
		getAccountsSnapshot: vi.fn(() => options.accounts),
	} as unknown as AccountManager;
}

/** Storage the transaction handler sees — replaced per test as needed. */
let txCurrent: AccountStorageV3 | null;
let persisted: AccountStorageV3[];

beforeEach(() => {
	vi.clearAllMocks();
	txCurrent = buildStorage();
	persisted = [];
	vi.mocked(loadAccounts).mockResolvedValue(buildStorage());
	vi.mocked(withAccountStorageTransaction).mockImplementation(
		async (handler) =>
			handler(txCurrent, async (storage) => {
				persisted.push(storage);
			}),
	);
	vi.mocked(repairDoctorAccounts).mockResolvedValue({
		refreshedCount: 1,
		verificationFailureIdentities: [],
		reloginNeeded: [],
		appliedFixes: ["Refreshed and persisted 1 account token(s)."],
		fixErrors: [],
	});
	vi.mocked(clearTuiQuotaSnapshot).mockResolvedValue(undefined);
	vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(
		buildManager({
			explainability: [
				{ index: 0, eligible: true, healthScore: 50, tokensAvailable: 10 },
				{ index: 1, eligible: true, healthScore: 90, tokensAvailable: 20 },
			],
			accounts: [accountA, accountB],
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("codex-doctor tool — fix flow", () => {
	it("refreshes, clears the stale quota cache, switches to the best account and reloads", async () => {
		const { ctx, reloadCachedAccountManager } = buildCtx();
		const tool = createCodexDoctorTool(ctx);

		const output = (await tool.execute({ fix: true }, {} as never)) as string;

		expect(repairDoctorAccounts).toHaveBeenCalledTimes(1);
		expect(clearTuiQuotaSnapshot).toHaveBeenCalledTimes(1);
		// The transaction mutated and persisted the storage object.
		expect(persisted).toHaveLength(1);
		const written = persisted[0];
		expect(written?.activeIndex).toBe(1);
		for (const family of MODEL_FAMILIES) {
			expect(written?.activeIndexByFamily?.[family]).toBe(1);
		}
		expect(reloadCachedAccountManager).toHaveBeenCalledTimes(1);
		expect(output).toContain("Switched active account to 2 (best eligible).");
		expect(output).toContain("Cleared stale TUI quota cache.");
		// Diagnostics are reloaded after fixes so health matches live results.
		expect(loadAccounts.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("does not mutate anything when fix is omitted", async () => {
		const { ctx, reloadCachedAccountManager } = buildCtx();
		const tool = createCodexDoctorTool(ctx);

		await tool.execute({}, {} as never);

		expect(repairDoctorAccounts).not.toHaveBeenCalled();
		expect(withAccountStorageTransaction).not.toHaveBeenCalled();
		expect(clearTuiQuotaSnapshot).not.toHaveBeenCalled();
		expect(reloadCachedAccountManager).not.toHaveBeenCalled();
	});

	it("reports a race when the best account disappears inside the transaction", async () => {
		txCurrent = buildStorage({ accounts: [accountA] });
		const { ctx } = buildCtx();
		const tool = createCodexDoctorTool(ctx);

		const output = (await tool.execute({ fix: true }, {} as never)) as string;

		expect(persisted).toHaveLength(0);
		expect(output).toContain(
			"Selected account changed during auto-switch; no switch was applied.",
		);
	});

	it("leaves the active index alone when the best account is already active", async () => {
		txCurrent = buildStorage({ activeIndex: 1 });
		const { ctx } = buildCtx();
		const tool = createCodexDoctorTool(ctx);

		const output = (await tool.execute({ fix: true }, {} as never)) as string;

		expect(persisted).toHaveLength(0);
		expect(output).not.toContain("Switched active account");
		expect(output).not.toContain("no switch was applied");
	});

	it("reports 'no eligible account' when explainability marks everything ineligible", async () => {
		vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(
			buildManager({
				explainability: [
					{ index: 0, eligible: false, healthScore: 10, tokensAvailable: 0 },
					{ index: 1, eligible: false, healthScore: 5, tokensAvailable: 0 },
				],
				accounts: [accountA, accountB],
			}),
		);
		const { ctx } = buildCtx();
		const tool = createCodexDoctorTool(ctx);

		const output = (await tool.execute({ fix: true }, {} as never)) as string;

		expect(withAccountStorageTransaction).not.toHaveBeenCalled();
		expect(output).toContain(
			"No eligible account available for auto-switch.",
		);
	});

	it("surfaces a quota-cache clear failure as a warning, not a throw", async () => {
		vi.mocked(clearTuiQuotaSnapshot).mockRejectedValue(
			new Error("EBUSY: resource busy or locked"),
		);
		const { ctx } = buildCtx();
		const tool = createCodexDoctorTool(ctx);

		const output = (await tool.execute({ fix: true }, {} as never)) as string;

		expect(output).toContain(
			"Failed to clear TUI quota cache: EBUSY: resource busy or locked",
		);
		// The rest of the fix pipeline still ran to completion.
		expect(output).toContain("Switched active account to 2 (best eligible).");
	});

	it("skips the quota-cache clear when nothing was refreshed", async () => {
		vi.mocked(repairDoctorAccounts).mockResolvedValue({
			refreshedCount: 0,
			verificationFailureIdentities: [],
			reloginNeeded: [],
			appliedFixes: [],
			fixErrors: [],
		});
		const { ctx } = buildCtx();
		const tool = createCodexDoctorTool(ctx);

		await tool.execute({ fix: true }, {} as never);

		expect(clearTuiQuotaSnapshot).not.toHaveBeenCalled();
	});

	it("reports refresh verification failures as findings plus a re-login error", async () => {
		vi.mocked(repairDoctorAccounts).mockResolvedValue({
			refreshedCount: 0,
			verificationFailureIdentities: [
				{ accountId: "acct-a", refreshToken: "rt-a" },
			],
			reloginNeeded: [1],
			appliedFixes: [],
			fixErrors: [
				"Account 1: refresh verification or credential persistence failed — run `opencode auth login` to re-authenticate.",
			],
		});
		const { ctx } = buildCtx();
		const tool = createCodexDoctorTool(ctx);

		const output = (await tool.execute({ fix: true }, {} as never)) as string;

		expect(output).toContain(
			"account(s) failed refresh-token verification",
		);
		expect(output).toContain("account(s) need re-login");
	});

	it("surfaces an auto-switch evaluation failure without throwing", async () => {
		vi.spyOn(AccountManager, "loadFromDisk").mockRejectedValue(
			new Error("corrupt storage"),
		);
		const { ctx } = buildCtx();
		const tool = createCodexDoctorTool(ctx);

		const output = (await tool.execute({ fix: true }, {} as never)) as string;

		expect(output).toContain(
			"Auto-switch evaluation failed: corrupt storage",
		);
	});

	it("exposes the autoFix payload under format=json", async () => {
		const { ctx } = buildCtx();
		const tool = createCodexDoctorTool(ctx);

		const raw = (await tool.execute(
			{ fix: true, format: "json" },
			{} as never,
		)) as string;
		const parsed = JSON.parse(raw) as {
			autoFix: { appliedFixes: string[]; errors: string[] } | null;
		};

		expect(parsed.autoFix).not.toBeNull();
		expect(parsed.autoFix?.appliedFixes).toContain(
			"Cleared stale TUI quota cache.",
		);
		expect(parsed.autoFix?.appliedFixes).toContain(
			"Switched active account to 2 (best eligible).",
		);
		expect(parsed.autoFix?.errors).toEqual([]);
	});

	it("sets autoFix to null in JSON output when fix is not requested", async () => {
		const { ctx } = buildCtx();
		const tool = createCodexDoctorTool(ctx);

		const raw = (await tool.execute(
			{ format: "json" },
			{} as never,
		)) as string;
		const parsed = JSON.parse(raw) as { autoFix: unknown };

		expect(parsed.autoFix).toBeNull();
	});
});
