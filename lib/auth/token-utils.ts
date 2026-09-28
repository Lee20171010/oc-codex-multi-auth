/**
 * Token utility functions for JWT parsing and account ID extraction.
 * Extracted from accounts.ts to reduce module size and improve cohesion.
 */

import { decodeJWT } from "./auth.js";
import { JWT_CLAIM_PATH, JWT_PROFILE_CLAIM_PATH } from "../constants.js";
import { isRecord } from "../utils.js";
import type { AccountIdSource, JWTPayload } from "../types.js";

/**
 * Account ID candidate from token or organization data.
 */
export interface AccountIdCandidate {
	accountId: string;
	organizationId?: string;
	label: string;
	source: AccountIdSource;
	isDefault?: boolean;
	isPersonal?: boolean;
}

/**
 * Converts a value to a trimmed string if it's a non-empty string.
 * Local helper - returns undefined for non-strings (different from lib/utils.toStringValue).
 */
function toStringValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * Upper bound for a display-bound claim value (workspace name, role, plan
 * label). Real values are a few dozen characters at most.
 */
const MAX_CLAIM_TEXT_LENGTH = 64;

/**
 * Strip control characters (C0, DEL, C1 — including the ESC that opens ANSI
 * sequences) from a string. Used on values extracted from JWT claims / org
 * payloads before they are rendered into account labels, menus, or emails:
 * upstream text is nominally trustworthy but crosses the prompt/terminal
 * boundary, where a stray `\n` splits a rendered row and a `\x1b` rewrites
 * the display. Mirrors `sanitizePlanLabel` in plan-tier.ts.
 */
function stripControlChars(value: string): string {
	let cleaned = "";
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		cleaned += (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) ? " " : char;
	}
	return cleaned;
}

/**
 * Sanitize a display-bound claim value: control characters are replaced by
 * spaces (then collapsed) and the result is bounded in length.
 */
function sanitizeClaimText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const collapsed = stripControlChars(value).replace(/\s+/g, " ").trim();
	if (!collapsed) return undefined;
	return collapsed.length > MAX_CLAIM_TEXT_LENGTH
		? `${collapsed.slice(0, MAX_CLAIM_TEXT_LENGTH - 1)}…`
		: collapsed;
}

/**
 * Sanitize an email-shaped claim value: control characters are removed
 * outright (a valid address never contains whitespace) rather than replaced
 * with spaces.
 */
function sanitizeClaimEmail(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = stripControlChars(value).replace(/\s+/g, "");
	if (!cleaned || !cleaned.includes("@")) return undefined;
	return cleaned.length > MAX_CLAIM_TEXT_LENGTH ? undefined : cleaned;
}

/**
 * Converts a value to boolean if possible.
 */
function toBoolean(value: unknown): boolean | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}
	return undefined;
}

/**
 * Formats account ID to last 6 characters for display.
 *
 * The suffix is display-only (it goes into `[id:…]` label markers), so
 * control characters are stripped here rather than trusted to be absent from
 * the claim.
 */
function formatAccountIdSuffix(accountId: string): string {
	const cleaned = stripControlChars(accountId).replace(/\s+/g, "");
	return cleaned.length > 6 ? cleaned.slice(-6) : cleaned;
}

/**
 * Formats a label for token-derived account candidates.
 */
function formatTokenCandidateLabel(prefix: string, accountId: string): string {
	const suffix = formatAccountIdSuffix(accountId);
	return `${prefix} [id:${suffix}]`;
}

/**
 * Trailing `[id:…]` marks a label this plugin generated — the shape every
 * generator here emits, via {@link formatTokenCandidateLabel} or the `Override
 * [id:…]` branch in `resolveAccountSelection`. A user-supplied label never
 * carries one, which is what lets a login clear a stale generated label
 * without overwriting a name someone chose with `codex-label`.
 */
const GENERATED_LABEL_PATTERN = /\s\[id:[^\]]*\]$/;

/**
 * Whether a stored label may be replaced by a login.
 *
 * A blank label counts as generated so an account that never had one can pick
 * one up. Anything that does not carry the `[id:…]` marker is treated as a
 * name a user chose and is left alone.
 */
export function isGeneratedAccountLabel(label: string | undefined): boolean {
	const normalized = toStringValue(label);
	if (!normalized) return true;
	return GENERATED_LABEL_PATTERN.test(normalized);
}

/**
 * Whether a stored label is one this plugin generated for *this* account.
 *
 * {@link isGeneratedAccountLabel} answers a softer question - may a login
 * replace this label - and deliberately treats any trailing `[id:…]` as
 * generated, because the worst case there is that a login overwrites a name
 * with a fresh one. Deleting a label outright is not reversible, and
 * `codex-label` accepts any string, so `Work [id:mine]` is a name someone is
 * allowed to have typed.
 *
 * Every generator here emits the account's own id suffix in that marker, so
 * the stricter test compares it against what this account's id would produce.
 * A label carrying an arbitrary word, someone else's suffix, or belonging to
 * an account with no stored id to compare against, is left alone.
 *
 * A user who types a label ending in their own real id suffix is
 * indistinguishable from the generator and loses it. Nothing in the stored
 * data separates those two cases; the alternative is deleting every
 * `[id:…]` label, which is the strictly worse trade.
 */
export function isStaleGeneratedAccountLabel(
	label: string | undefined,
	accountId: string | undefined,
): boolean {
	const normalizedLabel = toStringValue(label);
	const normalizedId = toStringValue(accountId);
	if (!normalizedLabel || !normalizedId) return false;
	const marker = normalizedLabel.match(GENERATED_LABEL_PATTERN)?.[0];
	if (!marker) return false;
	return marker === ` [id:${formatAccountIdSuffix(normalizedId)}]`;
}

/**
 * Extracts account ID from a JWT payload.
 */
function extractAccountIdFromPayload(payload: JWTPayload | Record<string, unknown> | null): string | undefined {
	if (!payload) return undefined;
	const auth = payload[JWT_CLAIM_PATH];
	if (isRecord(auth)) {
		const id = toStringValue(auth.chatgpt_account_id);
		if (id) return id;
	}

	const direct =
		toStringValue((payload as Record<string, unknown>).chatgpt_account_id) ??
		toStringValue((payload as Record<string, unknown>).account_id) ??
		toStringValue((payload as Record<string, unknown>).accountId);
	return direct;
}

/**
 * Normalizes candidate arrays from various response formats.
 */
function normalizeCandidateArray(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (isRecord(value)) {
		const nested =
			value.data ??
			value.items ??
			value.accounts ??
			value.organizations ??
			value.workspaces ??
			value.teams;
		if (Array.isArray(nested)) return nested;
	}
	return [];
}

function extractOrganizationIdFromRecord(
	record: Record<string, unknown>,
): string | undefined {
	return (
		toStringValue(record.organization_id) ??
		toStringValue(record.organizationId) ??
		toStringValue(record.org_id)
	);
}

/**
 * Extracts a single account candidate from a record.
 */
function extractCandidateFromRecord(
	record: Record<string, unknown>,
	source: AccountIdSource,
	organizationIdOverride?: string,
): AccountIdCandidate | null {
	const accountId =
		toStringValue(record.account_id) ??
		toStringValue(record.accountId) ??
		toStringValue(record.chatgpt_account_id) ??
		toStringValue(record.organization_id) ??
		toStringValue(record.org_id) ??
		toStringValue(record.workspace_id) ??
		toStringValue(record.team_id) ??
		toStringValue(record.id);

	if (!accountId) return null;

	// Prefer explicit org identity from the record; only fall back to positional
	// overrides when a record doesn't carry its own org identifier.
	const organizationId =
		extractOrganizationIdFromRecord(record) ?? organizationIdOverride;

	// Display-bound fields are sanitized at extraction: they come from JWT
	// claims / org payloads and are interpolated into account labels rendered
	// in menus, tables, and toasts, so control characters must not pass
	// through (same treatment as `sanitizePlanLabel` for plan labels).
	const name =
		sanitizeClaimText(record.name) ??
		sanitizeClaimText(record.display_name) ??
		sanitizeClaimText(record.title) ??
		sanitizeClaimText(record.organization_name) ??
		sanitizeClaimText(record.workspace_name) ??
		sanitizeClaimText(record.team_name) ??
		sanitizeClaimText(record.slug);
	const type =
		sanitizeClaimText(record.type) ??
		sanitizeClaimText(record.plan_type) ??
		sanitizeClaimText(record.kind) ??
		sanitizeClaimText(record.account_type);
	const role =
		sanitizeClaimText(record.role) ??
		sanitizeClaimText(record.membership_role) ??
		sanitizeClaimText(record.user_role);
	const isDefault = toBoolean(
		record.is_default ?? record.isDefault ?? record.default ?? record.primary ?? record.is_active ?? record.isActive ?? record.current,
	);
	const isPersonal = toBoolean(record.is_personal ?? record.isPersonal ?? record.personal);

	const suffix = formatAccountIdSuffix(accountId);
	const labelParts: string[] = [];
	let labelBase = name ?? "Workspace";

	if (!name && type) {
		labelBase = type;
	}

	if (type && (!name || name.toLowerCase() !== type.toLowerCase())) {
		labelParts.push(type);
	}
	if (role) {
		labelParts.push(`role:${role}`);
	}
	if (isPersonal) {
		labelParts.push("personal");
	}

	const meta = labelParts.length > 0 ? ` (${labelParts.join(", ")})` : "";
	const label = `${labelBase}${meta} [id:${suffix}]`;

	return {
		accountId,
		organizationId,
		label,
		source,
		isDefault,
		isPersonal,
	};
}

/**
 * Collects candidates from a list of records.
 */
function collectCandidatesFromList(
	value: unknown,
	source: AccountIdSource,
	organizationIdsByIndex?: Array<string | undefined>,
): AccountIdCandidate[] {
	const result: AccountIdCandidate[] = [];
	const list = normalizeCandidateArray(value);
	if (list.length === 0) return result;

	for (const [index, item] of list.entries()) {
		if (!isRecord(item)) continue;
		const candidate = extractCandidateFromRecord(
			item,
			source,
			organizationIdsByIndex?.[index],
		);
		if (candidate) {
			result.push(candidate);
		}
	}
	return result;
}

function extractOrganizationIdsByIndex(value: unknown): Array<string | undefined> {
	const organizations = normalizeCandidateArray(value);
	if (organizations.length === 0) return [];

	return organizations.map((organization) => {
		if (!isRecord(organization)) return undefined;
		return (
			toStringValue(organization.id) ??
			toStringValue(organization.organization_id) ??
			toStringValue(organization.organizationId) ??
			toStringValue(organization.org_id) ??
			toStringValue(organization.team_id) ??
			toStringValue(organization.workspace_id)
		);
	});
}

function extractPrimaryAuthClaimOrganizationId(
	payload: JWTPayload | Record<string, unknown> | null,
): string | undefined {
	if (!payload || !isRecord(payload)) return undefined;
	const auth = payload[JWT_CLAIM_PATH];
	if (!isRecord(auth)) return undefined;
	const organizations = normalizeCandidateArray(auth.organizations);
	if (organizations.length === 0) return undefined;
	const firstOrganization = organizations[0];
	if (!isRecord(firstOrganization)) return undefined;
	return toStringValue(firstOrganization.id);
}

function extractCanonicalOrganizationIds(
	payload: JWTPayload | Record<string, unknown> | null,
): Array<string | undefined> {
	if (!payload || !isRecord(payload)) return [];
	const auth = payload[JWT_CLAIM_PATH];
	if (!isRecord(auth)) return [];

	// Authoritative source: idToken['https://api.openai.com/auth'].organizations[0].id
	// Only fall back to broader field extraction when this exact path is missing.
	const primaryOrganizationId = extractPrimaryAuthClaimOrganizationId(payload);

	if (primaryOrganizationId) {
		const organizationIds = extractOrganizationIdsByIndex(auth.organizations);
		if (organizationIds.length === 0) return [primaryOrganizationId];
		organizationIds[0] = primaryOrganizationId;
		return organizationIds;
	}

	// Fallback: broader field extraction
	return extractOrganizationIdsByIndex(auth.organizations);
}

function resolveOrganizationOverridesForKey(
	key: string,
	value: unknown,
	canonicalOrganizationIds: Array<string | undefined>,
): Array<string | undefined> | undefined {
	if (key === "organizations") {
		if (canonicalOrganizationIds.length > 0) return canonicalOrganizationIds;
		return extractOrganizationIdsByIndex(value);
	}

	if (key !== "accounts" && key !== "workspaces" && key !== "teams") {
		return undefined;
	}

	if (canonicalOrganizationIds.length === 0) {
		return undefined;
	}

	const listLength = normalizeCandidateArray(value).length;
	if (listLength === 0 || listLength !== canonicalOrganizationIds.length) {
		return undefined;
	}

	return canonicalOrganizationIds;
}

/**
 * Collects candidates from a JWT payload.
 */
function collectCandidatesFromPayload(
	payload: JWTPayload | Record<string, unknown> | null,
	source: AccountIdSource,
): AccountIdCandidate[] {
	if (!payload || !isRecord(payload)) return [];

	const candidates: AccountIdCandidate[] = [];
	const keys = ["organizations", "orgs", "accounts", "workspaces", "teams"];
	const payloadCanonicalOrganizationIds = extractOrganizationIdsByIndex(payload.organizations);
	for (const key of keys) {
		if (key in payload) {
			candidates.push(
				...collectCandidatesFromList(
					payload[key],
					source,
					resolveOrganizationOverridesForKey(
						key,
						payload[key],
						payloadCanonicalOrganizationIds,
					),
				),
			);
		}
	}

	const auth = payload[JWT_CLAIM_PATH];
	if (isRecord(auth)) {
		const canonicalOrganizationIds = extractCanonicalOrganizationIds(payload);
		for (const key of keys) {
			if (key in auth) {
				candidates.push(
					...collectCandidatesFromList(
						auth[key],
						source,
						resolveOrganizationOverridesForKey(
							key,
							auth[key],
							canonicalOrganizationIds,
						),
					),
				);
			}
		}
	}

	return candidates;
}

/**
 * Removes duplicate candidates by identity hierarchy.
 * organizationId -> accountId.
 */
function uniqueCandidates(candidates: AccountIdCandidate[]): AccountIdCandidate[] {
	const seen = new Set<string>();
	const result: AccountIdCandidate[] = [];
	for (const candidate of candidates) {
		const organizationId = candidate.organizationId?.trim();
		const accountId = candidate.accountId.trim();
		const key = organizationId
			? `organizationId:${organizationId}`
			: `accountId:${accountId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(candidate);
	}
	return result;
}

/**
 * Select the best workspace candidate for OAuth account binding.
 * Preference order:
 * 1) org default that is not personal
 * 2) org default (any)
 * 3) id_token candidate
 * 4) non-personal org candidate
 * 5) token candidate
 * 6) first candidate
 */
export function selectBestAccountCandidate(
	candidates: AccountIdCandidate[],
): AccountIdCandidate | undefined {
	if (candidates.length === 0) return undefined;

	const orgDefaultNonPersonal = candidates.find(
		(candidate) =>
			candidate.source === "org" && candidate.isDefault === true && candidate.isPersonal !== true,
	);
	if (orgDefaultNonPersonal) return orgDefaultNonPersonal;

	const orgDefault = candidates.find(
		(candidate) => candidate.source === "org" && candidate.isDefault === true,
	);
	if (orgDefault) return orgDefault;

	const idTokenCandidate = candidates.find(
		(candidate) => candidate.source === "id_token",
	);
	if (idTokenCandidate) return idTokenCandidate;

	const nonPersonalOrg = candidates.find(
		(candidate) => candidate.source === "org" && candidate.isPersonal !== true,
	);
	if (nonPersonalOrg) return nonPersonalOrg;

	const tokenCandidate = candidates.find(
		(candidate) => candidate.source === "token",
	);
	if (tokenCandidate) return tokenCandidate;

	return candidates[0];
}

/**
 * Extracts the ChatGPT account ID from a JWT access token.
 * @param accessToken - JWT access token from OAuth flow
 * @returns Account ID string or undefined if not found
 */
export function extractAccountId(accessToken?: string): string | undefined {
	if (!accessToken) return undefined;
	const decoded = decodeJWT(accessToken);
	const accountId = decoded?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
	return typeof accountId === "string" && accountId.trim() ? accountId : undefined;
}

/**
 * Extracts the account-scoped ChatGPT user id from an access token.
 *
 * Business workspace members share `chatgpt_account_id`, but each seat has a
 * distinct `chatgpt_account_user_id`. Keeping both values prevents the last
 * OAuth login for a workspace from replacing every member's credential.
 */
export function extractAccountUserId(accessToken?: string): string | undefined {
	if (!accessToken) return undefined;
	const decoded = decodeJWT(accessToken);
	const accountUserId = decoded?.[JWT_CLAIM_PATH]?.chatgpt_account_user_id;
	return typeof accountUserId === "string" && accountUserId.trim()
		? accountUserId.trim()
		: undefined;
}

/**
 * Extracts the email address from OAuth tokens.
 * Checks id_token first (where OpenAI puts email), then falls back to access_token.
 */
export function extractAccountEmail(accessToken?: string, idToken?: string): string | undefined {
	// Try id_token first - OpenAI puts email here
	if (idToken) {
		const idDecoded = decodeJWT(idToken);
		const idEmail = sanitizeClaimEmail(idDecoded?.email);
		if (idEmail) {
			return idEmail;
		}
	}

	// Fall back to access_token
	if (!accessToken) return undefined;
	const decoded = decodeJWT(accessToken);
	const nested = decoded?.[JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
	// The profile claim is the only email an access token carries on its own, so
	// it is what keeps the address recoverable on a refresh that returns no
	// id_token.
	const profile = decoded?.[JWT_PROFILE_CLAIM_PATH] as
		| Record<string, unknown>
		| undefined;
	const candidate =
		nested?.email ??
		nested?.chatgpt_user_email ??
		profile?.email ??
		decoded?.email ??
		decoded?.preferred_username;
	return sanitizeClaimEmail(candidate);
}

/**
 * Extracts all accountId candidates from access/id tokens.
 * Used to support business workspaces/organizations that are not the token default.
 */
export function getAccountIdCandidates(
	accessToken?: string,
	idToken?: string,
): AccountIdCandidate[] {
	const candidates: AccountIdCandidate[] = [];
	const accessId = extractAccountId(accessToken);
	if (accessId) {
		candidates.push({
			accountId: accessId,
			label: formatTokenCandidateLabel("Token account", accessId),
			source: "token",
			isDefault: true,
		});
	}

	if (accessToken) {
		const accessDecoded = decodeJWT(accessToken);
		candidates.push(...collectCandidatesFromPayload(accessDecoded, "org"));
	}

	if (idToken) {
		const decoded = decodeJWT(idToken);
		const primaryOrganizationId = extractPrimaryAuthClaimOrganizationId(decoded);
		const idAccountId = extractAccountIdFromPayload(decoded);
		if (idAccountId && idAccountId !== accessId) {
			candidates.push({
				accountId: idAccountId,
				organizationId: primaryOrganizationId,
				label: formatTokenCandidateLabel("ID token account", idAccountId),
				source: "id_token",
			});
		}
		candidates.push(...collectCandidatesFromPayload(decoded, "org"));
	}

	return uniqueCandidates(candidates);
}

/**
 * Determines if accountId should be updated from a token-derived value.
 * We keep org/manual selections stable across refreshes.
 */
export function shouldUpdateAccountIdFromToken(
	source: AccountIdSource | undefined,
	currentAccountId?: string,
): boolean {
	if (!currentAccountId) return true;
	if (!source) return true;
	return source === "token" || source === "id_token";
}

/**
 * Resolve which accountId to use for runtime API calls.
 * Preserves explicit org/manual selections; only token/id_token sources auto-follow token changes.
 */
export function resolveRequestAccountId(
	storedAccountId: string | undefined,
	source: AccountIdSource | undefined,
	tokenAccountId: string | undefined,
): string | undefined {
	if (!storedAccountId) return tokenAccountId;
	// Entries persisted before #226 carry an organization id as their accountId.
	// The Codex backend meters quota by the `chatgpt-account-id` header and
	// ignores organization ids outright, so sending one does not fail loudly -
	// it silently bills the token's default subscription, which is how two
	// workspace subscriptions collapsed onto a single pool. Prefer the token's
	// ChatGPT account id, which does route. `manual` is left alone: a
	// CODEX_AUTH_ACCOUNT_ID override is a deliberate user choice.
	//
	// This only redirects the request header. `shouldUpdateAccountIdFromToken`
	// still reports `false` for org-sourced entries so the *stored* selection
	// stays stable across refreshes.
	if (source === "org") return tokenAccountId ?? storedAccountId;
	if (!shouldUpdateAccountIdFromToken(source, storedAccountId)) {
		return storedAccountId;
	}
	return tokenAccountId ?? storedAccountId;
}

/**
 * Sanitizes an email address by stripping control characters, trimming
 * whitespace, and lowercasing.
 * @param email - Email string to sanitize
 * @returns Sanitized email or undefined if invalid
 */
export function sanitizeEmail(email: string | undefined): string | undefined {
	if (!email) return undefined;
	const cleaned = stripControlChars(email).trim();
	if (!cleaned || !cleaned.includes("@")) return undefined;
	return cleaned.toLowerCase();
}
