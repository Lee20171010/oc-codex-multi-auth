# Configuration Reference

Complete reference for configuring `oc-codex-multi-auth`. Most of this is optional; the defaults work for most people.

Boolean environment overrides are truthy only for the literal string `"1"`.

---

## Base Configuration

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["oc-codex-multi-auth"],
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

---

## Model Options

### Reasoning Effort

controls how much thinking the model does.

| model | supported values |
|-------|------------------|
| `gpt-6-astra` | low, medium, high, xhigh, max, ultra |
| `gpt-6-sol` | low, medium, high, xhigh, max, ultra |
| `gpt-6-luna` | low, medium, high, xhigh, max |
| `gpt-daybreak-blue-latest` | low, medium, high, xhigh, max, ultra (Daybreak-gated; add manually) |
| `gpt-daybreak-red-latest` | low, medium, high, xhigh, max, ultra (Daybreak-gated; add manually) |
| `gpt-5.6-cyber` | low, medium, high, xhigh, max, ultra (Daybreak-gated; add manually) |
| `gpt-5.6-sol` | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-terra` | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-luna` | low, medium, high, xhigh, max |
| `gpt-5.5` | none, low, medium, high, xhigh |
| `gpt-5.5-fast` | none, low, medium, high, xhigh |
| `gpt-5.4` | none, low, medium, high, xhigh (retired from Codex 2026-08-31; auto-upgrades to `gpt-6-sol`) |
| `gpt-5.4-mini` | none, low, medium, high, xhigh (retired from Codex 2026-08-31, no longer shipped as a base; auto-upgrades to `gpt-6-luna`; still routed if typed) |
| `gpt-5.4-nano` | none, low, medium, high, xhigh |
| `gpt-5.4-pro` | low, medium, high, xhigh (optional/manual model) |
| `gpt-5-codex` | low, medium, high (default: high; API shutdown 2026-07-23, no longer shipped as a base; replacement `gpt-5.6-sol`; still routed if typed) |
| `gpt-5.3-codex` | low, medium, high, xhigh (distinct legacy model id; falls back to `gpt-5-codex`) |
| `gpt-5.3-codex-spark` | low, medium, high, xhigh (entitlement-gated distinct model id, not an alias of `gpt-5-codex`; add manually) |
| `gpt-5.2-codex` | low, medium, high, xhigh (distinct legacy model id; falls back to `gpt-5-codex`) |
| `gpt-5.2` | none, low, medium, high, xhigh |
| `gpt-5.1-codex-max` | low, medium, high, xhigh (default: high; `xhigh` only when explicitly requested; API shutdown 2026-07-23, no longer shipped as a base; replacement `gpt-5.6-sol`; still routed if typed) |
| `gpt-5.1-codex` | low, medium, high (legacy alias to `gpt-5-codex`; API shutdown 2026-07-23, no longer shipped as a base; still routed if typed) |
| `gpt-5.1-codex-mini` | medium, high (API shutdown 2026-07-23, no longer shipped as a base; replacement `gpt-5.6-terra`; still routed if typed) |
| `gpt-5.1` | none, low, medium, high |

The shipped config templates include 10 base model families and 53 shipped presets overall (53 modern variants or 53 legacy explicit entries). Default install preserves `provider.openai`; use `--modern` to install the compact base families and variant picker, or `--full` to install explicit selector IDs too. `gpt-5.5-pro` is ChatGPT-only (not routed by this plugin). `gpt-6-astra-pro` is almost certainly not a model id at all (see below). `gpt-5.3-codex-spark` and the three Daybreak-gated cyber tiers remain manual add-ons for entitled workspaces only.

Base families:

```text
gpt-6-astra
gpt-6-sol
gpt-6-luna
gpt-5.6-sol
gpt-5.6-terra
gpt-5.6-luna
gpt-5.5
gpt-5.5-fast
gpt-5.4-nano
gpt-5.1
```

`gpt-5.4-mini`, `gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, and `gpt-5.1-codex-mini` were removed from both config templates: `gpt-5.4-mini` retired from Codex with ChatGPT sign-in on 2026-08-31 (replacement `gpt-6-luna`), and the other four were shut down from the OpenAI API on 2026-07-23 (replacement `gpt-5.6-sol`, or `gpt-5.6-terra` for `gpt-5.1-codex-mini`). Routing for these ids is unchanged: a user who still types one of them by hand is still routed and rescued by the default fallback chains.

GPT-6 Astra notes:
- Astra is OpenAI's frontier model, launched 2026-09-03. Efforts are low through `ultra`, matching OpenAI's Codex model list. Its API reference page says only "`reasoning.effort` supports `low`, `medium`, `high`, `xhigh`, and `max`", which is not a contradiction: `ultra` is a Codex client-side tier that is rewritten to `max` before the request leaves the client, so an API reference has no reason to list it. `gpt-5.6-sol` shows the same split.
- Astra is opt-in, like the 5.6 tiers: neither the `gpt-5` alias nor the plugin default resolves to it (both resolve to `gpt-6-sol`). It rolled out to a limited set of organizations first and to Plus/Pro/Business/Enterprise over the following days, so an account outside the rollout auto-degrades `gpt-6-astra → gpt-6-sol → gpt-5.6-sol → gpt-5.6-terra → gpt-5.5 → gpt-6-luna → gpt-5.6-luna`. Disable with `CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK=1`.
- Bare `gpt-6` is a **plugin-side** alias for `gpt-6-astra`. OpenAI publishes no bare `gpt-6` id.
- "GPT-6 Astra Pro" appears in launch-day press but is very likely not a model id at all: `/api/docs/models/gpt-6-astra-pro` returns 404 while the real `gpt-5.5-pro` and `gpt-5.4-pro` pages both return 200, and it is absent from both the `ChatModel` and `ResponsesOnlyModel` enums of the OpenAPI spec added by the SDK PR that introduced Astra (openai/openai-python#3791), an enum that does list `gpt-5.5-pro`. The plugin maps `gpt-6-astra-pro*` onto `gpt-6-astra` anyway, so a user who typed it after reading the press gets a working request instead of an unknown slug on the wire.
- Astra is sent over the **responses-lite** path. Astra's catalog entry landed in openai/codex commit `ed391d4d` (2026-09-03) and reads `use_responses_lite: true`, `tool_mode: "code_mode_only"`, `multi_agent_version: "v2"`, so the shape is read rather than inferred. The `CODEX_AUTH_ASTRA_RESPONSES_LITE` switch that 6.17.0 carried while this was unverifiable has been removed.
- Astra's instructions come from the catalog. Its first catalog entry shipped an empty `base_instructions`, but openai/codex #43604 (2026-09-07) moved every model's instructions into `model_messages.instructions_template`, and the plugin now renders that template (substituting the empty `personality_default`) instead of falling back to `gpt_5_2_prompt.md`.
- The catalog marks Astra `visibility: "hide"` with `priority: 1` and `minimal_client_version: 0.153.0`, which is the staged rollout rather than a program gate. Unlike the Daybreak tiers it still ships in the config templates, because it has an auto-fallback chain: an unentitled account costs one round trip and lands on a working model, where a Daybreak request would hard-fail.

GPT-6 Sol / Luna notes:
- `gpt-6-sol` and `gpt-6-luna` were added to the Codex model catalog on 2026-09-22 (openai/codex commit `49e95cc7`). Sol is the workhorse model for coding and everyday work; Luna is the fast, affordable model for easier tasks.
- Sol supports low/medium/high/xhigh/max/ultra; Luna supports low/medium/high/xhigh/max (no `ultra`). Neither accepts `none` or `minimal`; both clamp to `low`. `ultra` is sent on the wire as `max`, same as Astra and 5.6.
- Both ship in the config templates and are served over the **responses-lite** path with default client identity `opencode`, same as Astra.
- Both are covered by the same `CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK` opt-out as Astra.
- A release tag from before 2026-09-22 has no catalog entry for either, so instructions fall back to `gpt_5_2_prompt.md` on those tags.

Cyber tier notes (Daybreak-gated):
- `gpt-daybreak-blue-latest` (defensive security) and `gpt-daybreak-red-latest` (cyber-permissive, for authorized security research) are catalog-verified cyber-specialty models with `model_specialty: "cyber"`, `use_responses_lite: true`, `tool_mode: "code_mode_only"`, efforts low through ultra. `gpt-5.6-cyber` is OpenAI's published alias fronting them; it belongs to the 5.6 generation, not GPT-6.
- All three require Daybreak program approval, and Blue/Red are `visibility: "hide"` in the catalog. They are therefore **not** in the shipped config templates, for the same reason `gpt-5.3-codex-spark` is not: shipping an entitlement-gated id to every user causes avoidable startup failures. The plugin routes them fully, so an entitled user adds the id by hand and it works.
- None of the three has a fallback chain, deliberately. Degrading a cyber-specialty request onto a general model would answer a security-research prompt with a model that was never asked for, so an unentitled account gets a hard failure instead of a silent substitution.
- `gpt-daybreak-blue` and `gpt-daybreak-red` are accepted as short forms of the `-latest` ids.
- `gpt-5.6-cyber` is matched ahead of the bare `gpt-5.6` alias, which would otherwise claim it and route a security request to Sol.

GPT-5.6 notes:
- 5.6 models are served over the **responses-lite** path. Their catalog entry sets `use_responses_lite: true` and `tool_mode: "code_mode_only"`, so the plugin reshapes the request the way Codex does: tool definitions move into `input` as a leading `additional_tools` developer item, the Codex instructions follow as a developer message, top-level `instructions` is emptied, `tools` is omitted, `parallel_tool_calls` is forced off, image `detail` fields are stripped, and an `x-openai-internal-codex-responses-lite: true` header is sent. Pre-5.6 models keep the classic shape.
- No 5.6 tier accepts `none` or `minimal`; both are raised to `low`.
- `max` and `ultra` are new in 5.6. Requesting them on an older family steps down to `xhigh` (then `high` where xhigh is unsupported).
- `ultra` is a client-side tier. Codex rewrites it to `max` before the request leaves the client, and the subagent orchestration that distinguishes ultra lives in the Codex client rather than the request body. This plugin is a proxy, so `-ultra` is accepted as an alias and sent on the wire as `max`, and it does **not** spawn subagents.
- 5.6 is opt-in: the legacy `gpt-5` alias now resolves to `gpt-6-sol` (was `gpt-5.5`), and the plugin default for a missing or unrecognized model id is also `gpt-6-sol` (was `gpt-5.4`, retired). Because 5.6 shipped as a limited preview, an account without access falls back down the 5.6 tiers, through `gpt-5.5`, and on to the Luna tiers automatically. This works under the default `strict` policy, like the `gpt-5.5`/`gpt-5-codex` auto-fallbacks, and can be disabled with `CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK=1`. The lite shape is applied per request attempt, so a request that falls back from `gpt-5.6-sol` to `gpt-5.5` is re-serialized into the classic shape and keeps its tools.
- Client identity defaults to `originator: opencode` for every responses-lite model (the 5.6 tiers, GPT-6 Astra/Sol/Luna and both Daybreak tiers) and `codex_cli_rs` for other models. Override with `CODEX_AUTH_CLIENT_IDENTITY=codex|opencode`.
- Instructions for the 5.6 tiers come from the Codex model catalog. See "System instructions" below.

GPT-5.5 notes:
- Still shipped and live. OpenAI's Codex models page lists GPT-5.5 as retiring from Codex with ChatGPT sign-in on 2026-10-14, with `gpt-6-sol` as the replacement on Plus/Pro/Business/Enterprise/Edu and `gpt-6-luna` on Free/Go.

### System instructions

Modern Codex carries full instructions **per model** in its catalog (`codex-rs/models-manager/models.json`) rather than the legacy `*_prompt.md` files. Older catalog tags carried them as a `base_instructions` string; openai/codex #43604 (2026-09-07) moved them into `model_messages.instructions_template`, rendered with the placeholder `{{ personality }}` substituted by `instructions_variables.personality_default`. The plugin reads `base_instructions` when present and falls back to the rendered template, so it sources instructions from the catalog for every model the catalog covers:

| Model | Instruction source |
|-------|--------------------|
| `gpt-6-astra` | catalog (`model_messages.instructions_template`, since openai/codex #43604 dropped `base_instructions`) |
| `gpt-6-sol`, `gpt-6-luna` | catalog on tags from 2026-09-22 onward (openai/codex commit `49e95cc7`); `gpt_5_2_prompt.md` on older tags |
| `gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest` | catalog |
| `gpt-5.6-cyber` | `gpt_5_2_prompt.md` (the catalog has no entry under this slug, only the Daybreak ids it fronts) |
| `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | catalog (each tier has distinct text) |
| `gpt-5.5` | catalog |
| `gpt-5.4`, `gpt-5.4-mini` | catalog |
| `gpt-5.2` | catalog |
| `gpt-5-codex`, `gpt-5.1*`, `gpt-5.2-codex`, `gpt-5.4-nano`, `gpt-5.4-pro` | `*_prompt.md` file (absent from the catalog) |

Catalog-sourced instructions cache per model id (`catalog-<slug>-instructions.md`); file-sourced instructions keep the historical per-family cache. This matters because `gpt-5.5` and `gpt-5.4` share the `gpt-5.4` family but have different catalog text, and a family-keyed cache would let one serve the other's prompt. `models.json` is fetched once per release tag and shared across models. If the pinned Codex release has no catalog entry for a model, the plugin falls back to that family's prompt file.

For context sizing, shipped templates use:
- `gpt-6-astra`, `gpt-6-sol`, and `gpt-6-luna`: `context=1050000`, `output=128000`
- `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`: `context=1050000`, `output=128000`
- `gpt-5.5` and `gpt-5.5-fast`: `context=1050000`, `output=128000`
- `gpt-5.4-nano`: `context=400000`, `output=128000`
- `gpt-5.1`: `context=272000`, `output=128000`

model normalization aliases:
- bare `gpt-6` maps to `gpt-6-astra`; `gpt-6-astra-pro*` collapses onto `gpt-6-astra` (not a Codex-routable id)
- `gpt-daybreak-blue*` and `gpt-daybreak-red*` map to the catalog ids `gpt-daybreak-blue-latest` / `gpt-daybreak-red-latest`; `gpt-5.6-cyber*` maps to itself, never to Sol
- bare `gpt-5.6` maps to the flagship tier `gpt-5.6-sol`; `gpt-5.6-terra*` and `gpt-5.6-luna*` map to their own ids
- `gpt-5.5*`, `gpt-5.5-fast*`, and user-typed `gpt-5.5-pro*` normalize to the public Codex model id `gpt-5.5`
- legacy `gpt-5` maps to `gpt-6-sol` (was `gpt-5.5`); any other unrecognized `gpt-5*` name also resolves to `gpt-6-sol`; legacy `gpt-5-mini` maps to `gpt-6-luna` (was `gpt-5.4-mini`); legacy `gpt-5-nano` still maps to `gpt-5.4-nano`
- snapshot ids `gpt-5.4-2026-03-05*`, `gpt-5.4-mini-2026-03-05*`, and `gpt-5.4-pro-2026-03-05*` map to stable `gpt-5.4` / `gpt-5.4-mini` / `gpt-5.4-pro`
- `opencode debug config` is the reliable way to confirm merged custom/template model entries; `--modern` exposes compact entries like `gpt-5.5` and `gpt-5.5-fast`, while `--full` also exposes explicit entries like `gpt-5.5-medium`, `gpt-5.5-fast-medium`, and `gpt-5.5-high`

if your OpenCode runtime supports global compaction tuning, you can set:
- `model_context_window = 1000000`
- `model_auto_compact_token_limit = 900000`

selector note:
- `--modern` is optimized for the TUI model picker: choose a base `(OAuth)` model, then choose a variant
- install with `--full` when you need direct selector IDs such as `openai/gpt-5.5-medium` or `openai/gpt-5.5-fast-medium`

what they mean:
- `none` - no reasoning phase (base general-purpose families only; pro families such as `gpt-5.4-pro` ultimately coerce it to `medium`)
- `low` - light reasoning, fastest
- `medium` - balanced (default)
- `high` - deep reasoning
- `xhigh` - max depth for complex tasks (default for `gpt-5.3-codex` / `gpt-5.2-codex`; available for `gpt-5.1-codex-max`, `gpt-5.5`, `gpt-5.5-fast`, `gpt-5.4`, `gpt-5.4-nano`, `gpt-5.2`, and optional `gpt-5.4-pro`. `gpt-5.1-codex-max` defaults to `high` and only sends `xhigh` when explicitly requested)

### Reasoning Summary

| value | what it does |
|-------|--------------|
| `auto` | adapts automatically (default) |
| `concise` | short summaries |
| `detailed` | verbose summaries |

legacy `off`/`on` values are accepted from old configs but normalized to `auto` at request time.

### Text Verbosity

| value | what it does |
|-------|--------------|
| `low` | concise responses |
| `medium` | balanced (default) |
| `high` | verbose responses |

### Include

array of extra response fields.

| value | why you need it |
|-------|-----------------|
| `reasoning.encrypted_content` | required for multi-turn with `store: false` |

### Store

| value | what it does |
|-------|--------------|
| `false` | stateless mode (required for this plugin) |
| `true` | not supported by codex api |

---

## Plugin Config

advanced settings go in `~/.opencode/openai-codex-auth-config.json`:

Request settings are re-read on subsequent requests when this file changes.
During an incomplete write, invalid config, or temporary file removal, the
process retains its last usable settings instead of switching account pools to
defaults. Write a valid empty object (`{}`) to reset settings to defaults.
Startup components, including the quota monitor and recovery hooks, still require
a restart to change their configuration.

```json
{
  "requestTransformMode": "native",
  "codexMode": true,
  "codexTuiV2": true,
  "codexTuiColorProfile": "truecolor",
  "codexTuiGlyphMode": "ascii",
  "maskEmail": false,
  "maskEmailInQuotaDetails": false,
  "quotaDisplay": "free",
  "quotaStatus": {
    "mode": "active",
    "rotateMs": 5000,
    "layout": "accounts",
    "accountNames": "number",
    "order": "number",
    "multipliers": false,
    "allotment": false,
    "resetTimes": "low",
    "resetCredits": false,
    "recovery": false,
    "rows": 1,
    "showFor": "always"
  },
  "beginnerSafeMode": false,
  "fastSession": false,
  "fastSessionStrategy": "hybrid",
  "fastSessionMaxInputItems": 30,
  "rotationStrategy": "hybrid",
  "modelAccountPools": {
    "gpt-5.6-sol": ["org-example-account-id"]
  },
  "modelAccountPoolModes": {
    "gpt-5.6-sol": "strict"
  },
  "retryProfile": "balanced",
  "retryBudgetOverrides": {
    "network": 2,
    "server": 2
  },
  "perProjectAccounts": true,
  "credentialSnapshots": true,
  "credentialSnapshotsMaxCount": 10,
  "autoUpdate": true,
  "toastDurationMs": 5000,
  "accountToasts": true,
  "retryAllAccountsRateLimited": true,
  "retryAllAccountsMaxWaitMs": 0,
  "retryAllAccountsMaxRetries": 3,
  "unsupportedCodexPolicy": "strict",
  "fallbackOnUnsupportedCodexModel": false,
  "fallbackToGpt52OnUnsupportedGpt53": true,
  "unsupportedCodexFallbackChain": {
    "gpt-5.4-pro": ["gpt-5.4"],
    "gpt-5-codex": ["gpt-5.2-codex"]
  },
  "parallelProbing": false,
  "parallelProbingMaxConcurrency": 2,
  "emptyResponseMaxRetries": 2,
  "emptyResponseRetryDelayMs": 1000,
  "pidOffsetEnabled": false,
  "sessionRecovery": true,
  "autoResume": true,
  "tokenRefreshSkewMs": 60000,
  "rateLimitToastDebounceMs": 60000,
  "fetchTimeoutMs": 60000,
  "streamStallTimeoutMs": 45000,
  "quotaNotifications": {
    "enabled": false,
    "autoProtectCredits": true,
    "intervalMs": 1800000,
    "notifyEveryCheck": false,
    "thresholds": [25, 10, 0]
  }
}
```

The sample above intentionally sets `"retryAllAccountsMaxRetries": 3` as a bounded override; the default remains `Infinity` when the key is omitted.

### Options

| option | default | what it does |
|--------|---------|--------------|
| `requestTransformMode` | `native` | request shaping mode: `native` normalizes model names, sets instruction identity lines, and upserts `## Backend Model Identity`; `legacy` enables full Codex compatibility rewrites |
| `codexMode` | `true` | legacy-only bridge prompt behavior (applies when `requestTransformMode=legacy`) |
| `codexTuiV2` | `true` | enables codex-style terminal ui output (set `false` to keep legacy output) |
| `codexTuiColorProfile` | `truecolor` | terminal color profile for codex ui (`truecolor`, `ansi256`, `ansi16`) |
| `codexTuiGlyphMode` | `ascii` | glyph set for codex ui (`ascii`, `unicode`, `auto`) |
| `maskEmail` | `false` | masks account emails across account-display surfaces: the TUI prompt quota status, command output (`codex-list`, `codex-status`, `codex-limits`, `codex-health`, `codex-dashboard`, `codex-refresh`, `codex-switch`, `codex-label`, `codex-tag`, `codex-note`, `codex-remove`), the interactive account menu, and the standalone login menu. Account labels (set via `codex-label`) are preferred and always shown; emails are reduced to a masked form such as `us***@example.com`. Raw emails are still emitted in `--includeSensitive` JSON output, which is opt-in. |
| `maskEmailInQuotaDetails` | `false` | also masks the active account email in the quota details dialog when `maskEmail` is enabled |
| `quotaDisplay` | `free` | wording of every quota percentage a person reads: `free` reports the headroom left (`5h limit: 88% left`), matching how Codex itself reports a quota; `used` reports consumption instead (`5h limit: 12% used`). Covers the TUI prompt status line and quota details dialog, `codex-limits`, the standalone `limits` CLI, the interactive account check, and macOS quota notifications. Presentation only: exhaustion, rotation blocks, notification thresholds, and the status line's warning/danger colouring stay keyed on the remaining percentage, and the `usedPercent` / `leftPercent` fields in JSON output are unchanged. |
| `quotaStatus` | `mode: active` | shape of the TUI prompt status line. `active` describes the account serving requests, `overview` describes the whole pool on one constant line, `resets` lists redeemable reset credits once nothing has headroom left. A list of screens alternates between them. File-only; no environment override. See [Pool-wide quota status](#pool-wide-quota-status). |
| `limitsSort` | `by: account, direction: asc` | default account order of the standalone `limits` CLI. `by` is `account`, `usage` (least used first), or `reset` (earliest renewal first); `direction` is `asc` or `desc`. `--sort` and `--asc` / `--desc` override each half. File-only. See [What `limits` reports](tools-and-cli.md#what-limits-reports). |
| `beginnerSafeMode` | `false` | enables conservative beginner-safe runtime behavior for retries and recovery |
| `fastSession` | `false` | forces low-latency settings per request (`reasoningEffort=none/low`, `reasoningSummary=auto`, `textVerbosity=low`) |
| `fastSessionStrategy` | `hybrid` | `hybrid` speeds simple turns and keeps full-depth for complex prompts; `always` forces fast mode every turn |
| `fastSessionMaxInputItems` | `30` | max input items kept when fast mode is applied |
| `rotationStrategy` | `hybrid` | account selection strategy: `hybrid` (stick while healthy, else score-select), `sticky` (drain one account first), or `round-robin` |
| `modelAccountPools` | `{}` | optional map of effective model IDs to preferred stable account or Business-seat identities; selection uses the configured pool while it has a healthy account, then falls back to the general account pool |
| `modelAccountPoolModes` | `{}` | optional per-model `preferred` or `strict` policy; omitted models default to `preferred` |
| `retryProfile` | `balanced` | retry budget profile for request classes (`conservative`, `balanced`, `aggressive`) |
| `retryBudgetOverrides` | `{}` | optional per-class budget overrides (`authRefresh`, `network`, `server`, `rateLimitShort`, `rateLimitGlobal`, `emptyResponse`) |
| `perProjectAccounts` | `true` | each project gets its own account storage |
| `credentialSnapshots` | `true` | before a significant change to the account store, copy the previous on-disk version into `backups/` so a clobbered store can be restored to a recent state. Refresh tokens are single-use: a snapshot taken just before a refresh holds the consumed token for the one account that refresh rotated, and the live token for every other account, so restoring costs at most a re-login for that one account rather than the whole pool. Snapshots are taken for account additions and removals, token refreshes, identity changes, label/tag/note/enabled changes, plan changes, schema-version changes, and deletion of the store. Rotation bookkeeping never triggers one on its own: `lastUsed`, `lastSwitchReason`, rate-limit and cooldown state, quota-exhaustion stamps, and the `activeIndex` / `activeIndexByFamily` rotation cursor. A snapshot failure is logged and never fails the write it precedes. The flagged-accounts file beside the store is covered the same way, since it retains quarantined refresh tokens. Snapshots cover the default JSON backend only, not `CODEX_KEYCHAIN=1` |
| `credentialSnapshotsMaxCount` | `10` | how many credential snapshots to keep. Pruning deletes strictly by the snapshot filename prefix, so other files in `backups/` are never touched. `0` means keep every snapshot; use `credentialSnapshots: false` to turn the feature off |
| `autoUpdate` | `true` | check npm daily and clear the OpenCode-managed plugin cache on exit when a newer version is available; restart OpenCode to install it |
| `toastDurationMs` | `5000` | how long toast notifications stay visible (ms) |
| `accountToasts` | `true` | show the transient `Using <account> (N/N)` account-selection toast; set `false` to hide only this informational toast (rate-limit/auth/recovery warnings and errors still show) |
| `retryAllAccountsRateLimited` | `true` | wait and retry when all accounts hit rate limits |
| `retryAllAccountsMaxWaitMs` | `0` | max wait time in ms (0 = unlimited) |
| `retryAllAccountsMaxRetries` | `Infinity` | max retry attempts (omit this key for unlimited retries) |
| `unsupportedCodexPolicy` | `strict` | unsupported-model behavior: `strict` (return entitlement error) or `fallback` (retry with configured fallback chain) |
| `fallbackOnUnsupportedCodexModel` | `false` | legacy fallback toggle mapped to `unsupportedCodexPolicy` (prefer using `unsupportedCodexPolicy`) |
| `fallbackToGpt52OnUnsupportedGpt53` | `true` | legacy compatibility toggle for the `gpt-5.3-codex -> gpt-5.2-codex` edge when generic fallback is enabled |
| `unsupportedCodexFallbackChain` | `{}` | optional per-model fallback-chain override (map of `model -> [fallback1, fallback2, ...]`; default rows follow `gpt-6-astra` > `gpt-6-sol` > `gpt-5.6-sol` > `gpt-5.6-terra` > `gpt-5.5` > `gpt-6-luna` > `gpt-5.6-luna`, and each row is that order's tail after its own model, so every general model reaches the terminal `gpt-5.6-luna`). These entry IDs auto-fallback by default, even when selected directly, both for common entitlement gates and when every enabled account has an active upstream rate/quota block for the requested model; set `CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK=1`, `CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK=1`, `CODEX_AUTH_DISABLE_GPT55_AUTO_FALLBACK=1`, or `CODEX_AUTH_DISABLE_CODEX_AUTO_FALLBACK=1` to opt out. Directly selected non-entry IDs stay strict under this auto gate. GPT-5.5 Pro and GPT-6 Astra Pro are not mapped: neither is a Codex-routable id. The Daybreak cyber tiers are deliberately chainless, so an unentitled account fails loudly rather than being answered by a general model. `gpt-5.2` was removed as the catalog terminal after openai/codex #44250 (2026-09-09) removed it; the terminal is now `gpt-5.6-luna` (was `gpt-5.5`), since GPT-5.5 retires from Codex with ChatGPT sign-in on 2026-10-14. |
| `sessionRecovery` | `true` | classify recoverable API errors and show recovery toasts in the TUI |
| `autoResume` | `true` | auto-resume flag (supported by underlying recovery engine in `lib/recovery/hook.ts`) |
| `tokenRefreshSkewMs` | `60000` | refresh tokens this many ms before expiry |
| `rateLimitToastDebounceMs` | `60000` | debounce rate limit toasts |
| `parallelProbing` | `false` | enable concurrent account health probes. Probe infrastructure exists in `lib/parallel-probe.ts` with test coverage, but runtime probe scheduling in the main fetch loop uses direct sequential rotation checks, so this toggle has no runtime consumer today |
| `parallelProbingMaxConcurrency` | `2` | max concurrent probes when parallel probing is enabled (1–5) |
| `emptyResponseMaxRetries` | `2` | retries after an empty SSE/response body |
| `emptyResponseRetryDelayMs` | `1000` | delay in ms between empty-response retries |
| `pidOffsetEnabled` | `false` | add a small PID-based offset to hybrid selection scores (helps multi-process load spread) |
| `fetchTimeoutMs` | `60000` | upstream fetch timeout in ms |
| `streamStallTimeoutMs` | `45000` | max time to wait for next SSE chunk before aborting |
| `quotaNotifications` | disabled | optional macOS Notification Center alerts for aggregate 5-hour and weekly pool quotas. `autoProtectCredits` defaults to `true` and polls the same endpoint to exclude fully spent subscription quotas from rotation; `intervalMs` defaults to 30 minutes with a 30-second minimum, `notifyEveryCheck` defaults to `false`, and `thresholds` defaults to `[25, 10, 0]` |

### Retry Budgets by Profile

`retryProfile` picks the per-class retry budgets, and `retryBudgetOverrides` replaces any single class. The classes, in the order the tables above list them, are `authRefresh`, `network`, `server`, `rateLimitShort`, `rateLimitGlobal`, and `emptyResponse`. Budgets come from `lib/request/retry-budget.ts`.

| profile | authRefresh | network | server | rateLimitShort | rateLimitGlobal | emptyResponse |
|---------|-------------|---------|--------|----------------|-----------------|---------------|
| `conservative` | 2 | 2 | 2 | 2 | 1 | 1 |
| `balanced` (default) | 4 | 4 | 4 | 4 | 3 | 2 |
| `aggressive` | 8 | 8 | 8 | 8 | 10 | 4 |

The two rate-limit classes split on a 5000 ms threshold (`RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS` in `lib/request/rate-limit-backoff.ts`). When a 429 arrives, the backoff helper computes a wait from the server's `retry-after` header, 1000 ms by default, doubling per consecutive 429 and capped at 60 seconds. A wait of at most 5000 ms on a non-exhausted quota window consumes `rateLimitShort` and retries the same account after the wait. Anything else, a longer wait, an exhausted window, or a spent `rateLimitShort` budget, marks the account rate-limited and rotates; when every account is limited, the wait-and-retry loop consumes `rateLimitGlobal`.

For upstream rate/quota blocks, automatic model fallback runs **before** configured
waiting (`retryAllAccountsRateLimited` and its wait/retry limits). It only moves to
a model with an eligible account under that target's pool policy: unavailable
strict pools are skipped, while preferred pools may use general accounts. An
unavailable strict pool for the current model remains a strict-pool error. Local
token-bucket depletion or authentication cooldown alone does not trigger model
fallback. Shared subscription exhaustion blocks the account across all models;
changing models cannot bypass it. A single request hops across at most 6 quota-exhausted
models (`MAX_QUOTA_FALLBACK_SWITCHES` in `lib/constants.ts`, was 3), which is at least
the longest default chain (`gpt-6-astra`'s, 6 targets) so a request does not stop before
reaching the tail of its own chain.

The quota guard queries each distinct enabled account with bounded concurrency
every `intervalMs` (30 minutes by default), even when notifications are off.
When the backend reports a fully spent 5-hour or weekly subscription window,
the account is excluded from every model-family rotation until that window's
reported reset. Failed or rate-limited usage queries fail open and wait for the
next interval; they never block an account. Set `autoProtectCredits` to `false`
to disable this periodic guard. A manual `codex-limits` or standalone `limits`
check always persists an observed exhaustion block immediately. Quota
notifications use the same poller. The 5-hour and
weekly windows are tracked independently, and each
threshold alerts once until that window rises above it after a reset. Each line
reports the account with the most headroom in that window plus that same
account's reset time, so the percentage and the reset it is printed with always
come from one account. When another account recovers earlier, that reset is
appended as a separate `another account resets ...` clause instead of replacing
the first one. A window the plan has switched off reports `used_percent: 0` and
is skipped rather than scored as a full quota. Account identities are omitted
from alerts and are never persisted in notification state.
Set `notifyEveryCheck` to `true` to deliver the aggregate message after every
successful poll interval even when no threshold was crossed. Set
`thresholds` to `[]` to disable threshold alerts entirely; omitting the key
keeps the `[25, 10, 0]` default. `"thresholds": []` together with
`"notifyEveryCheck": false` can never produce an alert, so the monitor stops
polling instead of querying the usage endpoint for every account forever.
Delivery state is stored beside the accounts
file the alerts are computed from (`oc-codex-multi-auth-quota-notifications.json`),
so concurrent OpenCode processes in the same account scope produce only one
routine alert per interval. With the default `perProjectAccounts`, that scope
is one project.
Delivery uses macOS's built-in `osascript` support and does not require an
additional notification package. The feature is unavailable on Windows and
Linux. Quit and restart OpenCode after changing the setting. If macOS blocks
the alert, allow notifications for the process shown in **System Settings >
Notifications**.

Use `codex-pool action="set" model="gpt-5.6-sol" accounts=[7,8]` to manage a
pool with 1-based account numbers while persisting stable IDs. The tool also
supports `status` (default), `add`, `remove`, `clear`, `set-mode`, `dryRun=true`, and JSON
output. Restart OpenCode after an applied mutation. Because this config is
global while account storage is per-project by default, references unavailable
in the current project are reported but not automatically pruned.

Model keys are matched case-insensitively after request model normalization.
Empty lists and unmapped models use the general account pool. A `preferred`
pool with no selectable account falls back to the general pool. A `strict`
pool never leaves its configured accounts and immediately returns
`strict_pool_unavailable` instead of entering the global wait loop. Switch an
existing pool with `codex-pool action="set-mode" model="gpt-5.6-sol"
poolMode="strict"`. Routing diagnostics expose `general`, `preferred`,
`general-fallback`, `strict`, or `strict-unavailable`.

### Pool-wide quota status

By default the prompt status line describes the account that served the last
request. On a pool of several accounts that account changes as rotation moves,
so the line changes identity while you work and no single glance shows where
the pool stands.

Set `quotaStatus.mode` to `overview` to describe the whole pool on one line
instead:

```json
{
  "quotaStatus": {
    "mode": "overview"
  }
}
```

```text
24%: #1 87%, #2 0% 3d, #3 88%
```

The leading figure is the pool total. It is a **weighted** mean: a Pro seat
spent to 50% has given up twenty times the capacity a Business Standard seat
does at 50%, so each account is weighted by its plan's allotment. See
[plan allotments](plan-allotments.md) for the map and its sources.

Each account is shown by its 1-based `codex-list` number and the window with
the least headroom left, which is the one that would stop a request. A reset
time is printed only for an account at or below 25% headroom; every account has
a reset, and printing all of them triples the length of the line.

Percentages follow [`quotaDisplay`](#options), so the same pool reads `24%` as
headroom or `76%` as consumption.

The whole `quotaStatus` object is read from the config file only. It is a
display preference that belongs to a person rather than to whichever shell
started OpenCode, so there is no environment override for any field in it.

#### What the line says

| Field | Default | Effect |
| --- | --- | --- |
| `layout` | `accounts` | `accounts` gives one segment per account; `aggregate` collapses accounts that share a percentage; `count` gives `24%: 3 accounts`; `total` shows only the pool percentage plus any enabled allotment/recovery |
| `accountNames` | `number` | `number` gives `#1`; `label` gives the account's `codex-label` label, or its email's local part; `none` drops the name |
| `order` | `number` | `number`, `most-used`, `least-used`, `renewing-earliest`, `renewing-latest` |
| `multipliers` | `false` | `5x` / `20x` plan allotment badges |
| `allotment` | `false` | `24% of 26x`, what the pool the percentage is averaged over adds up to |
| `resetTimes` | `low` | `never`, `low` (only accounts at or below 25% headroom), or `always` |
| `resetCredits` | `false` | `1r` for banked rate-limit resets redeemable now |
| `recovery` | `false` | `true` shows the next capacity gain with the display-direction sign; `"all"` shows all known gains with a positive capacity-return sign |
| `resetsMinUsedPercent` | `100` | Minimum total weighted usage (0-100) for the `resets` screen, independent of `quotaDisplay` |

With everything on:

```text
24% of 26x: #1 5x 87%, #2 20x 0% 3d 1r, #3 1x 88%, +3% in 2d
```

`resetTimes: "always"` answers a question `low` cannot: 90% spent with an hour
to go and 90% spent with six days to go are not the same situation.

```text
24%: #1 87% 2d, #2 0% 3d, #3 88% 5d
```

`layout: "aggregate"` is for a pool where several accounts read the same
number. The percentage is printed once and only what differs follows it, so
three spent accounts cost one segment rather than three:

```text
72%: 12% 3d, 50% 4d, 100% 3d 1r 4d 5d
```

A group states its own size - `100% x3 4d 5d` - when its annotations would not
already reveal it. Grouping discards identity by construction, so
`accountNames` has no effect under this layout.

`accountNames: "none"` leaves position to identify the accounts, which only
works while they are in `number` order and every one of them is readable:

```text
24%: 87%, 0% 3d, 88%
```

With `recovery: true`, the next recovery clause is signed to match the direction
the figure moves: `+12% in 3d` under `free`, `-12% in 3d` under `used`.

Use `recovery: "all"` for a chronological capacity forecast. Each `+N%` means
**incremental percentage points of pool capacity returned at that timestamp**,
not a cumulative gain. Exact-time gains sharing the same displayed countdown
are summed before shortening: `+7% in 5d, +24% in 5d, +2% in 5d` becomes
`+33% in 5d`. Distinct hour/day labels remain separate, in chronological order.
The sign is positive even under `quotaDisplay: "used"`.
Known ordinary windows are simulated cumulatively, simultaneous resets are
batched, and a reset that leaves another window blocking the account adds no
gain. Invalid/past timestamps and unreadable windows are not refilled, and no
future recurrence is invented. Differences between rounded weighted totals
keep the gains from adding up to more than the displayed used capacity.

For just the total and forecast, with no account count, account segments, or
allotment:

```json
{
  "quotaDisplay": "used",
  "quotaStatus": {
    "mode": ["overview", "resets"],
    "layout": "total",
    "allotment": false,
    "recovery": "all",
    "resetsMinUsedPercent": 90
  }
}
```

```text
25% +1% in 3h, +12% in 3d, +5% in 4d
```

Recovery works with every layout. Narrow candidates omit `in`, then retain a
chronological prefix; `total` never falls back to an account count.

#### Rotating between screens

`mode` accepts a list, and the line then alternates between its entries every
`rotateMs` (default 5000, minimum 1000):

```json
{
  "quotaStatus": {
    "mode": ["overview", "resets"],
    "rotateMs": 5000
  }
}
```

A screen with nothing to say is skipped rather than shown blank, which is what
makes `resets` worth leaving in the list permanently. By default it renders only
once **every readable** account is spent. Set `resetsMinUsedPercent` to show it
earlier, for example at 90% total weighted usage. The threshold uses the exact
weighted usage before display rounding, regardless of free/used wording.
The page lists only accounts with applicable banked reset credits,
latest reset first - because redeeming a credit on an account that renews by
itself tomorrow throws the credit away, while the account six days out is the
one worth spending it on:

```text
Free resets: 6d 1r damian@nowaker.net, 4d 2r work@example.com
```

Unknown applicability is not treated as redeemable, nor as proof that no
actionable credits exist. Old cache counts are considered only for spent
accounts; newly fetched readings preserve explicit applicability. A page with
no known applicable credits is skipped. This display never redeems a credit.

That line honours [`maskEmail`](#options). It shortens by giving up the word
`Free`, then the address (to a label, then to `#1`), then the countdown, then
the credit counts, and finally becomes `Resets: 2`.

#### How much room the line takes

```json
{
  "quotaStatus": {
    "rows": 2
  }
}
```

`rows` (1 to 4, default 1) is a **ceiling, not a height**. A rendering that
fits on one row still takes one, so raising it costs nothing on a wide terminal
and buys the whole line back on a narrow one, where the agent/model label
beside it has already wrapped to two rows anyway. Rows break only at the `, `
between accounts, so a row never ends mid-account.

The space available is measured from the laid-out prompt row rather than
computed from the terminal width, since an open sidebar takes a share nothing
in the plugin can derive. The model label's own width is deliberately *not*
measured: the row sizes both boxes by their content, so a label with no room
left is shrunk to whatever this line did not take, and reading its width would
make the budget a function of the line's own length.

Within that space the line degrades in the order that costs a reader the least:
the recovery clause and the pool allotment, then the badges and banked resets,
then reset countdowns, then the account names, then the per-account breakdown
(`3 accounts` -> `3 acct.` -> `3`), and finally the pool total alone. A switch
left off never reappears because the terminal happens to be wide.

#### When the line appears

```json
{
  "quotaStatus": {
    "showFor": "always"
  }
}
```

`always` (the default) shows the line whenever accounts are configured,
whichever model the session is running. `codex-models` shows it only while the
session is running a model this plugin routes. A session that has not run
anything yet still shows the line.

#### Where the numbers come from

Quota for the whole pool is read from `/wham/usage` on a five-minute interval
and cached at `oc-codex-multi-auth-tui-quota-overview.json` in the OpenCode
state directory, so several OpenCode windows on one machine share a single
round of requests. The account currently serving requests is refreshed from
response headers after every response and folded into the cached pool, so its
figure stays live between polls.

Add the configuration to `~/.opencode/openai-codex-auth-config.json`. The
status line re-reads that file while sessions are open, so an edit takes effect
within a couple of seconds without a restart.
This reload applies to settings, not plugin code. After upgrading a build to
introduce new options, restart each older OpenCode process once to load it.

### Beginner Safe Mode Behavior

when `beginnerSafeMode` is enabled (`true` or `CODEX_AUTH_BEGINNER_SAFE_MODE=1`), the plugin applies a safer retry profile automatically:
- forces `retryProfile` to `conservative`
- forces `retryAllAccountsRateLimited` to `false`
- caps `retryAllAccountsMaxRetries` to at most `1`

this mode is intended for beginners who prefer quick failures + clearer recovery actions over long retry loops.

### Unsupported-Model Behavior and Fallback Chain

by default the plugin is strict (`unsupportedCodexPolicy: "strict"`) except for common default-selector entitlement gates. it returns other entitlement errors directly for unsupported models.

set `unsupportedCodexPolicy: "fallback"` to enable model fallback after account/workspace attempts are exhausted.

defaults when fallback policy is enabled and `unsupportedCodexFallbackChain` is empty (plus the always-on public-selector auto-fallbacks for common entitlement gates). The general rows follow one order, most capable first (`gpt-6-astra > gpt-6-sol > gpt-5.6-sol > gpt-5.6-terra > gpt-5.5 > gpt-6-luna > gpt-5.6-luna`), and each row is that order's tail after its own model:
- `gpt-6-astra -> gpt-6-sol -> gpt-5.6-sol -> gpt-5.6-terra -> gpt-5.5 -> gpt-6-luna -> gpt-5.6-luna`
- `gpt-6-sol -> gpt-5.6-sol -> gpt-5.6-terra -> gpt-5.5 -> gpt-6-luna -> gpt-5.6-luna`
- `gpt-5.6-sol -> gpt-5.6-terra -> gpt-5.5 -> gpt-6-luna -> gpt-5.6-luna`
- `gpt-5.6-terra -> gpt-5.5 -> gpt-6-luna -> gpt-5.6-luna`
- `gpt-5.5 -> gpt-6-sol -> gpt-5.6-sol -> gpt-5.6-terra -> gpt-6-luna -> gpt-5.6-luna`
- `gpt-6-luna -> gpt-5.6-luna -> gpt-6-sol -> gpt-5.6-sol -> gpt-5.6-terra -> gpt-5.5`
- `gpt-5.6-luna -> gpt-6-luna -> gpt-6-sol -> gpt-5.6-sol -> gpt-5.6-terra -> gpt-5.5`
- `gpt-5-codex -> gpt-5.6-terra -> gpt-5.6-luna`
- `gpt-5.4 -> gpt-6-sol -> gpt-5.6-terra -> gpt-5.6-luna` (the successor its catalog entry names)
- `gpt-5.4-mini -> gpt-6-luna -> gpt-5.6-luna`
- `gpt-5.4-nano -> gpt-6-luna -> gpt-5.6-luna`
- `gpt-5.4-pro -> gpt-6-sol -> gpt-5.6-terra -> gpt-5.6-luna` (if `gpt-5.4-pro` is selected manually; not a shipped base)

> The terminal is `gpt-5.6-luna`, not `gpt-5.5`: OpenAI's Codex model docs say GPT-5.5 retires from Codex with ChatGPT sign-in on 2026-10-14, while 5.6 Luna is listed for every plan with no retirement date. `gpt-5.2`, the terminal before that, left the catalog in openai/codex #44250 (2026-09-09). GPT-5.4 and GPT-5.4 Mini were retired from Codex on 2026-08-31; the catalog marks both `visibility: "hide"` and names their replacements (`gpt-5.4` -> `gpt-6-sol`, `gpt-5.4-mini` -> `gpt-6-luna`), and `gpt-5.4-nano` has no catalog entry. The default chains therefore end at live models rather than leading with retired ones.
- `gpt-5.3-codex -> gpt-5-codex -> gpt-5.2-codex`
- `gpt-5.3-codex-spark -> gpt-5-codex -> gpt-5.3-codex -> gpt-5.2-codex` (applies if you manually select Spark model IDs)
- `gpt-5.2-codex -> gpt-5-codex`
- `gpt-5.1-codex -> gpt-5-codex`

Note: `gpt-5.4` and `gpt-5.4-pro` appear in fallback/runtime normalization but are not shipped as compact modern base picker entries (bases use `gpt-5.4-nano`; `gpt-5.4-mini` is no longer shipped either, see below).

`gpt-5.4-mini` is no longer shipped as a base: Codex retired it on 2026-08-31, and it was later removed from the templates. It is still routed if typed by hand; selecting it costs one extra round trip, since the request 400s and the default chain immediately upgrades it to `gpt-6-luna`, the successor its catalog entry now names. Prefer `gpt-6-luna` directly.

note: the TUI can continue showing your originally selected model while fallback is applied internally. use request logs to verify the effective upstream model (`request-*-after-transform.json`). set `CODEX_PLUGIN_LOG_BODIES=1` when you need to inspect raw `.body.*` fields.

custom chain example:
```json
{
  "unsupportedCodexPolicy": "fallback",
  "fallbackOnUnsupportedCodexModel": true,
  "unsupportedCodexFallbackChain": {
    "gpt-5.5": ["gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-luna", "gpt-5.6-luna"],
    "gpt-5.4": ["gpt-5.6-terra", "gpt-5.6-luna"],
    "gpt-5.4-pro": ["gpt-5.6-terra", "gpt-5.6-luna"],
    "gpt-5-codex": ["gpt-5.6-terra", "gpt-5.6-luna"],
    "gpt-5.3-codex": ["gpt-5-codex", "gpt-5.2-codex"],
    "gpt-5.3-codex-spark": ["gpt-5-codex", "gpt-5.3-codex", "gpt-5.2-codex"]
  }
}
```

legacy toggle compatibility:
- `CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL=1` maps to fallback mode
- `CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL=0` maps to strict mode

### Environment Variables

override any config with env vars (boolean values are truthy only for `"1"`):

| variable | what it does |
|----------|--------------|
| `OPENAI_BASE_URL=https://gateway.example/v1` | OpenAI-compatible OAuth inference gateway; requires `CODEX_AUTH_ALLOW_OPENAI_BASE_URL=1` |
| `CODEX_AUTH_ALLOW_OPENAI_BASE_URL=1` | explicitly allow the trusted gateway to receive the ChatGPT OAuth access token; remote gateways require HTTPS, while HTTP is accepted only on literal loopback IPs |
| `DEBUG_CODEX_PLUGIN=1` | enable debug logging |
| `ENABLE_PLUGIN_REQUEST_LOGGING=1` | log request metadata (no raw prompt/response bodies) |
| `CODEX_PLUGIN_LOG_BODIES=1` | include raw request/response bodies in log files (sensitive) |
| `CODEX_PLUGIN_LOG_LEVEL=debug` | set log level (debug/info/warn/error) |
| `CODEX_AUTH_REQUEST_TRANSFORM_MODE=legacy` | re-enable legacy Codex request rewriting |
| `CODEX_MODE=0` | disable bridge prompt |
| `CODEX_TUI_V2=0` | disable codex-style ui (use legacy output) |
| `CODEX_TUI_COLOR_PROFILE=ansi16` | force color profile for codex ui |
| `CODEX_TUI_GLYPHS=unicode` | override glyph mode (`ascii`, `unicode`, `auto`) |
| `CODEX_TUI_MASK_EMAIL=1` | mask account emails across account-display surfaces (TUI prompt quota status, command output, interactive account menu, and standalone login menu) |
| `CODEX_TUI_MASK_EMAIL_DETAILS=1` | also mask the active account email in quota details when prompt masking is enabled |
| `CODEX_AUTH_QUOTA_DISPLAY=free\|used` | word quota percentages as headroom left (default) or as consumption |

| `CODEX_AUTH_PREWARM=0` | disable startup prewarm when legacy transform is enabled (native mode does not prewarm) |
| `CODEX_AUTH_TOKEN_REFRESH_SKEW_MS=60000` | refresh OAuth tokens this many ms before expiry |
| `CODEX_AUTH_RATE_LIMIT_TOAST_DEBOUNCE_MS=60000` | debounce rate-limit toast notifications |
| `CODEX_AUTH_QUOTA_NOTIFICATIONS=1` | enable macOS aggregate quota notifications |
| `CODEX_AUTH_AUTO_PROTECT_CREDITS=0` | disable periodic quota checks that protect paid Credits (enabled by default) |
| `CODEX_AUTH_QUOTA_NOTIFICATIONS_INTERVAL_MS=1800000` | override the quota check interval (minimum 30000 ms) |
| `CODEX_AUTH_SESSION_RECOVERY=0` | disable recoverable error classification and warning toasts |
| `CODEX_AUTH_AUTO_RESUME=0` | disable auto-resume after thinking-block recovery |
| `CODEX_AUTH_FAST_SESSION=1` | enable fast-session defaults |
| `CODEX_AUTH_FAST_SESSION_STRATEGY=always` | force fast mode on every prompt |
| `CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS=24` | tune max retained input items in fast mode |
| `CODEX_AUTH_ROTATION_STRATEGY=sticky` | override account selection (`hybrid`, `sticky`, `round-robin`) |
| `CODEX_AUTH_BEGINNER_SAFE_MODE=1` | enable beginner-safe retry behavior |
| `CODEX_AUTH_RETRY_PROFILE=aggressive` | override retry profile (`conservative`, `balanced`, `aggressive`) |
| `CODEX_AUTH_PER_PROJECT_ACCOUNTS=0` | disable per-project accounts |
| `CODEX_AUTH_CREDENTIAL_SNAPSHOTS=0` | disable pre-write credential-store snapshots (enabled by default) |
| `CODEX_AUTH_CREDENTIAL_SNAPSHOTS_MAX_COUNT=25` | how many credential snapshots to keep (`0` keeps all of them) |
| `CODEX_AUTH_PARALLEL_PROBING=1` | enable concurrent account health probes |
| `CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY=3` | max concurrent probes (1–5) |
| `CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES=3` | override empty-response retry count |
| `CODEX_AUTH_EMPTY_RESPONSE_RETRY_DELAY_MS=1500` | override empty-response retry delay |
| `CODEX_AUTH_PID_OFFSET_ENABLED=1` | enable PID-based hybrid score offset |
| `CODEX_AUTH_AUTO_UPDATE=0` | disable automatic OpenCode plugin cache refresh when npm has a newer plugin version |
| `CODEX_AUTH_TOAST_DURATION_MS=8000` | set toast duration |
| `CODEX_AUTH_ACCOUNT_TOASTS=0` | hide the `Using <account> (N/N)` account-selection toast (warnings and errors still show) |
| `CODEX_AUTH_RETRY_ALL_RATE_LIMITED=0` | disable wait-and-retry |
| `CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS=30000` | set max wait time |
| `CODEX_AUTH_RETRY_ALL_MAX_RETRIES=1` | set max retries |
| `CODEX_AUTH_UNSUPPORTED_MODEL_POLICY=fallback` | enable generic unsupported-model fallback policy |
| `CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL=1` | legacy fallback toggle (prefer policy variable above) |
| `CODEX_AUTH_FALLBACK_GPT53_TO_GPT52=0` | disable only the legacy `gpt-5.3-codex -> gpt-5.2-codex` edge |
| `CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK=1` | disable automatic `gpt-6-astra -> gpt-6-sol -> gpt-5.6-sol -> gpt-5.6-terra -> gpt-5.5 -> gpt-6-luna -> gpt-5.6-luna` rollout fallback (also covers `gpt-6-sol` and `gpt-6-luna` selected directly) |
| `CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK=1` | disable automatic `gpt-5.6-sol -> gpt-5.6-terra -> gpt-5.5 -> gpt-6-luna -> gpt-5.6-luna` preview fallback |
| `CODEX_AUTH_DISABLE_GPT55_AUTO_FALLBACK=1` | disable automatic `gpt-5.5 -> gpt-6-sol -> gpt-5.6-sol -> gpt-5.6-terra -> gpt-6-luna -> gpt-5.6-luna` fallback |
| `CODEX_AUTH_DISABLE_CODEX_AUTO_FALLBACK=1` | disable automatic `gpt-5-codex -> gpt-5.6-terra -> gpt-5.6-luna` fallback |
| `CODEX_AUTH_ACCOUNT_ID=acc_xxx` | force specific workspace id |
| `CODEX_AUTH_CLIENT_IDENTITY=codex` | force one client identity for all models: `codex` (`originator: codex_cli_rs`) or `opencode` (alias `host`; `originator: opencode`). Default: `opencode` for every responses-lite model (5.6 tiers, GPT-6 Astra/Sol/Luna, Daybreak), `codex` for everything else |
| `CODEX_AUTH_DISABLE_CODEX_USER_AGENT=1` | keep the host runtime's `User-Agent` instead of the identity's `User-Agent` |
| `CODEX_AUTH_CLIENT_VERSION=0.150.0` | override the Codex CLI version advertised in the `codex_cli_rs` `User-Agent` |
| `CODEX_AUTH_HOST_VERSION=1.18.0` | override the opencode version advertised in the `opencode` `User-Agent` (default: the host runtime's own UA version when it injects one, else a baked-in fallback) |
| `CODEX_AUTH_SEND_ORGANIZATION_HEADER=1` | restore legacy `openai-organization` request pinning (off by default; upstream Codex never sends it) |
| `CODEX_AUTH_FETCH_TIMEOUT_MS=120000` | override fetch timeout |
| `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS=60000` | override SSE stall timeout |
| `CODEX_KEYCHAIN=1` | opt in to OS-native keychain account storage |
| `CODEX_AUTH_SYNC_CODEX_CLI=0` | disable hydrating accounts from Codex CLI `~/.codex` storage (on by default) |
| `CODEX_CONSOLE_LOG=1` | also mirror plugin logs to the console |
| `CODEX_COLLABORATION_MODE=plan` | collaboration mode hint for request shaping (`OPENCODE_COLLABORATION_MODE` is accepted as an alias) |
| `OPENCODE_STATE_DIR=/path` | override OpenCode state dir used for the TUI quota cache file (default `~/.local/state/opencode`) |

### Advanced / power-user environment variables

These are real runtime knobs used by the plugin. Most people never need them.

| variable | what it does |
|----------|--------------|
| `CODEX_THREAD_ID=<id>` | optional correlation / prompt-cache seed attached to outbound Codex requests |
| `OPENCODE_CODEX_PROMPT_URL=<url>` | override the OpenCode→Codex bridge prompt catalog URL used in legacy transform |
| `OPENCODE_SKIP_EMAIL_HYDRATE=1` | skip account email hydrate during account-manager bootstrap |
| `FORCE_INTERACTIVE_MODE=1` | force interactive menu paths even when the host looks non-interactive (tests / special shells) |
| `OPENCODE_TUI=1` / `OPENCODE_DESKTOP=1` | host-injected markers used for non-interactive detection (normally set by OpenCode, not by you) |

Boolean overrides remain truthy only for the literal string `"1"`.

---

## Config Patterns

### Global Options

same settings for all models:

```json
{
  "plugin": ["oc-codex-multi-auth"],
  "provider": {
    "openai": {
      "options": {
        "reasoningEffort": "high",
        "textVerbosity": "high",
        "store": false
      }
    }
  }
}
```

### Per-Model Options

different settings for different models:

```json
{
  "provider": {
    "openai": {
      "options": {
        "reasoningEffort": "medium",
        "store": false
      },
      "models": {
        "gpt-5.5-fast": {
          "name": "fast gpt-5.5",
          "options": { "reasoningEffort": "low" }
        },
        "gpt-5.6-sol": {
          "name": "GPT 5.6 Sol (OAuth)",
          "options": { "reasoningEffort": "high" }
        }
      }
    }
  }
}
```

model options override global options.

### Project-Specific

global (`~/.config/opencode/opencode.json`):
```json
{
  "plugin": ["oc-codex-multi-auth"],
  "provider": {
    "openai": {
      "options": {
        "store": false,
        "include": ["reasoning.encrypted_content"]
      }
    }
  }
}
```

project override (`<project>/.opencode.json`) can set a default model or per-project provider options without changing the global install.

### Compact modern selectors (`--modern` install)

```bash
opencode run "task" --model=openai/gpt-5.5 --variant=medium
opencode run "task" --model=openai/gpt-5.5-fast --variant=medium
opencode run "task" --model=openai/gpt-5.6-sol --variant=high
opencode run "task" --model=openai/gpt-5-codex --variant=high
```

### Explicit selectors (`--full` or `--legacy`)

```bash
npx -y oc-codex-multi-auth@latest --full
opencode run "task" --model=openai/gpt-5.5-medium
opencode run "task" --model=openai/gpt-5.6-sol-high
```

---

## File Locations

| Path | Purpose |
|------|---------|
| `~/.config/opencode/opencode.json` | OpenCode provider/plugin config |
| `~/.config/opencode/tui.json` | OpenCode TUI plugin config |
| `~/.opencode/openai-codex-auth-config.json` | plugin runtime config (this page) |
| `~/.opencode/auth/openai.json` | OpenCode OAuth tokens |
| `~/.opencode/oc-codex-multi-auth-accounts.json` | global V3 account pool |
| `~/.opencode/projects/<project-key>/oc-codex-multi-auth-accounts.json` | per-project account pool |
| `~/.opencode/projects/<project-key>/oc-codex-multi-auth-flagged-accounts.json` | flagged/deactivated account metadata, written beside the active accounts file. With the default `perProjectAccounts` this is the per-project path; with project storage off it is `~/.opencode/oc-codex-multi-auth-flagged-accounts.json` |
| `~/.opencode/backups/codex-credential-snapshot-*.json` | pre-write credential-store snapshots, written beside the accounts file they belong to (so the per-project `backups/` directory when `perProjectAccounts` is on). Mode `0600` in a `0700` directory on POSIX systems, because they hold live refresh tokens; on Windows the POSIX-mode hardening is skipped and the profile directory's ACLs apply |
| `~/.opencode/logs/codex-plugin/` | request/debug logs when enabled |
| `~/.opencode/cache/` | instruction/catalog and auto-update caches |
| `~/.local/state/opencode/oc-codex-multi-auth-tui-quota.json` | TUI quota snapshot cache shared by the provider and TUI plugins; `$OPENCODE_STATE_DIR` overrides the directory when set |
| `~/.local/state/opencode/oc-codex-multi-auth-tui-quota-overview.json` | pool-wide quota snapshot cache, written only when `quotaStatus.mode` includes `overview` or `resets`; same directory resolution as above |
| `$XDG_DATA_HOME/opencode/storage/…` (Windows: `%APPDATA%/opencode/storage`) | OpenCode session message/part store (session recovery) |
| `openai-codex-accounts.json` / `openai-codex-flagged-accounts.json` / `openai-codex-blocked-accounts.json` | legacy migration sources only |

---

## See Also

- [getting-started.md](getting-started.md)
- [tools-and-cli.md](tools-and-cli.md)
- [architecture.md](architecture.md)
- [development/CONFIG_FIELDS.md](development/CONFIG_FIELDS.md)
- [development/CONFIG_FLOW.md](development/CONFIG_FLOW.md)
- [../config/README.md](../config/README.md)
