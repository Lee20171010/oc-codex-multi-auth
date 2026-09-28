/** `codex-pool` tool - manage model-specific account pools by account number. */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import {
	getModelAccountPoolMode,
	loadPluginConfig,
	type ModelAccountPoolMode,
	type ModelAccountPoolMutationResult,
	updateModelAccountPool,
	type ModelAccountPoolMutation,
} from "../config.js";
import { ConfigLockContentionError, ErrorCode } from "../errors.js";
import { logWarn } from "../logger.js";
import { normalizeToolOutputFormat, renderJsonOutput } from "../runtime.js";
import { loadAccounts, type AccountStorageV3 } from "../storage.js";
import {
	expandLegacyModelPoolKeys,
	getModelPoolAccountKey,
	isSeatPoolKey,
	matchesModelPoolAccountKey,
} from "../accounts/pool-identity.js";
import { getCurrentProjectRoot, getCurrentStoragePath } from "../storage/state.js";
import {
	TOOL_OUTPUT_FORMAT_DESCRIPTION,
	TOOL_OUTPUT_FORMAT_VALUES,
} from "./args.js";
import type { ToolContext } from "./index.js";

type CodexPoolAction = "status" | ModelAccountPoolMutation;

type CodexPoolArgs = {
	action?: string;
	model?: string;
	accounts?: number[];
	dryRun?: boolean;
	poolMode?: string;
	format?: string;
	includeSensitive?: boolean;
};

function normalizePoolAction(action?: string): CodexPoolAction {
	if (action === undefined || action === "status") return "status";
	if (
		action === "set" ||
		action === "add" ||
		action === "remove" ||
		action === "clear" ||
		action === "set-mode"
	) {
		return action;
	}
	throw new Error(
		`Invalid action "${action}". Expected "status", "set", "add", "remove", "clear", or "set-mode".`,
	);
}

function normalizePoolMode(mode?: string): ModelAccountPoolMode | undefined {
	const normalized = mode?.trim().toLowerCase();
	if (!normalized) return undefined;
	if (normalized === "preferred" || normalized === "strict") return normalized;
	throw new Error(
		`Invalid pool mode "${mode}". Expected "preferred" or "strict".`,
	);
}

function normalizeModel(model?: string): string | undefined {
	const normalized = model?.trim().toLowerCase();
	return normalized || undefined;
}

function resolveAccountIds(
	storage: AccountStorageV3 | null,
	accountNumbers: readonly number[] | undefined,
): string[] {
	if (!accountNumbers?.length) {
		throw new Error("At least one account number is required.");
	}
	if (!storage || storage.accounts.length === 0) {
		throw new Error("No Codex accounts are configured.");
	}

	const ids: string[] = [];
	for (const accountNumber of Array.from(new Set(accountNumbers))) {
		if (
			!Number.isInteger(accountNumber) ||
			accountNumber < 1 ||
			accountNumber > storage.accounts.length
		) {
			throw new Error(
				`Invalid account number ${accountNumber}. Expected 1-${storage.accounts.length}.`,
			);
		}
		const account = storage.accounts[accountNumber - 1];
		const accountId = account ? getModelPoolAccountKey(account) : undefined;
		if (!accountId) {
			throw new Error(
				`Account ${accountNumber} has no stable account ID and cannot be assigned to a model pool.`,
			);
		}
		ids.push(accountId);
	}
	return ids;
}

/**
 * Migrate legacy workspace-wide pool entries to member-scoped seat keys.
 *
 * `modelAccountPools` lives in the GLOBAL plugin config, but account storage is
 * per-project by default (`perProjectAccounts`). Expanding a legacy key against
 * a project-scoped account list would rewrite the global pool using only the
 * seats visible from THIS project and silently drop the routing every other
 * project depends on, so the migration is skipped whenever project-scoped
 * storage is active.
 */
function normalizeExistingPoolAccountIds(
	ids: readonly string[],
	storage: AccountStorageV3 | null | undefined,
): readonly string[] {
	const projectScoped = Boolean(getCurrentStoragePath() && getCurrentProjectRoot());
	if (projectScoped) {
		if (ids.some((id) => !isSeatPoolKey(id))) {
			logWarn(
				"Project-scoped account storage is active; leaving legacy workspace-wide model pool entries unmigrated so pools used by other projects are not rewritten.",
			);
		}
		return ids;
	}
	return expandLegacyModelPoolKeys(ids, storage?.accounts ?? []);
}

function buildPoolSnapshot(
	model: string,
	accountIds: readonly string[],
	storage: AccountStorageV3 | null,
	ctx: ToolContext,
	includeSensitive: boolean,
	poolMode: ModelAccountPoolMode,
): {
	model: string;
	poolMode: ModelAccountPoolMode;
	configuredCount: number;
	accounts: Record<string, unknown>[];
	unresolvedCount: number;
	unresolvedAccountIds?: string[];
} {
	const accounts: Record<string, unknown>[] = [];
	const unresolvedAccountIds: string[] = [];
	const storedAccounts = storage?.accounts ?? [];
	const maskEmail = ctx.resolveMaskEmail();

	const includedIndices = new Set<number>();
	for (const accountId of accountIds) {
		const matchingIndices = storedAccounts
			.map((account, index) =>
				matchesModelPoolAccountKey(account, accountId) ? index : -1,
			)
			.filter((index) => index >= 0);
		if (matchingIndices.length === 0) {
			unresolvedAccountIds.push(accountId);
			continue;
		}
		for (const index of matchingIndices) {
			if (includedIndices.has(index)) continue;
			includedIndices.add(index);
			const account = storedAccounts[index];
			if (!account) continue;
			accounts.push({
				...ctx.buildJsonAccountIdentity(index, {
					includeSensitive,
					account,
					label: ctx.formatCommandAccountLabel(account, index, {
						maskEmail,
						peerAccounts: storedAccounts,
					}),
					peerAccounts: storedAccounts,
				}),
				enabled: account.enabled !== false,
			});
		}
	}

	return {
		model,
		poolMode,
		configuredCount: accountIds.length,
		accounts,
		unresolvedCount: unresolvedAccountIds.length,
		...(includeSensitive ? { unresolvedAccountIds } : {}),
	};
}

function renderPoolStatusText(
	pools: ReturnType<typeof buildPoolSnapshot>[],
	ctx: ToolContext,
	storage: AccountStorageV3 | null,
): string {
	if (pools.length === 0) return "No model account pools configured.";
	const lines = ["Model account pools"];
	const maskEmail = ctx.resolveMaskEmail();
	for (const pool of pools) {
		lines.push("", `${pool.model} [${pool.poolMode}]`);
		for (const identity of pool.accounts) {
			const index = identity.zeroBasedIndex;
			if (typeof index !== "number") continue;
			const account = storage?.accounts[index];
			if (account) {
				lines.push(
					`  ${ctx.formatCommandAccountLabel(account, index, { maskEmail, peerAccounts: storage?.accounts })}${
						account.enabled === false ? " [disabled]" : ""
					}`,
				);
			}
		}
		if (pool.unresolvedCount > 0) {
			lines.push(
				`  ${pool.unresolvedCount} account reference${pool.unresolvedCount === 1 ? " is" : "s are"} not present in this project`,
			);
		}
	}
	return lines.join("\n");
}

export function createCodexPoolTool(ctx: ToolContext): ToolDefinition {
	return tool({
		description:
			"Inspect and manage model-specific account pools. Account numbers are 1-based inputs; stable account IDs are persisted.",
		args: {
			action: tool.schema
				.string()
				.optional()
				.describe('"status" (default), "set", "add", "remove", "clear", or "set-mode".'),
			model: tool.schema
				.string()
				.optional()
				.describe("Effective model ID, such as gpt-5.6-sol."),
			accounts: tool.schema
				.array(tool.schema.number())
				.optional()
				.describe("1-based account numbers used by set, add, and remove."),
			dryRun: tool.schema
				.boolean()
				.optional()
				.describe("Preview a mutation without changing configuration."),
			poolMode: tool.schema
				.string()
				.optional()
				.describe('Pool routing mode used by "set-mode": "preferred" or "strict".'),
			format: tool.schema
				.enum(TOOL_OUTPUT_FORMAT_VALUES)
				.optional()
				.describe(TOOL_OUTPUT_FORMAT_DESCRIPTION),
			includeSensitive: tool.schema
				.boolean()
				.optional()
				.describe("Include stable account IDs in JSON output (default: false)."),
		},
		async execute(args: CodexPoolArgs) {
			const action = normalizePoolAction(args.action);
			const format = normalizeToolOutputFormat(args.format);
			const model = normalizeModel(args.model);
			const poolMode = normalizePoolMode(args.poolMode);
			const storage = await loadAccounts();
			const includeSensitive = args.includeSensitive === true;

			if (action === "status") {
				const config = loadPluginConfig();
				const configuredPools = config.modelAccountPools ?? {};
				const entries = Object.entries(configuredPools).filter(
					([configuredModel]) =>
						model === undefined || configuredModel.trim().toLowerCase() === model,
				);
				const pools = entries.map(([configuredModel, ids]) =>
					buildPoolSnapshot(
						configuredModel.trim().toLowerCase(),
						ids,
						storage,
						ctx,
						includeSensitive,
						getModelAccountPoolMode(config, configuredModel),
					),
				);
				if (format === "json") {
					return renderJsonOutput({ action, pools });
				}
				if (pools.length === 0 && model) {
					return `No model account pool configured for ${model}.`;
				}
				return renderPoolStatusText(pools, ctx, storage);
			}

			if (!model) throw new Error(`Model is required for action "${action}".`);
			if (action === "set-mode" && !poolMode) {
				throw new Error('poolMode is required for action "set-mode".');
			}
			if (action !== "set-mode" && poolMode) {
				throw new Error('poolMode is only valid for action "set-mode".');
			}
			const accountIds =
				action === "clear" || action === "set-mode"
					? []
					: resolveAccountIds(storage, args.accounts);
			let result: ModelAccountPoolMutationResult;
			try {
				result = await updateModelAccountPool(model, action, accountIds, {
					dryRun: args.dryRun,
					poolMode,
					...(action === "add" || action === "remove"
						? {
								normalizeExistingAccountIds: (ids: readonly string[]) =>
									normalizeExistingPoolAccountIds(ids, storage),
							}
						: {}),
				});
			} catch (error) {
				if (!(error instanceof ConfigLockContentionError)) throw error;

				const message =
					"The plugin configuration is locked by another process. No change was made — retry shortly.";
				logWarn("codex-pool could not acquire the plugin configuration lock", {
					action,
					model,
				});
				if (format === "json") {
					// Mirror the success payload's shape. Dropping `pool`,
					// `previousPoolMode` and friends makes every consumer that reads
					// `pool.accounts` throw a TypeError - a harder failure than the raw
					// lock error this degrade path replaced. Nothing was mutated, so the
					// pool currently on disk is the accurate answer.
					const config = loadPluginConfig();
					const currentAccountIds = Array.from(
						new Set(
							Object.entries(config.modelAccountPools ?? {})
								.filter(
									([configuredModel]) =>
										configuredModel.trim().toLowerCase() === model,
								)
								.flatMap(([, ids]) => ids ?? []),
						),
					);
					const currentPoolMode = getModelAccountPoolMode(config, model);
					return renderJsonOutput({
						action,
						model,
						changed: false,
						applied: false,
						dryRun: args.dryRun === true,
						restartRequired: false,
						previousConfiguredCount: currentAccountIds.length,
						previousPoolMode: currentPoolMode,
						pool: buildPoolSnapshot(
							model,
							currentAccountIds,
							storage,
							ctx,
							includeSensitive,
							currentPoolMode,
						),
						// Same identifier the class and the logs use, so a caller that
						// greps for what it saw in tool JSON actually finds something.
						error: ErrorCode.CONFIG_LOCK_CONTENTION,
						retryable: true,
						message,
					});
				}
				return `Could not update the account pool for ${model}: ${message}`;
			}
			const pool = buildPoolSnapshot(
				result.model,
				result.accountIds,
				storage,
				ctx,
				includeSensitive,
				result.poolMode,
			);
			const applied = result.changed && !result.dryRun;
			const payload = {
				action,
				model: result.model,
				changed: result.changed,
				applied,
				dryRun: result.dryRun,
				// Pool config is re-read from disk per request
				// (`loadPluginConfig()` inside the fetch path), so an applied
				// mutation takes effect on the next request — no restart. The
				// field stays on the wire shape for consumers that read it.
				restartRequired: false,
				previousConfiguredCount: result.previousAccountIds.length,
				previousPoolMode: result.previousPoolMode,
				pool,
			};
			if (format === "json") return renderJsonOutput(payload);

			const verb = result.dryRun ? "Previewed" : applied ? "Updated" : "No change to";
			const lines = [
				`${verb} model account pool: ${result.model}`,
				`Previous accounts: ${result.previousAccountIds.length}`,
				`Current accounts: ${result.accountIds.length}`,
				`Pool mode: ${result.poolMode}`,
			];
			if (applied) lines.push("Applies on the next request; no restart needed.");
			return lines.join("\n");
		},
	});
}
