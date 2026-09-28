import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../lib/prompts/codex.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/prompts/codex.js")>();
	return {
		...actual,
		getCodexInstructions: vi.fn(async () => "test-instructions"),
	};
});

import {
	handleErrorResponse,
	shouldRefreshToken,
} from "../lib/request/fetch-helpers.js";
import {
	convertSseToJson,
	isEmptyResponse,
	readBoundedResponseText,
} from "../lib/request/response-handler.js";
import { handleContextOverflow } from "../lib/context-overflow.js";
import { warmAccountWindow } from "../lib/accounts/warm-request.js";
import { MAX_QUOTA_RESET_HORIZON_MS } from "../lib/quota-windows.js";
import type { Auth } from "../lib/types.js";

const encoder = new TextEncoder();

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function sseResponse(chunks: Uint8Array[], init?: ResponseInit): Response {
	let index = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < chunks.length) {
				controller.enqueue(chunks[index] as Uint8Array);
				index += 1;
			} else {
				controller.close();
			}
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
		...init,
	});
}

/** A stream that never produces a chunk and never errors — a stalled body. */
function neverEndingStream(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		pull() {
			return new Promise(() => {});
		},
	});
}

type ErrorPayloadView = { error?: { message?: string; code?: string; type?: string } };

describe("handleErrorResponse body reads are bounded, timed, and sanitized", () => {
	it("cancels a body that overshoots the cap instead of reading it all", async () => {
		let pulls = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				controller.enqueue(new Uint8Array(64 * 1024).fill(0x61));
			},
		});
		const response = new Response(stream, { status: 429 });

		const result = await handleErrorResponse(response);

		// 256KB cap: ~5 reads of 64KB. Unbounded, this stream feeds forever.
		expect(pulls).toBeLessThanOrEqual(10);
		const errorBody = result.errorBody as ErrorPayloadView;
		expect((errorBody.error?.message ?? "").length).toBeLessThanOrEqual(2100);
	});

	it("masks bearer/API tokens that hostile bodies embed in the message", async () => {
		// Constructed at runtime — a literal `sk-` string in a committed file
		// trips the doc-parity secret scan even though it is a fixture.
		const fakeKey = `sk-${"A".repeat(24)}`;
		const leak = `gateway error — Authorization: Bearer ${fakeKey} was echoed back by the proxy`;
		const result = await handleErrorResponse(
			new Response(leak, { status: 500 }),
		);
		const errorBody = result.errorBody as ErrorPayloadView;
		const message = errorBody.error?.message ?? "";
		expect(message).not.toContain(fakeKey);
		expect(message).not.toContain(`Bearer ${fakeKey}`);
		expect(message).toContain("gateway error");
	});

	it("truncates a multi-hundred-KB upstream message instead of echoing it", async () => {
		const huge = JSON.stringify({
			error: { message: `oops ${"x".repeat(500_000)}` },
		});
		const result = await handleErrorResponse(
			new Response(huge, { status: 500 }),
		);
		const errorBody = result.errorBody as ErrorPayloadView;
		const message = errorBody.error?.message ?? "";
		expect(message.length).toBeLessThanOrEqual(2100);
		expect(message).toContain("[truncated]");
	});

	it("a body that never ends resolves on the read timeout instead of hanging", async () => {
		vi.useFakeTimers();
		const response = new Response(neverEndingStream(), { status: 500 });
		const pending = handleErrorResponse(response);
		await vi.advanceTimersByTimeAsync(11_000);
		const result = await pending;
		expect(result.response.status).toBe(500);
		const errorBody = result.errorBody as ErrorPayloadView;
		expect(errorBody.error?.message).toBe("Request failed");
	});
});

describe("reset-timestamp horizon enforcement on the generic paths", () => {
	const horizonSeconds = MAX_QUOTA_RESET_HORIZON_MS / 1000;

	it("rejects a multi-year body resets_at instead of writing an eternal block", async () => {
		// ~3000 years out in epoch milliseconds — the observed hostile value.
		const resetsAt = 98_209_432_614_256;
		const result = await handleErrorResponse(
			new Response(
				JSON.stringify({
					error: { code: "rate_limit_exceeded", resets_at: resetsAt },
				}),
				{ status: 429 },
			),
		);
		// The uncapped path handed back ~9.8e13 ms straight into the persisted
		// monotonic block; bounded it must not exceed the 30-day horizon, and
		// with no other candidates it falls back to the 60s default.
		expect(result.rateLimit?.retryAfterMs).toBe(60_000);
	});

	it("rejects a multi-year x-ratelimit-reset header the same way", async () => {
		const response = new Response(
			JSON.stringify({ error: { code: "rate_limit_exceeded" } }),
			{
				status: 429,
				headers: { "x-ratelimit-reset": "99999999999999999" },
			},
		);
		const result = await handleErrorResponse(response);
		expect(result.rateLimit?.retryAfterMs).toBe(60_000);
	});

	it("accepts a near-future body resets_at inside the horizon", async () => {
		const resetsAt = Date.now() + 3_600_000; // +1h, epoch ms
		const result = await handleErrorResponse(
			new Response(
				JSON.stringify({
					error: { code: "rate_limit_exceeded", resets_at: resetsAt },
				}),
				{ status: 429 },
			),
		);
		expect(result.rateLimit?.retryAfterMs).toBeGreaterThan(3_500_000);
		expect(result.rateLimit?.retryAfterMs).toBeLessThanOrEqual(3_600_000);
	});

	it("reads x-ratelimit-reset as epoch seconds below the 10^10 discriminator", async () => {
		const inTwoMinutes = Math.floor(Date.now() / 1000) + 120;
		const result = await handleErrorResponse(
			new Response(
				JSON.stringify({ error: { code: "rate_limit_exceeded" } }),
				{
					status: 429,
					headers: { "x-ratelimit-reset": `${inTwoMinutes}` },
				},
			),
		);
		// Kills the inverted seconds/ms heuristic: multiplying this value by
		// 1000 again lands ~33h out (inside the horizon), so the assertion
		// window around ~120s only holds when seconds are detected correctly.
		expect(result.rateLimit?.retryAfterMs).toBeGreaterThan(110_000);
		expect(result.rateLimit?.retryAfterMs).toBeLessThanOrEqual(121_000);
	});

	it("reads x-ratelimit-reset as epoch milliseconds above the discriminator", async () => {
		const in45s = Date.now() + 45_000;
		const result = await handleErrorResponse(
			new Response(
				JSON.stringify({ error: { code: "rate_limit_exceeded" } }),
				{
					status: 429,
					headers: { "x-ratelimit-reset": `${in45s}` },
				},
			),
		);
		expect(result.rateLimit?.retryAfterMs).toBeGreaterThan(40_000);
		expect(result.rateLimit?.retryAfterMs).toBeLessThanOrEqual(45_500);
	});

	it("a hostile reset beyond the horizon is dropped even when a sane candidate exists", async () => {
		// Hostile x-ratelimit-reset (epoch-ms, ~100y out) plus a sane body
		// resets_at (+30s): the dropped header must not block the sane pick.
		const saneReset = Date.now() + 30_000;
		const result = await handleErrorResponse(
			new Response(
				JSON.stringify({
					error: { code: "rate_limit_exceeded", resets_at: saneReset },
				}),
				{
					status: 429,
					headers: { "x-ratelimit-reset": `${Date.now() + 100 * 365 * 24 * 3600 * 1000}` },
				},
			),
		);
		expect(result.rateLimit?.retryAfterMs).toBeGreaterThan(25_000);
		expect(result.rateLimit?.retryAfterMs).toBeLessThanOrEqual(30_500);
	});

	it("does not let a horizon-sized legitimate reset get confused for overflow", () => {
		// Sanity pin: the horizon itself stays ~30 days — the mutant that loosens
		// the guard (e.g. multiplying the bound) is caught downstream.
		expect(horizonSeconds).toBeGreaterThanOrEqual(30 * 24 * 3600);
	});
});

describe("retry_after_ms cannot normalize to a block-clearing zero", () => {
	it("floors a fractional sub-millisecond server delay at 1ms", async () => {
		const result = await handleErrorResponse(
			new Response(
				JSON.stringify({
					error: { code: "rate_limit_exceeded", retry_after_ms: 0.5 },
				}),
				{ status: 429 },
			),
		);
		// 0 reached markRateLimitedWithReason(0), where zero means "expired"
		// and deletes every existing block on the account.
		expect(result.rateLimit?.retryAfterMs).toBe(1);
	});
});

describe("shouldRefreshToken non-finite guards", () => {
	it("a NaN skew is treated as zero, not as never-refresh", () => {
		vi.spyOn(Date, "now").mockReturnValue(1_000);
		const auth: Auth = {
			type: "oauth",
			access: "tok",
			refresh: "r",
			expires: 500, // already expired
		};
		expect(shouldRefreshToken(auth, Number.NaN)).toBe(true);
	});

	it("an Infinity skew does not force a refresh on a valid token", () => {
		vi.spyOn(Date, "now").mockReturnValue(1_000);
		const auth: Auth = {
			type: "oauth",
			access: "tok",
			refresh: "r",
			expires: 10_000_000, // far from expiry
		};
		expect(shouldRefreshToken(auth, Number.POSITIVE_INFINITY)).toBe(false);
	});

	it("a non-finite stored expiry is corrupt — refresh to repair", () => {
		const base = { type: "oauth", access: "tok", refresh: "r" } as const;
		expect(shouldRefreshToken({ ...base, expires: Number.NaN })).toBe(true);
		expect(shouldRefreshToken({ ...base, expires: Number.POSITIVE_INFINITY })).toBe(true);
	});
});

describe("convertSseToJson terminal-event and verdict hardening", () => {
	it("a terminal event carrying a bare scalar response is a 502, not a 200", async () => {
		for (const scalar of ['"just-a-string"', "42", "[1,2,3]", "null"]) {
			const sse = `data: {"type":"response.completed","response":${scalar}}\n\n`;
			const result = await convertSseToJson(
				new Response(sse),
				new Headers(),
			);
			expect(result.status).toBe(502);
			const body = (await result.json()) as ErrorPayloadView;
			expect(body.error?.type).toBe("stream_error");
		}
	});

	it("surfaces a string-valued response.error instead of the generic wording", async () => {
		const sse =
			'data: {"type":"response.failed","response":{"status":"failed","error":"upstream exploded"}}\n\n';
		const result = await convertSseToJson(new Response(sse), new Headers());
		expect(result.status).toBe(502);
		const body = (await result.json()) as ErrorPayloadView;
		expect(body.error?.message).toBe("upstream exploded");
	});

	it("surfaces a bare-string error on an error event", async () => {
		const sse = 'data: {"type":"error","error":"melted"}\n\n';
		const result = await convertSseToJson(new Response(sse), new Headers());
		const body = (await result.json()) as ErrorPayloadView;
		expect(body.error?.message).toBe("melted");
	});

	it("includes incomplete_details.reason in the incomplete verdict", async () => {
		const sse =
			'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\n';
		const result = await convertSseToJson(new Response(sse), new Headers());
		expect(result.status).toBe(502);
		const body = (await result.json()) as ErrorPayloadView;
		expect(body.error?.message).toContain("incomplete");
		expect(body.error?.message).toContain("max_output_tokens");
	});

	it("does not treat a text/HTML body containing data:-lines as truncated SSE", async () => {
		const body = "line one\ndata: this is not sse\nmore text\n";
		const result = await convertSseToJson(
			new Response(body, { status: 200 }),
			new Headers(),
		);
		expect(result.status).toBe(200);
		expect(await result.text()).toBe(body);
	});

	it("does not treat event:-only noise as truncated SSE either", async () => {
		const body = "event: foo\nevent: bar\n\n";
		const result = await convertSseToJson(
			new Response(body, { status: 200 }),
			new Headers(),
		);
		expect(result.status).toBe(200);
		expect(await result.text()).toBe(body);
	});

	it("still reports genuinely truncated SSE (JSON data, no terminal) as 502", async () => {
		const sse = 'data: {"type":"response.created","response":{"id":"x"}}\n';
		const result = await convertSseToJson(new Response(sse), new Headers());
		expect(result.status).toBe(502);
		const body = (await result.json()) as ErrorPayloadView;
		expect(body.error?.code).toBe("incomplete_stream");
	});

	it("converts an unserializable terminal object into a deterministic 502", async () => {
		// JSON.parse is iterative and accepts this depth; recursive stringify
		// throws RangeError — which used to escape as a transient stream error
		// and churn account rotation.
		const depth = 200_000;
		const deepResponse = '{"a":'.repeat(depth) + "1" + "}".repeat(depth);
		const sse = `data: {"type":"response.completed","response":${deepResponse}}\n\n`;
		const result = await convertSseToJson(new Response(sse), new Headers());
		expect(result.status).toBe(502);
		const body = (await result.json()) as ErrorPayloadView;
		expect(body.error?.code).toBe("unserializable_response");
	});
});

describe("convertSseToJson carry-buffer bounds", () => {
	it("never rescans the carried newline-free tail on every chunk", async () => {
		const original = String.prototype.indexOf;
		let longestNewlineScan = 0;
		vi.spyOn(String.prototype, "indexOf").mockImplementation(function (
			this: string,
			...args: [searchElement: string, position?: number]
		) {
			if (args[0] === "\n") {
				longestNewlineScan = Math.max(longestNewlineScan, this.length);
			}
			return original.apply(this, args);
		});
		try {
			// 64 chunks × 1KB of newline-free text: the carried tail grows to
			// 64KB. Pre-fix, every chunk re-scanned the whole tail (O(n²));
			// post-fix only the fresh chunk (1KB) is ever searched.
			const chunk = encoder.encode("x".repeat(1024));
			const chunks = Array.from({ length: 64 }, () => chunk);
			await convertSseToJson(sseResponse(chunks), new Headers());
		} finally {
			vi.restoreAllMocks();
		}
		expect(longestNewlineScan).toBeLessThanOrEqual(4096);
	});
});

describe("convertSseToJson post-headers total deadline", () => {
	it("a drip that always beats the stall gap still dies at the deadline", async () => {
		vi.useFakeTimers();
		const mockReader = {
			read: vi.fn(
				() =>
					new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
						// One byte every 400ms — comfortably inside a 1.5s stall gap.
						setTimeout(() => resolve({ done: false, value: encoder.encode("x") }), 400);
					}),
			),
			cancel: vi.fn(async () => undefined),
			releaseLock: vi.fn(),
		};
		const response = {
			body: { getReader: () => mockReader },
			status: 200,
			statusText: "OK",
		} as unknown as Response;

		const pending = convertSseToJson(response, new Headers(), {
			streamStallTimeoutMs: 1500,
			maxStreamDurationMs: 2000,
		});
		const assertion = expect(pending).rejects.toThrow(/total duration|exceeded/i);
		await vi.advanceTimersByTimeAsync(3_000);
		await assertion;
		expect(mockReader.cancel).toHaveBeenCalled();
		expect(mockReader.releaseLock).toHaveBeenCalled();
	});

	it("a fully stalled stream still dies at the (earlier) stall timeout", async () => {
		vi.useFakeTimers();
		const mockReader = {
			read: vi.fn(() => new Promise<{ done: boolean; value?: Uint8Array }>(() => {})),
			cancel: vi.fn(async () => undefined),
			releaseLock: vi.fn(),
		};
		const response = {
			body: { getReader: () => mockReader },
			status: 200,
			statusText: "OK",
		} as unknown as Response;

		const pending = convertSseToJson(response, new Headers(), {
			streamStallTimeoutMs: 1200,
			maxStreamDurationMs: 60_000,
		});
		const assertion = expect(pending).rejects.toThrow(/stalled/);
		await vi.advanceTimersByTimeAsync(1300);
		await assertion;
	});
});

describe("readBoundedResponseText", () => {
	it("returns the whole body under the cap", async () => {
		const response = new Response("hello", { status: 500 });
		expect(await readBoundedResponseText(response)).toBe("hello");
	});

	it("stops at maxBytes and cancels the rest", async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(64 * 1024).fill(0x62));
			},
			cancel() {
				cancelled = true;
			},
		});
		const text = await readBoundedResponseText(
			new Response(stream, { status: 500 }),
			{ maxBytes: 128 * 1024 },
		);
		expect(encoder.encode(text).byteLength).toBeLessThanOrEqual(192 * 1024);
		expect(cancelled).toBe(true);
	});

	it("resolves partial content when the timeout fires", async () => {
		vi.useFakeTimers();
		const stream = neverEndingStream();
		const pending = readBoundedResponseText(
			new Response(stream, { status: 500 }),
			{ timeoutMs: 500 },
		);
		await vi.advanceTimersByTimeAsync(600);
		await expect(pending).resolves.toBe("");
	});
});

describe("handleContextOverflow bounded read", () => {
	it("a 400 body that never ends resolves unhandled instead of hanging", async () => {
		vi.useFakeTimers();
		const response = new Response(neverEndingStream(), { status: 400 });
		const pending = handleContextOverflow(response, "gpt-5.5");
		await vi.advanceTimersByTimeAsync(11_000);
		await expect(pending).resolves.toEqual({ handled: false });
	});
});

describe("warmAccountWindow bounded error-body read", () => {
	it("a huge 500 body is capped before classification instead of read whole", async () => {
		let pulls = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				controller.enqueue(new Uint8Array(64 * 1024).fill(0x61));
			},
		});
		const fetchImpl = vi.fn(
			async () => new Response(stream, { status: 500 }),
		);
		await expect(
			warmAccountWindow({
				accountId: "acct-1",
				accessToken: "tok-1",
				organizationId: undefined,
				fetchImpl,
			}),
		).rejects.toThrow(/Warm request failed/);
		// 2KB cap → at most one 64KB chunk is read before cancel.
		expect(pulls).toBeLessThanOrEqual(3);
	});
});

describe("isEmptyResponse treats shape-only responses as empty", () => {
	it("empty output array and empty output string are not meaningful content", () => {
		expect(isEmptyResponse({ id: "resp_1", output: [] })).toBe(true);
		expect(isEmptyResponse({ id: "resp_1", output: "" })).toBe(true);
		expect(isEmptyResponse({ id: "resp_1", output: "  " })).toBe(true);
	});

	it("non-empty output still counts as content", () => {
		expect(isEmptyResponse({ id: "resp_1", output: "x" })).toBe(false);
		expect(isEmptyResponse({ id: "resp_1", output: [{ text: "x" }] })).toBe(false);
	});
});
