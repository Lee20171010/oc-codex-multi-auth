# lib/tools/

Per-tool modules for the 24 `codex-*` tools registered by the plugin.
`index.ts` builds a `ToolContext` in `OpenAIOAuthPlugin` (root `index.ts`) and
passes it to `createToolRegistry(ctx)`, which maps each `codex-<name>` tool id to
its factory.

## Layout

```text
index.ts            # ToolContext type + createToolRegistry(ctx); also re-exports the codex-diag/codex-diff/codex-keychain factories
args.ts             # shared format/includeSensitive constants (values + descriptions)
doctor-repair.ts    # shared doctor repair pass (refresh + stale-state clear); used by codex-doctor and CLI --fix
refresh-account.ts  # shared single-use refresh-token persistence; used by account-management tools
codex-<name>.ts     # one file per tool: list, switch, warm, status, limits, reset, metrics, help, setup,
                    # doctor, next, label, tag, pool, note, dashboard, health, remove, refresh,
                    # export, import, diag, diff — plus codex-keychain.ts
```

## Factory pattern

Each tool file exports `createCodex<Name>Tool(ctx: ToolContext): ToolDefinition`
built with `tool({ description, args, execute })` from
`@opencode-ai/plugin/tool`. `ToolContext` (declared in `index.ts`) carries three
groups:

- **Mutable plugin-closure refs** (`cachedAccountManagerRef`,
  `accountManagerPromiseRef`) — `MutableRef<T>` wrappers (`{ current }`) over
  `let` bindings in the plugin closure, so writes propagate outward.
- **Read-only handles** (`runtimeMetrics`, `beginnerSafeModeRef`).
- **Closure helpers** (`resolveUiRuntime`, `formatCommandAccountLabel`,
  `promptAccountIndexSelection`, `buildRoutingVisibilitySnapshot`, …).

No module-level mutable singletons — all shared state arrives through `ctx`.

## args.ts: constants only across the module boundary

`args.ts` owns `TOOL_OUTPUT_FORMAT_VALUES` (`"text" | "json"`),
`TOOL_OUTPUT_FORMAT_DESCRIPTION`, and `TOOL_INCLUDE_SENSITIVE_DESCRIPTION`.
Only plain constants may cross the boundary: a shared schema *factory*'s
inferred Zod return type is not nameable from this package without leaking the
plugin's bundled `zod` copy (TS2742), so each tool inlines its own
`tool.schema` calls. `format` fields use
`tool.schema.enum(TOOL_OUTPUT_FORMAT_VALUES).optional()` — never `.string()` —
so the emitted JSON Schema constrains the value. `codex-pool` scopes its
`includeSensitive` wording to account IDs and passes its own string.

## Adding a tool

1. Create `lib/tools/codex-<name>.ts` exporting `createCodex<Name>Tool(ctx)`.
2. Import it in `lib/tools/index.ts` and add the
   `"codex-<name>": createCodex<Name>Tool(ctx)` entry in `createToolRegistry` —
   the registry is checked against the file list by `test/doc-parity.test.ts`.
3. If the tool needs a new closure helper, add a `ToolContext` field and wire it
   in the `ctx` builder in root `index.ts` (search `const ctx: ToolContext = {`).
4. Add coverage as `test/tools-codex-<name>.test.ts` (see test/AGENTS.md).
