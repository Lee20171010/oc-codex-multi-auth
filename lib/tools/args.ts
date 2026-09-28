/**
 * Shared `codex-*` tool argument field declarations.
 *
 * Most tools redeclare the same two optional fields inline in their `args`
 * object: an output `format` and a boolean `includeSensitive`. This module
 * owns the repeated parts — the accepted `format` values and both `.describe`
 * strings — so the JSON Schema every tool advertises cannot drift.
 *
 * `format` is a real `enum(TOOL_OUTPUT_FORMAT_VALUES)` rather than a free
 * `string()`, so a tool-call payload naming any other value fails schema
 * validation before `execute` runs instead of being rejected (or silently
 * ignored) inside the handler.
 *
 * The schema calls themselves stay inline per tool rather than behind an
 * exported factory: the plugin's bundled `tool.schema` zod copy is not
 * nameable from this package, so a factory's inferred return type cannot
 * cross the module boundary (TS2742 — see `lib/tools/AGENTS.md`). Plain
 * string constants have no such constraint.
 */

/** Accepted `format` argument values: `"text"` (default) or `"json"`. */
export const TOOL_OUTPUT_FORMAT_VALUES = ["text", "json"] as const;

/** Shared `.describe` text for the `format` field. */
export const TOOL_OUTPUT_FORMAT_DESCRIPTION =
	'Output format: "text" (default) or "json".';

/**
 * Shared `.describe` text for `includeSensitive`.
 *
 * `codex-pool` scopes its wording to stable account IDs rather than the
 * general label/email wording the other tools share, so it passes its own
 * string instead of importing this one.
 */
export const TOOL_INCLUDE_SENSITIVE_DESCRIPTION =
	"Include raw account labels, emails, and account IDs in JSON output. Defaults to false.";
