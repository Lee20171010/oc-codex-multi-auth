---
name: oc-codex-setup
description: Install or refresh oc-codex-multi-auth in OpenCode, choose the right config mode, and verify Codex OAuth with ChatGPT Plus or Pro access.
---

# oc-codex-setup

Use this skill when the user wants to install, reinstall, upgrade, or troubleshoot `oc-codex-multi-auth` in OpenCode. Requires Node >= 22.19.

## Maintained source build

Use the standalone clone of `https://github.com/Lee20171010/oc-codex-multi-auth` on `main`. npm and OpenCode must both resolve to this maintained checkout so subscription discovery, Long selectors, confirmation forms and bounded recovery stay available:

```bash
npm ci
npm run build
npm install --global .
oc-codex-multi-auth install --v2
```

`install --v2` registers the CLI checkout's `dist` file URL in the existing OpenCode `plugins` array. It preserves other settings, plugins and explicit local registrations, and backs up changed configuration.

OpenCode 2.0.22 discovers the server and TUI from this entry. Keep the checkout in place, back up configuration before changing registration, restart the host, and verify the plugin is active. Account files and sessions keep their existing paths. Use `oc-codex-multi-auth list --json` for a redacted account inventory. Validate real generation separately; never redeem real reset credits during tests.

## Happy path

```bash
opencode service restart        # after building and registering the checkout
opencode auth login             # pick a "Codex OAuth" method and sign in
oc-codex-multi-auth doctor       # verify
```

Use `oc-codex-multi-auth install --v2` to register the built checkout while preserving `provider.openai` and other plugins. The linked CLI retains the installer flags below for optional catalog configuration; preserve the checkout registration when using them.

## Config modes (choose at most one)

| Flag | When to use |
| --- | --- |
| _(none)_ / `--plugin-only` | User already manages `provider.openai` (default) |
| `--modern` | Compact catalog: 11 base OAuth model families + variant presets |
| `--full` | Compact bases plus 59 explicit selector IDs (e.g. `openai/gpt-5.5-medium`, `openai/gpt-6-astra-high`) |
| `--legacy` | 59 explicit model IDs only, for OpenCode versions without variant support |
| `--v2` | Register for OpenCode V2 (`plugins` entry; plugin-only, includes quota UI) |

`--v2` cannot combine with a catalog mode; it refuses an existing `opencode.jsonc` or V1 `plugin` entries. Other installer flags: `--dry-run`, `--no-cache-clear`, `--version`, `--help`.

## Refresh without touching config

```bash
git pull --ff-only origin main
npm ci
npm run build
opencode service restart
```

Run these commands inside the standalone clone. `origin` is the maintained fork; `upstream` is the author's repository for reviewed merges. The global npm link follows this checkout automatically. Local-checkout builds skip the upstream npm version check; the legacy CLI `update` command only clears package caches and does not update this source tree.

## Verify

```bash
# modern/--full selectors use base + variant:
opencode run "Explain this repository" --model=openai/gpt-5.5 --variant=medium
opencode run "Explain this repository" --model=openai/gpt-6-astra --variant=medium
opencode run "Explain this repository" --model=openai/gpt-5.6-sol --variant=medium
# explicit IDs only exist after --full or --legacy:
opencode run "Explain this repository" --model=openai/gpt-5.5-medium
```

## Standalone CLI (no agent cost)

```bash
oc-codex-multi-auth status
oc-codex-multi-auth list
oc-codex-multi-auth switch 2
oc-codex-multi-auth label 2 "Work"
oc-codex-multi-auth tag 2 "work,primary"
oc-codex-multi-auth note 2 "Weekday primary"
oc-codex-multi-auth pool set gpt-6.1-sol 1,2
oc-codex-multi-auth pool set-mode gpt-6.1-sol strict
oc-codex-multi-auth limits
oc-codex-multi-auth doctor
oc-codex-multi-auth health
oc-codex-multi-auth warm
oc-codex-multi-auth dashboard
oc-codex-multi-auth diag
oc-codex-multi-auth limits --refresh   # live reads
oc-codex-multi-auth doctor --fix       # verified refresh + stale markers and both quota caches
```

Management inputs and terminal account numbers start at 1. Run commands inside the target project directory; each project has an independent account pool. Empty strings clear labels/tags/notes. `pool` supports status/set/add/remove/clear/set-mode and `--dry-run`. Failed credential verification requires `opencode auth login`; `limits --refresh` reads current server usage after a reset.

## Config knobs that matter

All live in `~/.opencode/openai-codex-auth-config.json`; every boolean env override is truthy for `"1"` only.

| Knob | Default | Purpose |
| --- | --- | --- |
| `perProjectAccounts` | `true` | Per-project pools under `~/.opencode/projects/<key>/` |
| `rotationStrategy` | `hybrid` | `sticky` / `round-robin` alternatives |
| `maskEmail` | `false` | Render emails as `us***@example.com` |
| `quotaNotifications.autoProtectCredits` | `true` | 30-min `/wham/usage` poll that blocks spent accounts pre-429 |
| `autoUpdate` | `true` | npm version check for packaged builds; skipped for the maintained checkout |
| `CODEX_KEYCHAIN=1` | off | Opt-in OS-keychain credential backend |

## Troubleshooting

- Config must register the maintained checkout's built-directory file URL in `plugins` (V2); V1 uses file URLs for the server and TUI entrypoints.
- `opencode auth login` again if tokens expired or the wrong workspace was picked.
- Failed requests: `ENABLE_PLUGIN_REQUEST_LOGGING=1`, then inspect `~/.opencode/logs/codex-plugin/` (set `CODEX_PLUGIN_LOG_BODIES=1` only for raw bodies).
- Deeper docs: `docs/getting-started.md`, `docs/configuration.md`, `docs/troubleshooting.md`, `docs/faq.md`.

## Usage boundaries

Personal development use with your own ChatGPT Plus or Pro subscription. For production or shared services, prefer the OpenAI Platform API.
