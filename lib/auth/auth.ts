import { randomBytes, webcrypto } from "node:crypto";
import type { PKCEPair, AuthorizationFlow, TokenResult, JWTPayload } from "../types.js";
import { logError, maskString } from "../logger.js";
import {
	OAUTH_CALLBACK_PATH,
	OAUTH_CALLBACK_PORT,
} from "../oauth-constants.js";
import { safeParseOAuthTokenResponse } from "../schemas.js";
export {
	SCOPE,
	REQUIRED_OAUTH_SCOPES,
	getMissingRequiredOAuthScopes,
	hasRequiredOAuthScopes,
} from "./scopes.js";
import { normalizeScope, SCOPE } from "./scopes.js";

// OAuth constants (from openai/codex)
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const TOKEN_URL = "https://auth.openai.com/oauth/token";
// The current Codex OAuth client registration expects localhost in the
// authorize redirect_uri, while the callback server still binds the concrete
// 127.0.0.1 loopback interface for local-only listening.
export const REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;

/**
 * Classification of manually pasted authorization input.
 *
 * `raw` means the value could not be read as a callback URL, query string, or
 * fragment, so it is returned byte for byte as an opaque authorization code and
 * never carries state. Every other source is structured callback input, where
 * `code` and `state` are exactly what the callback supplied.
 */
export type AuthorizationInputParseResult =
	| {
		readonly source: "raw";
		readonly code: string | undefined;
		readonly state: undefined;
	}
	| {
		readonly source: "url" | "query" | "fragment";
		readonly code: string | undefined;
		readonly state: string | undefined;
	};

// An authorization code is opaque and may contain a colon, so a value that only
// looks like a URL ("ac:1a2b3c") must fall back to the raw path instead of being
// reported as a callback that carries no code.
const ABSOLUTE_URL_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

// A query string opens with a parameter name followed by "=". Anything else
// ("Zm9vYmFy&state=x") is an opaque code that happens to contain "&".
const QUERY_STRING_PREFIX = /^[^\s&=?#/]+=/;

/**
 * Parse a URL, reporting failure as undefined instead of throwing.
 *
 * Every rejection is treated the same on purpose: this runs inside the
 * interactive login prompt, where an unexpected error class must degrade to
 * "treat the value as a raw code" rather than escape the prompt.
 */
function tryParseUrl(value: string): URL | undefined {
	try {
		return new URL(value);
	} catch {
		return undefined;
	}
}

/**
 * Cap for upstream error bodies. The token endpoint's error body is untrusted
 * text that flows into the user-facing `TokenResult.message` (and the log
 * line), so it is both truncated and run through the credential masker before
 * it leaves this module.
 */
const UPSTREAM_BODY_LIMIT = 120;

function sanitizeUpstreamBody(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "";
	const truncated =
		trimmed.length > UPSTREAM_BODY_LIMIT
			? `${trimmed.slice(0, UPSTREAM_BODY_LIMIT)}...`
			: trimmed;
	return maskString(truncated);
}

/**
 * Read `code` and `state` from a callback, preferring the query string and
 * falling back to the fragment for whichever value the query omitted.
 */
function readCallbackParams(
	query: URLSearchParams,
	fragment: string,
): { code: string | undefined; state: string | undefined } {
	const code = query.get("code") ?? undefined;
	const state = query.get("state") ?? undefined;
	if (!fragment || (code !== undefined && state !== undefined)) {
		return { code, state };
	}
	const fragmentParams = new URLSearchParams(fragment);
	return {
		code: code ?? fragmentParams.get("code") ?? undefined,
		state: state ?? fragmentParams.get("state") ?? undefined,
	};
}

/**
 * Generate a random state value for OAuth flow
 * @returns Random hex string
 */
export function createState(): string {
	return randomBytes(16).toString("hex");
}

/**
 * Parse the authorization code and state out of manually pasted input.
 *
 * Accepts a full callback URL (values in the query string, in the fragment, or
 * split across both), a callback URL pasted without its scheme, a bare query
 * string, a bare `#code=...&state=...` fragment, the `code#state` shorthand,
 * and an opaque authorization code on its own. Values are returned exactly as
 * pasted: the shorthand and raw paths never percent-encode or normalise them.
 *
 * @param input - User input (callback URL, query string, fragment, code#state, or a bare code)
 * @returns The parsed values and the `source` they were recognised from, where
 *   `source: "raw"` marks an opaque code that carries no callback state
 */
export function parseAuthorizationInput(input: string): AuthorizationInputParseResult {
	const value = (input || "").trim();
	if (!value) {
		return { source: "raw", code: undefined, state: undefined };
	}

	const url = tryParseUrl(value);
	if (url) {
		const { code, state } = readCallbackParams(url.searchParams, url.hash.slice(1));
		// Without a "scheme://" prefix this may be an opaque code that merely
		// parsed as a URL, so only claim it when it actually carried a value.
		if (code !== undefined || state !== undefined || ABSOLUTE_URL_PREFIX.test(value)) {
			return { source: "url", code, state };
		}
	}

	if (value.startsWith("#")) {
		const fragmentParams = new URLSearchParams(value.slice(1));
		if (fragmentParams.has("code") || fragmentParams.has("state")) {
			return {
				source: "fragment",
				code: fragmentParams.get("code") ?? undefined,
				state: fragmentParams.get("state") ?? undefined,
			};
		}
		// "#abc123" names no parameter. The prompt asks for a code, so return it
		// as one rather than filing it under state where it can never match.
		return { source: "raw", code: value.slice(1) || undefined, state: undefined };
	}

	// Callback URL pasted without its scheme, e.g. "127.0.0.1:1455/auth/callback?code=...".
	const queryIndex = value.indexOf("?");
	if (queryIndex >= 0) {
		const afterQuery = value.slice(queryIndex + 1);
		const boundary = afterQuery.indexOf("#");
		const { code, state } = readCallbackParams(
			new URLSearchParams(boundary >= 0 ? afterQuery.slice(0, boundary) : afterQuery),
			boundary >= 0 ? afterQuery.slice(boundary + 1) : "",
		);
		if (code !== undefined || state !== undefined) {
			return { source: "url", code, state };
		}
	}

	// "code#state" shorthand, split on the raw bytes. Routing this through URL
	// would percent-encode the values, collapse "..", and truncate at "?". A
	// value that looks like a URL but failed to parse is a malformed URL rather
	// than a shorthand, so it is left for the raw path below.
	const fragmentIndex = value.indexOf("#");
	if (fragmentIndex >= 0 && !ABSOLUTE_URL_PREFIX.test(value)) {
		return {
			source: "fragment",
			code: value.slice(0, fragmentIndex) || undefined,
			state: value.slice(fragmentIndex + 1),
		};
	}

	if (QUERY_STRING_PREFIX.test(value)) {
		const params = new URLSearchParams(value);
		if (params.has("code") || params.has("state")) {
			return {
				source: "query",
				code: params.get("code") ?? undefined,
				state: params.get("state") ?? undefined,
			};
		}
	}

	return { source: "raw", code: value, state: undefined };
}

/**
 * Exchange authorization code for access and refresh tokens
 * @param code - Authorization code from OAuth flow
 * @param verifier - PKCE verifier
 * @param redirectUri - OAuth redirect URI
 * @returns Token result
 */
export async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	redirectUri: string = REDIRECT_URI,
): Promise<TokenResult> {
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		}),
	});
	if (!res.ok) {
		const text = sanitizeUpstreamBody(await res.text().catch(() => ""));
		logError(`code->token failed: ${res.status} ${text}`);
		return { type: "failed", reason: "http_error", statusCode: res.status, message: text || undefined };
	}
	const rawJson = (await res.json()) as unknown;
	const json = safeParseOAuthTokenResponse(rawJson);
	if (!json) {
		logError("token response validation failed", rawJson);
		return { type: "failed", reason: "invalid_response", message: "Response failed schema validation" };
	}
	return {
		type: "success",
		access: json.access_token,
		refresh: json.refresh_token ?? "",
		expires: Date.now() + json.expires_in * 1000,
		idToken: json.id_token,
		// A blank `scope` must fall back to what we actually requested, not be
		// stored verbatim: `??` lets an empty string through, and that empty
		// string then overwrites known-good scope metadata downstream
		// (`result.scope ?? existing.oauthScope`). See issue #213.
		scope: normalizeScope(json.scope) ?? SCOPE,
		multiAccount: true,
	};
}

/**
 * Decode a JWT token to extract payload
 * @param token - JWT token to decode
 * @returns Decoded payload or null if invalid
 */
export function decodeJWT(token: string): JWTPayload | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payload = parts[1] ?? "";
		const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized.padEnd(
			normalized.length + ((4 - (normalized.length % 4)) % 4),
			"=",
		);
		const decoded = Buffer.from(padded, "base64").toString("utf-8");
		return JSON.parse(decoded) as JWTPayload;
	} catch {
		return null;
	}
}

/**
 * Refresh access token using refresh token
 * @param refreshToken - Refresh token
 * @returns Token result
 */
export async function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
	try {
		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: CLIENT_ID,
			}),
		});

		if (!response.ok) {
			const text = sanitizeUpstreamBody(await response.text().catch(() => ""));
			logError(`Token refresh failed: ${response.status} ${text}`);
			return { type: "failed", reason: "http_error", statusCode: response.status, message: text || undefined };
		}

		const rawJson = (await response.json()) as unknown;
		const json = safeParseOAuthTokenResponse(rawJson);
		if (!json) {
			logError("Token refresh response validation failed", rawJson);
			return { type: "failed", reason: "invalid_response", message: "Response failed schema validation" };
		}

		const nextRefresh = json.refresh_token ?? refreshToken;
		if (!nextRefresh) {
			logError("Token refresh missing refresh token");
			return { type: "failed", reason: "missing_refresh", message: "No refresh token in response or input" };
		}

		return {
			type: "success",
			access: json.access_token,
			refresh: nextRefresh,
			expires: Date.now() + json.expires_in * 1000,
			idToken: json.id_token,
			...(json.scope ? { scope: json.scope } : {}),
			multiAccount: true,
		};
	} catch (error) {
		const err = error as Error;
		logError("Token refresh error", err);
		return {
			type: "failed",
			reason: "network_error",
			// Keep the Node error text for diagnosability, masked — a network
			// error string can carry credential-shaped fragments (e.g. a request
			// body echoed by a proxy error).
			message: typeof err?.message === "string" ? maskString(err.message) : undefined,
		};
	}
}

export interface AuthorizationFlowOptions {
	/**
	 * Force a fresh login screen instead of using cached browser session.
	 * Use when adding multiple accounts to ensure different credentials.
	 */
	forceNewLogin?: boolean;
}

/**
 * Generate an RFC 7636 S256 PKCE pair.
 *
 * Previously `generatePKCE` from `@openauthjs/openauth/pkce`. That package was
 * pulled in for this one function and dragged `hono` into the production tree
 * as a peer dependency - which is the only reason `hono` was a direct
 * dependency and an override here - carrying advisories that could not be
 * cleared without it.
 *
 * Semantics are preserved exactly:
 *   - 64 random bytes, base64url-encoded, giving an 86-character verifier
 *     (RFC 7636 allows 43-128).
 *   - challenge = base64url(SHA-256(ASCII(verifier))).
 *   - The upstream helper also returned `method: "S256"`; nothing read it.
 *     {@link PKCEPair} is `{ challenge, verifier }` and the request hardcodes
 *     `code_challenge_method=S256` below.
 *
 * Both encoders emit unpadded base64url, so the wire format is unchanged.
 */
async function generatePKCE(): Promise<PKCEPair> {
	const verifier = randomBytes(64).toString("base64url");
	const digest = await webcrypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	return { verifier, challenge: Buffer.from(digest).toString("base64url") };
}

/**
 * Create OAuth authorization flow
 * @param options - Optional configuration for the flow
 * @returns Authorization flow details
 */
export async function createAuthorizationFlow(options?: AuthorizationFlowOptions): Promise<AuthorizationFlow> {
	const pkce = await generatePKCE();
	const state = createState();

	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", CLIENT_ID);
	url.searchParams.set("redirect_uri", REDIRECT_URI);
	url.searchParams.set("scope", SCOPE);
	url.searchParams.set("code_challenge", pkce.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	url.searchParams.set("id_token_add_organizations", "true");
	url.searchParams.set("codex_cli_simplified_flow", "true");
	url.searchParams.set("originator", "codex_cli_rs");

	// Force a fresh login screen when adding multiple accounts
	// This helps prevent the browser from auto-using an existing session
	if (options?.forceNewLogin) {
		url.searchParams.set("prompt", "login");
	}

	return { pkce, state, url: url.toString() };
}
