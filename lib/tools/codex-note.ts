/**
 * `codex-note` tool — set or clear per-account reminder note.
 * Extracted from `index.ts` per RC-1 Phase 2.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import { loadAccounts } from "../storage.js";
import { AccountManager } from "../accounts.js";
import { mutateManagedAccount } from "../account-management.js";
import { getWorkspaceIdentityKey } from "../storage/identity.js";
import {
	withToolErrorEnvelope,
} from "./output.js";
import { sanitizeDisplayText } from "../ui/display-text.js";
import type { ToolContext } from "./index.js";

export function createCodexNoteTool(ctx: ToolContext): ToolDefinition {
	const {
		resolveUiRuntime,
		promptAccountIndexSelection,
		supportsInteractiveMenus,
		formatCommandAccountLabel,
		resolveMaskEmail,
		cachedAccountManagerRef,
		accountManagerPromiseRef,
	} = ctx;
	const definition = tool({
		description: "Set or clear an account note for reminders.",
		args: {
			index: tool.schema
				.number()
				.optional()
				.describe(
					"Account number to update (1-based, e.g., 1 for first account)",
				),
			note: tool.schema
				.string()
				.describe("Short note. Empty string clears the note."),
		},
		async execute({ index, note }: { index?: number; note: string }) {
			const ui = resolveUiRuntime();
			const maskEmail = resolveMaskEmail();
			const storage = await loadAccounts();
			if (!storage || storage.accounts.length === 0) {
				return "No Codex accounts configured. Run: opencode auth login";
			}

			let resolvedIndex = index;
			if (resolvedIndex === undefined) {
				const selectedIndex = await promptAccountIndexSelection(
					ui,
					storage,
					"Set account note",
				);
				if (selectedIndex === null) {
					if (supportsInteractiveMenus()) return "No account selected.";
					return 'Missing account number. Use: codex-note index=2 note="weekday primary"';
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
			const identityKey = getWorkspaceIdentityKey(account);

			// Notes persist and are later rendered — strip the full escape
			// sequence (not just the ESC byte) at write time so a note cannot
			// carry concealment or cursor movement. Cap at 241 so the
			// over-length check below still fires.
			const normalizedNote =
				sanitizeDisplayText((note ?? "").trim(), { maxLength: 241 }) ?? "";
			if (normalizedNote.length > 240) {
				return "Note is too long (max 240 characters).";
			}

			const mutation = await mutateManagedAccount(resolvedIndex, { action: "note", value: normalizedNote }, identityKey);
			const outcome = mutation.kind === "ok" ? "ok"
				: mutation.kind === "save-failed" ? "persist-failed" : "account-changed";
			const persistedAccount = mutation.kind === "ok" ? mutation.account : account;

			if (outcome === "account-changed") {
				return "Account changed before its note could be updated. Retry codex-list and pick the account again.";
			}
			if (outcome === "persist-failed") {
				return "Note update failed to persist. Changes may be lost on restart.";
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
			if (normalizedNote.length === 0) {
				return `Cleared note for ${accountLabel}`;
			}
			return `Saved note for ${accountLabel}: ${normalizedNote}`;
		},
	});
	return withToolErrorEnvelope("codex-note", definition);
}
