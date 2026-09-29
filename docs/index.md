# oc-codex-multi-auth Overview

`oc-codex-multi-auth` is an OpenCode plugin that signs in ChatGPT Plus/Pro accounts through OAuth, keeps a pool of them on your machine, and rotates between them with health scoring and cooldowns — plus 24 `codex-*` tools and a thin standalone CLI for quota status, diagnostics, and recovery.

## Who needs it

- You hit ChatGPT/Codex usage limits inside OpenCode and want a second (or fifth) account ready to serve.
- You want per-project account pools scoped to one repository.
- You run OpenCode 2.0.16+ (V2 adapter) or 1.18.29+ (V1 plugin).
- You want quota visibility and recovery tooling inside OpenCode instead of an opaque auth file.

If a single ChatGPT account covers your work and you never think about quota, OpenCode's built-in `opencode auth login` is enough — this plugin wraps multi-account management around it, it does not replace it.

## What it does at runtime

Two surfaces, always kept distinct:

1. **In-session plugin.** OpenCode loads the package as a provider plugin (the V1 `server` hook, or the V2 `setup` hook on 2.0.16+). It shapes requests to the stateless Codex contract (`store: false` plus `reasoning.encrypted_content`), rotates to a healthy account on rate limits and failures, and registers the 24 `codex-*` tools the agent can call. The TUI plugin shows live quota status beside the prompt.
2. **Standalone CLI.** `oc-codex-multi-auth <command>` runs the installer plus nine commands (`doctor`, `status`, `list`, `limits`, `dashboard`, `health`, `diag`, `warm`, `update`) that read and write the same local pool — useful for scripting and repair without an agent loop.

OAuth sign-in uses a loopback callback on `localhost:1455` (the listener binds both `127.0.0.1` and `::1`), or device-code/manual login for headless shells.

## What it owns — and what it never touches

| `oc-codex-multi-auth` owns | OpenCode keeps |
| --- | --- |
| `~/.opencode` — account pools, the flagged store, plugin config, refresh journals, and quota caches (`0600`/`0700`) | `~/.config/opencode` — `opencode.json`/`tui.json`; the installer edits these only when you run it |
| The `codex-*` tools registered into each session | The host model/provider registry — V2 reroutes `openai` through the adapter but OpenCode owns the catalog |
| Request logs under `~/.opencode/logs/codex-plugin/`, only when `ENABLE_PLUGIN_REQUEST_LOGGING=1` | `~/.local/share/opencode/auth.json` — the host OAuth token store the plugin reads |

## First five minutes

```bash
npx -y oc-codex-multi-auth@latest   # register the plugin in opencode.json
opencode auth login                 # sign in a ChatGPT account (repeat for more)
oc-codex-multi-auth status          # inspect the pool
oc-codex-multi-auth limits          # usage windows across the pool
```

## Where to go next

| I want to... | Read |
| --- | --- |
| Install and sign in | [getting-started.md](getting-started.md) |
| Tour the 24 tools and the CLI | [tools-and-cli.md](tools-and-cli.md) |
| Understand the components and request flow | [architecture.md](architecture.md) |
| Change settings or environment overrides | [configuration.md](configuration.md) |
| Upgrade from an older name or release | [upgrade.md](upgrade.md) |
| Recover from a problem | [troubleshooting.md](troubleshooting.md) |
| Browse the full doc set | [README.md](README.md) — the complete portal |
