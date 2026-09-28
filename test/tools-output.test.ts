import { homedir } from "node:os";

import { describe, expect, it } from "vitest";
import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";

import {
	CodexError,
	ErrorCode,
	StorageError,
	StorageTransactionContentionError,
} from "../lib/errors.js";
import {
	buildToolErrorEnvelope,
	enrichThrownError,
	redactHomePaths,
	redactPluginOrigin,
	rethrowIfRetryable,
	sanitizeToolErrorMessage,
	stripControlCharacters,
	toToolCallError,
	withToolErrorEnvelope,
} from "../lib/tools/output.js";

const TOOL_CONTEXT = {} as never;

function failingTool(error: unknown): ToolDefinition {
	return tool({
		description: "test tool",
		args: {},
		execute: () => Promise.reject(error),
	});
}

function passingTool(result: string): ToolDefinition {
	return tool({
		description: "test tool",
		args: {},
		execute: () => Promise.resolve(result),
	});
}

describe("stripControlCharacters", () => {
	it("removes C0/C1/DEL control characters while keeping tab and newline", () => {
		expect(
			stripControlCharacters("a\u0000b\u0007c\u001B[31md\u007Fe\u0085f\tg\nh"),
		).toBe("abc[31mdef\tg\nh");
	});

	it("leaves ordinary text untouched", () => {
		expect(stripControlCharacters("weekday primary")).toBe("weekday primary");
	});
});

describe("sanitizeToolErrorMessage", () => {
	it("collapses newlines so upstream bodies cannot forge extra output lines", () => {
		expect(sanitizeToolErrorMessage("first\nsecond\r\nthird")).toBe(
			"first second third",
		);
	});

	it("masks emails and bearer-shaped tokens via maskString", () => {
		const masked = sanitizeToolErrorMessage(
			"401 for alice@example.com: Bearer abcdef1234567890",
		);
		expect(masked).not.toContain("alice@example.com");
		expect(masked).not.toContain("abcdef1234567890");
		expect(masked).toContain("***");
	});

	it("truncates to the configured limit", () => {
		expect(sanitizeToolErrorMessage("x".repeat(500))).toHaveLength(160);
		expect(sanitizeToolErrorMessage("x".repeat(500), 10)).toHaveLength(10);
	});
});

describe("redactHomePaths", () => {
	it("replaces the home directory with <HOME>", () => {
		const home = homedir();
		expect(redactHomePaths(`${home}/.opencode/accounts.json`)).toBe(
			"<HOME>/.opencode/accounts.json",
		);
	});

	it("leaves other paths untouched", () => {
		expect(redactHomePaths("/etc/passwd")).toBe("/etc/passwd");
	});
});

describe("redactPluginOrigin", () => {
	it("passes null through and redacts the root of a resolved origin", () => {
		expect(redactPluginOrigin(null)).toBeNull();
		const origin = redactPluginOrigin({
			name: "oc-codex-multi-auth",
			version: "1.0.0",
			root: `${homedir()}/Projects/plugin`,
			isLocalCheckout: true,
		});
		expect(origin?.root).toBe("<HOME>/Projects/plugin");
		expect(origin?.name).toBe("oc-codex-multi-auth");
	});
});

describe("buildToolErrorEnvelope", () => {
	it("emits the stable key set for a generic error", () => {
		const envelope = buildToolErrorEnvelope("codex-x", new Error("boom"));
		expect(envelope).toEqual({
			ok: false,
			tool: "codex-x",
			error: "CODEX_TOOL_ERROR",
			message: "boom",
			retryable: false,
			nextAction: null,
			path: null,
		});
	});

	it("carries the CodexError code and sanitizes the message", () => {
		const envelope = buildToolErrorEnvelope(
			"codex-x",
			new CodexError("line1\nalice@example.com", {
				code: ErrorCode.VALIDATION_ERROR,
			}),
		);
		expect(envelope.error).toBe("CODEX_VALIDATION_ERROR");
		expect(envelope.message).not.toContain("\n");
		expect(envelope.message).not.toContain("alice@example.com");
	});

	it("surfaces StorageError.hint as nextAction and redacts the path", () => {
		const home = homedir();
		const envelope = buildToolErrorEnvelope(
			"codex-x",
			new StorageError(
				"corrupt store",
				ErrorCode.STORAGE_ERROR,
				`${home}/.opencode/accounts.json`,
				"Delete the file and re-login",
			),
		);
		expect(envelope.nextAction).toBe("Delete the file and re-login");
		expect(envelope.path).toBe("<HOME>/.opencode/accounts.json");
	});

	it("marks contention errors retryable with a retry hint", () => {
		const envelope = buildToolErrorEnvelope(
			"codex-x",
			new StorageTransactionContentionError("/tmp/accounts.json"),
		);
		expect(envelope.retryable).toBe(true);
		expect(envelope.error).toBe("CODEX_STORAGE_TRANSACTION_CONTENTION");
		expect(envelope.nextAction).toMatch(/retry/i);
		expect(envelope.path).toBe("/tmp/accounts.json");
	});
});

describe("enrichThrownError", () => {
	it("appends the StorageError hint when the message lacks it", () => {
		const enriched = enrichThrownError(
			new StorageError(
				"save failed",
				ErrorCode.STORAGE_ERROR,
				"/tmp/x",
				"check permissions",
			),
		) as StorageError;
		expect(enriched.message).toContain("save failed");
		expect(enriched.message).toContain("hint: check permissions");
		expect(enriched.code).toBe(ErrorCode.STORAGE_ERROR);
	});

	it("adds a retry note to transient errors", () => {
		const enriched = enrichThrownError(
			new StorageTransactionContentionError("/tmp/x"),
		) as Error;
		expect(enriched.message).toMatch(/retry/i);
	});

	it("returns the original error when there is nothing to add", () => {
		const error = new Error("plain");
		expect(enrichThrownError(error)).toBe(error);
	});
});

describe("toToolCallError", () => {
	it("builds a CodexError that keeps the cause code and hint", () => {
		const cause = new StorageError(
			"disk full",
			ErrorCode.STORAGE_ERROR,
			"/tmp/x",
			"free space",
		);
		const error = toToolCallError("Import failed", cause);
		expect(error).toBeInstanceOf(CodexError);
		expect(error.code).toBe(ErrorCode.STORAGE_ERROR);
		expect(error.message).toContain("Import failed: disk full");
		expect(error.message).toContain("hint: free space");
	});

	it("marks transient causes retryable in the message", () => {
		const error = toToolCallError(
			"Export failed",
			new StorageTransactionContentionError("/tmp/x"),
		);
		expect(error.message).toMatch(/retry/i);
	});
});

describe("rethrowIfRetryable", () => {
	it("rethrows retryable CodexErrors and swallows everything else", () => {
		const contention = new StorageTransactionContentionError("/tmp/x");
		expect(() => rethrowIfRetryable(contention)).toThrow(contention);
		expect(() => rethrowIfRetryable(new Error("io"))).not.toThrow();
		expect(() =>
			rethrowIfRetryable(
				new StorageError("x", ErrorCode.STORAGE_ERROR, "/p", "h"),
			),
		).not.toThrow();
	});
});

describe("withToolErrorEnvelope", () => {
	it("returns the JSON envelope when the caller asked for format:\"json\"", async () => {
		const wrapped = withToolErrorEnvelope(
			"codex-x",
			failingTool(new Error("boom\nmore")),
		);
		const output = await wrapped.execute({ format: "json" }, TOOL_CONTEXT);
		const parsed = JSON.parse(output as string) as Record<string, unknown>;
		expect(parsed).toMatchObject({
			ok: false,
			tool: "codex-x",
			error: "CODEX_TOOL_ERROR",
			retryable: false,
			nextAction: null,
			path: null,
		});
		expect(parsed.message).toBe("boom more");
	});

	it("emits the envelope without a format arg when alwaysJson is set", async () => {
		const wrapped = withToolErrorEnvelope(
			"codex-x",
			failingTool(new StorageTransactionContentionError("/tmp/x")),
			{ alwaysJson: true },
		);
		const parsed = JSON.parse(
			(await wrapped.execute({}, TOOL_CONTEXT)) as string,
		) as Record<string, unknown>;
		expect(parsed).toMatchObject({
			ok: false,
			tool: "codex-x",
			error: "CODEX_STORAGE_TRANSACTION_CONTENTION",
			retryable: true,
		});
		expect(parsed.nextAction).toBeTruthy();
	});

	it("rethrows enriched errors in text mode", async () => {
		const wrapped = withToolErrorEnvelope(
			"codex-x",
			failingTool(
				new StorageError(
					"corrupt store",
					ErrorCode.STORAGE_ERROR,
					"/tmp/x",
					"fix the file",
				),
			),
		);
		await expect(wrapped.execute({}, TOOL_CONTEXT)).rejects.toThrow(
			/hint: fix the file/,
		);
	});

	it("passes successful results through untouched", async () => {
		const wrapped = withToolErrorEnvelope("codex-x", passingTool("ok"));
		expect(await wrapped.execute({ format: "json" }, TOOL_CONTEXT)).toBe("ok");
	});
});
