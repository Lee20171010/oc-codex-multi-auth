# Troubleshooting

Symptom-by-symptom fixes for `oc-codex-multi-auth`. For command arguments see
[Tools and CLI](tools-and-cli.md); for every config key see
[Configuration](configuration.md).

## Start here

```bash
oc-codex-multi-auth doctor         # diagnose; add --fix for safe repairs
oc-codex-multi-auth status         # which storage file and accounts are in use
opencode auth login                # re-authenticate
```

Inside OpenCode the equivalents are `codex-doctor`, `codex-doctor fix=true`,
`codex-status`, and `codex-next`. When state is badly tangled, remove the
`openai` entry from the host auth store — `~/.local/share/opencode/auth.json`
(older layouts used `~/.opencode/auth/openai.json`) — and sign in again. To
fully reset the pool, also remove the accounts file that `status` reports as
`storagePath` plus its `*-flagged-accounts.json` sibling. With
`CODEX_KEYCHAIN=1`, credentials live in the OS keychain under service
`oc-codex-multi-auth`; use `codex-keychain` to roll back instead.

Machine-readable output for every read-only command: append `--json` (CLI) or
`format="json"` (tools).

## Error codes

Structured errors carry a `code`. The codes the current build emits:

| Code | Meaning |
| --- | --- |
| `CODEX_AUTH_ERROR` | OAuth/token problem — re-login usually fixes it |
| `CODEX_VALIDATION_ERROR` | Response failed schema validation (usually transient) |
| `CODEX_CONFIG_ERROR` | Plugin config file failed to parse |
| `CODEX_STORAGE_ERROR` | Account storage could not be read or written |
| `CODEX_CIRCUIT_OPEN` | An account's circuit breaker is cooling down; rotation handles it |
| `CODEX_CONFIG_LOCK_CONTENTION` | Another process is writing plugin config; retry shortly |
| `CODEX_STORAGE_TRANSACTION_CONTENTION` | Another process holds the account-store lease; retry shortly |
| `CODEX_RECOVERY_ERROR`, `CODEX_PROMPT_ERROR`, `CODEX_REQUEST_ERROR` | Recovery, prompt-cache, or request-transform failures |

`CODEX_NETWORK_ERROR`, `CODEX_API_ERROR`, `CODEX_RATE_LIMIT`, and
`CODEX_TIMEOUT` are declared in `lib/errors.ts` but are **reserved**: no code
path throws them today. Network, HTTP, rate-limit, and timeout failures are
handled by the retry/rotation pipeline and surface as plain errors (or get
absorbed by a retry), not as dedicated `CODEX_*` codes.

## Install and loading

**Plugin does not load / no logs appear.**

1. Confirm `~/.config/opencode/opencode.json` (or `opencode.jsonc` — both are
   supported) contains `"plugin": ["oc-codex-multi-auth"]`, or your checkout
   path when developing.
2. Rerun `npx -y oc-codex-multi-auth@latest` — it refreshes the entry and
   clears OpenCode's cached plugin copy, then restart OpenCode.
3. Request logs are written only after the first request and only when
   `ENABLE_PLUGIN_REQUEST_LOGGING=1` is set.
4. Check the package resolves: `npm view oc-codex-multi-auth version`.

**Installer refuses to write.**

- A config it cannot parse is never overwritten — fix the JSON/JSONC syntax
  first or move the file aside. `--dry-run` shows what would change. A JSONC
  file whose block comment never closes counts as unparseable: an
  unterminated `/*` is refused rather than silently blanked to end-of-file
  and overwritten.
- Unknown flags are errors; check spelling against `--help`.
- `--v2` refuses an existing `opencode.jsonc` and any V1 `plugin` entries;
  edit the JSONC `plugins` list by hand or keep separate V1/V2 configs.

## Sign-in and callback

**Browser never opens / callback fails.** Port `1455` must be free — Codex
CLI uses the same one, so quit it first. Check with `lsof -i :1455`
(macOS/Linux) or `netstat -ano | findstr :1455` (Windows). If the port cannot
be bound, login fails fast with `OAuth callback server failed to start on
localhost loopback port 1455`; use `Codex OAuth (Device Code)` or
`Codex OAuth (Manual URL Paste)`, which need no listener.

**Headless / SSH / containers.** With `ssh -L 1455:localhost:1455
user@remote` the loopback flows still work; otherwise use Device Code. The
Manual URL Paste method needs the complete callback URL — its `state`
parameter binds the pasted value to your login attempt.

**"Authorization session expired".** The callback window is five minutes and
starts when the listener starts. Rerun `opencode auth login` and open the
fresh URL promptly.

**Device code never completes.** The one-time code lives about 15 minutes and
the plugin polls until then; 403/404 while polling just means sign-in is not
finished. A 404 from the *start* request means the server has device code
disabled — use another method.

**Safari on macOS.** HTTPS-Only Mode blocks `http://localhost` callbacks —
use another browser, or toggle the setting in Safari > Settings > Privacy for
the login.

## Authentication and accounts

**401 Unauthorized.** Usually an expired or revoked grant — rerun
`opencode auth login`. Accounts whose recorded scope explicitly lacks
`openid`, `profile`, `email`, or `offline_access` are marked for re-auth;
unrecorded scopes stay active. Diagnostics on the 401 (`requestId`,
`cfRay`) are worth quoting when reporting.

**403 Forbidden / "Usage not included in your plan".** Check the ChatGPT
Plus/Pro subscription is active, then re-login picking the intended workspace
in the browser — workspace selection happens in the browser session, not the
CLI. `CODEX_AUTH_ACCOUNT_ID=<id>` pins a workspace for non-interactive runs.

**Token refresh failures** report one reason: `http_error` (4xx = re-login,
5xx = retry later), `invalid_response` (transient), `missing_refresh`
(re-login), or `network_error` (connectivity). Three consecutive genuine auth
failures disable the account instead of deleting credentials — a fresh login
repairs it.

**All accounts fail.** Re-auth one known-good account, inspect
`oc-codex-multi-auth status` and the flagged-accounts file beside the active
store, remove stale duplicates, then run
`codex-doctor fix=true`.

## Rate limits and retries

A rate limit means the account's 5-hour or weekly window is spent.
Options: wait for the reset (`codex-limits` shows times), add or switch
accounts (`opencode auth login`, `codex-switch`), or change model family.

When **every** account is limited, the wait-and-retry loop honors
`retryAllAccountsMaxWaitMs`; a configured `0` is bounded by a 10-minute
interactive ceiling because upstream quota blocks can stretch for days.
`CODEX_RETRY_ALL_UNBOUNDED=1` restores truly unbounded waits. The
"Waiting (… remaining)" countdown sleeps on elapsed time rather than wall
clock, so a system-clock jump neither stretches nor cancels the wait.

The quota guard polls enabled accounts (30 minutes by default) and skips
fully spent ones until their reset so rotation never draws paid Credits.
`codex-limits` applies the same check immediately.

## Models

**"Model not found".** The `--model` value must match a config key exactly,
with the `openai/` prefix. `--variant` presets and `gpt-5.5-fast` exist only
after a catalog install (`--modern`/`--full`/`--legacy`); a default
plugin-only install writes no catalog. Use `opencode debug config` to see the
merged result.

**"Model is not supported when using Codex with a ChatGPT account".**
Entitlement failure — re-login, add an entitled account, or let the default
fallback chain downgrade. Escape hatches and the full chain list are in
[Configuration](configuration.md); `CODEX_AUTH_UNSUPPORTED_MODEL_POLICY=strict`
turns substitution off.

**Retired model IDs** (`gpt-5.4-mini`, the `gpt-5.x-codex` family) still
resolve through fallback chains when typed by hand.

## Storage and concurrency

**Corrupt accounts file.** Loads and writes fail rather than silently
emptying the pool — a `CODEX_STORAGE_ERROR`. Quit all OpenCode sessions, keep
the corrupt file for diagnosis, then preview a
`backups/codex-credential-snapshot-*.json` restore with
`codex-import dryRun=true` before applying. Snapshots hold refresh tokens —
do not share them — and a token rotated since the snapshot needs a fresh
login.

**Lock contention.** `CODEX_CONFIG_LOCK_CONTENTION` means another process is
updating `openai-codex-auth-config.json`; `CODEX_STORAGE_TRANSACTION_CONTENTION`
means another holds the account-store lease. Nothing partial was applied —
retry shortly, or stop the other session. A refresh that succeeded upstream but
could not be committed to the pool is journaled in a `<accounts-file>.refresh.pending`
file beside the accounts file, so the rotated credential is applied on the next
load instead of being lost to a crash or a lost lease.

**"Multi-worktree collision detected".** Advisory only: another live process
uses the same accounts file. Refresh exchange and commits still serialize
across sessions on one host; do not delete a lock belonging to a live
process.

## OpenCode V2

- Registered but inert? Run `opencode service restart`, then add an account
  through `opencode auth login` → **OpenAI** → **Codex OAuth (Add account —
  ChatGPT Plus/Pro)**. The built-in browser method does not feed the plugin
  pool.
- `Connect a Codex multi-account OAuth method with /connect first` means no
  usable credential exists yet.
- `Codex refresh account is ambiguous` means one refresh token maps to
  several pool entries — remove duplicates (`codex_remove`) and re-login once
  per account.
- Tool names normalize to `codex_list` etc.; `/codex-accounts` and the
  **Codex accounts** palette command show the pool.

## Debugging

```bash
DEBUG_CODEX_PLUGIN=1 ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "test" --model=openai/gpt-5.5 --variant=medium
```

Add `CODEX_PLUGIN_LOG_BODIES=1` to capture raw bodies (sensitive). Logs land
in `~/.opencode/logs/codex-plugin/`; `request-*-after-transform.json` should
show `store` as `false` and `include` containing `reasoning.encrypted_content`.
Boolean env overrides are truthy only for the literal `"1"`.

## Getting help

Before filing an [issue](https://github.com/ndycode/oc-codex-multi-auth/issues),
collect `opencode --version`, the plugin version (`oc-codex-multi-auth
--version`), a redacted config, and relevant logs. `codex-diag` exports a
redacted snapshot for exactly this.

---

Next: [Configuration](configuration.md) | [FAQ](faq.md) | [Docs home](index.md)
