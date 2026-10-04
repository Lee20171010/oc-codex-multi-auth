import { withAccountStorageTransaction, type AccountMetadataV3 } from "./storage.js";
import { getWorkspaceIdentityKey } from "./storage/identity.js";
import { MODEL_FAMILIES } from "./prompts/codex.js";
import { sanitizeDisplayText } from "./ui/display-text.js";
import { rethrowIfRetryable } from "./tools/output.js";
import { logWarn } from "./logger.js";

export type AccountMutation =
	| { action: "switch" }
	| { action: "label"; value: string }
	| { action: "note"; value: string }
	| { action: "tag"; tags: string[] };

export type AccountMutationOutcome =
	| { kind: "invalid"; accountCount: number }
	| { kind: "account-changed" }
	| { kind: "save-failed" }
	| { kind: "ok"; account: AccountMetadataV3; accounts: AccountMetadataV3[];
		index: number; activeIndex: number; previousLabel: string; previousTags: string[] };

export function normalizeManagedTags(raw: string): string[] {
	return Array.from(new Set(raw.split(",")
		.map((entry) => sanitizeDisplayText(entry.trim().toLowerCase()) ?? "")
		.filter(Boolean)));
}

export function normalizeManagedText(value: string, field: "label" | "note"): string {
	const maximum = field === "label" ? 60 : 240;
	const normalized = sanitizeDisplayText(value.trim(), { maxLength: maximum + 1 }) ?? "";
	if (normalized.length > maximum) {
		throw new Error(`${field === "label" ? "Label" : "Note"} is too long (max ${maximum} characters).`);
	}
	return normalized;
}

/** Shared durable mutations for agent tools and the standalone CLI. */
export async function mutateManagedAccount(
	accountNumber: number,
	mutation: AccountMutation,
	expectedIdentity?: string,
): Promise<AccountMutationOutcome> {
	const value = mutation.action === "label" || mutation.action === "note"
		? normalizeManagedText(mutation.value, mutation.action) : undefined;
	return withAccountStorageTransaction<AccountMutationOutcome>(async (storage, persist) => {
		const accounts = storage?.accounts ?? [];
		if (!Number.isInteger(accountNumber) || accountNumber < 1 ||
			(expectedIdentity === undefined && accountNumber > accounts.length)) {
			return { kind: "invalid", accountCount: accounts.length };
		}
		const index = expectedIdentity === undefined ? accountNumber - 1
			: accounts.findIndex((account) => getWorkspaceIdentityKey(account) === expectedIdentity);
		const account = accounts[index];
		if (!storage || !account) return { kind: "account-changed" };
		const previousLabel = account.accountLabel?.trim() ?? "";
		const previousTags = [...(account.accountTags ?? [])];
		switch (mutation.action) {
			case "switch":
				account.lastUsed = Date.now();
				account.lastSwitchReason = "rotation";
				storage.activeIndex = index;
				storage.activeIndexByFamily ??= {};
				for (const family of MODEL_FAMILIES) storage.activeIndexByFamily[family] = index;
				break;
			case "label":
				if (value) account.accountLabel = value;
				else delete account.accountLabel;
				break;
			case "note":
				if (value) account.accountNote = value;
				else delete account.accountNote;
				break;
			case "tag": {
				const tags = mutation.tags.map((tag) => sanitizeDisplayText(tag.trim()) ?? "").filter(Boolean);
				if (tags.length > 0) account.accountTags = tags;
				else delete account.accountTags;
				break;
			}
		}
		try {
			await persist(storage);
		} catch (error) {
			rethrowIfRetryable(error);
			logWarn("Account management mutation could not be persisted", { action: mutation.action });
			return { kind: "save-failed" };
		}
		return { kind: "ok", account, accounts, index, activeIndex: storage.activeIndex, previousLabel, previousTags };
	});
}
