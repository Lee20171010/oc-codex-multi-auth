# Upgrade Guide

Update the maintained `Lee20171010/oc-codex-multi-auth` checkout while preserving its account pools and OpenCode configuration.

---

## What's Current

| Item | Value |
| --- | --- |
| Package | `oc-codex-multi-auth`, installed by npm from the maintained source checkout |
| Plugin entry | `plugin` list in `~/.config/opencode/opencode.json` for OpenCode 1.18.29+; `plugins` for OpenCode 2.0.16+ |
| Standalone CLI | `oc-codex-multi-auth <command>` — `doctor`, `status`, `list`, `limits`, `dashboard`, `health`, `diag`, `warm`, `update` |
| Runtime state | `~/.opencode` — global pool `oc-codex-multi-auth-accounts.json`, per-project pools under `projects/<project-key>/` |

---

## Upgrade

```bash
git pull --ff-only origin main
npm ci
npm run build
opencode service restart
```

Run these commands inside the standalone clone. Its `origin` points to the maintained fork; use `upstream` for reviewed merges from the author. npm's global link and OpenCode's built-directory file URL both follow this checkout. Run `npm install --global .` and `oc-codex-multi-auth install --v2` once during initial setup; see [Getting Started](getting-started.md).

The legacy CLI `update` command clears package caches only; it does not update this source tree. Local-checkout builds skip upstream npm update checks.

Then verify the install:

```bash
oc-codex-multi-auth doctor
oc-codex-multi-auth status
```

No storage migration step is needed — account pools upgrade in place on first load.

---

## Changes To Know About

### Package renames

The package has been renamed twice: `opencode-openai-codex-auth-multi` → `oc-chatgpt-multi-auth` → `oc-codex-multi-auth` (current since 6.0.0). Retired names may still appear in `~/.config/opencode/opencode.json` or `tui.json`; the installer rewrites the plugin entries it manages and clears both old package names from OpenCode's package cache.

### Storage file renames

Also since 6.0.0, the account pool moved from `openai-codex-accounts.json` to `oc-codex-multi-auth-accounts.json`, and the flagged store from `openai-codex-flagged-accounts.json` to `oc-codex-multi-auth-flagged-accounts.json` — under `~/.opencode/` and each `projects/<project-key>/` alike. First load migrates the old files automatically; the old names are read for migration only, and pool content upgrades to the current format on the same first load.

### OpenCode V1 to V2

OpenCode 2.0.16+ loads the plugin through a V2 adapter (the `setup` hook) instead of the V1 `server` hook. Run `oc-codex-multi-auth install --v2` to register the maintained checkout's built-directory file URL in `plugins`, preserving other configuration. The command refuses an existing `opencode.jsonc` file or V1 registration; edit those configurations explicitly to migrate, using the checkout's absolute `dist` file URL in `plugins`. The account pool, OAuth login, tools, and quota cache are shared between the two adapters; V1 remains supported for OpenCode 1.18.29+. In V2 the host normalizes tool names to `codex_list`, `codex_switch`, and so on.

### Per-project pools

`perProjectAccounts` (default `true`, env `CODEX_AUTH_PER_PROJECT_ACCOUNTS`) gives each project its own pool under `~/.opencode/projects/<project-key>/`. Toggling switches scope live but does not migrate or delete the other scope's files — copy or remove them yourself. `$HOME` itself is never a project root.

---

## Uninstall / Disable

There is no `uninstall` command — removal is manual. Step-by-step: [getting-started.md § Uninstall / disable](getting-started.md#uninstall--disable). Runtime state stays under `~/.opencode` unless deleted; see [privacy.md § Deleting your data](privacy.md#deleting-your-data).

## Related

- [getting-started.md](getting-started.md)
- [configuration.md](configuration.md)
- [troubleshooting.md](troubleshooting.md)
- [../CHANGELOG.md](../CHANGELOG.md)
