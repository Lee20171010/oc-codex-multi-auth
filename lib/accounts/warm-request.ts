/**
 * Real upstream "warm" request for issue #182.
 *
 * Sends a single minimal billable request to `POST /codex/responses` — the
 * same endpoint and request shape the live request path uses for its quota
 * probe — so the account's rolling usage window actually starts. A read-only
 * `GET /wham/usage` does NOT open the window (it only reports server-side
 * windows that already exist), so warming must send a genuine inference
 * request. The body is deliberately tiny (reasoning effort "none", verbosity
 * "low", no stored conversation) to keep the quota cost negligible, and mirrors
 * the proven quota-probe request shape used by the live request path.
 *
 * This module owns the network side-effect; the pure iteration/summary logic
 * lives in `warm.ts` and is injected this function via `codex-warm.ts`.
 */

import { CODEX_BASE_URL } from "../constants.js";
import {
	createCodexHeaders,
	getUnsupportedCodexModelInfo,
	resolveUnsupportedCodexFallbackModel,
	DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN,
} from "../request/fetch-helpers.js";
import { getReasoningConfig } from "../request/request-transformer.js";
import { readBoundedResponseText } from "../request/response-handler.js";
import { shapeBodyForModel } from "../request/helpers/responses-lite.js";
import { GPT_6_LUNA_MODEL_ID } from "../request/helpers/model-map.js";
import { sanitizeCodexApiErrorMessage } from "../codex-usage.js";
import { getCodexInstructions } from "../prompts/codex.js";
import { parseRateLimitReason } from "./rate-limits.js";
import type { RequestBody } from "../types.js";
import { createLogger } from "../logger.js";

const log = createLogger("warm-request");

/**
 * Model used for the warm ping.
 *
 * GPT-6 Luna: listed for every plan in the Codex catalog, and the cheapest
 * general tier. It replaced GPT-5.5, which OpenAI's Codex model docs retire
 * from Codex with ChatGPT sign-in on 2026-10-14; an anchor that stops working
 * would turn every warm ping into a fallback walk. An account outside the
 * GPT-6 rollout degrades onto gpt-5.6-luna through the shared chain.
 *
 * The HTTP 400 in #210 was the missing request content type, fixed in
 * `attemptWarm`, not the choice of model.
 */
const WARM_MODEL: string = GPT_6_LUNA_MODEL_ID;

/**
 * Absolute ceiling on warm attempts, independent of the chain's shape.
 *
 * `warm.ts` fans out across every enabled account concurrently, so attempts
 * multiply by the account count. This bounds the batch even if the shared
 * chain later grows a long tail.
 */
export const WARM_ATTEMPT_HARD_CEILING = 7;

let cachedMaxModelAttempts: number | undefined;

/**
 * How many models one warm ping will try before giving up (#210).
 *
 * Derived from the shared fallback chain rather than hardcoded, so extending
 * `DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN` cannot silently leave warming
 * unable to reach an entitled model at the end of the chain.
 *
 * Resolved on first call, not at module scope: `fetch-helpers` and this module
 * are mutually reachable through `codex-warm.ts`, so the chain is still
 * uninitialized while this module's top level runs.
 */
function getWarmMaxModelAttempts(): number {
	if (cachedMaxModelAttempts !== undefined) return cachedMaxModelAttempts;
	const seen = new Set<string>([WARM_MODEL]);
	const queue: string[] = [WARM_MODEL];
	while (queue.length > 0) {
		const current = queue.shift() as string;
		for (const target of DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN[current] ?? []) {
			if (seen.has(target)) continue;
			seen.add(target);
			queue.push(target);
		}
	}
	cachedMaxModelAttempts = Math.min(seen.size, WARM_ATTEMPT_HARD_CEILING);
	return cachedMaxModelAttempts;
}

/** Hard ceiling on a warm request so a hung upstream cannot wedge the batch. */
const WARM_TIMEOUT_MS = 15_000;

export interface WarmRequestParams {
	accountId: string;
	accessToken: string;
	organizationId: string | undefined;
	/** Override the timeout (tests). */
	timeoutMs?: number;
	/** Injectable fetch for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch;
}

/**
 * Build the minimal warm-ping request body. Exported for tests so the exact
 * shape (stream/store/reasoning) stays pinned.
 *
 * Instruction resolution is best-effort: a warm ping only needs a valid request
 * that opens the usage window, not the full Codex system prompt. If
 * `getCodexInstructions` cannot resolve the prompt (offline, cache miss, or the
 * bundled file is unavailable in a standalone CLI run), we fall back to a
 * minimal instruction so warming never fails on prompt-file resolution.
 */
export async function buildWarmRequestBody(model = WARM_MODEL): Promise<RequestBody> {
	let instructions: string;
	try {
		instructions = await getCodexInstructions(model);
	} catch (error) {
		log.debug("getCodexInstructions failed for warm ping; using minimal fallback", {
			error: error instanceof Error ? error.message : String(error),
		});
		instructions = "You are a helpful assistant.";
	}
	return {
		model,
		stream: true,
		store: false,
		include: ["reasoning.encrypted_content"],
		instructions,
		input: [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "warm ping" }],
			},
		],
		// The warm body is built outside the request transformer, so it asks the
		// transformer's canonical clamp what "none" resolves to on this model
		// rather than keeping its own copy of the rule. Sending "none" to a model
		// that rejects it is its own 400 — that would turn a fallback hop into a
		// fresh failure.
		reasoning: getReasoningConfig(model, {
			reasoningEffort: "none",
			reasoningSummary: "auto",
		}),
		text: { verbosity: "low" },
	};
}

/**
 * Outcome of a warm request.
 * - `opened`: the request started/confirmed the usage window (2xx, or a 429
 *   whose reason is a transient token/concurrency limit — the window is ticking).
 * - `exhausted`: a 429 whose reason is quota/usage-limit — the account's window
 *   is already spent, so warming it is meaningless. Reported distinctly so the
 *   tool does not claim a quota-dead account was "warmed".
 */
export type WarmRequestStatus = "opened" | "exhausted";

export interface WarmRequestResult {
	status: WarmRequestStatus;
	detail?: string;
	rateLimited?: boolean;
	model?: string;
}

/**
 * Result of a single model attempt. `unsupported-model` is the only outcome the
 * caller retries; everything else is terminal for the account.
 */
type WarmAttempt =
	| { kind: "opened"; rateLimited?: boolean }
	| { kind: "exhausted"; detail: string }
	| { kind: "unsupported-model"; errorBody: unknown; message: string };

/** Send one warm ping for exactly one model. */
async function attemptWarm(
	params: WarmRequestParams,
	model: string,
): Promise<WarmAttempt> {
	const doFetch = params.fetchImpl ?? fetch;
	const body = await buildWarmRequestBody(model);
	const headers = createCodexHeaders(undefined, params.accountId, params.accessToken, {
		model,
		organizationId: params.organizationId,
	});
	// `createCodexHeaders` never sets a content type: on the live request path it
	// wraps opencode's own `RequestInit`, which already carries one. Warming
	// builds its headers from nothing, and `fetch` defaults a string body to
	// `text/plain;charset=UTF-8`, which the backend rejects with
	// `400 {"detail":"Unsupported content type"}` before it ever looks at the
	// model (#210). Set it explicitly, as the other bodied POST caller
	// (`codex-reset.ts`) already does.
	headers.set("content-type", "application/json");

	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		params.timeoutMs ?? WARM_TIMEOUT_MS,
	);
	try {
		const response = await doFetch(`${CODEX_BASE_URL}/codex/responses`, {
			method: "POST",
			headers,
			// A fallback target may be a responses-lite model, which takes a
			// materially different wire shape than the classic body built above.
			body: JSON.stringify(shapeBodyForModel(body)),
			signal: controller.signal,
		});

		if (response.ok) {
			// Drain/cancel the SSE stream — we only needed to start the window.
			try {
				await response.body?.cancel();
			} catch {
				// Ignore cancellation failures.
			}
			return { kind: "opened" };
		}

		// Read the error body (small) BEFORE classifying so a 429 quota-exhausted
		// account is not mis-reported as warmed. Bounded + timed: `text()` used
		// to pull the whole body before slicing — a hostile multi-MB error body
		// (or a drip the outer abort ignores) had no bound.
		let bodyText = "";
		try {
			bodyText = (await readBoundedResponseText(response, {
				maxBytes: 2048,
				timeoutMs: params.timeoutMs ?? WARM_TIMEOUT_MS,
			})).slice(0, 2048);
		} catch {
			// Ignore body-read failures; fall back to status-only classification.
		}

		if (response.status === 429) {
			const reason = parseRateLimitReason(extractErrorCode(bodyText));
			if (reason === "quota") {
				log.debug("Warm ping hit 429 quota limit — account window already spent", {
					accountId: params.accountId,
				});
				return { kind: "exhausted", detail: "quota/usage limit reached" };
			}
			// token/concurrent/unknown → the window is active and ticking.
			log.debug("Warm ping hit 429 — window already active", {
				accountId: params.accountId,
				reason,
			});
			return { kind: "opened", rateLimited: true };
		}

		// The account is not entitled to `model`. The live request path degrades
		// down the shared fallback chain here rather than failing (#210); warming
		// does the same so an entitlement gap does not read as a broken account.
		//
		// Only an *entitlement* 400 is retryable. Gate on the same predicate
		// `resolveUnsupportedCodexFallbackModel` uses, so a transport-level 400
		// (malformed body, bad content type) is terminal instead of being
		// relabelled a model problem and burning a retry that cannot help.
		const message = sanitizeCodexApiErrorMessage(response.status, bodyText);
		if (response.status === 400) {
			const errorBody = parseErrorBody(bodyText);
			if (getUnsupportedCodexModelInfo(errorBody).isUnsupported) {
				return { kind: "unsupported-model", errorBody, message };
			}
		}

		throw new Error(`Warm request failed: ${message}`);
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Send a warm request to open the account's usage window.
 *
 * Resolves with `{ status: "opened" }` when the upstream started/confirmed the
 * window (2xx, or a non-quota 429 meaning the window is already active), or
 * `{ status: "exhausted" }` for a quota/usage-limit 429 (window already spent).
 * Any other non-2xx, or a network/timeout error, throws so the caller records
 * the account as failed.
 *
 * A 400 carrying `model_not_supported_with_chatgpt_account` is retried down the
 * shared unsupported-model fallback chain (bounded by
 * {@link getWarmMaxModelAttempts}) before the account is failed, mirroring the
 * live request path.
 */
export async function warmAccountWindow(
	params: WarmRequestParams,
): Promise<WarmRequestResult> {
	const attempted: string[] = [];
	let model = WARM_MODEL;
	let lastUnsupported: { kind: "unsupported-model"; errorBody: unknown; message: string } | undefined;

	const maxAttempts = getWarmMaxModelAttempts();
	for (let i = 0; i < maxAttempts; i += 1) {
		const attempt = await attemptWarm(params, model);
		if (attempt.kind === "opened") return attempt.rateLimited
			? { status: "opened", rateLimited: true, model }
			: { status: "opened", model };
		if (attempt.kind === "exhausted") {
			return { status: "exhausted", detail: attempt.detail };
		}

		lastUnsupported = attempt;
		attempted.push(model);
		const next = resolveUnsupportedCodexFallbackModel({
			requestedModel: model,
			errorBody: attempt.errorBody,
			attemptedModels: attempted,
			// A warm ping picks its own model, so there is no user selection to
			// respect — always take the chain when the backend rejects one.
			fallbackOnUnsupportedCodexModel: true,
			fallbackToGpt52OnUnsupportedGpt53: true,
		});
		if (!next) break;

		log.debug("Warm ping model not entitled — falling back", {
			accountId: params.accountId,
			from: model,
			to: next,
		});
		model = next;
	}

	const detail = attempted.length > 1 ? ` (tried ${attempted.join(", ")})` : "";
	throw new Error(
		`Warm request failed: ${lastUnsupported?.message ?? "HTTP 400"}${detail}`,
	);
}

/** Parse an error body as JSON so the shared matchers can read its fields. */
function parseErrorBody(bodyText: string): unknown {
	if (!bodyText) return undefined;
	try {
		return JSON.parse(bodyText) as unknown;
	} catch {
		// Non-JSON bodies still match on the raw text.
		return bodyText;
	}
}

/**
 * Pull a rate-limit error code/message out of a JSON or plain-text error body
 * so {@link parseRateLimitReason} can classify the 429. Best-effort: returns
 * the raw text when JSON parsing fails so substring matching still works.
 */
function extractErrorCode(bodyText: string): string | undefined {
	if (!bodyText) return undefined;
	try {
		const parsed = JSON.parse(bodyText) as {
			error?: { code?: string; type?: string; message?: string };
			code?: string;
		};
		return (
			parsed.error?.code ??
			parsed.error?.type ??
			parsed.error?.message ??
			parsed.code ??
			bodyText
		);
	} catch {
		return bodyText;
	}
}
