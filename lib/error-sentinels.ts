/**
 * Sentinel error codes and factory/matcher helpers.
 *
 * These sentinels are the runtime contract between throwing code paths (e.g.
 * request pipeline, usage tracking) and the orchestrator in `index.ts` that
 * inspects error messages to decide on account rotation, cooldown, and retry
 * behaviour. Keeping the sentinel string and its create/match helpers in one
 * module guarantees producers and consumers cannot drift apart.
 *
 * This module is pure: it performs no I/O, persistence, or logging, so
 * centralizing these values does not introduce new Windows lock or
 * token-redaction surfaces.
 */
import { CodexAuthError, CodexTimeoutError } from "./errors.js";

export const DEACTIVATED_WORKSPACE_ERROR_CODE = "deactivated_workspace";
export const USAGE_REQUEST_TIMEOUT_MESSAGE = "Usage request timed out";

/**
 * Matches the "authentication token has been invalidated" auth failure that the
 * Codex/OpenAI backend returns (HTTP 401) when a stored account's access token
 * has been revoked server-side — for example after the user re-runs
 * `opencode auth login` on another machine.
 *
 * This is the *request-path* counterpart to the token-refresh failure path: the
 * stored access token can still look unexpired locally, so no proactive refresh
 * fires, yet the upstream rejects it mid-request. The orchestrator in `index.ts`
 * and the `codex-health`/`codex-doctor` probe use this matcher to treat such a
 * response as an account-health failure (cool down + rotate / flag) instead of
 * bubbling the 401 straight back to the caller and pinning every request to the
 * dead account slot.
 *
 * The pattern tolerates the "(run `opencode auth login` if this persists)" hint
 * the plugin appends to 401 bodies and minor wording variants.
 *
 * The second branch deliberately requires an explicit token/credential keyword
 * before "sign in again": this matcher is also used on the status-less
 * codex-health/codex-doctor probe path, where a bare "please sign in again"
 * could otherwise come from a generic session-expiry, workspace-lock, or
 * license error (e.g. a 402/403 body) and wrongly flag a healthy account as
 * token-invalid.
 */
export const INVALIDATED_AUTH_TOKEN_MESSAGE_PATTERN =
	/token has been invalidated|(?:authentication|auth|access|session|login)\s+token\b[^.]*\bsign(?:ing)?[\s-]*in again/i;

export function isInvalidatedAuthTokenMessage(message: string | undefined): boolean {
	if (!message) return false;
	return INVALIDATED_AUTH_TOKEN_MESSAGE_PATTERN.test(message);
}

/**
 * The sentinel factories return typed errors (`CodexAuthError` /
 * `CodexTimeoutError`) so `err.code` and `instanceof` classify correctly for
 * consumers that never see the message. The message strings stay byte-identical
 * to the sentinels — the `is*Message` matchers and every `err.message`-based
 * consumer keep working unchanged.
 */
export function createDeactivatedWorkspaceError(): CodexAuthError {
	return new CodexAuthError(DEACTIVATED_WORKSPACE_ERROR_CODE, {
		retryable: false,
	});
}

export function isDeactivatedWorkspaceErrorMessage(message: string | undefined): boolean {
	return message === DEACTIVATED_WORKSPACE_ERROR_CODE;
}

export function createUsageRequestTimeoutError(): CodexTimeoutError {
	return new CodexTimeoutError(USAGE_REQUEST_TIMEOUT_MESSAGE);
}

export function isUsageRequestTimeoutMessage(message: string | undefined): boolean {
	return message === USAGE_REQUEST_TIMEOUT_MESSAGE;
}
