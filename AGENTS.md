# PROJECT KNOWLEDGE BASE

Branch: main
Package version: see `package.json` (`version` field).

## OVERVIEW

`oc-codex-multi-auth` is an OpenCode plugin for ChatGPT Plus/Pro OAuth, Codex/GPT-5/GPT-6 request routing (including GPT-6 Astra/Sol/Luna, Daybreak, and GPT-5.6 Sol/Terra/Luna responses-lite), multi-account rotation, account switching, health checks, quota status, diagnostics, and recovery tools. The npm bin is an installer that manages OpenCode provider/TUI config and also runs standalone CLI commands (`doctor`, `status`, `list`, `limits`, `dashboard`, `health`, `diag`, `warm`). OpenCode loads `index.ts` as the provider plugin and `tui.ts` as the prompt quota status plugin. Runtime account state stays local under `~/.opencode` with per-project pools enabled by default.

## STRUCTURE

```text
./
├── index.ts              # OpenCode provider plugin entry: auth loader, fetch pipeline, tool registry context; default export also carries the V2 `setup` hook
├── tui.ts                # OpenCode TUI plugin: prompt quota status and quota details; default export also carries the V2 `setup` hook
├── lib/                  # core runtime logic (see lib/AGENTS.md)
├── test/                 # vitest suites (see test/AGENTS.md)
├── scripts/              # installer, standalone CLI, build, audit, and validation helpers
├── config/               # opencode.json examples (modern/full/legacy/minimal)
├── docs/                 # public docs, architecture, maintainer guides
├── skills/               # repo-local setup skill
├── assets/               # static assets
├── .codex-plugin/        # plugin metadata for Codex skill/plugin tooling
└── dist/                 # build output (generated, do not edit)
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Installer + standalone CLI | `scripts/install-oc-codex-multi-auth.js`, `scripts/install-oc-codex-multi-auth-core.js` | npm bin, config merge, cache cleanup, TUI enablement; standalone doctor/status/list/limits/dashboard/health/diag/warm |
| Plugin orchestration | `index.ts` | OAuth loader, request pipeline, metrics, recovery, `ToolContext` assembly |
| TUI quota status | `tui.ts`, `lib/tui-status.ts`, `lib/tui-quota-cache.ts`, `lib/codex-usage.ts` | prompt quota status, quota details, shared quota cache |
| OpenCode V2 adapter | `lib/opencode-v2.ts`, `lib/opencode-v2-provider.ts`, `lib/opencode-v2-rpc.ts`, `lib/opencode-v2-status.ts`, `lib/opencode-v2-tui.ts` | V2 `setup` entrypoints, auth/provider/model transforms, aisdk hooks, status RPC, TUI slots |
| Tool registry | `lib/tools/index.ts` + `lib/tools/codex-*.ts` | 24 registered `codex-*` tools |
| OAuth flow + PKCE | `lib/auth/auth.ts`, `lib/auth/server.ts`, `lib/auth/device-code.ts`, `lib/auth/login-runner.ts`, `lib/auth/loopback-flow.ts` | browser/device/manual login, shared listener lifecycle, token refresh, workspace selection |
| OAuth scopes | `lib/auth/scopes.ts` | connector scope validation and re-auth checks |
| Multi-account rotation | `lib/accounts.ts`, `lib/accounts/`, `lib/rotation.ts` | `rotationStrategy` hybrid/sticky/round-robin, health scoring, cooldowns, token bucket, recovery |
| Account storage | `lib/storage.ts`, `lib/storage/` | V3 facade, per-project/global paths, keychain, backup/import/export |
| Request transformation | `lib/request/request-transformer.ts` | model normalization, prompt injection, stateless compatibility |
| Responses-lite | `lib/request/helpers/responses-lite.ts` | lite body reshape + header for GPT-6 Astra/Sol/Luna, Daybreak Blue/Red, and 5.6 Sol/Terra/Luna |
| Client identity | `lib/request/helpers/client-identity.ts` | default `opencode` for responses-lite models, `codex_cli_rs` otherwise |
| Headers + rate limits | `lib/request/fetch-helpers.ts` | Codex headers, error mapping, fallback, token refresh |
| Retry budgets | `lib/request/retry-budget.ts`, `lib/request/rate-limit-backoff.ts` | bounded retry classes, exponential backoff |
| SSE to JSON | `lib/request/response-handler.ts` | stream parsing and empty-response detection |
| Prompt templates | `lib/prompts/codex.ts`, `lib/prompts/opencode-codex.ts`, `lib/prompts/codex-opencode-bridge.ts` | model-family detection, Codex prompt cache, bridge prompts |
| Config parsing | `lib/config.ts`, `lib/schemas.ts` | plugin config and environment overrides (bool env truthy only `"1"`) |
| Session recovery | `lib/recovery/`, `lib/recovery.ts` | recoverable error detection and TUI toast notifications; underlying auto-resume/repair engine exists in hook.ts |
| Health monitoring | `lib/health.ts`, `lib/parallel-probe.ts` | account health status and concurrent probes |
| Circuit breaker | `lib/circuit-breaker.ts` | failure isolation |
| Public architecture | `docs/architecture.md` | user-facing architecture overview |
| Maintainer architecture | `docs/development/ARCHITECTURE.md` | current subsystem map and invariants |
| Discoverability guide | `docs/development/GITHUB_DISCOVERABILITY.md` | repo description/topics/search wording |
| Tests | `test/` | Vitest, property tests, docs parity, installer, tool modules, TUI quota |

## OPENCODE V2 SUBSYSTEM

OpenCode V2 (2.0.16+) loads the same package through a different contract: the
default export's `setup` hook instead of the V1 `server` hook. The adapter lives
in `lib/opencode-v2*.ts` and reuses the shared V1 runtime rather than
duplicating it.

- **Entry points.** `index.ts` ends with a default export `{ id, server, setup }`; `setup` dynamically imports `lib/opencode-v2.ts` and calls `setupV2(context, createPluginRuntime)` (`index.ts:5155-5163`). `tui.ts` does the same for the terminal side, delegating `setup` to `setupV2Tui` (`tui.ts` tail).
- **Modules.** `lib/opencode-v2.ts` is the adapter: integration auth methods, `provider`/`model` transforms, `aisdk` hooks, `tool.transform` bridge, `CodexStatusRpc` registration, credential-event subscription. `lib/opencode-v2-provider.ts` is a two-line module that only re-exports `createOpenAI` from `@ai-sdk/openai` — its *separate module identity* is what keeps V2 from replacing this transport with its native OpenAI driver before the multi-account fetch hook is installed (`provider.package = aisdk:<that module>`). `lib/opencode-v2-rpc.ts` defines `CodexStatusRpc` (`status` method), `lib/opencode-v2-status.ts` formats the answer on the plugin side so remote TUIs never need credentials, and `lib/opencode-v2-tui.ts` renders it: three `ui.slot`s (app poller, `prompt.footer.status`, `sidebar.content`), the `codex.quota.details` and `codex.accounts` palette commands, and the `/codex-accounts` slash command.
- **Dual-runtime contract.** V2's `setup` receives a `Plugin.Context` — there is no V1 `client` and no host `auth.json`. `createPluginRuntime` (the V1 `OpenAIOAuthPlugin` factory) is passed in so account rotation, the auth `loader`, the `codex-*` tool registry, and the disposal `event` hook are shared, not re-implemented (`index.ts:398-402`). V2 wraps that runtime in a per-location `createStorageScope` (`lib/storage/state.ts`), so several V2 locations in one process keep separate account-storage state.
- **Why a second SDK path.** V1 owns the whole HTTP exchange through a custom `fetch`. V2's provider system instantiates an AI-SDK client itself, so the adapter reroutes the `openai` provider and its models to the `aisdk:` package above, then installs `aisdk.hook("sdk")` to build `createOpenAI` around the shared loader's fetcher and `aisdk.hook("language")` to wrap the model. `createV2Fetch` re-adds what V1 supplied via provider options — `store: false`, the `reasoning.encrypted_content` include, and the `opencode/<version>` user-agent — and `createV2Language` strips `previousResponseId`/`conversation` so V2's server-side references cannot reach the stateless Codex backend.
- **Key invariants.** OAuth methods are re-mapped onto the `openai` integration as `codex-multi-N` method IDs (the first reuses the manual-browser loopback flow so authorization can run in the V2 service, where the V1 readline menu cannot). The adapter stays inert (`enabled = false`) until a pooled account or an `openai` OAuth connection exists, then calls `context.provider.reload()`. Tool calls execute through `tool.transform` with zod-validated args; legacy tool `ask` permission requests are unsupported and throw. Quota status is read via RPC (`CodexStatusRpc.status`), not by the TUI touching files — a remote TUI needs no credentials. `codexTuiV2` / `CODEX_TUI_V2` (default on) gates V2-aware TUI formatting in the V1 runtime.
- **Install.** `npx -y oc-codex-multi-auth@latest --v2` writes a V2 `plugins` entry; it refuses an existing `opencode.jsonc` or V1 `plugin` entries rather than migrating them (`scripts/install-oc-codex-multi-auth-core.js`).

## CONVENTIONS

- Source: root `index.ts`, `tui.ts`, `lib/`, and `scripts/`; `dist/` is generated output.
- ESLint flat config: `no-explicit-any` enforced, unused args prefixed `_`.
- ESM only (`"type": "module"`), Node >= 18.
- Canonical package/plugin name is `oc-codex-multi-auth`.
- The npm bin is an installer and thin standalone CLI, not a long-running runtime daemon.
- OpenCode loads the provider plugin and TUI plugin from built package exports.
- Default installer mode only registers plugin entries and preserves `provider.openai`; `--modern` writes compact config (10 bases / 53 variants), `--full` adds 53 explicit selector IDs, `--legacy` writes legacy explicit-only config, and `--v2` registers the plugin for OpenCode V2 (`plugins` entry only); `--dry-run` and `--no-cache-clear` are supported.
- Runtime requests preserve Codex stateless requirements: `store: false` and `reasoning.encrypted_content`.
- GPT-6 Astra/Sol/Luna, Daybreak and GPT-5.6 use responses-lite shaping and default client identity `opencode`; other models default to `codex_cli_rs`. All are catalog-read (`use_responses_lite: true`). Astra's entry shipped an empty `base_instructions`, but the loader now renders `model_messages.instructions_template` instead, so it reads catalog text rather than its prompt file.
- Account selection uses `rotationStrategy` (`hybrid` default) with health scoring in `lib/rotation.ts`.
- Per-project account storage is enabled by default.
- Optional OS keychain backend is opt-in with `CODEX_KEYCHAIN=1`.

## ANTI-PATTERNS (THIS PROJECT)

- Do not edit `dist/` or `tmp*` directories.
- Do not use `as any`, `@ts-ignore`, or `@ts-expect-error`.
- Do not open public security issues; see `SECURITY.md`.
- Do not hardcode ports other than OAuth callback port `1455`; use existing constants/helpers.
- Do not remove `store: false` or `reasoning.encrypted_content` from shipped config templates.
- Do not treat `oc-chatgpt-multi-auth` as current except in migration/cleanup logic.
- Do not identify a plugin entry by the spelling of its last path segment. Resolve what it points at; a path outside package-manager output - `node_modules`, and the versioned directories of the OpenCode package cache - belongs to whoever wrote it and is never rewritten or removed.
- Do not run the installer to repair a developer machine's config. It writes that machine's real OpenCode config; `update` refreshes the package cache without touching either file.
- Do not expose account emails, access tokens, refresh tokens, or raw prompt/response bodies in normal diagnostics.
- Do not silently delete JSON credentials when keychain operations fail.
- Do not document boolean env overrides as truthy for `"true"` or `"yes"`. Only `"1"` is truthy.

## COMMANDS

```bash
npm run build            # clean dist + tsc + copy oauth-success.html
npm run typecheck        # type checking only
npm test                 # vitest once
npm run test:coverage    # vitest coverage
npm run audit:ci         # prod audit + dev allowlist
npm run test:watch       # vitest watch mode
npm run lint             # eslint
```

Installer, which writes the real `~/.config/opencode/opencode.json` and
`tui.json` of whoever runs it:

```bash
npx -y oc-codex-multi-auth@latest          # register plugin entries only
npx -y oc-codex-multi-auth@latest --full   # also install the explicit model catalog
npx -y oc-codex-multi-auth@latest update   # refresh the package cache; never reads or writes config
```

A config that already registers this plugin keeps the entry it has, including
one pointing at a working checkout of this repository. The published package
name is added only when nothing in the config resolves to this plugin.

Standalone CLI examples:

```bash
oc-codex-multi-auth warm
oc-codex-multi-auth status --json
oc-codex-multi-auth doctor
```

## NOTES

- OAuth redirect URI: `http://localhost:1455/auth/callback` (registered with the Codex OAuth client). The callback server binds both `127.0.0.1:1455` and `[::1]:1455`.
- ChatGPT backend requires `store: false`, include `reasoning.encrypted_content`.
- OpenCode config: `~/.config/opencode/opencode.json`.
- OpenCode TUI config: `~/.config/opencode/tui.json`.
- OpenCode auth tokens: `~/.opencode/auth/openai.json`.
- Plugin config: `~/.opencode/openai-codex-auth-config.json`.
- Per-project accounts: `~/.opencode/projects/<project-key>/oc-codex-multi-auth-accounts.json`.
- Global accounts: `~/.opencode/oc-codex-multi-auth-accounts.json`.
- Flagged accounts: `oc-codex-multi-auth-flagged-accounts.json`, written beside the active accounts file (per project when `perProjectAccounts` is on).
- Credential snapshots: `backups/codex-credential-snapshot-*.json`, written beside the active accounts file. Holds the previous store content, captured before a significant write; retention prunes strictly by that prefix so it never deletes another backup kind.
- Quota notification state: `oc-codex-multi-auth-quota-notifications.json`, written beside the active accounts file (per project when `perProjectAccounts` is on).
- Request logs: `~/.opencode/logs/codex-plugin/` when logging is enabled.
- Model catalog: 10 modern bases / 53 variants; legacy 53 explicit.
- Bases: `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.5-fast`, `gpt-5.4-nano`, `gpt-5.1`. Routed but deliberately unshipped (Daybreak-gated, add by hand): `gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest`, `gpt-5.6-cyber`. Also routed but no longer shipped as bases (retired from Codex; still resolved if typed and rescued by default fallback): `gpt-5.4-mini` (retired 2026-08-31, replacement `gpt-6-luna`), `gpt-5-codex`/`gpt-5.1-codex`/`gpt-5.1-codex-max` (API shutdown 2026-07-23, replacement `gpt-5.6-sol`), `gpt-5.1-codex-mini` (API shutdown 2026-07-23, replacement `gpt-5.6-terra`).
- Prompt templates sync from Codex CLI GitHub releases with ETag caching; 5.6, GPT-6, and Daybreak instructions come from the Codex model catalog. openai/codex #43604 moved every model's instructions from `base_instructions` into `model_messages.instructions_template`, which the loader now renders; `gpt-6-astra` reads catalog text this way instead of falling back to its prompt file.
- 5xx server errors trigger account rotation and health penalty like network errors.
- API deprecation/sunset headers (RFC 8594) are logged as warnings.
- StorageError preserves original stack traces via `cause` parameter.
- `saveToDiskDebounced` errors are logged but do not crash the plugin.
