/**
 * `codex-tag` tool — set or clear account tags.
 * Extracted from `index.ts` per RC-1 Phase 2.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import { loadAccounts, withAccountStorageTransaction } from "../storage.js";
import { AccountManager } from "../accounts.js";
import { logWarn } from "../logger.js";
import { getWorkspaceIdentityKey } from "../storage/identity.js";
import {
	formatUiHeader,
	formatUiItem,
	formatUiKeyValue,
} from "../ui/format.js";
import {
	rethrowIfRetryable,
	stripControlCharacters,
	withToolErrorEnvelope,
} from "./output.js";
import type { ToolContext } from "./index.js";

export function createCodexTagTool(ctx: ToolContext): ToolDefinition {
	const {
		resolveUiRuntime,
		promptAccountIndexSelection,
		supportsInteractiveMenus,
		formatCommandAccountLabel,
		resolveMaskEmail,
		getStatusMarker,
		normalizeAccountTags,
		cachedAccountManagerRef,
		accountManagerPromiseRef,
	} = ctx;
	const definition = tool({
		description: "Set or clear account tags for filtering and grouping.",
		args: {
			index: tool.schema
				.number()
				.optional()
				.describe(
					"Account number to update (1-based, e.g., 1 for first account)",
				),
			tags: tool.schema
				.string()
				.describe(
					"Comma-separated tags (e.g., work,team-a). Empty string clears tags.",
				),
		},
		async execute({ index, tags }: { index?: number; tags: string }) {
			const ui = resolveUiRuntime();
			const maskEmail = resolveMaskEmail();
			const storage = await loadAccounts();
			if (!storage || storage.accounts.length === 0) {
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Set account tags"),
						"",
						formatUiItem(ui, "No accounts configured.", "warning"),
						formatUiItem(ui, "Run: opencode auth login", "accent"),
					].join("\n");
				}
				return "No Codex accounts configured. Run: opencode auth login";
			}

			let resolvedIndex = index;
			if (resolvedIndex === undefined) {
				const selectedIndex = await promptAccountIndexSelection(
					ui,
					storage,
					"Set account tags",
				);
				if (selectedIndex === null) {
					if (supportsInteractiveMenus()) {
						return ui.v2Enabled
							? [
									...formatUiHeader(ui, "Set account tags"),
									"",
									formatUiItem(ui, "No account selected.", "warning"),
								].join("\n")
							: "No account selected.";
					}
					return 'Missing account number. Use: codex-tag index=2 tags="work,team-a"';
				}
				resolvedIndex = selectedIndex + 1;
			}

			const targetIndex = Math.floor((resolvedIndex ?? 0) - 1);
			if (
				!Number.isFinite(targetIndex) ||
				targetIndex < 0 ||
				targetIndex >= storage.accounts.length
			) {
				return `Invalid account number: ${resolvedIndex}\n\nValid range: 1-${storage.accounts.length}`;
			}

			const account = storage.accounts[targetIndex];
			if (!account) return `Account ${resolvedIndex} not found.`;
			// Tags are echoed back into tool output — drop control characters so a
			// crafted tag cannot inject escape sequences (or empty-remainder tags).
			const normalizedTags = normalizeAccountTags(tags ?? "")
				.map((entry) => stripControlCharacters(entry).trim())
				.filter((entry) => entry.length > 0);
			const identityKey = getWorkspaceIdentityKey(account);
			let previousTags: string[] = [];
			let persistedAccount = account;

			// Same contract as codex-note: the handler reports its outcome so only
			// real transaction failures (e.g. lock contention) escape and surface
			// as retryable, machine-readable errors through the registry wrapper.
			type TagOutcome = "ok" | "account-changed" | "persist-failed";
			const outcome = await withAccountStorageTransaction<TagOutcome>(
				async (current, persist) => {
					const currentAccount = current?.accounts.find(
						(candidate) => getWorkspaceIdentityKey(candidate) === identityKey,
					);
					if (!current || !currentAccount) {
						return "account-changed";
					}
					previousTags = Array.isArray(currentAccount.accountTags)
						? [...currentAccount.accountTags]
						: [];
					if (normalizedTags.length === 0) {
						delete currentAccount.accountTags;
					} else {
						currentAccount.accountTags = normalizedTags;
					}
					try {
						await persist(current);
					} catch (error) {
						// A compromised transaction lease surfaces through persist()
						// too — let it escape so the wrapper marks the call retryable.
						rethrowIfRetryable(error);
						logWarn("Failed to save account tag update", {
							error: String(error),
						});
						return "persist-failed";
					}
					persistedAccount = currentAccount;
					return "ok";
				},
			);

			if (outcome === "account-changed") {
				return "Account changed before tags could be updated. Retry codex-list and pick the account again.";
			}
			if (outcome === "persist-failed") {
				return "Tag update failed to persist. Changes may be lost on restart.";
			}

			if (cachedAccountManagerRef.current) {
				const reloadedManager = await AccountManager.loadFromDisk();
				cachedAccountManagerRef.current = reloadedManager;
				accountManagerPromiseRef.current = Promise.resolve(reloadedManager);
			}

			const accountLabel = formatCommandAccountLabel(persistedAccount, targetIndex, {
				maskEmail,
				peerAccounts: storage.accounts,
			});
			const previousText =
				previousTags.length > 0 ? previousTags.join(", ") : "none";
			const nextText =
				normalizedTags.length > 0 ? normalizedTags.join(", ") : "none";
			if (ui.v2Enabled) {
				return [
					...formatUiHeader(ui, "Set account tags"),
					"",
					formatUiItem(
						ui,
						`${getStatusMarker(ui, "ok")} Updated tags for ${accountLabel}`,
						"success",
					),
					formatUiKeyValue(ui, "Previous tags", previousText, "muted"),
					formatUiKeyValue(
						ui,
						"Current tags",
						nextText,
						normalizedTags.length > 0 ? "accent" : "muted",
					),
				].join("\n");
			}
			return `Updated tags for ${accountLabel}\nPrevious tags: ${previousText}\nCurrent tags: ${nextText}`;
		},
	});
	return withToolErrorEnvelope("codex-tag", definition);
}
