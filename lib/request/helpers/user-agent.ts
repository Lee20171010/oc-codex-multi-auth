/**
 * Codex CLI client-identity parity for backend requests.
 *
 * The ChatGPT Codex backend derives the client version from the `User-Agent`
 * product token (codex-rs `login/src/auth/default_client.rs`,
 * `get_codex_user_agent()`), and model catalog entries carry a
 * `minimal_client_version` gate — `0.144.0` for the gpt-5.6 tiers. We already
 * declare `originator: codex_cli_rs`; without a matching UA the backend sees a
 * versionless client and can reject preview-gated models with
 * `model_not_supported_with_chatgpt_account` even for entitled accounts (#196).
 *
 * Upstream format:
 *   codex_cli_rs/<version> (<os> <os version>; <arch>) <terminal>
 */
import os from "node:os";

/**
 * Version advertised in the User-Agent product token and model-list query.
 * The model-list rollout also depends on this version: 0.160.1 includes
 * GPT-6.1 Sol even though its reported minimum client version is lower.
 * Override with CODEX_AUTH_CLIENT_VERSION when the backend rollout advances.
 */
export const DEFAULT_CODEX_CLIENT_VERSION = "0.160.1";

const PLATFORM_LABELS: Record<string, string> = {
	win32: "Windows",
	darwin: "Mac OS",
	linux: "Linux",
};

/** Upstream sanitizes the UA to printable ASCII; mirror that. */
function sanitizeToken(value: string): string {
	return value.replace(/[^\x20-\x7e]/g, "").trim();
}

/**
 * Versions live in the UA product token (`name/version`), where a space would
 * split the token and break the backend's version parse. Keep only characters
 * that are safe in a product-token version; an empty result falls back to the
 * caller's default.
 */
export function sanitizeVersionToken(value: string): string {
	return value.replace(/[^0-9A-Za-z.+_-]/g, "");
}

export function buildCodexUserAgent(): string {
	const envVersion = process.env.CODEX_AUTH_CLIENT_VERSION;
	const version =
		(envVersion ? sanitizeVersionToken(envVersion) : "") ||
		DEFAULT_CODEX_CLIENT_VERSION;
	const platform = PLATFORM_LABELS[os.platform()] ?? os.platform();
	const release = sanitizeToken(os.release());
	const arch = os.arch();
	return `codex_cli_rs/${version} (${platform} ${release}; ${arch}) unknown`;
}
