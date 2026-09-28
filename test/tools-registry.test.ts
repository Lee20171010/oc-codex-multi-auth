import { describe, expect, it } from "vitest";

import { createToolRegistry, type ToolContext } from "../lib/tools/index.js";

/**
 * Every `codex-*` tool module must be wired into `createToolRegistry` —
 * a file that exists but is never registered is unreachable from the
 * OpenCode plugin surface. doc-parity.test.ts checks the registry keys
 * against the `lib/tools` file list by regex; this test is the runtime
 * counterpart: it instantiates the registry and asserts the exact key set
 * plus the minimum shape every entry must carry.
 */
const EXPECTED_TOOL_NAMES = [
	"codex-list",
	"codex-switch",
	"codex-warm",
	"codex-status",
	"codex-limits",
	"codex-reset",
	"codex-metrics",
	"codex-help",
	"codex-setup",
	"codex-doctor",
	"codex-next",
	"codex-label",
	"codex-tag",
	"codex-pool",
	"codex-note",
	"codex-dashboard",
	"codex-health",
	"codex-remove",
	"codex-refresh",
	"codex-export",
	"codex-import",
	"codex-diag",
	"codex-diff",
	"codex-keychain",
] as const;

function buildCtx(): ToolContext {
	// Factories only destructure helpers at build time — none are invoked
	// until `execute` runs, so an empty object satisfies construction.
	return {} as ToolContext;
}

describe("createToolRegistry", () => {
	it("registers every codex-* tool exactly once", () => {
		const registry = createToolRegistry(buildCtx());
		expect(Object.keys(registry).sort()).toEqual(
			[...EXPECTED_TOOL_NAMES].sort(),
		);
		expect(Object.keys(registry)).toHaveLength(24);
	});

	it("returns a well-formed ToolDefinition for every registered tool", () => {
		const registry = createToolRegistry(buildCtx());
		for (const name of EXPECTED_TOOL_NAMES) {
			const definition = registry[name];
			expect(definition, `${name} is missing from the registry`).toBeDefined();
			expect(
				typeof definition?.description,
				`${name}.description`,
			).toBe("string");
			expect(
				(definition?.description ?? "").length,
				`${name}.description must not be empty`,
			).toBeGreaterThan(0);
			expect(
				typeof definition?.execute,
				`${name}.execute`,
			).toBe("function");
			expect(
				typeof definition?.args,
				`${name}.args`,
			).toBe("object");
		}
	});

	/** Unwraps zod v4 `optional`/`default`/`nullable`/`readonly` wrappers. */
	function unwrap(schema: unknown): { _zod?: { def?: { type?: string } } } {
		let current = schema as {
			_zod?: {
				def?: {
					type?: string;
					innerType?: unknown;
				};
			};
		};
		for (let depth = 0; depth < 6; depth += 1) {
			const def = current?._zod?.def;
			if (!def) break;
			if (
				def.type === "optional" ||
				def.type === "default" ||
				def.type === "nullable" ||
				def.type === "readonly"
			) {
				current = def.innerType as typeof current;
				continue;
			}
			break;
		}
		return current;
	}

	it("types every format argument as a text/json enum, not a free string", () => {
		const registry = createToolRegistry(buildCtx());
		for (const [name, definition] of Object.entries(registry)) {
			const formatField = (definition.args as Record<string, unknown>)?.format;
			if (!formatField) continue;
			expect(
				unwrap(formatField)?._zod?.def?.type,
				`${name}.args.format must be an enum so the tool-call JSON Schema constrains it`,
			).toBe("enum");
		}
	});

	it("types every includeSensitive argument as boolean", () => {
		const registry = createToolRegistry(buildCtx());
		for (const [name, definition] of Object.entries(registry)) {
			const field = (definition.args as Record<string, unknown>)
				?.includeSensitive;
			if (!field) continue;
			expect(
				unwrap(field)?._zod?.def?.type,
				`${name}.args.includeSensitive must stay boolean-typed`,
			).toBe("boolean");
		}
	});
});
