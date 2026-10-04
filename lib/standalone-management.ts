import { mutateManagedAccount, normalizeManagedTags, type AccountMutation } from "./account-management.js";
import { clearTuiQuotaSnapshots, TUI_QUOTA_OVERVIEW_CACHE_FILE } from "./tui-quota-cache.js";
import { dirname, join } from "node:path";
import { createCodexPoolTool, type PoolToolContext } from "./tools/codex-pool.js";
import { buildToolErrorEnvelope } from "./tools/output.js";
import { sanitizeDisplayText } from "./ui/display-text.js";
import { Effect } from "effect";
import { getStoragePath, loadAccounts } from "./storage.js";

export type ManagementCommand = "switch" | "label" | "note" | "tag" | "pool";
export interface ManagementInput {
	index?: number;
	value?: string;
	action?: string;
	model?: string;
	accounts?: number[];
	poolMode?: string;
	dryRun?: boolean;
	includeSensitive?: boolean;
}

const poolContext: PoolToolContext = {
	resolveMaskEmail: () => true,
	formatCommandAccountLabel: (account, index) =>
		sanitizeDisplayText(account?.accountLabel) || `Account ${index + 1}`,
	buildJsonAccountIdentity: (index, options) => ({
		index: index + 1,
		zeroBasedIndex: index,
		label: options?.label ?? `Account ${index + 1}`,
		...(options?.includeSensitive ? { accountId: options.account?.accountId ?? null,
			accountUserId: options.account?.accountUserId ?? null } : {}),
	}),
};

/** CLI adapter for the same durable account and model-pool operations as tools. */
export async function executeStandaloneManagement(command: ManagementCommand, input: ManagementInput) {
	try {
		if (command === "pool") {
			const result = await createCodexPoolTool(poolContext).execute({ ...input, format: "json" },
				{ sessionID: "standalone", messageID: "standalone", agent: "standalone",
					directory: process.cwd(), worktree: process.cwd(),
					abort: new AbortController().signal, metadata: () => {}, ask: () => Effect.succeed(undefined) });
			const payload: Record<string, unknown> = JSON.parse(typeof result === "string" ? result : result.output);
			return { ...payload, ok: payload.ok !== false, command };
		}
		if (input.index === undefined) throw new Error("A 1-based account number is required.");
		// Project pools stay independent; never copy single-use refresh grants.
		const initial = await loadAccounts();
		if (!initial?.accounts.length) throw new Error("No accounts in the selected pool. Run opencode auth login from this project or select an existing account file with --config-path.");
		let mutation: AccountMutation;
		if (command === "switch") mutation = { action: "switch" };
		else {
			if (input.value === undefined) throw new Error(`A ${command} value is required; use an empty string to clear it.`);
			mutation = command === "tag" ? { action: "tag", tags: normalizeManagedTags(input.value) }
				: { action: command, value: input.value };
		}
		const outcome = await mutateManagedAccount(input.index, mutation);
		if (outcome.kind === "invalid") throw new Error(`Invalid account number ${input.index}. Expected 1-${outcome.accountCount}.`);
		if (outcome.kind === "account-changed") throw new Error("Account changed before the operation. List accounts and retry.");
		if (outcome.kind === "save-failed") throw new Error("Account storage could not be updated. No change was persisted.");
		let warning: string | undefined;
		if (command === "switch" || command === "label") {
			try { await clearTuiQuotaSnapshots(join(dirname(getStoragePath()), TUI_QUOTA_OVERVIEW_CACHE_FILE)); }
			catch { warning = "Saved successfully, but quota display caches could not be cleared."; }
		}
		// Render a redacted inventory, never the token-bearing mutation outcome.
		return {
			ok: true, command, index: outcome.index + 1,
			activeIndex: outcome.activeIndex + 1,
			label: outcome.account.accountLabel ?? null,
			note: outcome.account.accountNote ?? null,
			tags: outcome.account.accountTags ?? [],
			message: command === "switch" ? `Switched to account ${outcome.index + 1}.`
				: `Updated ${command} for account ${outcome.index + 1}.`,
			restartRequired: false,
			...(warning ? { warning } : {}),
		};
	} catch (error) {
		return { ...buildToolErrorEnvelope(`codex-${command}`, error), command };
	}
}
