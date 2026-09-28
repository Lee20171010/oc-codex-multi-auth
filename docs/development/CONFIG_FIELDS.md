# Config Fields

This document summarizes the current config fields that matter for `oc-codex-multi-auth`.

## Top-Level Fields

### `plugin`

Use the plain package name in OpenCode config:

```json
{
  "plugin": ["oc-codex-multi-auth"]
}
```

The installer normalizes to this unpinned value on purpose.

### `model`

Sets the default selected model. Compact modern installs use base IDs plus OpenCode variants:

```json
{
  "model": "openai/gpt-5.5"
}
```

With `--full` or `--legacy`, explicit preset IDs also work:

```json
{
  "model": "openai/gpt-5.5-medium"
}
```

## `provider.openai.options`

These are the global defaults the plugin receives for every OpenAI request.

Common fields:

| Field | Purpose |
|------|---------|
| `reasoningEffort` | default reasoning depth |
| `reasoningSummary` | reasoning summary style |
| `textVerbosity` | output verbosity |
| `include` | extra response fields, typically `reasoning.encrypted_content` |
| `store` | must stay `false` for this plugin |

Example:

```json
{
  "provider": {
    "openai": {
      "options": {
        "reasoningEffort": "medium",
        "reasoningSummary": "auto",
        "textVerbosity": "medium",
        "include": ["reasoning.encrypted_content"],
        "store": false
      }
    }
  }
}
```

## `provider.openai.models`

This field differs slightly between the modern and legacy shipped templates.

### Modern template fields

Modern templates define 10 base model families and expose 53 presets through `variants`.

Example:

```json
{
  "provider": {
    "openai": {
      "models": {
        "gpt-5.5": {
          "name": "GPT 5.5 (OAuth)",
          "limit": {
            "context": 1050000,
            "output": 128000
          },
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },
          "variants": {
            "none": { "reasoningEffort": "none" },
            "medium": { "reasoningEffort": "medium" },
            "xhigh": { "reasoningEffort": "xhigh" }
          }
        },
        "gpt-5.6-sol": {
          "name": "GPT 5.6 Sol (OAuth)",
          "limit": {
            "context": 1050000,
            "output": 128000
          },
          "variants": {
            "low": { "reasoningEffort": "low" },
            "medium": { "reasoningEffort": "medium" },
            "high": { "reasoningEffort": "high" },
            "xhigh": { "reasoningEffort": "xhigh" },
            "max": { "reasoningEffort": "max" },
            "ultra": { "reasoningEffort": "ultra" }
          }
        }
      }
    }
  }
}
```

Important fields:

| Field | Purpose |
|------|---------|
| model key (`gpt-5.5`, `gpt-5.6-sol`, …) | base model family exposed to OpenCode |
| `name` | human-readable picker label |
| `limit` | context/output metadata shown to OpenCode |
| `modalities` | allowed input/output types |
| `variants` | reasoning/verbosity presets selected with `--variant` |
| `options` | per-model defaults when needed |

If your OpenCode release exposes bare base entries, modern selection looks like:

```bash
opencode run "task" --model=openai/gpt-5.5 --variant=high
opencode run "task" --model=openai/gpt-5.6-sol --variant=medium
```

### Legacy template fields

Legacy templates expose each preset as its own model key (53 explicit entries).

Example:

```json
{
  "provider": {
    "openai": {
      "models": {
        "gpt-5.5-high": {
          "name": "GPT 5.5 High (OAuth)",
          "limit": {
            "context": 1050000,
            "output": 128000
          },
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },
          "options": {
            "reasoningEffort": "high",
            "reasoningSummary": "detailed",
            "textVerbosity": "medium",
            "include": ["reasoning.encrypted_content"],
            "store": false
          }
        }
      }
    }
  }
}
```

Legacy selection example:

```bash
opencode run "task" --model=openai/gpt-5.5-high
```

## Model Normalization

The plugin normalizes selected model IDs before the upstream API call.

Examples:

| Selected model | Effective upstream family |
|------|---------|
| `openai/gpt-5.5` + variant `medium` | `gpt-5.5` |
| `openai/gpt-5.5-medium` | `gpt-5.5` |
| `openai/gpt-5.6-sol` + variant `high` | `gpt-5.6-sol` |
| `openai/gpt-5.6-sol-xhigh` | `gpt-5.6-sol` |
| `openai/gpt-5.6` | `gpt-5.6-sol` |
| `openai/gpt-5.6-terra-medium` | `gpt-5.6-terra` |
| `openai/gpt-5.6-luna-max` | `gpt-5.6-luna` |
| `openai/gpt-6-astra-ultra` | `gpt-6-astra` |
| `openai/gpt-6` | `gpt-6-astra` |
| `openai/gpt-6-astra-pro-high` | `gpt-6-astra` (Astra Pro is not a Codex-routable id) |
| `openai/gpt-6-sol-xhigh` | `gpt-6-sol` |
| `openai/gpt-6-luna-max` | `gpt-6-luna` |
| `openai/gpt-daybreak-blue-xhigh` | `gpt-daybreak-blue-latest` |
| `openai/gpt-5.6-cyber-max` | `gpt-5.6-cyber` (never `gpt-5.6-sol`) |
| `openai/gpt-5.4-mini-xhigh` | `gpt-5.4-mini` |
| `openai/gpt-5.1-codex-high` | `gpt-5-codex` |
| `openai/gpt-5.1-codex-max-high` | `gpt-5.1-codex-max` |
| `openai/gpt-5-mini` | `gpt-6-luna` (was `gpt-5.4-mini`) |
| `openai/gpt-5-nano` | `gpt-5.4-nano` |

Note that the `gpt-5.1-codex` catalog entry normalizes to the canonical
`gpt-5-codex` family upstream, while `gpt-5.1-codex-max` and
`gpt-5.1-codex-mini` are each their own family. The catalog ID you select and
the family actually sent to the backend are therefore not always the same
string; `MODEL_MAP` in `lib/request/helpers/model-map.ts` is the authoritative
mapping.

This normalization is why legacy aliases and snapshot-like IDs can still route to a stable family while preserving the user-facing config surface. GPT-6 Astra/Sol/Luna, the Daybreak tiers and the GPT-5.6 tiers all trigger the responses-lite request shape after normalization.

## Plugin Runtime Config

Path: `~/.opencode/openai-codex-auth-config.json`

Defaults come from `lib/config.ts` / `lib/schemas.ts`. Environment overrides win over file values. Boolean env values are truthy only for `"1"`.

| Field | Default | Env override | Purpose |
|------|---------|--------------|---------|
| `codexMode` | `true` | `CODEX_MODE` | Legacy bridge prompt behavior when `requestTransformMode=legacy` |
| `requestTransformMode` | `native` | `CODEX_AUTH_REQUEST_TRANSFORM_MODE` | `native` preserves host payload; `legacy` rewrites for older SDKs |
| `codexTuiV2` | `true` | `CODEX_TUI_V2` | Codex-style terminal UI output |
| `codexTuiColorProfile` | `truecolor` | `CODEX_TUI_COLOR_PROFILE` | `truecolor` / `ansi256` / `ansi16` |
| `codexTuiGlyphMode` | `ascii` | `CODEX_TUI_GLYPHS` | `ascii` / `unicode` / `auto` |
| `maskEmail` | `false` | `CODEX_TUI_MASK_EMAIL` | Mask account emails on display surfaces |
| `maskEmailInQuotaDetails` | `false` | `CODEX_TUI_MASK_EMAIL_DETAILS` | Also mask email in quota details |
| `quotaDisplay` | `free` | `CODEX_AUTH_QUOTA_DISPLAY` | Word quota percentages as `free` headroom or `used` consumption; presentation only |
| `quotaStatus.mode` | `active` | (file only) | Screen, or list of screens to alternate between: `active`, `overview`, `resets` |
| `quotaStatus.rotateMs` | `5000` | (file only) | How long each screen stays up when `mode` is a list; minimum 1000 |
| `quotaStatus.layout` | `accounts` | (file only) | `accounts`, `aggregate` (collapse a shared percentage), `count` (`3 accounts`), or `total` (no account segments/count) |
| `quotaStatus.accountNames` | `number` | (file only) | `number` (`#1`), `label` (`codex-label` label or email local part), or `none` |
| `quotaStatus.order` | `number` | (file only) | `number`, `most-used`, `least-used`, `renewing-earliest`, `renewing-latest` |
| `quotaStatus.multipliers` | `false` | (file only) | `5x` / `20x` plan allotment badges |
| `quotaStatus.allotment` | `false` | (file only) | `24% of 26x`: what the weighted pool adds up to in 1x seats |
| `quotaStatus.resetTimes` | `low` | (file only) | `never`, `low` (at or below 25% headroom), or `always` |
| `quotaStatus.resetCredits` | `false` | (file only) | `1r` for banked rate-limit resets redeemable now |
| `quotaStatus.recovery` | `false` | (file only) | `true`: next signed movement; `"all"`: all known incremental capacity returns, always positive |
| `quotaStatus.resetsMinUsedPercent` | `100` | (file only) | Exact total weighted usage threshold (0-100) for the reset-credit screen, independent of `quotaDisplay` |
| `quotaStatus.rows` | `1` | (file only) | Ceiling on the rows the line may take (1-4). A rendering that fits on one row still takes one |
| `quotaStatus.showFor` | `always` | (file only) | `always`, or `codex-models` to hide the line unless the session runs a model this plugin routes |
| `limitsSort.by` | `account` | (file only) | Default order of the standalone `limits` CLI: `account`, `usage`, or `reset`; `--sort` overrides |
| `limitsSort.direction` | `asc` | (file only) | `asc` or `desc`; `--asc` / `--desc` override |

`quotaStatus` is deliberately file-only: it is a display preference belonging to
a person, not to whichever shell started OpenCode. `resetTimes` also accepts the
boolean spelling an earlier build took (`true` -> `low`, `false` -> `never`),
and `accounts: false` is honoured as `layout: "count"`, because
`PluginConfigSchema` validates the file as one unit and one stale value would
otherwise reset every other setting in it.
| `beginnerSafeMode` | `false` | `CODEX_AUTH_BEGINNER_SAFE_MODE` | Conservative retries and recovery |
| `fastSession` | `false` | `CODEX_AUTH_FAST_SESSION` | Force low-latency reasoning/verbosity |
| `fastSessionStrategy` | `hybrid` | `CODEX_AUTH_FAST_SESSION_STRATEGY` | `hybrid` or `always` |
| `fastSessionMaxInputItems` | `30` | `CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS` | Max input items kept in fast mode |
| `rotationStrategy` | `hybrid` | `CODEX_AUTH_ROTATION_STRATEGY` | `hybrid`, `sticky`, or `round-robin` account selection |
| `modelAccountPools` | `{}` | (file only) | Preferred stable account IDs per effective model |
| `modelAccountPoolModes` | `{}` | (file only) | Per-model `preferred` or `strict` pool policy |
| `retryProfile` | `balanced` | `CODEX_AUTH_RETRY_PROFILE` | `conservative` / `balanced` / `aggressive` |
| `retryBudgetOverrides` | `{}` | (file only) | Per-class budget overrides |
| `retryAllAccountsRateLimited` | `true` | `CODEX_AUTH_RETRY_ALL_RATE_LIMITED` | Wait/retry when every account is limited |
| `retryAllAccountsMaxWaitMs` | `0` | `CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS` | Max wait ms (`0` = unlimited) |
| `retryAllAccountsMaxRetries` | `Infinity` | `CODEX_AUTH_RETRY_ALL_MAX_RETRIES` | Max all-account retries |
| `unsupportedCodexPolicy` | `strict` | `CODEX_AUTH_UNSUPPORTED_MODEL_POLICY` | `strict` or `fallback` |
| `fallbackOnUnsupportedCodexModel` | `false` | `CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL` | Legacy fallback toggle |
| `fallbackToGpt52OnUnsupportedGpt53` | `true` | `CODEX_AUTH_FALLBACK_GPT53_TO_GPT52` | Legacy 5.3→5.2 edge |
| `unsupportedCodexFallbackChain` | `{}` | (file only) | Per-model fallback chain overrides |
| `tokenRefreshSkewMs` | `60000` | `CODEX_AUTH_TOKEN_REFRESH_SKEW_MS` | Refresh tokens this many ms before expiry |
| `rateLimitToastDebounceMs` | `60000` | `CODEX_AUTH_RATE_LIMIT_TOAST_DEBOUNCE_MS` | Debounce rate-limit toasts |
| `toastDurationMs` | `5000` | `CODEX_AUTH_TOAST_DURATION_MS` | Toast visibility duration |
| `accountToasts` | `true` | `CODEX_AUTH_ACCOUNT_TOASTS` | Gates only the informational "Using \<account\> (N/N)" selection toast; warning/error toasts are unaffected |
| `perProjectAccounts` | `true` | `CODEX_AUTH_PER_PROJECT_ACCOUNTS` | Project-scoped account pools |
| `credentialSnapshots` | `true` | `CODEX_AUTH_CREDENTIAL_SNAPSHOTS` | Copy the previous account store into `backups/` before a significant change |
| `credentialSnapshotsMaxCount` | `10` | `CODEX_AUTH_CREDENTIAL_SNAPSHOTS_MAX_COUNT` | Snapshots kept; `0` keeps all of them, and disabling is `credentialSnapshots`' job |
| `sessionRecovery` | `true` | `CODEX_AUTH_SESSION_RECOVERY` | Auto-recover common API errors |
| `autoResume` | `true` | `CODEX_AUTH_AUTO_RESUME` | Auto-resume after thinking-block recovery |
| `autoUpdate` | `true` | `CODEX_AUTH_AUTO_UPDATE` | Daily npm update check + cache refresh |
| `parallelProbing` | `false` | `CODEX_AUTH_PARALLEL_PROBING` | Concurrent account health probes; probe infrastructure exists in `lib/parallel-probe.ts` with test coverage, but the main fetch loop probes sequentially, so this flag has no runtime consumer today |
| `parallelProbingMaxConcurrency` | `2` | `CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY` | Max concurrent probes (1–5) |
| `emptyResponseMaxRetries` | `2` | `CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES` | Retries after empty SSE bodies |
| `emptyResponseRetryDelayMs` | `1000` | `CODEX_AUTH_EMPTY_RESPONSE_RETRY_DELAY_MS` | Delay between empty-response retries |
| `pidOffsetEnabled` | `false` | `CODEX_AUTH_PID_OFFSET_ENABLED` | Small PID-based hybrid score offset for multi-process spread |
| `fetchTimeoutMs` | `60000` | `CODEX_AUTH_FETCH_TIMEOUT_MS` | Upstream fetch timeout |
| `streamStallTimeoutMs` | `45000` | `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS` | SSE stall abort timeout |
| `quotaNotifications.enabled` | `false` | `CODEX_AUTH_QUOTA_NOTIFICATIONS` | macOS-only aggregate quota alerts |
| `quotaNotifications.autoProtectCredits` | `true` | `CODEX_AUTH_AUTO_PROTECT_CREDITS` | Periodically exclude fully spent subscription quotas from rotation before they draw paid Credits |
| `quotaNotifications.intervalMs` | `1800000` | `CODEX_AUTH_QUOTA_NOTIFICATIONS_INTERVAL_MS` | Quota poll interval (minimum `30000`) |
| `quotaNotifications.notifyEveryCheck` | `false` | (file only) | Alert after every poll, not only on threshold crossings |
| `quotaNotifications.thresholds` | `[25, 10, 0]` | (file only) | Remaining-percent alert thresholds; `[]` disables threshold alerts |

### Numeric bounds

`lib/schemas.ts` validates the config file with Zod. An out-of-bounds file value fails validation for that key, the loader logs a validation warning, and the key is dropped, so the default applies. It is never clamped to the nearest bound. Environment numeric overrides take a different path through `resolveNumberSetting` in `lib/config.ts`, which clamps into the configured range instead of dropping: a duration env value above `MAX_CONFIG_DURATION_MS` (86400000, i.e. 24h) is capped rather than silently honoured as an infinite wait. `retryAllAccountsMaxWaitMs` is exempt from that ceiling because `0` is a documented "wait without a bound" for riding out multi-day quota resets. Integer-semantic env values are strict: a fractional `CODEX_AUTH_*=2.5` is rejected and the config file / default applies, the same contract `CODEX_AUTH_CREDENTIAL_SNAPSHOTS_MAX_COUNT` already had (flooring a negative value to `0` would silently select keep-everything, and truncating `2.5` would honour a count nobody wrote).

| field | config-file bounds (Zod) | env bounds (resolver) |
|-------|--------------------------|-----------------------|
| `fastSessionMaxInputItems` | integer, 8 to 200 | integer, at least 8, no ceiling |
| `retryAllAccountsMaxRetries` | integer, at least 0 | integer, at least 0 |
| `retryAllAccountsMaxWaitMs` | at least 0 | at least 0 (`0` = unlimited; no 24h ceiling) |
| `parallelProbingMaxConcurrency` | integer, 1 to 5 | integer, clamped 1 to 5 |
| `emptyResponseMaxRetries` | integer, at least 0 | integer, at least 0 |
| `toastDurationMs` | 1000 to 86400000 | clamped 1000 to 86400000 |
| `tokenRefreshSkewMs` | 0 to 86400000 | clamped 0 to 86400000 |
| `rateLimitToastDebounceMs` | 0 to 86400000 | clamped 0 to 86400000 |
| `emptyResponseRetryDelayMs` | 0 to 86400000 | clamped 0 to 86400000 |
| `fetchTimeoutMs` | 1000 to 86400000 | clamped 1000 to 86400000 |
| `streamStallTimeoutMs` | 1000 to 86400000 | clamped 1000 to 86400000 |
| `quotaNotifications.intervalMs` | 30000 to 86400000 | clamped 30000 to 86400000 |
| `quotaStatus.rotateMs` | 1000 to 86400000 | (file only) |
| `retryBudgetOverrides.*` | integer, at least 0 | (file only) |
| `credentialSnapshotsMaxCount` | integer, at least 0 | integer, at least 0 (rejected, not clamped) |

So `parallelProbingMaxConcurrency: 9` in the file falls back to the default `2`, `CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY=9` is clamped to `5`, and `CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY=2.5` is rejected as non-integer so the file / default applies.

### `modelAccountPools`

The plugin runtime config can map effective model IDs to preferred stable account or
Business-seat identities:

```json
{
  "modelAccountPools": {
    "gpt-5.6-sol": ["org-example-account-id"],
    "gpt-5.5": ["org-another-account-id"]
  },
  "modelAccountPoolModes": {
    "gpt-5.6-sol": "strict"
  }
}
```

The request pipeline resolves the pool after model normalization. All rotation
strategies restrict selection to healthy accounts in the preferred pool while
one is available. `modelAccountPoolModes` defaults each mapping to `preferred`,
which falls back to the general pool when the mapping is unavailable. A
`strict` mapping never leaves its configured accounts and fails immediately.
Empty lists and unmapped models use the general pool directly.

`codex-pool` is the supported mutation surface. It accepts 1-based account
numbers for `set`, `add`, and `remove`, but resolves and atomically persists
stable identities. Business members that share one workspace are persisted as
distinct seat keys derived from `accountId` and `accountUserId`. Legacy raw
`accountId` entries remain supported and match every seat in that workspace;
the next mutation canonicalizes known entries. `set-mode` switches between `preferred` and `strict`,
`clear` removes a model mapping and its mode, and every mutation
supports a dry-run preview. Writes preserve unrelated raw config fields and
refuse to replace malformed JSON or an invalid existing pool.

The config file is global while account storage is per-project by default.
Consequently, status may report unresolved references for the current project;
the tool does not automatically prune them because they may be valid elsewhere.

## Verification Notes

Use these commands when validating config fields.

### Compact modern (`--modern` install)

```bash
opencode debug config
ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "ping" --model=openai/gpt-5.5 --variant=medium
ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "ping" --model=openai/gpt-5.6-sol --variant=medium
```

### Full / legacy explicit selectors

```bash
npx -y oc-codex-multi-auth@latest --full
opencode debug config
ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "ping" --model=openai/gpt-5.5-medium
```

Important behavior:

- `opencode debug config` shows merged config-defined models and variants.
- Compact modern (`--modern`) installs expose base OAuth entries such as `gpt-5.5`, `gpt-5.5-fast`, and `gpt-5.6-sol`. The default plugin-only install writes no catalog, so `gpt-5.5-fast` and the `--variant` presets are unavailable until you install one.
- Bare `openai/gpt-5.5` works with `--variant=medium` on compact modern installs.
- Explicit IDs such as `openai/gpt-5.5-medium` require `--full` or `--legacy` unless you added them manually.
- Do not use `gpt-5.5-medium` for verification unless the full/legacy catalog is installed.

## Advanced / non-schema environment variables

Not part of `PluginConfigSchema`, but used by runtime modules:

| Env | Effect |
|-----|--------|
| `CODEX_THREAD_ID` | Optional correlation / prompt-cache seed on outbound requests |
| `OPENCODE_CODEX_PROMPT_URL` | Override OpenCode→Codex bridge prompt catalog URL (legacy transform) |
| `OPENCODE_SKIP_EMAIL_HYDRATE=1` | Skip email hydrate during account bootstrap |
| `FORCE_INTERACTIVE_MODE=1` | Force interactive menu paths for tests/special shells |
| `CODEX_AUTH_SYNC_CODEX_CLI=0` | Disable `~/.codex` account hydrate (on unless `"0"`) |
| `CODEX_AUTH_ACCOUNT_ID` | Force a specific workspace/account id during `opencode auth login` |
| `CODEX_KEYCHAIN=1` | Opt in to OS-native keychain account storage |
| `DEBUG_CODEX_PLUGIN=1` | Enable debug logging (request logging implies it) |
| `ENABLE_PLUGIN_REQUEST_LOGGING=1` | Log request metadata (no raw bodies) |
| `CODEX_PLUGIN_LOG_BODIES=1` | Include raw request/response bodies in request logs (sensitive) |
| `CODEX_PLUGIN_LOG_LEVEL=debug` | Set request-log level (`debug` / `info` / `warn` / `error`) |
| `CODEX_CONSOLE_LOG=1` | Mirror plugin logs to console |
| `CODEX_AUTH_PREWARM=0` | Disable startup prewarm when legacy transform is enabled (native mode does not prewarm) |
| `OPENAI_BASE_URL=https://gateway.example/v1` | OpenAI-compatible OAuth inference gateway; requires `CODEX_AUTH_ALLOW_OPENAI_BASE_URL=1` |
| `CODEX_AUTH_ALLOW_OPENAI_BASE_URL=1` | Explicitly allow the trusted gateway to receive the ChatGPT OAuth access token (HTTPS required, HTTP only on loopback) |
| `CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK=1` | Disable the automatic `gpt-6-astra -> gpt-6-sol -> gpt-5.6-sol -> gpt-5.6-terra -> gpt-5.5 -> gpt-6-luna -> gpt-5.6-luna` rollout fallback chain (also covers `gpt-6-sol` and `gpt-6-luna` selected directly) |
| `CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK=1` | Disable the automatic `gpt-5.6-sol -> gpt-5.6-terra -> gpt-5.5 -> gpt-6-luna -> gpt-5.6-luna` preview fallback chain |
| `CODEX_AUTH_DISABLE_GPT55_AUTO_FALLBACK=1` | Disable the automatic `gpt-5.5 -> gpt-6-sol -> gpt-5.6-sol -> gpt-5.6-terra -> gpt-6-luna -> gpt-5.6-luna` fallback |
| `CODEX_AUTH_DISABLE_CODEX_AUTO_FALLBACK=1` | Disable the automatic `gpt-5-codex -> gpt-5.6-terra -> gpt-5.6-luna` fallback |
| `CODEX_AUTH_CLIENT_IDENTITY=codex` | Force one client identity for all models: `codex` or `opencode` (alias `host`) |
| `CODEX_AUTH_CLIENT_VERSION=0.150.0` | Override the Codex CLI version advertised in the `codex_cli_rs` User-Agent |
| `CODEX_AUTH_HOST_VERSION=1.18.0` | Override the opencode version advertised in the `opencode` User-Agent |
| `CODEX_AUTH_DISABLE_CODEX_USER_AGENT=1` | Keep the host runtime's `User-Agent` instead of the identity's |
| `CODEX_AUTH_SEND_ORGANIZATION_HEADER=1` | Restore legacy `openai-organization` request pinning (off by default) |
| `CODEX_COLLABORATION_MODE` / `OPENCODE_COLLABORATION_MODE` | Collaboration mode hint for request shaping |
| `OPENCODE_STATE_DIR` | Override state directory for TUI quota cache |

## Account Metadata Fields

Account storage also includes user-facing metadata fields used by the `codex-*` tools:

| Field | Purpose |
|------|---------|
| `accountLabel` | display label |
| `accountTags` | grouping/filter tags |
| `accountNote` | short reminder text |

These fields are updated by `codex-label`, `codex-tag`, and `codex-note`.

## See Also

- [CONFIG_FLOW.md](./CONFIG_FLOW.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [Public configuration reference](../configuration.md)
