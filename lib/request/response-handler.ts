import { RequestError } from "../errors.js";
import { createLogger, logRequest, LOGGING_ENABLED } from "../logger.js";

import type { SSEEventData } from "../types.js";

const log = createLogger("response-handler");

const MAX_SSE_SIZE = 10 * 1024 * 1024; // 10MB limit to prevent memory exhaustion
const DEFAULT_STREAM_STALL_TIMEOUT_MS = 45_000;
/**
 * Overall post-headers deadline for a non-streaming SSE conversion.
 *
 * The stall timer only measures the gap *between* reads and is re-armed on
 * every chunk, so a drip that always lands just inside the window (a byte
 * per 44s under the 45s default) used to hang the conversion forever. This
 * deadline is armed once and never re-armed.
 */
const DEFAULT_MAX_STREAM_DURATION_MS = 5 * 60_000;
const STREAM_ERROR_CODE = "stream_error";

/** Defaults for {@link readBoundedResponseText}. */
const DEFAULT_BOUNDED_READ_MAX_BYTES = 256 * 1024;
const DEFAULT_BOUNDED_READ_TIMEOUT_MS = 10_000;

/**
 * Read a response body with a hard byte cap and a total timeout.
 *
 * `Response.text()` keeps pulling until the stream ends: a hostile or broken
 * upstream can make it buffer unboundedly (150MB bodies were observed) or
 * never finish (a slow drip defeats nothing — nothing was armed). This reader
 * stops at `maxBytes` or `timeoutMs`, cancels the rest of the stream so
 * backpressure reaches the socket, and returns whatever arrived — a
 * truncated body still feeds the downstream parsers/classifiers.
 *
 * Bodies that are not byte streams (test doubles, exotic implementations)
 * fall back to `text()` — still char-capped — since there is nothing to
 * cancel.
 */
export async function readBoundedResponseText(
	response: Response,
	options?: { maxBytes?: number; timeoutMs?: number },
): Promise<string> {
	const maxBytes = Math.max(
		1,
		Math.floor(options?.maxBytes ?? DEFAULT_BOUNDED_READ_MAX_BYTES),
	);
	const timeoutMs = options?.timeoutMs ?? DEFAULT_BOUNDED_READ_TIMEOUT_MS;
	const body = response.body as ReadableStream<Uint8Array> | null;
	if (!body || typeof body.getReader !== "function") {
		const text = await response.text();
		return text.length > maxBytes ? text.slice(0, maxBytes) : text;
	}

	const reader = body.getReader();
	const parts: Uint8Array[] = [];
	let received = 0;
	let stop = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	// One shared deadline raced against every read: it never re-arms, so a
	// drip that keeps "progressing" cannot extend it.
	const timedOut = new Promise<"timeout">((resolve) => {
		if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
			timer = setTimeout(() => resolve("timeout"), timeoutMs);
		}
	});
	try {
		while (!stop) {
			const result = await Promise.race([reader.read(), timedOut]);
			if (result === "timeout") {
				stop = true;
				break;
			}
			if (result.done || !result.value) break;
			parts.push(result.value);
			received += result.value.byteLength;
			if (received >= maxBytes) {
				stop = true;
			}
		}
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (stop) {
			// Release the source so the upstream stops uploading a body nobody
			// will read further. Do NOT await: on a cloned (tee'd) body the
			// cancel promise only resolves once the sibling branch cancels
			// too, and the original body is deliberately left for callers —
			// awaiting it would deadlock. The cancellation itself takes effect
			// synchronously, which is what stops the pulls.
			void reader.cancel().catch(() => {});
		}
		reader.releaseLock();
	}

	const kept = Math.min(received, maxBytes);
	const merged = new Uint8Array(kept);
	let offset = 0;
	for (const part of parts) {
		if (offset >= kept) break;
		const slice = part.subarray(0, kept - offset);
		merged.set(slice, offset);
		offset += slice.length;
	}
	return new TextDecoder().decode(merged);
}

type ParsedSseResult =
	| {
			kind: "response";
			response: unknown;
	  }
	| {
			kind: "error";
			error: {
				message: string;
				type?: string;
				code?: string | number;
			};
	  };

function toRecord(value: unknown): Record<string, unknown> | null {
	// `Array.isArray` matters: an array-typed `response`/`error` used to pass
	// this check, letting `[1,2,3]` flow through as the terminal response and
	// surface to the caller as a 200 carrying odd JSON.
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return null;
}

function extractErrorFromRecord(errorRecord: Record<string, unknown> | null): {
	message: string;
	type?: string;
	code?: string | number;
} | null {
	if (!errorRecord) return null;
	const message =
		typeof errorRecord.message === "string" ? errorRecord.message.trim() : "";
	if (!message) return null;
	const type = typeof errorRecord.type === "string" ? errorRecord.type : undefined;
	const rawCode = errorRecord.code;
	const code =
		typeof rawCode === "string" || typeof rawCode === "number"
			? rawCode
			: undefined;

	return { message, type, code };
}

function extractStreamError(event: SSEEventData): {
	message: string;
	type?: string;
	code?: string | number;
} {
	const rawError = (event as { error?: unknown }).error;
	const parsedError = extractErrorFromRecord(toRecord(rawError));
	if (parsedError) return parsedError;
	// Some upstreams emit `error` as a bare string instead of an object —
	// that IS the failure detail, and silently dropping it turned a real
	// verdict into the generic "emitted an error event" wording.
	if (typeof rawError === "string" && rawError.trim()) {
		return { message: rawError.trim() };
	}

	const eventMessage = (event as { message?: unknown }).message;
	const message =
		(typeof eventMessage === "string" ? eventMessage.trim() : "") ||
		"Codex stream emitted an error event";
	return { message };
}

function extractResponseError(responseRecord: Record<string, unknown>): {
	message: string;
	type?: string;
	code?: string | number;
} | null {
	const status = typeof responseRecord.status === "string" ? responseRecord.status : "";
	const rawError = (responseRecord as { error?: unknown }).error;
	const parsedError = extractErrorFromRecord(toRecord(rawError));
	if (parsedError) return parsedError;
	if (typeof rawError === "string" && rawError.trim()) {
		return { message: rawError.trim() };
	}
	if (status === "failed" || status === "incomplete") {
		// `incomplete_details.reason` is the only diagnosis an incomplete
		// response carries (e.g. max_output_tokens) — don't drop it.
		const details = toRecord(responseRecord.incomplete_details);
		const reason =
			details && typeof details.reason === "string" ? details.reason.trim() : "";
		return {
			message: reason
				? `Codex stream ended with status: ${status} (${reason})`
				: `Codex stream ended with status: ${status}`,
		};
	}
	return null;
}

function parseDataPayload(line: string): string | null {
	if (!line.startsWith("data:")) return null;
	const payload = line.slice(5).trimStart();
	if (!payload || payload === "[DONE]") return null;
	return payload;
}

/**
 * Quoted `"type"` values the branches in {@link processSsePayload} can act
 * on. Delta/status events — the vast majority of SSE traffic — never carry
 * one, so this substring gate lets them skip JSON.parse entirely. A false
 * positive (e.g. `response.done` inside delta text) only costs the parse it
 * would have run anyway; a false negative is impossible because every
 * handled type is listed verbatim.
 */
const SSE_RESULT_MARKER_PATTERN =
	/"(?:response\.(?:done|completed|failed|incomplete|error)|error)"/;

/**
 * Parse SSE stream to extract final response
 * @param sseText - Complete SSE stream text
 * @returns Final response object or null if not found
 */
function processSsePayload(payload: string): ParsedSseResult | null {
	if (!payload || payload === "[DONE]") return null;
	if (!SSE_RESULT_MARKER_PATTERN.test(payload)) return null;
	try {
		const data = JSON.parse(payload) as SSEEventData;
		const responseRecord = toRecord((data as { response?: unknown }).response);

		if (data.type === "error" || data.type === "response.error") {
			const parsedError = extractStreamError(data);
			log.error("SSE error event received", { error: parsedError });
			return { kind: "error", error: parsedError };
		}

		if (data.type === "response.failed" || data.type === "response.incomplete") {
			const parsedError =
				(responseRecord && extractResponseError(responseRecord)) ??
				extractStreamError(data);
			log.error("SSE response terminal error event received", {
				type: data.type,
				error: parsedError,
			});
			return { kind: "error", error: parsedError };
		}

		if (data.type === "response.done" || data.type === "response.completed") {
			if (responseRecord) {
				const parsedError = extractResponseError(responseRecord);
				if (parsedError) {
					log.error("SSE response completed with terminal error", {
						error: parsedError,
						status: responseRecord.status,
					});
					return { kind: "error", error: parsedError };
				}
				return { kind: "response", response: data.response };
			}
			// A terminal event whose `response` is absent or a bare scalar/array
			// is malformed: returning it verbatim surfaced odd 200s (`"x"`,
			// `42`, `[1,2,3]`) that callers then treated as real responses.
			return {
				kind: "error",
				error: {
					message:
						"Codex stream terminal event carried no response object",
				},
			};
		}
	} catch {
		// Skip malformed JSON
	}
	return null;
}

/**
 * Convert SSE stream response to JSON for generateText()
 * @param response - Fetch response with SSE stream
 * @param headers - Response headers
 * @param options - Optional `streamStallTimeoutMs` (floored at 1000ms,
 *   inter-chunk gap) and `maxStreamDurationMs` (floored at 1000ms, total
 *   post-headers deadline that a drip cannot keep resetting)
 * @returns Response with JSON body
 */
export async function convertSseToJson(
	response: Response,
	headers: Headers,
	options?: { streamStallTimeoutMs?: number; maxStreamDurationMs?: number },
): Promise<Response> {
	if (!response.body) {
		throw new RequestError('[openai-codex-plugin] Response has no body', {
			code: 'NO_RESPONSE_BODY',
		});
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const textEncoder = new TextEncoder();
	// Chunks are collected and joined once — accumulating into a single
	// string is quadratic on multi-MB streams. They are only retained while
	// reachable: request logging wants the full body, and the no-SSE
	// passthrough needs it only until the stream has proven to be SSE.
	const textParts: string[] = [];
	// Leftover buffer: only text after the last complete line is held over
	// for the next chunk, instead of re-splitting the whole stream per chunk.
	let pendingText = '';
	// Scan cursor into pendingText: everything below it is already known to
	// contain no '\n'. Without it each drain rescanned the whole carried tail
	// — O(tail) per chunk made a stream of tiny chunks quadratic, and the
	// pathological single-byte-chunk case flattened an ever-growing rope
	// until the heap died.
	let pendingScanFrom = 0;
	let totalBytes = 0;
	let sawSseLine = false;
	const assertWithinLimit = (): void => {
		if (totalBytes > MAX_SSE_SIZE) {
			throw new RequestError(`SSE response exceeds ${MAX_SSE_SIZE} bytes limit`, {
				code: 'SSE_TOO_LARGE',
				context: { maxBytes: MAX_SSE_SIZE, actualBytes: totalBytes },
			});
		}
	};
	const streamStallTimeoutMs = Math.max(
		1_000,
		Math.floor(options?.streamStallTimeoutMs ?? DEFAULT_STREAM_STALL_TIMEOUT_MS),
	);
	const maxStreamDurationMs = Math.max(
		1_000,
		Math.floor(options?.maxStreamDurationMs ?? DEFAULT_MAX_STREAM_DURATION_MS),
	);

	// Incremental WHATWG-SSE event folding: consecutive `data:` lines of one
	// event concatenate with "\n" and dispatch on a blank line. Each line is
	// also tried on its own before the joined form, so a stream that omits
	// the blank-line separator between events still parses. The first
	// terminal/error event wins and stops the read.
	const dataLines: string[] = [];
	let parsedResult: ParsedSseResult | null = null;
	const dispatch = (): ParsedSseResult | null => {
		if (dataLines.length === 0) return null;
		const payloads = dataLines.splice(0);
		for (const candidate of [...payloads, payloads.join("\n")]) {
			const result = processSsePayload(candidate);
			if (result) return result;
		}
		return null;
	};
	const processLine = (line: string): ParsedSseResult | null => {
		const trimmedLine = line.trim();
		if (trimmedLine === '') {
			return dispatch();
		}
		if (trimmedLine.startsWith("data:")) {
			const payload = parseDataPayload(trimmedLine);
			if (payload !== null) dataLines.push(payload);
			// Only a JSON-object payload or the [DONE] sentinel proves SSE
			// framing. Plain text/HTML bodies legitimately contain `data:`- and
			// `event:`-prefixed lines — counting those flipped the passthrough
			// verdict into a false `incomplete_stream` error.
			const dataText = trimmedLine.slice(5).trimStart();
			if (dataText.startsWith("{") || dataText === "[DONE]") {
				sawSseLine = true;
			}
		}
		return null;
	};
	// Extract complete lines out of pendingText; a trailing partial line
	// (no newline yet) stays buffered for the next chunk. The scan starts at
	// pendingScanFrom — the cursor left by the previous drain — so a carried
	// tail is never rescanned.
	const drainLines = (): ParsedSseResult | null => {
		let lineStart = 0;
		let newlineIndex = pendingText.indexOf('\n', pendingScanFrom);
		while (newlineIndex !== -1) {
			const result = processLine(pendingText.slice(lineStart, newlineIndex));
			if (result) {
				pendingText = '';
				pendingScanFrom = 0;
				return result;
			}
			lineStart = newlineIndex + 1;
			newlineIndex = pendingText.indexOf('\n', lineStart);
		}
		if (lineStart > 0) {
			pendingText = pendingText.slice(lineStart);
		}
		// The last indexOf reached end-of-buffer without a match, so the whole
		// remaining tail is known newline-free — the next drain may resume
		// where this one stopped.
		pendingScanFrom = pendingText.length;
		return null;
	};
	// End-of-stream: the residual line has no trailing newline, and the
	// residual data buffer dispatches without a final blank line.
	const flushPending = (): ParsedSseResult | null => {
		if (pendingText.length > 0) {
			const lastLine = pendingText;
			pendingText = '';
			const result = processLine(lastLine);
			if (result) return result;
		}
		return dispatch();
	};

	// One stall timer re-armed per read (the inter-chunk gap guard), plus a
	// single total-duration deadline armed once and raced on every read. The
	// stall timer alone is defeated by a drip that always lands inside the
	// window (a byte per 44s under a 45s stall used to hang forever); the
	// deadline is the bound it could never extend.
	let stallTimer: ReturnType<typeof setTimeout> | undefined;
	let stallReject: ((error: Error) => void) | undefined;
	const stallPromise = new Promise<never>((_, reject) => {
		stallReject = reject;
	});
	// If the stream resolves early the promise is never raced again; without
	// this handler a late reject would surface as an unhandled rejection.
	stallPromise.catch(() => {});
	const armStallTimer = (): void => {
		if (stallTimer !== undefined) clearTimeout(stallTimer);
		stallTimer = setTimeout(() => {
			stallReject?.(
				new Error(
					`SSE stream stalled for ${streamStallTimeoutMs}ms while waiting for response.done`,
				),
			);
		}, streamStallTimeoutMs);
	};
	let deadlineReject: ((error: Error) => void) | undefined;
	const deadlinePromise = new Promise<never>((_, reject) => {
		deadlineReject = reject;
	});
	deadlinePromise.catch(() => {});
	const deadlineTimer = setTimeout(() => {
		deadlineReject?.(
			new Error(
				`SSE stream exceeded the ${maxStreamDurationMs}ms total duration limit waiting for response.done`,
			),
		);
	}, maxStreamDurationMs);

	try {
		// Consume the stream, folding SSE events as complete lines arrive.
		armStallTimer();
		while (true) {
			const { done, value } = await Promise.race([
				reader.read(),
				stallPromise,
				deadlinePromise,
			]);
			if (done || !value) break;
			totalBytes += value.byteLength;
			const decoded = decoder.decode(value, { stream: true });
			// Retain the chunk only while it is still reachable: the no-SSE
			// passthrough needs the pre-SSE body, request logging needs it all.
			if (LOGGING_ENABLED || !sawSseLine) {
				textParts.push(decoded);
			}
			pendingText += decoded;
			assertWithinLimit();
			// Only appended text containing '\n' can complete a line — the
			// carried tail is newline-free by the drainLines invariant, so a
			// newline-less chunk has nothing to drain.
			if (decoded.indexOf('\n') !== -1) {
				const lineResult = drainLines();
				if (lineResult) {
					parsedResult = lineResult;
					break;
				}
				// Once the stream has proven to be SSE the retained text is
				// unreachable (the passthrough requires !sawSseLine); drop it
				// unless logging still wants the full body.
				if (!LOGGING_ENABLED && sawSseLine) {
					textParts.length = 0;
				}
			}
			armStallTimer();
		}

		if (!parsedResult) {
			const tail = decoder.decode();
			if (tail) {
				if (LOGGING_ENABLED || !sawSseLine) {
					textParts.push(tail);
				}
				pendingText += tail;
				totalBytes += textEncoder.encode(tail).byteLength;
				assertWithinLimit();
				if (tail.indexOf('\n') !== -1) {
					const tailResult = drainLines();
					if (tailResult) {
						parsedResult = tailResult;
					}
				}
			}
			if (!parsedResult) {
				const flushed = flushPending();
				if (flushed) parsedResult = flushed;
			}
			if (!LOGGING_ENABLED && sawSseLine) {
				textParts.length = 0;
			}
		} else {
			// A resolved stream still has an upstream tail in flight; cancel it
			// so the socket does not keep downloading a response nobody reads.
			// Not awaited — a source whose cancel() pends forever must not hang
			// the conversion past its own deadline.
			void reader.cancel().catch(() => {});
		}

		if (LOGGING_ENABLED) {
			logRequest("stream-full", { fullContent: textParts.join('') });
		}

		if (parsedResult?.kind === "error") {
			log.warn("SSE stream returned an error event", parsedResult.error);
			logRequest("stream-error", {
				error: parsedResult.error.message,
				type: parsedResult.error.type,
				code: parsedResult.error.code,
			});

			const jsonHeaders = new Headers(headers);
			jsonHeaders.set("content-type", "application/json; charset=utf-8");
			const status = response.status >= 400 ? response.status : 502;
			const payload = {
				error: {
					message: parsedResult.error.message,
					type: parsedResult.error.type ?? STREAM_ERROR_CODE,
					code: parsedResult.error.code ?? STREAM_ERROR_CODE,
				},
			};

			return new Response(JSON.stringify(payload), {
				status,
				statusText: status === 502 ? "Bad Gateway" : response.statusText,
				headers: jsonHeaders,
			});
		}

		const finalResponse =
			parsedResult?.kind === "response" ? parsedResult.response : null;

		if (!finalResponse) {
			log.warn("Could not find final response in SSE stream");

			logRequest("stream-error", { error: "No response.done event found" });

			// Non-streaming responses are routed here unconditionally, so a body
			// with no SSE framing at all may simply be plain JSON — pass it
			// through untouched. A body that DID carry SSE data lines but never
			// reached a terminal event is a truncated upstream response:
			// returning it at the original 2xx status would credit the account
			// with a success and hand the client an unparseable body, so it is
			// surfaced like the terminal-error branch above instead.
			if (!sawSseLine) {
				return new Response(textParts.join(''), {
					status: response.status,
					statusText: response.statusText,
					headers: headers,
				});
			}

			const jsonHeaders = new Headers(headers);
			jsonHeaders.set("content-type", "application/json; charset=utf-8");
			const status = response.status >= 400 ? response.status : 502;
			return new Response(
				JSON.stringify({
					error: {
						message:
							"Upstream SSE stream ended without a terminal response event.",
						type: STREAM_ERROR_CODE,
						code: "incomplete_stream",
					},
				}),
				{
					status,
					statusText: status === 502 ? "Bad Gateway" : response.statusText,
					headers: jsonHeaders,
				},
			);
		}

		// Return as plain JSON (not SSE)
		const jsonHeaders = new Headers(headers);
		jsonHeaders.set('content-type', 'application/json; charset=utf-8');

		let serializedBody: string;
		try {
			serializedBody = JSON.stringify(finalResponse);
		} catch (error) {
			// JSON.parse accepts deeper nesting than the recursive stringify
			// can emit, so a hostile/garbled terminal object used to escape
			// here as a thrown RangeError — surfaced upstream as a transient
			// stream failure and churned account rotation. A deterministic 502
			// keeps the verdict honest without penalising the account.
			log.warn("SSE terminal response could not be serialized", {
				error: String(error),
			});
			logRequest("stream-error", { error: "terminal response not serializable" });
			return new Response(
				JSON.stringify({
					error: {
						message:
							"Upstream terminal response could not be serialized.",
						type: STREAM_ERROR_CODE,
						code: "unserializable_response",
					},
				}),
				{
					status: 502,
					statusText: "Bad Gateway",
					headers: jsonHeaders,
				},
			);
		}

		return new Response(serializedBody, {
			status: response.status,
			statusText: response.statusText,
			headers: jsonHeaders,
		});

	} catch (error) {
		log.error("Error converting stream", { error: String(error) });
		logRequest("stream-error", { error: String(error) });
		if (typeof reader.cancel === "function") {
			void reader.cancel(String(error)).catch(() => {});
		}
		throw error;
	} finally {
		if (stallTimer !== undefined) clearTimeout(stallTimer);
		clearTimeout(deadlineTimer);
		// Release the reader lock to prevent resource leaks
		reader.releaseLock();
	}

}

/**
 * Ensure response has content-type header
 * @param headers - Response headers
 * @returns Headers with content-type set
 */
export function ensureContentType(headers: Headers): Headers {
	const responseHeaders = new Headers(headers);

	if (!responseHeaders.has('content-type')) {
		responseHeaders.set('content-type', 'text/event-stream; charset=utf-8');
	}

	return responseHeaders;
}

/**
 * Check if a non-streaming response is empty or malformed.
 * Returns true if the response body is empty, null, or lacks meaningful content.
 * @param body - Parsed JSON body from the response
 * @returns True if response should be considered empty/malformed
 */
export function isEmptyResponse(body: unknown): boolean {
	if (body === null || body === undefined) return true;
	if (typeof body === 'string' && body.trim() === '') return true;
	if (typeof body !== 'object') return false;

	const obj = body as Record<string, unknown>;

	if (Object.keys(obj).length === 0) return true;

	// An `output` that is merely present is not content: `{id, output: []}`
	// and `{id, output: ""}` are shape-only responses and must read as empty
	// so the caller can retry instead of accepting a hollow success.
	const outputValue = obj.output;
	const hasOutput =
		'output' in obj &&
		outputValue !== null &&
		outputValue !== undefined &&
		!(Array.isArray(outputValue) && outputValue.length === 0) &&
		(typeof outputValue !== 'string' || outputValue.trim() !== '');
	const hasChoices = 'choices' in obj && Array.isArray(obj.choices) && 
		obj.choices.some(c => c !== null && c !== undefined && typeof c === 'object' && Object.keys(c as object).length > 0);
	const hasContent = 'content' in obj && obj.content !== null && obj.content !== undefined &&
		(typeof obj.content !== 'string' || obj.content.trim() !== '');

	if ('id' in obj || 'object' in obj || 'model' in obj) {
		return !hasOutput && !hasChoices && !hasContent;
	}

	return false;
}
