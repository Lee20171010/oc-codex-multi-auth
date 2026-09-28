# LIB KNOWLEDGE BASE

## OVERVIEW

Core plugin logic for authentication, request routing, account management, storage, model/prompt mapping, diagnostics, UI helpers, and TUI quota status support.

## STRUCTURE

```text
lib/
├── account-display.ts      # shared account identity rendering + maskEmail privacy behavior
├── accounts.ts             # account manager facade, storage orchestration, health scoring helpers
├── accounts/               # state, persistence, rotation, recovery, rate limits, warm requests, stale-state repair, pool identity
├── auth/                   # OAuth PKCE, callback server, browser/device/manual login, scopes, plan tier, token claims
├── auto-update-checker.ts  # npm version check and OpenCode cache refresh notification
├── circuit-breaker.ts      # failure isolation
├── cli.ts                  # auth/login CLI prompt helpers
├── codex-reset.ts          # banked rate-limit reset credit client (list + redeem)
├── codex-usage.ts          # usage/quota endpoint helpers for TUI status
├── config.ts               # plugin config parsing and env overrides
├── constants.ts            # URLs, provider ids, limits, labels
├── context-overflow.ts     # context length error handling
├── desktop-notifications.ts # macOS Notification Center delivery via osascript
├── error-sentinels.ts      # structured special-case errors
├── errors.ts               # custom error types
├── health.ts               # account health status
├── logger.ts               # debug/request logging
├── oauth-constants.ts      # OAuth port/path constants
├── oauth-success.ts        # OAuth success HTML source copied during build
├── opencode-v2.ts          # OpenCode V2 adapter: auth methods, provider/model reroute, aisdk hooks, tool bridge, RPC, storage scope
├── opencode-v2-provider.ts # distinct `aisdk:` package identity re-exporting `@ai-sdk/openai` createOpenAI
├── opencode-v2-rpc.ts      # `CodexStatusRpc` RPC definition shared by adapter and V2 TUI
├── opencode-v2-status.ts   # server-side quota/accounts formatting for the V2 status RPC
├── opencode-v2-tui.ts      # V2 TUI slots: status line, accounts sidebar, `/codex-accounts` + quota-details commands
├── parallel-probe.ts       # parallel account probes, first success wins
├── plan-allotment.ts       # ChatGPT plan_type -> allotment weight/multiplier/price
├── plugin-origin.ts        # published-package vs checkout detection + origin history file
├── proactive-refresh.ts    # token refresh before expiry
├── prompts/                # Codex/OpenCode prompts and ETag caches
├── quota-capacity.ts       # governing-window selection + plan-weighted pool headroom
├── quota-display.ts        # free/used wording for every human-readable quota percentage
├── quota-notification-state.ts # cross-process threshold/delivery state file
├── quota-notifications.ts  # aggregate quota poller and threshold transitions
├── quota-overview.ts       # pure pool-wide status line formatting + weighted total
├── quota-recovery.ts       # chronological quota-recovery simulation for the resets/recovery forecast
├── quota-windows.ts        # leaf parser for `x-codex-primary-*` / `x-codex-secondary-*` response headers
├── recovery.ts             # recovery barrel / compatibility entry
├── recovery/               # session recovery hook, storage, constants, types
├── refresh-queue.ts        # queued token refresh (race prevention)
├── request/                # URL/body/header transforms, SSE, retry budget, backoff
├── rotation.ts             # shared rotation utilities
├── runtime.ts              # pure runtime helpers and metrics/explainability types
├── schemas.ts              # Zod schemas
├── shutdown.ts             # graceful shutdown
├── storage.ts              # barrel re-exporting lib/storage/ (V3 JSON account storage)
├── storage/                # atomic writes, paths, migrations, keychain, backup/import/export, flagged accounts, transaction/worktree locks, coordinated refresh
├── table-formatter.ts      # CLI table formatting
├── tools/                  # 24 codex-* tool factories + registry
├── tui-quota-cache.ts      # shared quota snapshot cache (active account + pool overview)
├── tui-quota-overview.ts   # pool-wide quota gathering, caching, and live-account merge
├── tui-status-slot.ts      # Yoga flex-shrink guard so the host cannot ellipsize the budgeted status slot
├── tui-status.ts           # prompt quota status formatting
├── types.ts                # TypeScript interfaces
├── types/                  # dependency type shims
├── ui/                     # terminal UI formatting, menus, theme, select/confirm
└── utils.ts                # shared utilities
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Token exchange/refresh | `auth/auth.ts` | PKCE flow, JWT decode, skew window |
| Device/manual login | `auth/device-code.ts`, `auth/login-runner.ts` | headless login, workspace/account persistence |
| OAuth scopes | `auth/scopes.ts` | connector scope checks |
| Browser launch | `auth/browser.ts` | platform-specific open |
| Callback server | `auth/server.ts` | HTTP on port 1455 |
| Browser/manual OAuth lifecycle | `auth/loopback-flow.ts` | listener-first shared session, opener handling, callback exchange, close-once cleanup |
| Token claims / account ids | `auth/token-utils.ts` | JWT decode, `chatgpt_account_id` / `chatgpt_account_user_id` / organization extraction |
| Subscription name | `auth/plan-tier.ts` | `chatgpt_plan_type` claim -> OpenAI plan label (`team` is Business, `self_serve_business_prolite` is Business Premium) |
| OpenCode V2 adapter | `opencode-v2.ts`, `opencode-v2-provider.ts` | V2 `setup` entry; reuses the shared V1 runtime factory, re-points `openai` provider/models at a distinct `aisdk:` package identity, installs `sdk`/`language` hooks that enforce `store: false` + `reasoning.encrypted_content` on the wire, bridges `codex-*` tools through `tool.transform`, per-location `createStorageScope` |
| V2 status RPC | `opencode-v2-rpc.ts`, `opencode-v2-status.ts` | `CodexStatusRpc.status` formats quota/account data on the plugin side so remote TUIs never need credentials; pool overview re-fetches on a 5-minute cadence gated on last attempt, not last success |
| V2 TUI surface | `opencode-v2-tui.ts` | three `ui.slot`s (app poller, `prompt.footer.status`, `sidebar.content`), `codex.quota.details` + `codex.accounts` palette commands, `/codex-accounts` slash command |
| Plugin origin | `plugin-origin.ts` | detects published-package vs checkout installs and appends sightings to `oc-codex-multi-auth-origin.json` under a short proper-lockfile lease; shared name with the installer |
| URL/body transform | `request/request-transformer.ts` | model map, prompt injection, stateless compatibility |
| Headers + errors | `request/fetch-helpers.ts` | Codex headers, rate limit handling, fallback, refresh |
| Retry budgets | `request/retry-budget.ts` | bounded retry classes |
| Rate limit backoff | `request/rate-limit-backoff.ts` | exponential + jitter |
| SSE parsing | `request/response-handler.ts` | `response.done` extraction and empty responses |
| Model family detection | `prompts/codex.ts` | GPT-5.x and Codex variants |
| Bridge prompts | `prompts/codex-opencode-bridge.ts` | legacy OpenCode-to-Codex tool remapping instructions |
| Account selection | `accounts/rotation.ts`, `rotation.ts` | hybrid health + token bucket |
| Account rate limits | `accounts/rate-limits.ts` | per-account tracking |
| Account persistence | `accounts/persistence.ts`, `accounts/state.ts` | account manager state and save/load coordination |
| Model-pool identities | `accounts/pool-identity.ts` | stable pool keys for personal accounts and Business seats (`seat:` prefix) |
| Stale-state repair | `accounts/stale-state.ts`, `tools/doctor-repair.ts` | clears leftover cooldowns/rate-limit stamps after a verified refresh (`codex-doctor fix` / CLI `doctor --fix`) |
| Warm requests | `accounts/warm.ts`, `accounts/warm-request.ts`, `accounts/warm-recovery.ts` | minimal requests that open usage windows plus a post-warm `/wham/usage` re-check |
| Storage format | `storage.ts`, `storage/load-save.ts` | V3, with V1 migrated to V3 on load |
| Storage paths | `storage/paths.ts` | project root detection |
| Storage keychain | `storage/keychain.ts` | optional native keychain backend |
| Storage migrations | `storage/migrations.ts` | V1 → V3 upgrade; V2 files throw a StorageError with code UNKNOWN_V2_FORMAT |
| Backups/import/export | `storage/backup.ts`, `storage/export-import.ts` | timestamped backups and dry-run import preview |
| Credential snapshots | `storage/credential-snapshots.ts` | pre-write copy of the previous account store, denylist significance check, prefix-scoped retention |
| Test-home write guard | `storage/test-home-guard.ts` | refuses storage writes inside the real home during a vitest run |
| Transaction lease | `storage/transaction-lock.ts`, `storage/state.ts` | every mutation runs under the process mutex plus a `proper-lockfile` lease on `<storage>.transaction.lock` |
| Refresh coordination | `storage/coordinated-refresh.ts` | single-use refresh-token exchange serialized across processes under a separate `<storage>.refresh.lock` |
| Worktree collisions | `storage/worktree-lock.ts` | advisory detection of other live processes on the same account file; never blocks |
| Flagged accounts | `storage/flagged.ts` | deactivated/flagged metadata beside the active accounts file (V1-only schema) |
| Storage normalization | `storage/normalize.ts` | schema checks, forward-compat guard, V2 payload detection |
| Tool registry | `tools/index.ts` | `ToolContext`, `createToolRegistry` |
| TUI quota status | `tui-status.ts`, `tui-quota-cache.ts`, `codex-usage.ts` | prompt quota display and usage cache |
| Status slot flex guard | `tui-status-slot.ts` | captures/restores the Yoga flex-shrink on the exclusive host wrapper so a budgeted forecast is not ellipsized |
| Quota percentage wording | `quota-display.ts` | `quotaDisplay` free/used rendering shared by the TUI, `codex-limits`, the standalone CLI, and notifications; presentation only, so exhaustion and tone stay on the remaining percentage |
| Pool-wide status line | `quota-overview.ts`, `tui-quota-overview.ts` | `quotaStatus.mode` `overview` / `resets` renders every account on one constant line; `quota-overview.ts` is a pure formatter (ordering, `accounts`/`aggregate`/`count` layouts, degradation ladder, reset-credit line), `tui-quota-overview.ts` gathers/caches the pool and merges the request path's live reading of the serving account |
| Plan allotments | `plan-allotment.ts` | `plan_type` -> weight/multiplier/price, used to weight the pool total and to render `5x` badges; see `docs/plan-allotments.md` |
| Quota response headers | `quota-windows.ts` | leaf parser for `x-codex-primary-*` / `x-codex-secondary-*` headers; shared by the request path and the TUI cache |
| Pool headroom | `quota-capacity.ts` | governing-window selection per account and plan-weighted pool total |
| Quota recovery forecast | `quota-recovery.ts` | telescoped reset simulation feeding `quotaStatus.recovery` and the `resets` screen |
| Error types | `errors.ts`, `error-sentinels.ts` | StorageError and structured sentinel errors |
| Health monitoring | `health.ts` | account health status |
| Account display / masking | `account-display.ts` | label-preferred rendering, `maskEmail` behavior |
| Reset credits | `codex-reset.ts`, `codex-usage.ts` | banked rate-limit reset credit list/redeem; `codex-usage.ts` reads the same counts off the usage endpoint for `codex-limits`, sharing `normalizeResetCreditCount` so both agree |
| Parallel probes | `parallel-probe.ts` | races probe requests across candidate accounts, first success wins, losing probes aborted |
| Runtime helpers | `runtime.ts` | routing visibility, metrics, pure helper types |
| Graceful shutdown | `shutdown.ts` | cleanup on exit |
| Table formatting | `table-formatter.ts` | CLI output tables |
| Shared utilities | `utils.ts` | common helpers |

## CONVENTIONS

- Internal code imports focused modules directly; there is no lib-wide barrel.
- Model families are defined in `prompts/codex.ts` through `MODEL_FAMILIES` and helper functions.
- Account health uses a 0-100 score, decrements on failure, and recovers on success/passive recovery paths.
- Token bucket tracking is per account and helps avoid known rate-limit windows.
- StorageError preserves original stack traces via `cause`.
- Request defaults preserve `store: false` and `reasoning.encrypted_content` for ChatGPT-backed Codex compatibility.
- Tool modules receive shared state through `ToolContext`, not through module-level mutable singletons.

## ANTI-PATTERNS

- Never import from `dist/`; use source paths.
- Never suppress type errors.
- Never hardcode OAuth ports; use `oauth-constants.ts` / auth constants.
- Never remove `store: false` or `reasoning.encrypted_content` handling from the request path or templates.
- Never expose raw tokens in logs, tool output, diagnostics, or response headers.
- Never make keychain migration destructive without backup/rollback behavior.
