# Getting Started

This guide covers the full installation and first-run flow for `oc-codex-multi-auth`.

## Before You Begin

> [!CAUTION]
> This plugin is for personal development use with your own ChatGPT Plus/Pro subscription.
>
> - It is not intended for commercial resale, shared multi-user access, or production services.
> - It uses official OAuth authentication, but it is an independent open-source project and is not affiliated with OpenAI.
> - For production applications, use the [OpenAI Platform API](https://platform.openai.com/).

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| OpenCode | Install from [opencode.ai](https://opencode.ai) |
| ChatGPT Plus or Pro | Required for OAuth access and model entitlements |
| Node.js `>=18` | Needed for local OpenCode runtime and plugin installation |

## Fastest Install Path

```bash
npx -y oc-codex-multi-auth@latest --modern
opencode auth login
opencode run "Explain this repository" --model=openai/gpt-5.5 --variant=medium
```

`--modern` writes the **compact modern** config so the model picker shows **10 base OAuth model families** and **53 variants**. The `--variant` presets shown above are defined by that catalog, so install with `--modern` (or `--full` / `--legacy`) if you want them. Rerunning `--modern` also removes explicit preset entries and stale base models left by earlier plugin catalogs.

The **default** install takes no flag and does not write a model catalog at all:

```bash
npx -y oc-codex-multi-auth@latest
```

It normalizes the plugin entry in `~/.config/opencode/opencode.json`, enables the TUI status plugin, and clears the cached plugin copy so OpenCode reinstalls the latest package. It preserves `provider.openai` and leaves model definitions to OpenCode. Use it when OpenCode already supplies the OAuth model entries you need; `--variant` presets and `gpt-5.5-fast` come only from this plugin's catalogs.

If you want direct explicit selector IDs such as `openai/gpt-5.5-medium` (modern bases **plus** explicit entries):

```bash
npx -y oc-codex-multi-auth@latest --full
```

If you explicitly want the older explicit-only layout (53 individual model keys):

```bash
npx -y oc-codex-multi-auth@latest --legacy
```

To register the plugin without changing an existing `provider.openai` configuration:

```bash
npx -y oc-codex-multi-auth@latest install --plugin-only
```

For OpenCode V2 (2.0.16+), register with `--v2`. It is plugin-only: it writes a
V2 `plugins` entry with automatic quota UI loading, and it refuses an existing
`opencode.jsonc` or V1 `plugin` entries rather than migrating them. See the
[README V2 section](../README.md#opencode-v2) for the login flow.

```bash
npx -y oc-codex-multi-auth@latest --v2
```

To refresh an existing installation without reading or writing either OpenCode config file:

```bash
npx -y oc-codex-multi-auth@latest update
```

The update command clears only the managed package cache. Restart OpenCode afterward. The plugin's automatic updater uses the same cache-only behavior.

## Install from Source

Use this only when you want to develop or test the plugin locally.

```bash
git clone https://github.com/ndycode/oc-codex-multi-auth.git
cd oc-codex-multi-auth
npm ci
npm run build
```

Point OpenCode at the built plugin:

```json
{
  "plugin": ["file:///absolute/path/to/oc-codex-multi-auth/dist"]
}
```

Use the built `dist/` directory, not the repository root.

## Authentication

Run:

```bash
opencode auth login
```

Then choose:

1. `OpenAI`
2. One of the **four** plugin OAuth methods:
   - `Codex OAuth (ChatGPT Plus/Pro)` opens the default browser and completes through a localhost callback
   - `Codex OAuth (Open URL Manually)` prints the authorization URL after port 1455 is listening. Open it in any browser, and the callback completes automatically through localhost
   - `Codex OAuth (Device Code)` for headless or SSH sessions
   - `Codex OAuth (Manual URL Paste)` pastes the full callback URL, including its `state` parameter. The state is what ties the pasted value to this login attempt, so a bare code and a mismatched state are both rejected before token exchange

There is **no** registered "Manual API Key" login path for this plugin. The provider still presents a dummy SDK key (`chatgpt-oauth`) internally, and real auth is always OAuth.

If the default browser cannot be launched (no `xdg-open` on PATH, for example), the login is not cancelled: the authorization URL is printed and the listener keeps waiting, so opening that URL in any browser still completes the login.

Both browser-based OAuth methods use the same local callback port as Codex CLI. The authorize redirect is `http://localhost:1455/auth/callback`, while the local callback server binds `http://127.0.0.1:1455/auth/callback` and `[::1]:1455` for dual-stack localhost redirects. Authorization and token exchange go to `auth.openai.com`.

Account records persist the granted OAuth scope. The required scopes are `openid`, `profile`, `email`, and `offline_access`. An account whose recorded scope is explicitly missing one of them is marked for re-auth instead of being silently reused. An account whose scope is simply unrecorded is left enabled, because absent metadata is not treated as a failed grant, and an account previously marked for re-auth is restored automatically once a complete scope is known. A blank scope in the token response falls back to the scope the login requested, so an empty string never overwrites known-good scope metadata.

### Remote or Headless Login

If you are on SSH, WSL, or another environment where the browser callback flow is inconvenient:

- **If localhost port 1455 is reachable** (including via `ssh -L 1455:localhost:1455 user@remote`):
  1. rerun `opencode auth login`
  2. choose `Codex OAuth (Open URL Manually)`, which prints the URL after the listener is ready. Open it in any browser and login completes automatically through localhost
- **If localhost is not reachable** (containers, restricted networks):
  1. rerun `opencode auth login`
  2. choose `Codex OAuth (Device Code)` and follow the verification link and one-time code
  3. if device code is unavailable, fall back to `Codex OAuth (Manual URL Paste)` and paste the full callback URL, including its `state` parameter

## Add the Plugin to OpenCode

If you are not using the installer, edit `~/.config/opencode/opencode.json` manually:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["oc-codex-multi-auth"]
}
```

## Choose a Config Template

The repository ships two supported templates:

| OpenCode version | Template |
|------------------|----------|
| `v1.0.210+` | [`config/opencode-modern.json`](../config/opencode-modern.json) |
| `v1.0.209` and earlier | [`config/opencode-legacy.json`](../config/opencode-legacy.json) |

The templates include the supported GPT-5/Codex families, required `store: false` handling, and `reasoning.encrypted_content` for multi-turn sessions.

Current templates expose **10 base model families** and **53 presets** overall (53 modern variants or 53 legacy explicit entries):

| Base family | Notes |
|-------------|-------|
| `gpt-6-astra` | responses-lite; frontier model (2026-09-03) |
| `gpt-6-sol` | responses-lite; workhorse coding model (2026-09-22) |
| `gpt-6-luna` | responses-lite; fast, affordable model (2026-09-22) |
| `gpt-5.6-sol` | responses-lite; flagship 5.6 tier |
| `gpt-5.6-terra` | responses-lite |
| `gpt-5.6-luna` | responses-lite |
| `gpt-5.5` | default public GPT-5.5 selector; retires from Codex with ChatGPT sign-in on 2026-10-14 (replacement `gpt-6-sol`/`gpt-6-luna`) |
| `gpt-5.5-fast` | faster GPT-5.5 variant |
| `gpt-5.4-nano` | |
| `gpt-5.1` | |

On OpenCode `v1.0.210+`, the modern template shows the 10 base entries because additional presets are selected through `--variant` instead of separate model keys.

`gpt-5.5-pro` is not shipped in the Codex templates because it is ChatGPT-only, not Codex-routable. Add entitlement-gated Spark variants manually only when your workspace supports them.

`gpt-5.4-mini`, `gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, and `gpt-5.1-codex-mini` are no longer shipped: `gpt-5.4-mini` retired from Codex with ChatGPT sign-in on 2026-08-31 (replacement `gpt-6-luna`), and the other four were shut down from the OpenAI API on 2026-07-23 (replacement `gpt-5.6-sol`, or `gpt-5.6-terra` for `gpt-5.1-codex-mini`). They are still routed and rescued by the default fallback chains if typed by hand.

## Verify the Setup

Run one of these commands. The `--variant` presets and `gpt-5.5-fast` require a catalog install (`--modern`, `--full`, or `--legacy`); after a default plugin-only install only the model entries OpenCode itself supplies are selectable.

```bash
# Recommended current GPT-5.5 path
opencode run "Create a short TODO list for this repo" --model=openai/gpt-5.5 --variant=medium
opencode run "Create a short TODO list for this repo" --model=openai/gpt-5.5-fast --variant=medium
opencode run "Inspect the retry logic and summarize it" --model=openai/gpt-6-sol --variant=high

# Optional GPT-6 Astra (requires rollout access; auto-falls back astra→gpt-6-sol→sol→terra→gpt-5.5→gpt-6-luna→luna)
opencode run "Create a short TODO list for this repo" --model=openai/gpt-6-astra --variant=medium

# Optional GPT-6 Sol / Luna (added 2026-09-22; same auto-fallback opt-out as Astra)
opencode run "Create a short TODO list for this repo" --model=openai/gpt-6-sol --variant=medium

# Optional GPT-5.6 (requires account entitlement; auto-falls back sol→terra→gpt-5.5→gpt-6-luna→luna)
opencode run "Create a short TODO list for this repo" --model=openai/gpt-5.6-sol --variant=medium

# Direct selector IDs, only after installing with --full
opencode run "Create a short TODO list for this repo" --model=openai/gpt-5.5-medium
```

If you want to verify request routing, run a request with logging enabled:

```bash
ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "test" --model=openai/gpt-5.5 --variant=medium
```

The first request should create logs under `~/.opencode/logs/codex-plugin/`.

Use `opencode debug config` when you want to verify custom or template-defined models. Default install preserves the existing model catalog; `--modern` installs compact entries such as `gpt-5.5` and `gpt-5.6-sol`, while `--full` also exposes explicit entries such as `gpt-5.5-medium` / `gpt-5.5-fast-medium` / `gpt-5.5-high`.

## Multi-Account Setup

The plugin can manage multiple ChatGPT accounts and choose the healthiest account or workspace for each request. Per-project account pools default to **on** under `~/.opencode/projects/<project-key>/`.

After your first successful login, you can add more accounts by running `opencode auth login` again or by using the guided commands below.

Optional: pin models to preferred accounts with `modelAccountPools` / `codex-pool` (see [configuration.md](configuration.md) and [tools-and-cli.md](tools-and-cli.md)).

## Guided Onboarding Commands

These commands are useful after installation (from inside OpenCode as tools, or for several of them via the standalone bin):

```text
codex-setup
codex-help topic="setup"
codex-doctor
codex-next
codex-list
codex-warm
codex-pool
codex-reset
```

Standalone equivalents (no agent/model loop):

```bash
oc-codex-multi-auth doctor
oc-codex-multi-auth status
oc-codex-multi-auth list
oc-codex-multi-auth warm
```

Notes:

- `codex-switch`, `codex-label`, and `codex-remove` can show interactive account pickers when `index` is omitted in a supported terminal.
- `codex-warm` opens every enabled account's usage window so rolling quota windows start at session start.
- The plugin can show a startup preflight summary with the current account health state and suggested next step.

## Beginner Safe Mode

If you want conservative retry behavior while learning the workflow, enable beginner safe mode:

```json
{
  "beginnerSafeMode": true
}
```

Or via environment variable:

```bash
CODEX_AUTH_BEGINNER_SAFE_MODE=1 opencode
```

This mode forces a more conservative retry profile and reduces the chance of long retry loops while you are debugging setup issues.

## Update the Plugin

From npm:

```bash
npx -y oc-codex-multi-auth@latest
```

From a local clone:

```bash
git pull
npm ci
npm run build
```

When `autoUpdate` is enabled (default), the plugin also checks npm daily and can clear the OpenCode plugin cache so a restart picks up a newer release.

## Next Reading

- [Tools and CLI](tools-and-cli.md)
- [Configuration Reference](configuration.md)
- [Troubleshooting](troubleshooting.md)
- [FAQ](faq.md)
- [Privacy & Data Handling](privacy.md)
- [Architecture Overview](architecture.md)
