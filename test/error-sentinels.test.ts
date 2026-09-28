import { describe, expect, it } from "vitest";
import {
	createDeactivatedWorkspaceError,
	createUsageRequestTimeoutError,
	DEACTIVATED_WORKSPACE_ERROR_CODE,
	isDeactivatedWorkspaceErrorMessage,
	isInvalidatedAuthTokenMessage,
	isUsageRequestTimeoutMessage,
	USAGE_REQUEST_TIMEOUT_MESSAGE,
} from "../lib/error-sentinels.js";
import { CodexAuthError, CodexTimeoutError, ErrorCode } from "../lib/errors.js";

describe("error sentinels", () => {
	it("creates stable sentinel errors for workspace deactivation and usage timeouts", () => {
		const deactivatedWorkspaceError = createDeactivatedWorkspaceError();
		const usageTimeoutError = createUsageRequestTimeoutError();

		expect(deactivatedWorkspaceError.message).toBe(DEACTIVATED_WORKSPACE_ERROR_CODE);
		expect(isDeactivatedWorkspaceErrorMessage(deactivatedWorkspaceError.message)).toBe(true);
		expect(isDeactivatedWorkspaceErrorMessage("workspace-deactivated")).toBe(false);

		expect(usageTimeoutError.message).toBe(USAGE_REQUEST_TIMEOUT_MESSAGE);
		expect(isUsageRequestTimeoutMessage(usageTimeoutError.message)).toBe(true);
		expect(isUsageRequestTimeoutMessage("request timed out")).toBe(false);
	});

	it("returns typed errors so code/instanceof classification works without the message", () => {
		const deactivatedWorkspaceError = createDeactivatedWorkspaceError();
		const usageTimeoutError = createUsageRequestTimeoutError();

		expect(deactivatedWorkspaceError).toBeInstanceOf(CodexAuthError);
		expect(deactivatedWorkspaceError.code).toBe(ErrorCode.AUTH_ERROR);
		expect(deactivatedWorkspaceError.retryable).toBe(false);

		expect(usageTimeoutError).toBeInstanceOf(CodexTimeoutError);
		expect(usageTimeoutError.code).toBe(ErrorCode.TIMEOUT);
	});

	it("matches the token-invalidated auth error message (issue #171)", () => {
		// The exact upstream message, with and without the plugin's appended hint.
		expect(
			isInvalidatedAuthTokenMessage(
				"Your authentication token has been invalidated. Please try signing in again.",
			),
		).toBe(true);
		expect(
			isInvalidatedAuthTokenMessage(
				"Your authentication token has been invalidated. Please try signing in again. (run `opencode auth login` if this persists)",
			),
		).toBe(true);
		// The "sign in again" branch requires explicit token/credential context.
		expect(
			isInvalidatedAuthTokenMessage("Your auth token is no longer valid, please sign in again."),
		).toBe(true);

		// Must not match unrelated errors — including a bare "sign in again"
		// that can come from generic session-expiry / workspace-lock / license
		// bodies on the status-less probe path.
		expect(isInvalidatedAuthTokenMessage("Please sign in again")).toBe(false);
		expect(isInvalidatedAuthTokenMessage("Your session has expired. Please sign in again.")).toBe(false);
		expect(isInvalidatedAuthTokenMessage("Rate limit exceeded")).toBe(false);
		expect(isInvalidatedAuthTokenMessage("The server had an error")).toBe(false);
		expect(isInvalidatedAuthTokenMessage(undefined)).toBe(false);
		expect(isInvalidatedAuthTokenMessage("")).toBe(false);
	});
});
