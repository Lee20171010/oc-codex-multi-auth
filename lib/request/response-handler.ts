import { RequestError } from "../errors.js";
import { createLogger, logRequest, LOGGING_ENABLED } from "../logger.js";

import type { SSEEventData } from "../types.js";

const log = createLogger("response-handler");

const MAX_SSE_SIZE = 10 * 1024 * 1024; // 10MB limit to prevent memory exhaustion
const DEFAULT_STREAM_STALL_TIMEOUT_MS = 45_000;
const STREAM_ERROR_CODE = "stream_error";

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
	if (value && typeof value === "object") {
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
	const errorRecord = toRecord((event as { error?: unknown }).error);
	const eventMessage = (event as { message?: unknown }).message;
	const parsedError = extractErrorFromRecord(errorRecord);
	if (parsedError) return parsedError;

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
	const parsedError = extractErrorFromRecord(
		toRecord((responseRecord as { error?: unknown }).error),
	);
	if (parsedError) return parsedError;
	if (status === "failed" || status === "incomplete") {
		return { message: `Codex stream ended with status: ${status}` };
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
			}
			return { kind: "response", response: data.response };
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
 * @param options - Optional `streamStallTimeoutMs` override (floored at 1000ms)
 * @returns Response with JSON body
 */
export async function convertSseToJson(
	response: Response,
	headers: Headers,
	options?: { streamStallTimeoutMs?: number },
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
	// string is quadratic on multi-MB streams.
	const textParts: string[] = [];
	// Leftover buffer: only text after the last complete line is held over
	// for the next chunk, instead of re-splitting the whole stream per chunk.
	let pendingText = '';
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
		if (/^(?:data|event):/.test(trimmedLine)) sawSseLine = true;
		const payload = parseDataPayload(trimmedLine);
		if (payload !== null) dataLines.push(payload);
		return null;
	};
	// Extract complete lines out of pendingText; a trailing partial line
	// (no newline yet) stays buffered for the next chunk.
	const drainLines = (): ParsedSseResult | null => {
		let lineStart = 0;
		let newlineIndex = pendingText.indexOf('\n');
		while (newlineIndex !== -1) {
			const result = processLine(pendingText.slice(lineStart, newlineIndex));
			if (result) {
				pendingText = '';
				return result;
			}
			lineStart = newlineIndex + 1;
			newlineIndex = pendingText.indexOf('\n', lineStart);
		}
		pendingText = pendingText.slice(lineStart);
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

	// One stall timer re-armed per read, rather than a fresh timeout promise
	// (and timer object) per chunk.
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

	try {
		// Consume the stream, folding SSE events as complete lines arrive.
		armStallTimer();
		while (true) {
			const { done, value } = await Promise.race([reader.read(), stallPromise]);
			if (done || !value) break;
			totalBytes += value.byteLength;
			const decoded = decoder.decode(value, { stream: true });
			textParts.push(decoded);
			pendingText += decoded;
			assertWithinLimit();
			const lineResult = drainLines();
			if (lineResult) {
				parsedResult = lineResult;
				break;
			}
			armStallTimer();
		}

		if (!parsedResult) {
			const tail = decoder.decode();
			if (tail) {
				pendingText += tail;
				textParts.push(tail);
				totalBytes += textEncoder.encode(tail).byteLength;
				assertWithinLimit();
			}
			const flushed = flushPending();
			if (flushed) parsedResult = flushed;
		} else {
			// A resolved stream still has an upstream tail in flight; cancel it
			// so the socket does not keep downloading a response nobody reads.
			await reader.cancel().catch(() => {});
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

		return new Response(JSON.stringify(finalResponse), {
			status: response.status,
			statusText: response.statusText,
			headers: jsonHeaders,
		});

	} catch (error) {
		log.error("Error converting stream", { error: String(error) });
		logRequest("stream-error", { error: String(error) });
		if (typeof reader.cancel === "function") {
			await reader.cancel(String(error)).catch(() => {});
		}
		throw error;
	} finally {
		if (stallTimer !== undefined) clearTimeout(stallTimer);
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

	const hasOutput = 'output' in obj && obj.output !== null && obj.output !== undefined;
	const hasChoices = 'choices' in obj && Array.isArray(obj.choices) && 
		obj.choices.some(c => c !== null && c !== undefined && typeof c === 'object' && Object.keys(c as object).length > 0);
	const hasContent = 'content' in obj && obj.content !== null && obj.content !== undefined &&
		(typeof obj.content !== 'string' || obj.content.trim() !== '');

	if ('id' in obj || 'object' in obj || 'model' in obj) {
		return !hasOutput && !hasChoices && !hasContent;
	}

	return false;
}
