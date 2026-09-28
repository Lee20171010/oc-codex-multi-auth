/**
 * `codex-health` tool — verify refresh tokens for all accounts.
 * Extracted from `index.ts` per RC-1 Phase 2.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import { loadAccounts } from "../storage.js";
import {
	findDisabledAccountsWithFreshCredential,
	findDisabledTokenSourceDuplicates,
	findConflictingBusinessMemberCredentials,
	findStaleRecoverableAccounts,
	findQuotaExhaustedAccounts,
} from "../accounts/stale-state.js";
import { formatUiHeader, formatUiItem, paintUiText } from "../ui/format.js";
import { normalizeToolOutputFormat, renderJsonOutput } from "../runtime.js";
import {
	buildRefreshInputs,
	refreshAndPersistAccount,
} from "./refresh-account.js";
import {
	TOOL_INCLUDE_SENSITIVE_DESCRIPTION,
	TOOL_OUTPUT_FORMAT_DESCRIPTION,
	TOOL_OUTPUT_FORMAT_VALUES,
} from "./args.js";
import { sanitizeToolErrorMessage, withToolErrorEnvelope } from "./output.js";
import type { ToolContext } from "./index.js";

export function createCodexHealthTool(ctx: ToolContext): ToolDefinition {
	const {
		resolveUiRuntime,
		formatCommandAccountLabel,
		resolveMaskEmail,
		getStatusMarker,
		buildJsonAccountIdentity,
		reloadCachedAccountManager,
	} = ctx;
	const definition = tool({
		description:
			"Check health of all Codex accounts by validating refresh tokens.",
		args: {
			format: tool.schema
				.enum(TOOL_OUTPUT_FORMAT_VALUES)
				.optional()
				.describe(TOOL_OUTPUT_FORMAT_DESCRIPTION),
			includeSensitive: tool.schema
				.boolean()
				.optional()
				.describe(TOOL_INCLUDE_SENSITIVE_DESCRIPTION),
		},
		async execute({
			format,
			includeSensitive,
		}: {
			format?: string;
			includeSensitive?: boolean;
		} = {}) {
			const ui = resolveUiRuntime();
			const maskEmail = resolveMaskEmail();
			const outputFormat = normalizeToolOutputFormat(format);
			const includeSensitiveOutput = includeSensitive === true;
			const storage = await loadAccounts();
			if (!storage || storage.accounts.length === 0) {
				if (outputFormat === "json") {
					// Emit the same keys the populated branch does — including all
					// five *Slots arrays — so consumers get one stable schema.
					return renderJsonOutput({
						message:
							"No Codex accounts configured. Run: opencode auth login",
						totalAccounts: 0,
						healthyCount: 0,
						unhealthyCount: 0,
						skippedCount: 0,
						staleRecoverableSlots: [],
						quotaExhaustedSlots: [],
						disabledDuplicateSlots: [],
						businessMemberConflictSlots: [],
						disabledWithFreshCredentialSlots: [],
						accounts: [],
					});
				}
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Health check"),
						"",
						formatUiItem(ui, "No accounts configured.", "warning"),
						formatUiItem(ui, "Run: opencode auth login", "accent"),
					].join("\n");
				}
				return "No Codex accounts configured. Run: opencode auth login";
			}

			const results: string[] = ui.v2Enabled
				? []
				: [`Health Check (${storage.accounts.length} accounts):`, ""];
			const jsonAccounts: Array<Record<string, unknown>> = [];

			let healthyCount = 0;
			let unhealthyCount = 0;
			let skippedCount = 0;
			const inputs = buildRefreshInputs(storage.accounts);

			for (let i = 0; i < inputs.length; i++) {
				const input = inputs[i];
				const account = storage.accounts[i];
				if (!input || !account) continue;

				const label = formatCommandAccountLabel(account, i, {
					peerAccounts: storage.accounts,
				});
				const displayLabel = formatCommandAccountLabel(account, i, {
					maskEmail,
					peerAccounts: storage.accounts,
				});
				const outcome = await refreshAndPersistAccount(input);

				if (outcome.status === "refreshed") {
					jsonAccounts.push({
						...buildJsonAccountIdentity(i, {
							includeSensitive: includeSensitiveOutput,
							account,
							label,
							peerAccounts: storage.accounts,
						}),
						status: "healthy",
					});
					results.push(
						`  ${getStatusMarker(ui, "ok")} ${displayLabel}: Healthy`,
					);
					healthyCount++;
				} else if (outcome.status === "skipped") {
					jsonAccounts.push({
						...buildJsonAccountIdentity(i, {
							includeSensitive: includeSensitiveOutput,
							account,
							label,
							peerAccounts: storage.accounts,
						}),
						status: "skipped",
						error: "Account is disabled",
					});
					results.push(
						`  ${getStatusMarker(ui, "warning")} ${displayLabel}: Skipped (disabled)`,
					);
					skippedCount++;
				} else {
					jsonAccounts.push({
						...buildJsonAccountIdentity(i, {
							includeSensitive: includeSensitiveOutput,
							account,
							label,
							peerAccounts: storage.accounts,
						}),
						status: "unhealthy",
						// Upstream error bodies are masked + truncated before they reach
						// tool output — raw refresh failures can carry credential-shaped
						// fragments or emails.
						error: sanitizeToolErrorMessage(outcome.error),
					});
					results.push(
						`  ${getStatusMarker(ui, "error")} ${displayLabel}: ${sanitizeToolErrorMessage(outcome.error)}`,
					);
					unhealthyCount++;
				}
			}

			await reloadCachedAccountManager();

			results.push("");
			results.push(
				`Summary: ${healthyCount} healthy, ${unhealthyCount} unhealthy, ${skippedCount} skipped`,
			);

			// Surface recoverable stale state and disabled token-source duplicates
			// (issue #171). Token verification is destructive to single-use refresh
			// tokens, but this tool persists rotations before reporting health.
			const staleRecoverable = findStaleRecoverableAccounts(storage.accounts);
			const quotaExhausted = findQuotaExhaustedAccounts(storage.accounts);
			const duplicateSlots = findDisabledTokenSourceDuplicates(storage.accounts);
			const memberCredentialConflicts = findConflictingBusinessMemberCredentials(
				storage.accounts,
			);
			const staleSlots = staleRecoverable.map((index) => index + 1);
			const quotaSlots = quotaExhausted.map((index) => index + 1);
			const dupSlots = duplicateSlots.map((index) => index + 1);
			const memberConflictSlots = memberCredentialConflicts.map((indices) =>
				indices.map((index) => index + 1),
			);
			if (staleSlots.length > 0) {
				results.push(
					`Stale state: ${staleSlots.length} account(s) blocked by a stale cooldown/rate-limit (slots: ${staleSlots.join(", ")}). Run \`codex-doctor --fix\`.`,
				);
			}
			if (quotaSlots.length > 0) {
				results.push(
					`Quota exhausted: ${quotaSlots.length} account(s) carry an active quota-exhaustion stamp (slots: ${quotaSlots.join(", ")}). Stamps are set by the usage poller or a quota 429 and are usually real; \`codex-doctor --fix\` clears them after verification, and the next quota 429 re-establishes the block.`,
				);
			}
			if (dupSlots.length > 0) {
				results.push(
					`Duplicates: ${dupSlots.length} disabled duplicate entry(ies) shadow a real account (slots: ${dupSlots.join(", ")}). Remove with \`codex-remove\`.`,
				);
			}
			if (memberConflictSlots.length > 0) {
				results.push(
					`Business member conflict: ${memberConflictSlots.length} group(s) use one member credential under different emails (slots: ${memberConflictSlots.map((slots) => slots.join("/")).join(", ")}). Remove and re-login those slots separately.`,
				);
			}
			const absorbedSlots = findDisabledAccountsWithFreshCredential(
				storage.accounts,
			).map((index) => index + 1);
			if (absorbedSlots.length > 0) {
				results.push(
					`Disabled w/ fresh login: ${absorbedSlots.length} disabled account(s) hold a fresh credential (slots: ${absorbedSlots.join(", ")}) - a recent re-login landed on a disabled slot. Re-enable in oc-codex-multi-auth-accounts.json if intended.`,
				);
			}
			if (outputFormat === "json") {
				return renderJsonOutput({
					totalAccounts: storage.accounts.length,
					healthyCount,
					unhealthyCount,
					skippedCount,
					staleRecoverableSlots: staleSlots,
					quotaExhaustedSlots: quotaSlots,
					disabledDuplicateSlots: dupSlots,
					businessMemberConflictSlots: memberConflictSlots,
					disabledWithFreshCredentialSlots: absorbedSlots,
					accounts: jsonAccounts,
				});
			}

			if (ui.v2Enabled) {
				return [
					...formatUiHeader(ui, "Health check"),
					"",
					...results.map((line) => paintUiText(ui, line, "normal")),
				].join("\n");
			}

			return results.join("\n");
		},
	});
	return withToolErrorEnvelope("codex-health", definition);
}
