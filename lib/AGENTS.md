# LIB KNOWLEDGE BASE

Core plugin logic: auth, request pipeline, accounts/rotation, storage,
prompts/model catalog, quota + TUI support, tools, terminal UI.

## STRUCTURE

```text
lib/
├── accounts.ts             # AccountManager facade composing the accounts/ services; keeps the pre-split public API
├── accounts/               # state (registry + per-family cursors), persistence (debounced saves), rotation, rate-limits, recovery (auth-failure tracking + ~/.codex hydration), stale-state, pool-identity, warm + warm-request + warm-recovery
├── auth/                   # auth (PKCE + token exchange), server (port-1455 callback), loopback-flow (listener-first shared session), device-code, login-runner (headless login), browser, scopes, plan-tier, token-utils (JWT claims)
├── prompts/                # codex (model families + prompt-template fetch/ETag cache), codex-instructions (bundled offline fallback), opencode-codex, codex-opencode-bridge
├── request/                # request-transformer (URL/body), fetch-helpers (headers, error mapping, refresh), response-handler (SSE→JSON, empty-response, stall timeout), retry-budget, rate-limit-backoff
│   └── helpers/            # model-map, responses-lite, client-identity, user-agent, input-utils, tool-utils, effort-suffix
├── storage.ts              # facade barrel re-exporting lib/storage/ (pre-split import surface)
├── storage/                # paths, state (storage scope + path switching), load-save, migrations (V1→V3; V2 throws UNKNOWN_V2_FORMAT), normalize, identity (dedup/merge), atomic-write (0600 temp → fsync → rename → dir fsync), keychain (opt-in), backup, export-import, credential-snapshots, flagged, transaction-lock, worktree-lock, coordinated-refresh (cross-process token rotation), test-home-guard, errors
├── recovery.ts             # facade barrel re-exporting lib/recovery/
├── recovery/               # hook (auto-resume/repair engine), storage, constants, types
├── opencode-v2.ts          # V2 adapter: auth methods, provider/model reroute, aisdk hooks, tool bridge, RPC, storage scope
├── opencode-v2-provider.ts # distinct aisdk: package identity; re-exports createOpenAI from @ai-sdk/openai
├── opencode-v2-rpc.ts      # CodexStatusRpc RPC definition (status method)
├── opencode-v2-status.ts   # plugin-side quota/accounts formatting for the status RPC
├── opencode-v2-tui.ts      # V2 TUI slots: status line, accounts sidebar, palette + /codex-accounts commands
├── tools/                  # index (ToolContext + registry), args (shared arg constants), doctor-repair, refresh-account + 24 `codex-*` factories — see lib/tools/AGENTS.md
├── ui/                     # ansi, auth-menu, beginner, confirm, format, runtime, select, theme — terminal UI
├── types/                  # dependency type shims (napi-rs-keyring.d.ts)
├── account-display.ts      # account identity rendering + maskEmail privacy
├── auto-update-checker.ts  # npm latest-version check → cache refresh notice
├── circuit-breaker.ts      # failure isolation
├── cli.ts                  # auth/login CLI prompt helpers
├── codex-reset.ts          # banked rate-limit reset-credit client (list + redeem)
├── codex-usage.ts          # /wham/usage endpoint helpers (quota windows, reset-credit counts)
├── config.ts               # plugin config parsing, env overrides, stat-gated config cache, resolveAccountIdOverride
├── constants.ts            # URLs, provider ids, limits, labels
├── context-overflow.ts     # "prompt too long" → synthetic SSE advising /compact
├── desktop-notifications.ts # macOS Notification Center via osascript
├── error-sentinels.ts      # structured sentinel errors (rotation/cooldown contract)
├── errors.ts               # typed error hierarchy (CodexError, RequestError, …)
├── health.ts               # account health status types
├── logger.ts               # debug/request logging (env-gated)
├── oauth-constants.ts      # port 1455, callback path, bind hosts
├── oauth-success.ts        # OAuth callback success HTML renderer
├── parallel-probe.ts       # candidate ranking + concurrent probes; first success wins, losers aborted
├── plan-allotment.ts       # plan_type → allotment weight/multiplier/price
├── plugin-origin.ts        # published-package vs checkout detection + origin history file
├── proactive-refresh.ts    # refresh tokens before expiry (tokenRefreshSkewMs)
├── quota-capacity.ts       # governing-window selection + plan-weighted pool headroom
├── quota-display.ts        # shared free/used percentage wording
├── quota-notification-state.ts # cross-process threshold/delivery state file
├── quota-notifications.ts  # quota poller + threshold transitions
├── quota-overview.ts       # pure pool-wide status-line formatter
├── quota-recovery.ts       # reset simulation for recovery forecasts
├── quota-windows.ts        # x-codex-primary/secondary-* header parser
├── refresh-queue.ts        # serializes concurrent token refreshes
├── rotation.ts             # health-score + token-bucket trackers, rotation strategy
├── runtime.ts              # closure-free helpers, metrics + explainability types
├── schemas.ts              # Zod schemas — single source of truth for data shapes
├── shutdown.ts             # graceful-shutdown registry
├── table-formatter.ts      # ASCII tables for CLI output
├── tui-quota-cache.ts      # shared quota snapshot cache (active account + pool)
├── tui-quota-overview.ts   # pool gathering/caching + live-account merge for the status line
├── tui-status.ts           # prompt quota status formatting
├── tui-status-slot.ts      # Yoga flex-shrink guard for the status slot
├── types.ts                # shared TypeScript types (inferred from schemas)
└── utils.ts                # shared utilities
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Token exchange/refresh | `auth/auth.ts` | PKCE flow, JWT decode, skew window |
| Callback server | `auth/server.ts` | binds `127.0.0.1:1455` + `[::1]:1455`; IPv6 failure tolerated |
| Browser/manual OAuth lifecycle | `auth/loopback-flow.ts` | listener bound before any browser open; one close-once session shared by automatic + manual flows |
| Device/manual login | `auth/device-code.ts`, `auth/login-runner.ts` | headless paths; login-runner validates env input through schemas (e.g. `CODEX_AUTH_ACCOUNT_ID` via `resolveAccountIdOverride` in `config.ts`) |
| Scopes / plan / claims | `auth/scopes.ts`, `auth/plan-tier.ts`, `auth/token-utils.ts` | required scopes; `chatgpt_plan_type` → plan label; `chatgpt_account_*` claim extraction |
| Account selection | `accounts/rotation.ts`, `rotation.ts` | `rotationStrategy` hybrid (default)/sticky/round-robin; health score + token bucket |
| Account persistence/state | `accounts/persistence.ts`, `accounts/state.ts` | debounced saves + shutdown flush; in-memory registry + cursors |
| Auth-failure recovery + hydration | `accounts/recovery.ts` | per-token failure counters; hydrates from Codex CLI `~/.codex/accounts.json` |
| Model-pool identities | `accounts/pool-identity.ts` | stable pool keys; Business seats use `seat:` prefix |
| Stale-state repair | `accounts/stale-state.ts`, `tools/doctor-repair.ts` | clears leftover cooldowns/rate-limit stamps after verified refresh (`codex-doctor --fix`) |
| Warm requests | `accounts/warm.ts`, `accounts/warm-request.ts`, `accounts/warm-recovery.ts` | minimal request opens the usage window; post-warm `/wham/usage` re-check |
| URL/body transform | `request/request-transformer.ts` | model normalization, prompt injection, stateless compatibility |
| Headers + errors | `request/fetch-helpers.ts` | Codex headers, rate-limit handling, fallback, refresh |
| SSE parsing | `request/response-handler.ts` | `convertSseToJson`, `isEmptyResponse`; 10 MB cap + stall timeout |
| Retry/backoff | `request/retry-budget.ts`, `request/rate-limit-backoff.ts` | bounded retry classes; exponential + jitter |
| Model map | `request/helpers/model-map.ts` | config IDs → API model names incl. retired + Daybreak/cyber routes |
| Responses-lite + client identity | `request/helpers/responses-lite.ts`, `client-identity.ts`, `user-agent.ts` | lite reshape for catalog `use_responses_lite` models; `opencode` vs `codex_cli_rs` identity + UA |
| Storage format | `storage/load-save.ts`, `storage/migrations.ts`, `storage/normalize.ts` | V3 current; V1 migrates on load; V2 payload throws `UNKNOWN_V2_FORMAT` |
| Storage paths + scope | `storage/paths.ts`, `storage/state.ts` | project-root detection; `createStorageScope` for per-location isolation (V2) |
| Atomic writes | `storage/atomic-write.ts` | 0600 temp → fsync(fd) → rename → fsync(dir) |
| Cross-process refresh | `storage/coordinated-refresh.ts` | single-use refresh-token exchange serialized under a separate refresh lock; rotations propagate to sibling writers |
| Locks | `storage/transaction-lock.ts`, `storage/worktree-lock.ts` | proper-lockfile lease on every mutation; advisory worktree-collision detection (never blocks) |
| Keychain | `storage/keychain.ts` | opt-in (`CODEX_KEYCHAIN=1`); keychain holds the authoritative V3 blob when on; any keychain failure falls back to the JSON path — credentials are never silently lost |
| Dedup/merge | `storage/identity.ts` | identity-key hierarchy (org + account + user ids, then refreshToken) |
| Flagged accounts | `storage/flagged.ts` | deactivated metadata beside the accounts file; keychain-aware, JSON fallback on lock failure |
| Backups/import/export | `storage/backup.ts`, `storage/export-import.ts`, `storage/credential-snapshots.ts` | timestamped backups, dry-run import preview, pre-write snapshots with prefix-scoped retention |
| Test-home write guard | `storage/test-home-guard.ts` | refuses storage writes inside the real home during vitest |
| Model families + prompts | `prompts/codex.ts` | `MODEL_FAMILIES`, template fetch/ETag cache, `instructions_template` rendering |
| Prompt fallback | `prompts/codex-instructions.ts` | `BUNDLED_CODEX_INSTRUCTIONS` — last resort when fetch fails with no cache |
| Bridge prompts | `prompts/codex-opencode-bridge.ts` | legacy OpenCode→Codex tool remapping instructions |
| Config + env | `config.ts`, `schemas.ts` | stat-gated config cache (re-parse only when the file changes); env wins over file; bool env truthy only `"1"` |
| OpenCode V2 | `opencode-v2*.ts` | see root AGENTS.md → OPENCODE V2; `missingV2SdkSurface` guards SDK drift |
| Health / probes | `health.ts`, `parallel-probe.ts` | health status; concurrent probes across candidates, first success wins |
| TUI quota status | `tui-status.ts`, `tui-quota-cache.ts`, `tui-quota-overview.ts`, `tui-status-slot.ts`, `codex-usage.ts` | status line, shared cache, pool merge, flex guard, usage endpoint |
| Quota math | `quota-capacity.ts`, `quota-overview.ts`, `quota-recovery.ts`, `quota-windows.ts`, `quota-display.ts`, `quota-notifications.ts`, `quota-notification-state.ts`, `plan-allotment.ts` | header parsing → weighted pool totals → status line + notifications; `docs/plan-allotments.md` |
| Tools | `tools/index.ts` | `ToolContext`, `createToolRegistry` — see lib/tools/AGENTS.md |
| Errors | `errors.ts`, `error-sentinels.ts` | typed hierarchy; sentinels drive rotation/cooldown decisions |
| Terminal UI | `ui/` | ANSI/theme/format/select/confirm/auth-menu/beginner checklists/runtime |
| Misc | `account-display.ts`, `auto-update-checker.ts`, `circuit-breaker.ts`, `cli.ts`, `codex-reset.ts`, `context-overflow.ts`, `desktop-notifications.ts`, `plugin-origin.ts`, `proactive-refresh.ts`, `refresh-queue.ts`, `runtime.ts`, `shutdown.ts`, `table-formatter.ts`, `utils.ts` | see tree comments |

## CONVENTIONS

- Import the focused module, not a barrel — the former lib-wide barrel was deleted. The three remaining facades (`accounts.ts`, `storage.ts`, `recovery.ts`) exist only to keep the pre-split import surface stable.
- Internal imports carry `.js` specifiers so `tsc` output resolves under Node ESM.
- `schemas.ts` is the source of truth for data shapes; `types.ts` re-exports inferred types.
- Account health is a 0–100 score: decremented on failure, recovered on success/passive paths; token-bucket state avoids known rate-limit windows.
- The stateless contract — `store: false` + `reasoning.encrypted_content` — is enforced on every request path, including the V2 `aisdk` hooks.
- `StorageError` preserves original stack traces via `cause`; debounced-save failures are logged, never fatal.
- Tool modules get shared state via `ToolContext`, never module-level mutable singletons.

## ANTI-PATTERNS

- Never import from `dist/`; use source paths.
- Never suppress type errors (`as any`, `@ts-ignore`, `@ts-expect-error`, non-null `!` is a warning).
- Never hardcode OAuth ports — `oauth-constants.ts` owns port 1455 and the bind hosts.
- Never drop `store: false` / `reasoning.encrypted_content` from request paths or config templates.
- Never log raw tokens, emails, or prompt/response bodies; use the redaction helpers.
- Never delete JSON credentials when keychain operations fail — the JSON file is authoritative.
- Never write storage outside the atomic-write + transaction-lock path.
