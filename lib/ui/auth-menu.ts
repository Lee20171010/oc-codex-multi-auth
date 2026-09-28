import { ANSI, isTTY } from "./ansi.js";
import { confirm } from "./confirm.js";
import {
	formatIsoDate,
	sanitizeDisplayText,
} from "./display-text.js";
import { getUiRuntimeOptions } from "./runtime.js";
import { select, type MenuItem } from "./select.js";
import { paintUiText, formatUiBadge } from "./format.js";
import { formatSeatSuffix, resolveDisplayEmail } from "../account-display.js";

export type AccountStatus =
	| "active"
	| "ok"
	| "rate-limited"
	| "cooldown"
	| "disabled"
	| "error"
	| "flagged"
	| "unknown";

export interface AccountInfo {
	index: number;
	accountId?: string;
	accountUserId?: string;
	accountLabel?: string;
	email?: string;
	addedAt?: number;
	lastUsed?: number;
	status?: AccountStatus;
	isCurrentAccount?: boolean;
	enabled?: boolean;
}

export interface AuthMenuOptions {
	flaggedCount?: number;
	maskEmail?: boolean;
}

export type AuthMenuAction =
	| { type: "add" }
	| { type: "fresh" }
	| { type: "check" }
	| { type: "deep-check" }
	| { type: "verify-flagged" }
	| { type: "select-account"; account: AccountInfo }
	| { type: "delete-all" }
	| { type: "cancel" };

export type AccountAction = "back" | "delete" | "refresh" | "toggle" | "cancel";

function formatRelativeTime(timestamp: number | undefined): string {
	if (!timestamp) return "never";
	const days = Math.floor((Date.now() - timestamp) / 86_400_000);
	if (days <= 0) return "today";
	if (days === 1) return "yesterday";
	if (days < 7) return `${days}d ago`;
	if (days < 30) return `${Math.floor(days / 7)}w ago`;
	// Fixed ISO date — identical under every locale.
	return formatIsoDate(new Date(timestamp));
}

function formatDate(timestamp: number | undefined): string {
	if (!timestamp) return "unknown";
	return formatIsoDate(new Date(timestamp));
}

/**
 * Legacy (`!v2Enabled`) badges are interpolated raw — gate the SGR styling on
 * the resolved color decision so `NO_COLOR`, `FORCE_COLOR=0`, and non-TTY
 * output stay plain.
 */
function ansiBadge(text: string, color: string): string {
	const ui = getUiRuntimeOptions();
	if (ui.colorEnabled === false) return text;
	return `${color}${text}${ANSI.reset}`;
}

function statusBadge(status: AccountStatus | undefined): string {
	const ui = getUiRuntimeOptions();
	if (ui.v2Enabled) {
		switch (status) {
			case "active":
				return formatUiBadge(ui, "active", "success");
			case "ok":
				return formatUiBadge(ui, "ok", "success");
			case "rate-limited":
				return formatUiBadge(ui, "rate-limited", "warning");
			case "cooldown":
				return formatUiBadge(ui, "cooldown", "warning");
			case "flagged":
				return formatUiBadge(ui, "flagged", "danger");
			case "disabled":
				return formatUiBadge(ui, "disabled", "danger");
			case "error":
				return formatUiBadge(ui, "error", "danger");
			default:
				return "";
		}
	}

	switch (status) {
		case "active":
			return ansiBadge("[active]", ANSI.green);
		case "ok":
			return ansiBadge("[ok]", ANSI.green);
		case "rate-limited":
			return ansiBadge("[rate-limited]", ANSI.yellow);
		case "cooldown":
			return ansiBadge("[cooldown]", ANSI.yellow);
		case "flagged":
			return ansiBadge("[flagged]", ANSI.red);
		case "disabled":
			return ansiBadge("[disabled]", ANSI.red);
		case "error":
			return ansiBadge("[error]", ANSI.red);
		default:
			return "";
	}
}

function formatAccountIdSuffix(accountId: string | undefined): string | undefined {
	const sanitized = sanitizeDisplayText(accountId, { maxLength: 64 });
	if (!sanitized) return undefined;
	return sanitized.length > 14
		? `${sanitized.slice(0, 8)}...${sanitized.slice(-6)}`
		: sanitized;
}

function accountTitle(
	account: AccountInfo,
	maskEmail = false,
	peerAccounts?: readonly AccountInfo[],
): string {
	const email = resolveDisplayEmail(account.email, maskEmail);
	const label = sanitizeDisplayText(account.accountLabel, { maxLength: 64 });
	const accountIdSuffix = formatAccountIdSuffix(account.accountId);

	const details: string[] = [];
	if (email) details.push(email);
	if (label) details.push(`workspace:${label}`);
	if (accountIdSuffix && (!label || !label.includes(accountIdSuffix))) {
		details.push(`id:${accountIdSuffix}`);
	}
	const seatSuffix = formatSeatSuffix(
		account.accountUserId,
		peerAccounts?.map((peer) => peer.accountUserId),
	);
	if (seatSuffix) details.push(`seat:${seatSuffix}`);

	if (details.length === 0) {
		return `${account.index + 1}. Account`;
	}
	return `${account.index + 1}. ${details.join(" | ")}`;
}

export async function showAuthMenu(
	accounts: AccountInfo[],
	options: AuthMenuOptions = {},
): Promise<AuthMenuAction> {
	const ui = getUiRuntimeOptions();
	const flaggedCount = options.flaggedCount ?? 0;
	const maskEmail = options.maskEmail ?? false;
	const verifyLabel =
		flaggedCount > 0
			? `Verify flagged accounts (${flaggedCount})`
			: "Verify flagged accounts";

	const items: MenuItem<AuthMenuAction>[] = [
		{ label: "Actions", value: { type: "cancel" }, kind: "heading" },
		{ label: "Add account", value: { type: "add" }, color: "cyan" },
		{ label: "Check quotas", value: { type: "check" }, color: "cyan" },
		{ label: "Deep check accounts", value: { type: "deep-check" }, color: "cyan" },
		{ label: verifyLabel, value: { type: "verify-flagged" }, color: "cyan" },
		{ label: "Start fresh", value: { type: "fresh" }, color: "yellow" },
		{ label: "", value: { type: "cancel" }, separator: true },
		{ label: "Accounts", value: { type: "cancel" }, kind: "heading" },
		...accounts.map((account) => {
			const currentBadge = account.isCurrentAccount
				? (ui.v2Enabled ? ` ${formatUiBadge(ui, "current", "accent")}` : ` ${ansiBadge("[current]", ANSI.cyan)}`)
				: "";
			const badge = statusBadge(account.status);
			const disabledBadge =
				account.enabled === false
					? (ui.v2Enabled ? ` ${formatUiBadge(ui, "disabled", "danger")}` : ` ${ansiBadge("[disabled]", ANSI.red)}`)
					: "";
			const statusSuffix = badge ? ` ${badge}` : "";
			const label = `${accountTitle(account, maskEmail, accounts)}${currentBadge}${statusSuffix}${disabledBadge}`;
			return {
				label: ui.v2Enabled ? paintUiText(ui, label, "heading") : label,
				hint: `used ${formatRelativeTime(account.lastUsed)}`,
				value: { type: "select-account" as const, account },
			};
		}),
		{ label: "", value: { type: "cancel" }, separator: true },
		{ label: "Danger zone", value: { type: "cancel" }, kind: "heading" },
		{ label: "Delete all accounts", value: { type: "delete-all" }, color: "red" },
	];

	while (true) {
		const result = await select(items, {
			message: ui.v2Enabled ? "OpenAI accounts (Codex)" : "Codex accounts",
			subtitle: "Select action or account",
			clearScreen: true,
			variant: ui.v2Enabled ? "codex" : "legacy",
			theme: ui.theme,
		});

		if (!result) return { type: "cancel" };
		if (result.type === "delete-all") {
			const confirmed = await confirm("Delete all accounts?");
			if (!confirmed) continue;
		}
		return result;
	}
}

export async function showAccountDetails(
	account: AccountInfo,
	options: { maskEmail?: boolean; peerAccounts?: readonly AccountInfo[] } = {},
): Promise<AccountAction> {
	const ui = getUiRuntimeOptions();
	const maskEmail = options.maskEmail ?? false;
	const peerAccounts = options.peerAccounts;
	const header =
		`${accountTitle(account, maskEmail, peerAccounts)} ${statusBadge(account.status)}` +
		(account.enabled === false
			? (ui.v2Enabled
				? ` ${formatUiBadge(ui, "disabled", "danger")}`
				: ` ${ansiBadge("[disabled]", ANSI.red)}`)
			: "");
	const subtitle = `Added: ${formatDate(account.addedAt)} | Last used: ${formatRelativeTime(account.lastUsed)}`;

	while (true) {
		const action = await select<AccountAction>(
			[
				{ label: "Back", value: "back" },
				{
					label: account.enabled === false ? "Enable account" : "Disable account",
					value: "toggle",
					color: account.enabled === false ? "green" : "yellow",
				},
				{ label: "Refresh account", value: "refresh", color: "cyan" },
				{ label: "Delete this account", value: "delete", color: "red" },
			],
			{
				message: header,
				subtitle,
				clearScreen: true,
				variant: ui.v2Enabled ? "codex" : "legacy",
				theme: ui.theme,
			},
		);

		if (!action) return "cancel";
		if (action === "delete") {
			const confirmed = await confirm(`Delete ${accountTitle(account, maskEmail, peerAccounts)}?`);
			if (!confirmed) continue;
		}
		if (action === "refresh") {
			const confirmed = await confirm(`Re-authenticate ${accountTitle(account, maskEmail, peerAccounts)}?`);
			if (!confirmed) continue;
		}
		return action;
	}
}

export { isTTY };

