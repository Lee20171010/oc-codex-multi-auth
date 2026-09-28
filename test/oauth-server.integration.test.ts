/**
 * Integration test for OAuth server flow
 * Tests the local HTTP callback server used for OAuth authentication
 */
import { describe, it, expect, afterAll, afterEach, beforeAll } from "vitest";
import http from "node:http";
import { startLocalOAuthServer } from "../lib/auth/server.js";
import { REDIRECT_URI } from "../lib/auth/auth.js";
import { startLoopbackFlow } from "../lib/auth/loopback-flow.js";
import { acquireOAuthPortLock } from "./helpers/oauth-port-lock.js";

describe("OAuth Server Integration", () => {
	let serverInfo: Awaited<ReturnType<typeof startLocalOAuthServer>> | null = null;
	let openSession: { close: () => void } | null = null;
	// This suite binds the real port 1455, and so does test/chaos/auth-faults.
	// Vitest schedules files in parallel, so without the lock whichever suite
	// loses the race sees ready=false and fails.
	let releasePort: (() => Promise<void>) | null = null;

	beforeAll(async () => {
		releasePort = await acquireOAuthPortLock();
	});

	afterAll(async () => {
		await releasePort?.();
		releasePort = null;
	});

	afterEach(() => {
		if (serverInfo) {
			serverInfo.close();
			serverInfo = null;
		}
		if (openSession) {
			openSession.close();
			openSession = null;
		}
	});

	it("should start server and handle valid OAuth callback", async () => {
		const testState = "test-state-12345";
		serverInfo = await startLocalOAuthServer({ state: testState });

		expect(serverInfo.ready).toBe(true);
		expect(serverInfo.port).toBe(1455);

		// Simulate OAuth callback
		const testCode = "auth-code-67890";
		const callbackUrl = `http://127.0.0.1:1455/auth/callback?code=${testCode}&state=${testState}`;

		const response = await fetch(callbackUrl);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");

		const contentSecurityPolicy = response.headers.get("content-security-policy");
		expect(contentSecurityPolicy).toContain("default-src 'none'");
		expect(contentSecurityPolicy).toContain("script-src 'none'");
		expect(contentSecurityPolicy).toContain("frame-ancestors 'none'");

		const nonce = contentSecurityPolicy?.match(/style-src 'nonce-([^']+)'/)?.[1];
		expect(nonce).toBeTruthy();

		const body = await response.text();
		expect(body).toContain(`<style nonce="${nonce}">`);
		expect(body).toContain("Authentication complete");
		expect(body).toContain("You can close this tab.");
		expect(body).not.toContain("<script");
		expect(body).not.toContain("fonts.googleapis.com");
		expect(body).not.toMatch(/\\u[0-9a-f]{4}/i);

		// Server should have captured the code
		const result = await serverInfo.waitForCode(testState);
		expect(result).toEqual({ code: testCode });
	});

	it("should reject callback with wrong state", async () => {
		const testState = "correct-state";
		serverInfo = await startLocalOAuthServer({ state: testState });

		expect(serverInfo.ready).toBe(true);

		const callbackUrl = `http://127.0.0.1:1455/auth/callback?code=test&state=wrong-state`;
		const response = await fetch(callbackUrl);
		expect(response.status).toBe(400);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(response.headers.get("cache-control")).toContain("no-store");

		const csp = response.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("script-src 'none'");
		const nonce = csp.match(/style-src 'nonce-([^']+)'/)?.[1];
		expect(nonce).toBeTruthy();

		const body = await response.text();
		expect(body).toContain("Sign-in link mismatch");
		expect(body).toContain(`<style nonce="${nonce}">`);
		expect(body).toContain("restart the login flow");
		expect(body).not.toContain("<script");
	});

	it("should reject callback without code", async () => {
		const testState = "test-state";
		serverInfo = await startLocalOAuthServer({ state: testState });

		expect(serverInfo.ready).toBe(true);

		const callbackUrl = `http://127.0.0.1:1455/auth/callback?state=${testState}`;
		const response = await fetch(callbackUrl);
		expect(response.status).toBe(400);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(response.headers.get("cache-control")).toContain("no-store");

		const body = await response.text();
		expect(body).toContain("Missing authorization code");
		expect(body).toContain("restart the login flow");
		expect(body).not.toContain("<script");
	});

	it("should return 404 for non-callback paths", async () => {
		const testState = "test-state";
		serverInfo = await startLocalOAuthServer({ state: testState });

		expect(serverInfo.ready).toBe(true);

		const response = await fetch("http://127.0.0.1:1455/other-path");
		expect(response.status).toBe(404);
	});

	it("should handle server cleanup properly", async () => {
		const testState = "cleanup-test";
		serverInfo = await startLocalOAuthServer({ state: testState });

		expect(serverInfo.ready).toBe(true);

		// Close should work without error
		serverInfo.close();

		// Subsequent requests should fail (server closed)
		await expect(
			fetch("http://127.0.0.1:1455/auth/callback?code=test&state=test")
		).rejects.toThrow();

		serverInfo = null; // Prevent double-close in afterEach
	});

	it("captures a provider-shaped redirect on the real listener without the host awaiting first", async () => {
		// Given a ready manual-browser session on the real callback listener,
		// with only the network exchange stubbed
		const exchange = { code: "", verifier: "", redirectUri: "" };
		const session = await startLoopbackFlow({
			openBrowser: false,
			deps: {
				exchangeAuthorizationCode: async (code, verifier, redirectUri) => {
					exchange.code = code;
					exchange.verifier = verifier;
					exchange.redirectUri = redirectUri ?? "";
					return { type: "success", access: "a", refresh: "r", expires: 1 };
				},
			},
		});
		if (session.type !== "ready") {
			throw new Error(`expected ready session, got ${session.type}`);
		}
		openSession = session;
		const state = new URL(session.url).searchParams.get("state");
		expect(state).toBeTruthy();

		// When the browser follows the provider redirect back to loopback, in the
		// parameter shape the real provider sends, before the host calls back
		const providerCode = "ac_ZmFrZS1hdXRoLWNvZGU.ZmFrZS1zaWduYXR1cmU";
		const response = await fetch(
			`http://127.0.0.1:1455/auth/callback?code=${providerCode}&scope=openid+profile+email+offline_access&state=${state}`,
		);

		// Then the eagerly started observation already holds it, and the exchange
		// stays bound to this attempt's verifier and redirect URI
		expect(response.status).toBe(200);
		const result = await session.waitAndExchange();
		expect(result.type).toBe("success");
		expect(exchange.code).toBe(providerCode);
		expect(exchange.redirectUri).toBe(REDIRECT_URI);
		expect(exchange.verifier.length).toBeGreaterThanOrEqual(43);

		openSession = null;
	});

	it("releases the real port once the redirect lands, without the host ever calling back", async () => {
		// Given a ready session the host takes a URL from and then abandons
		const session = await startLoopbackFlow({
			openBrowser: false,
			deps: {
				exchangeAuthorizationCode: async () => {
					throw new Error("exchange must not run for an abandoned session");
				},
			},
		});
		if (session.type !== "ready") {
			throw new Error(`expected ready session, got ${session.type}`);
		}
		openSession = session;
		const state = new URL(session.url).searchParams.get("state");

		// When the browser delivers the callback and waitAndExchange is never called
		const response = await fetch(
			`http://127.0.0.1:1455/auth/callback?code=ac_abandoned.signature&scope=openid+profile+email+offline_access&state=${state}`,
		);
		expect(response.status).toBe(200);

		// Then the observation started at session creation closes the listener on
		// its own, so the port is free for the next attempt
		await expect
			.poll(
				async () => {
					try {
						await fetch("http://127.0.0.1:1455/auth/callback?code=x&state=y");
						return "open";
					} catch {
						return "closed";
					}
				},
				{ timeout: 5000 },
			)
			.toBe("closed");

		openSession = null;
	});
});
