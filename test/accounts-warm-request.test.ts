import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prompts/codex.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/prompts/codex.js")>();
	return {
		...actual,
		getCodexInstructions: vi.fn(async () => "test-instructions"),
	};
});

import {
	buildWarmRequestBody,
	warmAccountWindow,
	WARM_ATTEMPT_HARD_CEILING,
} from "../lib/accounts/warm-request.js";
import { DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN } from "../lib/request/fetch-helpers.js";
import { getReasoningConfig } from "../lib/request/request-transformer.js";
import { CODEX_BASE_URL } from "../lib/constants.js";

function fakeResponse(status: number, bodyText = ""): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		body: { cancel: vi.fn(async () => undefined) },
		text: vi.fn(async () => bodyText),
	} as unknown as Response;
}

const PARAMS = {
	accountId: "acct-1",
	accessToken: "tok-1",
	organizationId: undefined as string | undefined,
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("buildWarmRequestBody (#182)", () => {
	it("builds a minimal billable /responses body", async () => {
		const body = await buildWarmRequestBody();
		expect(body.model).toBe("gpt-6-luna");
		expect(body.stream).toBe(true);
		expect(body.store).toBe(false);
		// gpt-6-luna rejects "none"; the transformer's clamp sends "low".
		expect(body.reasoning).toEqual({ effort: "low", summary: "auto" });
		expect(body.input?.[0]).toMatchObject({ role: "user", type: "message" });
	});

	// Not every reachable model accepts "none" any more: the chain now ends in
	// the 5.6 tiers, which reject it and clamp to "low". What must hold is that
	// warming never puts an effort on the wire that the target model refuses.
	it("sends a backend-valid effort for every model the default chain can reach", async () => {
		for (const model of reachableFromWarmEntry()) {
			const body = await buildWarmRequestBody(model);
			expect(body.reasoning).toEqual(
				getReasoningConfig(model, {
					reasoningEffort: "none",
					reasoningSummary: "auto",
				}),
			);
			expect(body.reasoning?.effort).not.toBe("ultra");
		}
	});

	it("clamps effort to 'low' for a model that rejects 'none' (#210)", async () => {
		const body = await buildWarmRequestBody("gpt-5.6-sol");
		expect(body.reasoning).toMatchObject({ effort: "low" });
	});

	it("derives its effort from the transformer's canonical clamp, not a local copy", async () => {
		for (const model of [
			"gpt-5.5",
			"gpt-5.4",
			"gpt-5.4-mini",
			"gpt-5.4-nano",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
			"gpt-6-sol",
			"gpt-6-luna",
			"gpt-5.2",
			"gpt-5.4-pro",
			"gpt-5-codex",
		]) {
			const body = await buildWarmRequestBody(model);
			expect(body.reasoning).toEqual(
				getReasoningConfig(model, {
					reasoningEffort: "none",
					reasoningSummary: "auto",
				}),
			);
		}
	});
});

function reachableFromWarmEntry(): string[] {
	const reachable = new Set<string>(["gpt-6-luna"]);
	const queue = ["gpt-6-luna"];
	while (queue.length > 0) {
		const current = queue.shift() as string;
		for (const target of DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN[current] ?? []) {
			if (reachable.has(target)) continue;
			reachable.add(target);
			queue.push(target);
		}
	}
	return [...reachable];
}

describe("warm fallback chain invariants (#210)", () => {
	it("the attempt budget covers every model reachable from the warm entry point", () => {
		const reachable = reachableFromWarmEntry();
		// If this fails the default chain grew a tail past the warm attempt
		// budget, so warming would stop before reaching an entitled model.
		expect(reachable.length).toBeLessThanOrEqual(WARM_ATTEMPT_HARD_CEILING);
		expect(reachable).toEqual([
			"gpt-6-luna",
			"gpt-5.6-luna",
			"gpt-6.1-sol",
			"gpt-6-sol",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.5",
		]);
	});

	// gpt-5.4 and gpt-5.4-mini were retired from Codex on 2026-08-31 (catalog
	// `visibility: "hide"` plus an `upgrade` directive naming their
	// replacements), and gpt-5.4-nano has no catalog entry. Warming must not
	// spend its bounded budget on ids OpenAI has withdrawn.
	it("reaches no retired model from the warm entry point", () => {
		for (const model of reachableFromWarmEntry()) {
			expect(model.startsWith("gpt-5.4")).toBe(false);
		}
	});
});

describe("warmAccountWindow (#182)", () => {
	it("POSTs to /codex/responses with auth headers and returns true on 2xx", async () => {
		const fetchImpl = vi.fn(async () => fakeResponse(200));
		const result = await warmAccountWindow({ ...PARAMS, fetchImpl });
		expect(result.status).toBe("opened");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${CODEX_BASE_URL}/codex/responses`);
		expect(init.method).toBe("POST");
		const headers = init.headers as Headers;
		expect(headers.get("Authorization")).toBe("Bearer tok-1");
		expect(headers.get("chatgpt-account-id")).toBe("acct-1");
	});

	it("treats a token/concurrency 429 as opened (window already active)", async () => {
		const fetchImpl = vi.fn(async () =>
			fakeResponse(429, JSON.stringify({ error: { code: "rate_limit_exceeded" } })),
		);
		const result = await warmAccountWindow({ ...PARAMS, fetchImpl });
		expect(result.status).toBe("opened");
	});

	it("treats a quota/usage-limit 429 as exhausted (NOT warmed)", async () => {
		const fetchImpl = vi.fn(async () =>
			fakeResponse(429, JSON.stringify({ error: { code: "usage_limit_reached" } })),
		);
		const result = await warmAccountWindow({ ...PARAMS, fetchImpl });
		expect(result.status).toBe("exhausted");
		expect(result.detail).toMatch(/quota|usage/i);
	});

	it("treats a bare 429 with no parseable reason as opened", async () => {
		const fetchImpl = vi.fn(async () => fakeResponse(429, ""));
		const result = await warmAccountWindow({ ...PARAMS, fetchImpl });
		expect(result.status).toBe("opened");
	});

	it("throws on other non-2xx (e.g. 401)", async () => {
		const fetchImpl = vi.fn(async () => fakeResponse(401));
		await expect(warmAccountWindow({ ...PARAMS, fetchImpl })).rejects.toThrow(/HTTP 401/);
	});

	it("throws on a 500", async () => {
		const fetchImpl = vi.fn(async () => fakeResponse(500));
		await expect(warmAccountWindow({ ...PARAMS, fetchImpl })).rejects.toThrow(/HTTP 500/);
	});

	it("cancels the SSE stream body on success", async () => {
		const cancel = vi.fn(async () => undefined);
		const fetchImpl = vi.fn(
			async () =>
				({ ok: true, status: 200, body: { cancel } }) as unknown as Response,
		);
		await warmAccountWindow({ ...PARAMS, fetchImpl });
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("propagates a network error from fetch", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("ECONNRESET");
		});
		await expect(warmAccountWindow({ ...PARAMS, fetchImpl })).rejects.toThrow(/ECONNRESET/);
	});

	it("does not pin openai-organization by default (Codex CLI parity, #196)", async () => {
		const fetchImpl = vi.fn(async () => fakeResponse(200));
		await warmAccountWindow({ ...PARAMS, organizationId: "org-9", fetchImpl });
		const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Headers;
		expect(headers.get("openai-organization")).toBeNull();
	});

	it("falls back down the model chain on an unsupported-model 400 (#210)", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				fakeResponse(
					400,
					JSON.stringify({
						error: { code: "model_not_supported_with_chatgpt_account" },
					}),
				),
			)
			.mockResolvedValueOnce(fakeResponse(200));

		const result = await warmAccountWindow({ ...PARAMS, fetchImpl });

		expect(result.status).toBe("opened");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const firstBody = JSON.parse(
			(fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string,
		);
		const secondBody = JSON.parse(
			(fetchImpl.mock.calls[1] as [string, RequestInit])[1].body as string,
		);
		expect(firstBody.model).toBe("gpt-6-luna");
		expect(secondBody.model).toBe("gpt-5.6-luna");
	});

	it("stops after the bounded attempt budget when no model is entitled (#210)", async () => {
		const unsupported = () =>
			fakeResponse(
				400,
				JSON.stringify({
					error: { code: "model_not_supported_with_chatgpt_account" },
				}),
			);
		const fetchImpl = vi.fn(async () => unsupported());

		await expect(warmAccountWindow({ ...PARAMS, fetchImpl })).rejects.toThrow(
			/tried gpt-6-luna, gpt-5\.6-luna, gpt-6\.1-sol, gpt-6-sol, gpt-5\.6-sol, gpt-5\.6-terra, gpt-5\.5/,
		);
		expect(fetchImpl).toHaveBeenCalledTimes(7);
	});

	it("does not retry a 400 that is not an entitlement error, and surfaces its detail", async () => {
		const fetchImpl = vi.fn(async () =>
			fakeResponse(400, JSON.stringify({ error: { message: "bad input" } })),
		);

		await expect(warmAccountWindow({ ...PARAMS, fetchImpl })).rejects.toThrow(
			/HTTP 400.*bad input/,
		);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("sends content-type: application/json on the warm POST (#210)", async () => {
		const fetchImpl = vi.fn(async () => fakeResponse(200));
		await warmAccountWindow({ ...PARAMS, fetchImpl });
		const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Headers;
		expect(headers.get("content-type")).toBe("application/json");
	});

	it("puts a JSON content type on the wire, not fetch's text/plain default (#210)", async () => {
		const fetchImpl = vi.fn(async () => fakeResponse(200));
		await warmAccountWindow({ ...PARAMS, fetchImpl });
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];

		// Asserting on `init.headers` alone cannot catch the original bug: when no
		// content type is set, `fetch` silently stamps `text/plain;charset=UTF-8`
		// on a string body and the backend answers
		// `400 {"detail":"Unsupported content type"}`. Materializing the real
		// Request pins what actually leaves the process.
		const wire = new Request(url, { ...init, headers: init.headers });
		expect(wire.headers.get("content-type")).toBe("application/json");
		expect(wire.headers.get("content-type")).not.toMatch(/text\/plain/);
		expect(() => JSON.parse(init.body as string)).not.toThrow();
	});

	it("fails fast on the backend's 'Unsupported content type' 400 (#210)", async () => {
		// The exact body reported on #210 after the v6.11.1 fix. It is not an
		// entitlement error, so warming must surface it as-is rather than sweep
		// the fallback chain and blame the model.
		const fetchImpl = vi.fn(async () =>
			fakeResponse(400, JSON.stringify({ detail: "Unsupported content type" })),
		);

		await expect(warmAccountWindow({ ...PARAMS, fetchImpl })).rejects.toThrow(
			/HTTP 400.*Unsupported content type/,
		);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("redacts bearer tokens leaked in an error body", async () => {
		const fetchImpl = vi.fn(async () =>
			fakeResponse(401, "Bearer sk-secret-token-value"),
		);
		await expect(warmAccountWindow({ ...PARAMS, fetchImpl })).rejects.toThrow(
			/Bearer \[redacted\]/,
		);
	});

	it("passes organizationId into the request headers when CODEX_AUTH_SEND_ORGANIZATION_HEADER=1", async () => {
		try {
			vi.stubEnv("CODEX_AUTH_SEND_ORGANIZATION_HEADER", "1");
			const fetchImpl = vi.fn(async () => fakeResponse(200));
			await warmAccountWindow({ ...PARAMS, organizationId: "org-9", fetchImpl });
			const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
			const headers = init.headers as Headers;
			expect(headers.get("openai-organization")).toBe("org-9");
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
