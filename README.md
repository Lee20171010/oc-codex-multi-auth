# oc-codex-multi-auth

[![npm version](https://img.shields.io/npm/v/oc-codex-multi-auth.svg)](https://www.npmjs.com/package/oc-codex-multi-auth)
[![CI](https://github.com/ndycode/oc-codex-multi-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/ndycode/oc-codex-multi-auth/actions/workflows/ci.yml)
[![MIT license](https://img.shields.io/npm/l/oc-codex-multi-auth.svg)](LICENSE)

Use your ChatGPT Plus/Pro subscription inside OpenCode over OAuth. The plugin
routes Codex, GPT-5, and GPT-6 models (including GPT-6 Astra/Sol/Luna and the
GPT-5.6 tiers), rotates across multiple accounts, shows quota in the prompt,
and ships a 24-tool `codex-*` command kit. Account state stays local under
`~/.opencode`.

> [!CAUTION]
> Personal development use with your own ChatGPT Plus/Pro subscription only.
> This is an independent open-source project, not an official OpenAI product.
> For production or commercial workloads, use the OpenAI Platform API.

## Install

Requires Node.js `>=22.19` and [OpenCode](https://opencode.ai).

```bash
npx -y oc-codex-multi-auth@latest
```

With no flag, the installer only registers the plugin: it adds the plugin
entry to `~/.config/opencode/opencode.json`, enables the TUI quota plugin in
`~/.config/opencode/tui.json`, and refreshes the cached package. Your existing
`provider.openai` model config is left alone. Add a flag to also install a
model catalog:

| Flag | Effect |
| --- | --- |
| (none) / `--plugin-only` | Register the plugin entries only |
| `--modern` | Also install the compact catalog: 10 base models with 53 variants |
| `--full` | Also install the compact bases plus 53 explicit selector IDs (`openai/gpt-5.5-medium`) |
| `--legacy` | Install the explicit-only catalog (53 entries) for older OpenCode |
| `--v2` | Register for OpenCode V2 instead (plugin only; see below) |
| `--dry-run` | Show what would change without writing |
| `--no-cache-clear` | Skip clearing the OpenCode plugin cache |
| `--version` | Print the installed version |

Both `opencode.json` and `opencode.jsonc` are supported, comments and
trailing commas included. When `opencode.jsonc` is your effective config, the
installer merges into it; it refuses to overwrite a config it cannot parse
(an unterminated `/*` comment counts as unparseable), and unknown flags are
errors. Changed files are backed up first.

To update later without touching either config file:

```bash
npx -y oc-codex-multi-auth@latest update
```

To remove the plugin later, see
[Uninstall / disable](docs/getting-started.md#uninstall--disable) — removal is
manual; there is no `uninstall` command.

## Sign in and verify

```bash
opencode auth login            # choose OpenAI, then a Codex OAuth method
oc-codex-multi-auth status     # account and storage summary
oc-codex-multi-auth doctor     # diagnostics, or: doctor --fix
```

Run `opencode auth login` once per ChatGPT account. Four OAuth methods are
available (browser, open URL manually, device code, manual URL paste); see
[Getting Started](docs/getting-started.md) for headless login.

Then run a first prompt — catalog installs only:

```bash
opencode run "Explain this repository" --model=openai/gpt-5.5 --variant=medium
```

## OpenCode V2

OpenCode **2.0.16+** loads the plugin through a V2 adapter; the account pool,
OAuth login, and request pipeline are shared with V1.

```bash
npx -y oc-codex-multi-auth@latest --v2
```

`--v2` writes a `plugins` entry only — no model catalog — and refuses an
existing `opencode.jsonc` or V1 `plugin` entries rather than migrating them
(edit the JSONC `plugins` list by hand instead). Restart the background
service after installing or rebuilding:

```bash
opencode service restart
opencode auth login   # OpenAI -> Codex OAuth (Add account - ChatGPT Plus/Pro)
```

V1's entrypoint remains for OpenCode 1.18.29+. In V2, tool names normalize to
`codex_list`, `codex_switch`, and so on; `/codex-accounts` and the **Codex
accounts** palette command list the pool, and **Codex quota details** shows
quota. See [Troubleshooting](docs/troubleshooting.md) for V2-specific issues.

## Accounts

Run `opencode auth login` once per account; each login adds to the pool, and
logging into the same account updates its entry. Rotation picks the
healthiest enabled account per request (`rotationStrategy`, default
`hybrid`).

Account pools are **per-project by default**. The plugin walks up from the
working directory looking for a project marker (`.git`, `package.json`,
`.opencode`, and friends), stopping at your home directory; without a marker
it uses global storage.

| File | Path |
| --- | --- |
| Per-project accounts | `~/.opencode/projects/<project-key>/oc-codex-multi-auth-accounts.json` |
| Global accounts | `~/.opencode/oc-codex-multi-auth-accounts.json` |
| Flagged accounts | `oc-codex-multi-auth-flagged-accounts.json`, beside the active accounts file |
| Pre-write snapshots | `backups/codex-credential-snapshot-*.json`, beside the active accounts file |
| Plugin config | `~/.opencode/openai-codex-auth-config.json` |
| OpenCode config | `~/.config/opencode/opencode.json` (or `opencode.jsonc`) |
| Request logs | `~/.opencode/logs/codex-plugin/`, when logging is enabled |

The standalone CLI resolves the same pool — `status`, `list`, `limits`, and
`warm` all print the `storagePath` they used, and `--config-path` points them
at a specific file. Set `CODEX_AUTH_PER_PROJECT_ACCOUNTS=0` to force global
storage.

Prefer the OS keychain over JSON files? Opt in with `CODEX_KEYCHAIN=1`
(macOS Keychain, Windows Credential Manager, Linux libsecret) and manage it
with `codex-keychain`. JSON remains the default; nothing is migrated until
you ask.

## Models

`--modern` and `--full` install **10 base models** covering **53 variants**
(selectable via `--variant`); `--legacy` installs the 53 as explicit IDs.

| Base | Notes |
| --- | --- |
| `gpt-6-astra` | frontier; rolled out 2026-09-03 |
| `gpt-6-sol` | workhorse coding model |
| `gpt-6-luna` | fast, affordable |
| `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | GPT-5.6 tiers; entitlement-gated |
| `gpt-5.5`, `gpt-5.5-fast` | retires from Codex 2026-10-14 |
| `gpt-5.4-nano` | |
| `gpt-5.1` | |

GPT-6 and GPT-5.6 models use the responses-lite request shape and the
`opencode` client identity; other models use `codex_cli_rs`. Requests stay
stateless: `store: false` with `reasoning.encrypted_content` for multi-turn
continuity.

Retired IDs still route if typed — `gpt-5.4-mini`, `gpt-5-codex`,
`gpt-5.1-codex`, `gpt-5.1-codex-max`, and `gpt-5.1-codex-mini` are rescued by
the default fallback chains. The Daybreak-gated tiers
(`gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest`, `gpt-5.6-cyber`) are
routed but deliberately not shipped; add them by hand if your workspace is
approved. Full chain details live in
[docs/configuration.md](docs/configuration.md).

## Quota status

The TUI prompt line shows quota for the account that served the last request.
`quotaStatus.mode` in `~/.opencode/openai-codex-auth-config.json` controls it:

- `active` (default): the serving account's remaining quota
- `overview`: the whole pool on one line, weighted by plan
- `resets`: banked rate-limit reset credits

Pass a list (`["overview", "resets"]`) to rotate screens every `rotateMs`
(default 5s). Percentages read as headroom left; set `quotaDisplay: "used"`
to show consumption. All layout and forecast options are documented in
[docs/configuration.md](docs/configuration.md).

## The `codex-*` tools

Inside OpenCode, 24 tools manage the pool without leaving the session:

| Tool | What it does |
| --- | --- |
| `codex-setup` | Guided first-run setup checklist |
| `codex-help` | Plugin help, by topic |
| `codex-next` | Suggested next action to get unstuck |
| `codex-status` | Active account, model family, routing state |
| `codex-list` | Saved accounts and which is active |
| `codex-switch` | Change the active account |
| `codex-warm` | Open every enabled account's usage window now |
| `codex-limits` | Per-account and pool quota |
| `codex-reset` | List or redeem banked rate-limit reset credits |
| `codex-health` | Which accounts look healthy, limited, or disabled |
| `codex-doctor` | Diagnostics plus safe repairs (`fix=true`) |
| `codex-diag` | Redacted diagnostic snapshot for bug reports |
| `codex-dashboard` | Read-only eligibility, retry, and refresh snapshot |
| `codex-metrics` | Runtime counters and request metrics |
| `codex-pool` | Pin models to preferred accounts |
| `codex-label` | Name an account |
| `codex-tag` | Group accounts with tags |
| `codex-note` | Attach a private note to an account |
| `codex-remove` | Remove a saved account |
| `codex-refresh` | Verify every account's refresh token still works |
| `codex-export` / `codex-import` | Back up and restore account storage (import previews with `dryRun=true`) |
| `codex-diff` | Compare account/config snapshots |
| `codex-keychain` | Show or migrate the credential backend |

Argument details: [docs/tools-and-cli.md](docs/tools-and-cli.md).

## Standalone CLI

The same package runs account commands directly — no agent, no token cost:

```bash
oc-codex-multi-auth status      # pool summary + storagePath
oc-codex-multi-auth list        # accounts, --tag <name> to filter
oc-codex-multi-auth limits      # 5h/weekly usage; --sort account|usage|reset --asc|--desc --refresh
oc-codex-multi-auth warm        # open every enabled account's usage window
oc-codex-multi-auth doctor      # diagnostics; --deep, --fix
oc-codex-multi-auth diag        # alias for doctor --deep
oc-codex-multi-auth health      # local token/account health
oc-codex-multi-auth dashboard   # dashboard guidance
```

These standalone commands accept `--json` and `--config-path <file>`
(`install`/`update` do not — they reject it); `status`/`list`/`limits`
redact identifiers unless `--include-sensitive` is passed. Via npx:
`npx -y oc-codex-multi-auth@latest status --json`.

## Configuration

Plugin settings live in `~/.opencode/openai-codex-auth-config.json` and are
re-read per request — most edits need no restart. Boolean env overrides are
truthy only for the literal `"1"`. Common ones:

| Setting | Effect |
| --- | --- |
| `CODEX_AUTH_PER_PROJECT_ACCOUNTS=0` | Force the global account pool |
| `CODEX_KEYCHAIN=1` | Store accounts in the OS keychain |
| `CODEX_AUTH_ROTATION_STRATEGY=hybrid\|sticky\|round-robin` | Account selection strategy |
| `CODEX_AUTH_QUOTA_DISPLAY=free\|used` | Quota percentages as headroom (default) or consumption |
| `CODEX_RETRY_ALL_UNBOUNDED=1` | Let "wait as long as the backend asks" apply when every account is rate-limited; otherwise capped at 10 minutes |
| `ENABLE_PLUGIN_REQUEST_LOGGING=1` | Write request metadata logs |
| `CODEX_PLUGIN_LOG_BODIES=1` | Also log raw bodies (sensitive) |

Full reference, field by field: [docs/configuration.md](docs/configuration.md).

## Troubleshooting

Most issues resolve by signing in again (`opencode auth login`) or running
`codex-doctor fix=true` / `oc-codex-multi-auth doctor --fix`. The callback
listener needs port 1455 free. Symptom-by-symptom fixes:
[docs/troubleshooting.md](docs/troubleshooting.md). Common questions:
[docs/faq.md](docs/faq.md).

## Documentation

- [Getting Started](docs/getting-started.md) — install, login methods, first prompt
- [Tools and CLI](docs/tools-and-cli.md) — full tool/CLI argument reference
- [Configuration](docs/configuration.md) — every config key and env var
- [Troubleshooting](docs/troubleshooting.md) / [FAQ](docs/faq.md)
- [Architecture](docs/architecture.md) — how the pieces fit
- [Privacy](docs/privacy.md) — what is stored and where
- [Config templates](config/README.md) — modern vs. legacy catalogs
- [Changelog](CHANGELOG.md) — release history
- Maintainer docs: [docs/development/](docs/development/ARCHITECTURE.md)

## License

MIT — see [LICENSE](LICENSE). Not affiliated with OpenAI; "ChatGPT", "Codex",
and "OpenAI" are trademarks of OpenAI.
