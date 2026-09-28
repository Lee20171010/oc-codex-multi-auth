/**
 * Shared tool-output contract helpers for the `codex-*` tools.
 *
 * The OpenCode tool contract carries no `isError` flag, so a failed tool call
 * has exactly two honest shapes: it rejects, or it returns a structured string.
 * The plugin picks one consistent convention for each half:
 *
 * - Text mode failures reject with an error whose message is enriched with the
 *   `StorageError.hint` / retryable guidance that operators need (see
 *   {@link enrichThrownError}).
 * - `format:"json"` failures resolve to the machine-readable envelope from
 *   {@link buildToolErrorEnvelope} so tool consumers can branch on `ok` +
 *   `error` code instead of parsing prose.
 *
 * Every registered tool factory wraps its `tool({...})` definition in
 * {@link withToolErrorEnvelope} so thrown errors land on the right shape for
 * the caller's requested format — {@link codex-keychain.ts} is the exception
 * because its contract is owned by the storage-layer lease work.
 */
import { homedir } from "node:os";

import type { ToolDefinition, ToolResult } from "@opencode-ai/plugin/tool";

import { CodexError, StorageError } from "../errors.js";
import { maskString } from "../logger.js";
import type { PluginOrigin } from "../plugin-origin.js";
import { renderJsonOutput } from "../runtime.js";

/** Fallback error code when the thrown value carries none. */
const GENERIC_TOOL_ERROR_CODE = "CODEX_TOOL_ERROR";

/** Truncation budget for error text embedded in tool output. */
const TOOL_ERROR_MESSAGE_LIMIT = 160;

/**
 * The machine-readable failure payload emitted by `format:"json"` tool calls.
 */
export interface CodexToolErrorEnvelope {
	/** Stable failure discriminator for tool consumers. */
	ok: false;
	/** Registered tool id that produced the error. */
	tool: string;
	/** Machine-readable error code (a `CodexError.code` when available). */
	error: string;
	/** Masked, single-line, truncated copy of the underlying message. */
	message: string;
	/** True when the failure is transient and the call may be retried. */
	retryable: boolean;
	/** Operator-facing hint (from `StorageError.hint` or retryable defaults). */
	nextAction: string | null;
	/** Relevant filesystem path with the home directory redacted, if any. */
	path: string | null;
}

/**
 * Replaces occurrences of the user's home directory in free-form strings with
 * the placeholder `<HOME>` — the same redaction `codex-diag` applies. Both
 * POSIX- and Windows-style separators are covered so the replacement matches
 * regardless of how the path was embedded.
 *
 * In addition to the literal `homedir()`, generic `/home/<name>`,
 * `/Users/<name>`, and `X:\Users\<name>` prefixes are collapsed to `<HOME>`:
 * paths carried inside upstream errors or plugin-origin strings can point at
 * a *different* home (tests run under an isolated `HOME`, and a checkout can
 * live under another user's directory), and the username is the sensitive
 * part either way.
 */
export function redactHomePaths(input: string): string {
	let output = input;
	const home = homedir();
	if (home) {
		const needles = new Set<string>();
		needles.add(home);
		needles.add(home.replace(/\\/g, "/"));
		needles.add(home.replace(/\\/g, "\\\\"));
		for (const needle of needles) {
			if (!needle) continue;
			while (output.includes(needle)) {
				output = output.replace(needle, "<HOME>");
			}
		}
	}
	return output
		.replace(/\/home\/[^/\\]+/g, "<HOME>")
		.replace(/\/Users\/[^/\\]+/g, "<HOME>")
		.replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/]+/g, "<HOME>");
}

/**
 * Removes C0/C1/DEL control characters while keeping tab and newline —
 * enough to keep free-form `label`/`tags`/`note` text from smuggling terminal
 * escape sequences into rendered output without mangling ordinary whitespace.
 */
export function stripControlCharacters(input: string): string {
	return input.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
}

/**
 * Masks credential-shaped substrings, collapses embedded newlines, and
 * truncates to `limit` — the standard treatment for upstream error bodies and
 * `StorageError` text before it reaches tool output.
 */
export function sanitizeToolErrorMessage(
	message: string,
	limit: number = TOOL_ERROR_MESSAGE_LIMIT,
): string {
	return maskString(message).replace(/[\r\n]+/g, " ").slice(0, limit);
}

/**
 * Returns a copy of a resolved plugin origin with `root` home-path redacted so
 * `pluginOrigin` stays safe to emit inside JSON tool payloads.
 */
export function redactPluginOrigin(
	origin: PluginOrigin | null,
): (PluginOrigin & { root: string }) | null {
	if (!origin) return null;
	return { ...origin, root: redactHomePaths(origin.root) };
}

/** Machine-readable code for `error`, honouring the CodexError hierarchy. */
function toolErrorCode(error: unknown): string {
	if (error instanceof CodexError) return error.code;
	return GENERIC_TOOL_ERROR_CODE;
}

/** Whether the error advertises a `retryable: true` marker. */
function isRetryableError(error: unknown): boolean {
	return (
		error instanceof CodexError &&
		"retryable" in error &&
		error.retryable === true
	);
}

/** Filesystem path carried by the error, when one is exposed. */
function toolErrorPath(error: unknown): string | null {
	if (
		error instanceof CodexError &&
		"path" in error &&
		typeof error.path === "string"
	) {
		return error.path;
	}
	return null;
}

/**
 * Builds the stable `{ ok:false, tool, error, message, retryable, nextAction,
 * path }` payload. Messages are masked + truncated; `StorageError.hint`
 * surfaces as `nextAction`; retryable errors get a retry suggestion when no
 * more specific hint exists.
 */
export function buildToolErrorEnvelope(
	toolId: string,
	error: unknown,
): CodexToolErrorEnvelope {
	const retryable = isRetryableError(error);
	const hint = error instanceof StorageError ? error.hint : null;
	const path = toolErrorPath(error);
	return {
		ok: false,
		tool: toolId,
		error: toolErrorCode(error),
		message: sanitizeToolErrorMessage(
			error instanceof Error ? error.message : String(error),
		),
		retryable,
		nextAction:
			hint ?? (retryable ? "Retry shortly — the failure is transient." : null),
		path: path ? redactHomePaths(path) : null,
	};
}

/**
 * Enriches a thrown error's message with `StorageError.hint` and a retry note
 * for transient failures — the text-mode counterpart of the JSON envelope.
 * Returns the original error unchanged when there is nothing to add, so call
 * sites can rethrow the returned value without checking identity.
 */
export function enrichThrownError(error: unknown): unknown {
	if (!(error instanceof Error)) return error;
	const additions: string[] = [];
	if (
		error instanceof StorageError &&
		error.hint &&
		!error.message.includes(error.hint)
	) {
		additions.push(`Hint: ${error.hint}`);
	}
	if (isRetryableError(error) && !/retry/i.test(error.message)) {
		additions.push("Retry shortly — the failure is transient.");
	}
	if (additions.length === 0) return error;
	const message = `${error.message}\n${additions.join("\n")}`;
	if (error instanceof StorageError) {
		return new StorageError(message, error.code, error.path, error.hint, error);
	}
	if (error instanceof CodexError) {
		return new CodexError(message, { code: error.code, cause: error });
	}
	return new Error(message, { cause: error });
}

/**
 * Rethrows `error` when it is a transient (retryable) `CodexError` such as
 * `StorageTransactionContentionError` or `ConfigLockContentionError`, and
 * returns otherwise.
 *
 * Persistence handlers inside `withAccountStorageTransaction` callbacks use
 * this before downgrading a `persist()` failure to an outcome value: a
 * compromised transaction lease surfaces through `persist()`, and folding it
 * into a "failed to persist" string would hide the retryable signal the
 * wrapper is meant to expose.
 */
export function rethrowIfRetryable(error: unknown): void {
	if (isRetryableError(error)) throw error;
}

/**
 * Builds the error a text-mode tool throws to report a failed action: the
 * action label ("Import failed") plus the masked/truncated cause, a `Hint:`
 * line for `StorageError`s, and a retry note for transient failures.
 */
export function toToolCallError(actionLabel: string, error: unknown): CodexError {
	const base =
		error instanceof Error ? error.message : String(error);
	const lines = [`${actionLabel}: ${sanitizeToolErrorMessage(base)}`];
	if (
		error instanceof StorageError &&
		error.hint &&
		!base.includes(error.hint)
	) {
		lines.push(`Hint: ${error.hint}`);
	}
	if (isRetryableError(error) && !/retry/i.test(base)) {
		lines.push("Retry shortly — the failure is transient.");
	}
	return new CodexError(lines.join("\n"), {
		code: error instanceof CodexError ? error.code : GENERIC_TOOL_ERROR_CODE,
		cause: error instanceof Error ? error : undefined,
	});
}

export interface ToolErrorEnvelopeOptions {
	/** Emit the JSON envelope even when the tool declares no `format` arg. */
	alwaysJson?: boolean;
}

/**
 * Wraps a built tool definition so thrown errors land on a contract-stable
 * shape: the JSON envelope when the caller requested `format:"json"` (or
 * `options.alwaysJson` for always-JSON tools like `codex-diag`), otherwise an
 * enriched error is rethrown so host-side display keeps `StorageError.hint`
 * and retryable guidance. Returned values pass through untouched.
 */
export function withToolErrorEnvelope(
	toolId: string,
	definition: ToolDefinition,
	options: ToolErrorEnvelopeOptions = {},
): ToolDefinition {
	const inner = definition.execute;
	return {
		...definition,
		// Deliberately NOT `async`: several tools validate args synchronously
		// before their first await, and callers/tests rely on a synchronous
		// throw for those. Wrapping in `async` would silently turn every
		// sync validation failure into a promise rejection.
		execute: (args, context) => {
			const requestedFormat =
				typeof args === "object" && args !== null && "format" in args
					? args.format
					: undefined;
			const wantsJson =
				options.alwaysJson === true || requestedFormat === "json";
			const toEnvelope = (error: unknown) =>
				renderJsonOutput(buildToolErrorEnvelope(toolId, error));
			let result: ReturnType<typeof inner>;
			try {
				result = inner(args, context);
			} catch (error) {
				if (wantsJson) return Promise.resolve(toEnvelope(error));
				throw enrichThrownError(error);
			}
			return Promise.resolve(result).then(
				(value) => value as ToolResult,
				(error: unknown) => {
					if (wantsJson) return toEnvelope(error);
					throw enrichThrownError(error);
				},
			);
		},
	};
}
