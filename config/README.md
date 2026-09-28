# Configuration

This directory contains the official OpenCode config templates for `oc-codex-multi-auth`.

## Required: choose the right config file

| File | OpenCode version | Description |
|------|------------------|-------------|
| [`opencode-modern.json`](./opencode-modern.json) | **v1.0.210+** | Variant-based config: **10 base models**, **53 variants** total |
| [`opencode-legacy.json`](./opencode-legacy.json) | **v1.0.209 and below** | Legacy explicit entries: **53** individual model definitions |

## Install modes

| Installer flag | What gets written |
|----------------|-------------------|
| default / `--plugin-only` | Register plugin entries; preserve `provider.openai` |
| `--v2` | OpenCode V2 `plugins` entry only (plugin registration, no catalog) |
| `--modern` | Compact modern: 10 base OAuth families + variant picker |
| `--full` | Modern bases **plus** explicit legacy selector IDs |
| `--legacy` | Explicit-only catalog (53 preset model entries) |

```bash
npx -y oc-codex-multi-auth@latest          # plugin entries only
npx -y oc-codex-multi-auth@latest --v2     # register for OpenCode V2
npx -y oc-codex-multi-auth@latest --modern # compact modern catalog
npx -y oc-codex-multi-auth@latest --full   # modern + explicit IDs
npx -y oc-codex-multi-auth@latest --legacy # explicit only
```

Run the installer with `--modern` to remove explicit preset IDs and stale base models left by earlier plugin catalogs.

## Quick pick

If your OpenCode version is v1.0.210 or newer:

```bash
cp config/opencode-modern.json ~/.config/opencode/opencode.json
```

If your OpenCode version is v1.0.209 or older:

```bash
cp config/opencode-legacy.json ~/.config/opencode/opencode.json
```

Check your version with:

```bash
opencode --version
```

## Why there are two templates

OpenCode v1.0.210+ added model `variants`, so one model entry can expose multiple reasoning levels. That keeps modern config smaller while preserving the same effective presets.

Both templates include:

### Base model families (10)

| Base | Variants (modern) |
|------|-------------------|
| `gpt-6-astra` | low, medium, high, xhigh, max, ultra |
| `gpt-6-sol` | low, medium, high, xhigh, max, ultra |
| `gpt-6-luna` | low, medium, high, xhigh, max |
| `gpt-5.6-sol` | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-terra` | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-luna` | low, medium, high, xhigh, max |
| `gpt-5.5` | none, low, medium, high, xhigh |
| `gpt-5.5-fast` | none, low, medium, high, xhigh |
| `gpt-5.4-nano` | none, low, medium, high, xhigh |
| `gpt-5.1` | none, low, medium, high |

`gpt-5.4-mini`, `gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, and `gpt-5.1-codex-mini` were removed from both templates: `gpt-5.4-mini` retired from Codex with ChatGPT sign-in on 2026-08-31 (replacement `gpt-6-luna`), and `gpt-5-codex`/`gpt-5.1-codex`/`gpt-5.1-codex-max`/`gpt-5.1-codex-mini` were shut down from the OpenAI API on 2026-07-23 (replacement `gpt-5.6-sol`, or `gpt-5.6-terra` for `gpt-5.1-codex-mini`). They are no longer shipped, but routing is unchanged: a user who still types one of these ids by hand is still routed and rescued by the default fallback chains below.

Shared template requirements:

- `store: false` and `include: ["reasoning.encrypted_content"]`
- Context metadata:
  - `gpt-6-astra` / `gpt-6-sol` / `gpt-6-luna` / `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` / `gpt-5.5` / `gpt-5.5-fast`: context **1,050,000**, output **128,000**
  - `gpt-5.4-nano`: context **400,000**, output **128,000**
  - `gpt-5.1`: context **272,000**, output **128,000**

Use `opencode debug config` to verify that these template entries were merged into your effective config. A `--modern` install shows base OAuth entries such as `gpt-5.5` / `gpt-5.6-sol`; the separate OpenCode variant picker exposes the reasoning presets. The default install writes no catalog, so these entries appear only if OpenCode supplies them itself.

If your OpenCode runtime supports global compaction tuning, you can also set values near the largest context windows (for example ~1M context / slightly lower auto-compact limit). Prefer values that match your selected model family.

## GPT-6 Astra notes

- Served over the **responses-lite** path. Astra's catalog entry landed in openai/codex commit `ed391d4d` (2026-09-03) and reads `use_responses_lite: true`, `tool_mode: "code_mode_only"`, `multi_agent_version: "v2"`, so the shape is read rather than inferred. The `CODEX_AUTH_ASTRA_RESPONSES_LITE` switch that 6.17.0 carried while this was unverifiable has been removed.
- Rollout gate: Astra reached a limited set of organizations first, so accounts outside it auto-fallback  
  `gpt-6-astra → gpt-6-sol → gpt-5.6-sol → gpt-5.6-terra → gpt-5.5 → gpt-6-luna → gpt-5.6-luna`  
  (disable with `CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK=1`).
- Efforts are low through `ultra`, per OpenAI's Codex model list. `ultra` is sent as `max` on the wire, as with 5.6.
- Bare `gpt-6` is a plugin-side alias for `gpt-6-astra`, unchanged by the Sol/Luna additions. `gpt-6-astra-pro` is not a Codex-routable id and collapses onto `gpt-6-astra`.

## GPT-6 Sol / Luna notes

- `gpt-6-sol` ("GPT 6 Sol") and `gpt-6-luna` ("GPT 6 Luna") were added to the Codex model catalog on 2026-09-22 (openai/codex commit `49e95cc7`). Sol is the workhorse model for coding and everyday work; Luna is the fast, affordable model for easier tasks.
- Both ship in the modern and legacy templates. Sol supports low/medium/high/xhigh/max/ultra; Luna supports low/medium/high/xhigh/max (no `ultra`). Neither accepts `none` or `minimal`; both clamp to `low`.
- Served over the **responses-lite** path with default client identity `opencode`, same as Astra.
- `ultra` is sent as `max` on the wire, as with Astra and 5.6.
- Covered by the same `CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK` opt-out as Astra.

## GPT-5.5 notes

- Still shipped and live. OpenAI's Codex models page lists GPT-5.5 as retiring from Codex with ChatGPT sign-in on 2026-10-14, with `gpt-6-sol` as the replacement on Plus/Pro/Business/Enterprise/Edu and `gpt-6-luna` on Free/Go.

## Cyber tier notes (Daybreak-gated)

- `gpt-daybreak-blue-latest` (defensive) and `gpt-daybreak-red-latest` (cyber-permissive, for authorized security research) are catalog-verified cyber-specialty models, served over the responses-lite path. `gpt-5.6-cyber` is OpenAI's published alias fronting them, and belongs to the 5.6 generation rather than GPT-6.
- All three need Daybreak program approval, and Blue/Red are `visibility: "hide"` in the catalog, so they are **not** in the shipped templates, the same policy as `gpt-5.3-codex-spark` below. The plugin routes them fully; entitled users add the ids by hand.
- None has a fallback chain on purpose, because a cyber-specialty request must not be silently answered by a general model.

## GPT-5.6 notes

- Served over the **responses-lite** path (`use_responses_lite`).
- Preview entitlement: accounts without access auto-fallback  
  `gpt-5.6-sol → gpt-5.6-terra → gpt-5.5 → gpt-6-luna → gpt-5.6-luna`  
  (disable with `CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK=1`).
- Default client identity for every responses-lite model (5.6, GPT-6 Astra/Sol/Luna, Daybreak) is host/opencode (`originator: opencode`); other families default to Codex CLI identity.
- `ultra` is accepted as a client-side alias and sent as `max` on the wire (no subagent orchestration in this plugin).

## Spark model note

The templates intentionally do **not** include `gpt-5.3-codex-spark` by default. Spark is a distinct backend model id, not an alias of `gpt-5-codex`, and it is often entitlement-gated at the account/workspace level, so shipping it by default causes avoidable startup failures for many users.

If your workspace is entitled, you can add Spark model IDs manually.

## Usage examples

Recommended compact UI selectors:

```bash
opencode run "task" --model=openai/gpt-5.5 --variant=medium
opencode run "task" --model=openai/gpt-5.5-fast --variant=medium
opencode run "task" --model=openai/gpt-6-astra --variant=medium
opencode run "task" --model=openai/gpt-6-sol --variant=medium
opencode run "task" --model=openai/gpt-6-luna --variant=medium
opencode run "task" --model=openai/gpt-5.6-sol --variant=medium
```

If you need direct explicit selector IDs for scripts, install with:

```bash
npx -y oc-codex-multi-auth@latest --full
```

## Minimal config (advanced)

A barebones debug template is available at [`minimal-opencode.json`](./minimal-opencode.json). It omits the full preset catalog.

## Plugin account storage

These templates configure `~/.config/opencode/opencode.json`. The plugin's own
runtime settings live in `~/.opencode/openai-codex-auth-config.json` — see
[`docs/configuration.md`](../docs/configuration.md). One worth knowing up
front: `perProjectAccounts` (default `true`) stores accounts per project under
`~/.opencode/projects/<project-key>/` instead of the global
`~/.opencode/oc-codex-multi-auth-accounts.json`. Toggling it changes which
scope the plugin uses; it does **not** migrate or delete the other scope's
account, flagged-account, or backup files, which stay on disk until you copy
or remove them yourself.

## Unsupported-model behavior

Current defaults are strict entitlement handling except for common default-selector entitlement gates:

- **GPT-6 Astra** auto-fallback: `gpt-6-astra → gpt-6-sol → gpt-5.6-sol → gpt-5.6-terra → gpt-5.5 → gpt-6-luna → gpt-5.6-luna`
- **Daybreak** cyber tiers: no fallback chain, deliberately
- **GPT-5.6** auto-fallback: `gpt-5.6-sol → gpt-5.6-terra → gpt-5.5 → gpt-6-luna → gpt-5.6-luna`
- **`gpt-5.5`** can auto-fallback through `gpt-6-sol`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-6-luna`, then `gpt-5.6-luna`; canonical **`gpt-5-codex`** can auto-fallback through `gpt-5.6-terra`, then `gpt-5.6-luna` when the backend reports the selected model is not supported
- `unsupportedCodexPolicy: "strict"` returns other entitlement errors directly
- set `unsupportedCodexPolicy: "fallback"` (or `CODEX_AUTH_UNSUPPORTED_MODEL_POLICY=fallback`) to enable the full fallback chain for manual/legacy selectors
- `fallbackToGpt52OnUnsupportedGpt53: true` keeps the legacy `gpt-5.3-codex -> gpt-5.2-codex` edge inside fallback mode
- user-typed `gpt-5.5-pro*` is canonicalized to `gpt-5.5` before fallback because GPT-5.5 Pro is ChatGPT-only, not a Codex-routable model; `gpt-6-astra-pro*` is canonicalized to `gpt-6-astra` for the same reason
- legacy Codex selector `gpt-5.1-codex` normalizes to canonical `gpt-5-codex`, while `gpt-5.2-codex` and `gpt-5.3-codex` route as distinct backend model IDs; if canonical Codex or a gated model fails entitlement, default auto-fallback can retry through `gpt-5.6-terra`, then `gpt-5.6-luna`
- set `CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK=1` to disable GPT-6 Astra/Sol/Luna auto-fallback
- set `CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK=1` to disable GPT-5.6 auto-fallback
- set `CODEX_AUTH_DISABLE_GPT55_AUTO_FALLBACK=1` to disable GPT-5.5 auto-fallback
- set `CODEX_AUTH_DISABLE_CODEX_AUTO_FALLBACK=1` to disable canonical Codex/GPT-5.4-family auto-fallback
- `gpt-5.4-pro -> gpt-6-sol -> gpt-5.6-terra -> gpt-5.6-luna` applies when you manually select `gpt-5.4-pro`
- `unsupportedCodexFallbackChain` lets you override fallback order per model
- a single request hops across at most 6 quota-exhausted models (`MAX_QUOTA_FALLBACK_SWITCHES`, was 3)

Default chains when generic fallback policy is enabled (and empty override map). The general rows follow one order, most capable first (`gpt-6-astra > gpt-6-sol > gpt-5.6-sol > gpt-5.6-terra > gpt-5.5 > gpt-6-luna > gpt-5.6-luna`), and each row is that order's tail after its own model:

- `gpt-6-astra → gpt-6-sol → gpt-5.6-sol → gpt-5.6-terra → gpt-5.5 → gpt-6-luna → gpt-5.6-luna` (also auto under default strict for rollout gates)
- `gpt-6-sol → gpt-5.6-sol → gpt-5.6-terra → gpt-5.5 → gpt-6-luna → gpt-5.6-luna`
- `gpt-5.6-sol → gpt-5.6-terra → gpt-5.5 → gpt-6-luna → gpt-5.6-luna` (also auto under default strict for preview gates)
- `gpt-5.6-terra → gpt-5.5 → gpt-6-luna → gpt-5.6-luna`
- `gpt-5.5 → gpt-6-sol → gpt-5.6-sol → gpt-5.6-terra → gpt-6-luna → gpt-5.6-luna`
- `gpt-6-luna → gpt-5.6-luna → gpt-6-sol → gpt-5.6-sol → gpt-5.6-terra → gpt-5.5`
- `gpt-5.6-luna → gpt-6-luna → gpt-6-sol → gpt-5.6-sol → gpt-5.6-terra → gpt-5.5`
- `gpt-5-codex → gpt-5.6-terra → gpt-5.6-luna`

> The terminal is `gpt-5.6-luna`, not `gpt-5.5`: OpenAI's Codex model docs say GPT-5.5 retires from Codex with ChatGPT sign-in on 2026-10-14, while 5.6 Luna is listed for every plan with no retirement date. `gpt-5.2`, the terminal before that, left the catalog in openai/codex #44250 (2026-09-09). GPT-5.4 and GPT-5.4 Mini were retired from Codex on 2026-08-31; the catalog marks both `visibility: "hide"` and names their replacements (`gpt-5.4` -> `gpt-6-sol`, `gpt-5.4-mini` -> `gpt-6-luna`), and `gpt-5.4-nano` has no catalog entry. The default chains therefore end at live models rather than leading with retired ones.
- `gpt-5.4 → gpt-6-sol → gpt-5.6-terra → gpt-5.6-luna`
- `gpt-5.4-mini → gpt-6-luna → gpt-5.6-luna`
- `gpt-5.4-nano → gpt-6-luna → gpt-5.6-luna`
- `gpt-5.4-pro → gpt-6-sol → gpt-5.6-terra → gpt-5.6-luna` (if you manually select `gpt-5.4-pro`)
- `gpt-5.3-codex → gpt-5-codex → gpt-5.2-codex`
- `gpt-5.3-codex-spark → gpt-5-codex → gpt-5.3-codex → gpt-5.2-codex` (only if Spark IDs are added manually)
- `gpt-5.2-codex → gpt-5-codex`
- `gpt-5.1-codex → gpt-5-codex`

## Additional docs

- Main config reference: [`docs/configuration.md`](../docs/configuration.md)
- Getting started: [`docs/getting-started.md`](../docs/getting-started.md)
- Tools and CLI: [`docs/tools-and-cli.md`](../docs/tools-and-cli.md)
- Troubleshooting: [`docs/troubleshooting.md`](../docs/troubleshooting.md)
