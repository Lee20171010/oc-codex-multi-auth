# Tools and CLI

Reference for the **24** OpenCode `codex-*` tools and the standalone `oc-codex-multi-auth` bin commands.

Tools run inside OpenCode (agent/tool surface). Several diagnostics also run as a **direct CLI** with no agent loop and no model token cost.

---

## OpenCode tools (24)

Registered from **24 per-file factories** under `lib/tools/` via `createToolRegistry` in `lib/tools/index.ts`.

### Setup and guidance

| Tool | Purpose |
|------|---------|
| `codex-setup` | Beginner checklist / optional wizard for first-run readiness |
| `codex-help` | Topic-oriented help for plugin commands and workflows |
| `codex-next` | Suggested next action when stuck |

### Daily account use

| Tool | Purpose |
|------|---------|
| `codex-list` | List saved accounts, active index, tags/labels |
| `codex-switch` | Switch the active account (interactive picker when index omitted) |
| `codex-warm` | Open every enabled account's usage window (one minimal request each) |
| `codex-status` | Active account, model family, routing / pool mode |
| `codex-limits` | Live 5-hour and weekly Codex usage per account, plus what the pool holds between them (fetched via `fetchCodexUsage`) |
| `codex-reset` | Inspect or redeem banked rate-limit reset credit |
| `codex-dashboard` | Read-only snapshot report of account eligibility, retry budgets, and refresh queue health |

### Account metadata and routing

| Tool | Purpose |
|------|---------|
| `codex-label` | Set a stable display label for an account |
| `codex-tag` | Set or clear account tags for grouping/filtering |
| `codex-note` | Attach a private note to an account |
| `codex-pool` | Manage model account pools and `preferred`/`strict` routing modes |
| `codex-remove` | Remove a saved account (confirm required) |
| `codex-refresh` | Manually refresh OAuth tokens for all accounts |

### Diagnostics and resilience

| Tool | Purpose |
|------|---------|
| `codex-health` | Live health verification across accounts by refreshing each refresh token (makes network calls) |
| `codex-metrics` | Runtime counters and request metrics |
| `codex-doctor` | Beginner-friendly diagnostics with fix hints |
| `codex-diag` | Redacted diagnostic snapshot export |
| `codex-diff` | Diff account/config snapshots |

### Backup and secrets

| Tool | Purpose |
|------|---------|
| `codex-export` | Back up account storage |
| `codex-import` | Restore accounts (supports dry-run) |
| `codex-keychain` | Report credential backend; migrate/rollback OS keychain |

### Common tool examples

```text
codex-list
codex-switch index=2
codex-warm
codex-status
codex-limits
codex-reset
codex-pool
codex-pool action="set" model="gpt-5.6-sol" accounts=[7,8]
codex-pool action="add" model="gpt-5.6-sol" accounts=[9]
codex-pool action="remove" model="gpt-5.6-sol" accounts=[7]
codex-pool action="set-mode" model="gpt-5.6-sol" poolMode="strict"
codex-pool action="clear" model="gpt-5.6-sol"
codex-label index=2 label="plus-1"
codex-tag index=2 tags="work,team-a"
codex-note index=2 note="weekend only"
codex-doctor
codex-health
codex-export
codex-import path="~/backup.json" dryRun=true
codex-keychain
```

Many tools accept structured output (`format="json"`) and opt-in sensitive fields (`includeSensitive=true`). Prefer labels over emails; enable `maskEmail` in plugin config for shared screens.

### Tool arguments matrix

Account indices are **1-based**. Destructive tools require an explicit confirm flag.

| Tool | Args |
|------|------|
| `codex-setup` | `wizard?` (bool), menu-driven setup when terminal supports it |
| `codex-help` | `topic?` (`setup`, `switch`, `pools`, `health`, `backup`, `dashboard`) |
| `codex-next` | `format?` (`text` \| `json`) |
| `codex-list` | `tag?`, `format?`, `includeSensitive?` |
| `codex-switch` | `index?`, omit for interactive picker when supported |
| `codex-warm` | `format?` (`text` \| `json`) |
| `codex-status` | `format?`, `includeSensitive?` |
| `codex-limits` | `format?`, `includeSensitive?` |
| `codex-reset` | `action?` (`status` \| `consume`), `creditId?`, `confirm?` (required true to redeem), `dryRun?`, `account?` (1-based), `format?`, `includeSensitive?` |
| `codex-dashboard` | `format?`, `includeSensitive?` |
| `codex-label` | `index?`, `label` (empty string clears) |
| `codex-tag` | `index?`, `tags` (CSV; empty clears) |
| `codex-note` | `index?`, `note` (empty clears) |
| `codex-pool` | `action?` (`status` \| `set` \| `add` \| `remove` \| `clear` \| `set-mode`), `model?`, `accounts?` (1-based number array), `poolMode?` (`preferred` \| `strict`), `dryRun?`, `format?`, `includeSensitive?` |
| `codex-remove` | `index?`, `confirm?` (must be `true` to delete, omitted or false is a no-op that prints guidance) |
| `codex-refresh` | _(none)_ |
| `codex-health` | `format?`, `includeSensitive?` |
| `codex-metrics` | `format?` |
| `codex-doctor` | `deep?`, `fix?` (safe automated fixes), `format?` |
| `codex-diag` | _(none)_, redacted snapshot only |
| `codex-diff` | `left`, `right` (paths), `section?` (`accounts` \| `config` \| `both`) |
| `codex-export` | `path?`, `force?`, `timestamped?` (default true when path omitted) |
| `codex-import` | `path`, `dryRun?` |
| `codex-keychain` | `command?` (`status` \| `migrate` \| `rollback`), `confirm?` (required for rollback when a live JSON file exists) |

### Operational notes

- **`codex-warm` / CLI `warm`.** One lightweight request per enabled account to open usage windows. CLI exits non-zero if any account fails; disabled accounts are skipped.
- **`codex-reset`.** Banked WHAM/rate-limit reset credits. `action="consume"` is irreversible and requires `confirm=true` (use `dryRun=true` to preview).
- **`codex-pool`.** Accepts 1-based numbers but persists **stable account IDs** in `~/.opencode/openai-codex-auth-config.json`. Restart OpenCode after mutations.
- **Tool `codex-health` vs CLI `health`.** The tool refreshes every account's token against the auth server, so it makes real network calls and reports the live result. The CLI `health` command scans the local JSON storage and counts accounts where `enabled && hasRefreshToken`, with no network calls.
- **Standalone default storage.** CLI commands read the **global** accounts file unless `--config-path` points at a project pool. In-session tools use the active per-project path when `perProjectAccounts` is true.
- **Keychain routing.** `status`, `list`, `health`, and `dashboard` parse the JSON accounts file directly. `warm` and `limits` load the plugin storage runtime, so they honor `CODEX_KEYCHAIN=1`. `doctor` reads the JSON file directly unless `--fix` is passed, and `--fix` repairs through the storage runtime (an explicit `--config-path` forces keychain off for the repair).

---

## Standalone CLI

Bin: `oc-codex-multi-auth` (also via `npx -y oc-codex-multi-auth@latest …`).

### Commands

| Command | Role |
|---------|------|
| `install` (default) | Install/update OpenCode config and TUI plugin entry |
| `doctor` | Local account/config diagnostics |
| `status` | Account/config status |
| `list` | List configured accounts |
| `limits` | 5-hour and weekly quota usage per account from the plugin's last readings (`--refresh` reads live), plus the pool total |
| `dashboard` | Prints guidance (does not start a full dashboard server) |
| `health` | Local token/account health summary |
| `diag` | Alias for `doctor --deep` |
| `warm` | Open every enabled account's usage window (same idea as `codex-warm`) |

```bash
oc-codex-multi-auth                 # register plugin entries; preserve provider.openai
oc-codex-multi-auth install
oc-codex-multi-auth update          # cache-only; does not change config
oc-codex-multi-auth doctor
oc-codex-multi-auth status
oc-codex-multi-auth list
oc-codex-multi-auth limits
oc-codex-multi-auth dashboard
oc-codex-multi-auth health
oc-codex-multi-auth diag
oc-codex-multi-auth warm
```

`warm` exits non-zero if any account failed. Disabled accounts are skipped. `limits` exits 1 when it cannot load storage or any account it had to read live failed.

### What `limits` reports

Each account is listed with its windows, the plan it is on, and what one of
that plan's seats is worth beside the others. The report closes with what the
pool holds between them:

```text
Storage:  /home/me/.opencode/oc-codex-multi-auth-accounts.json
Accounts: 11
Sort:     reset (asc)
Readings: the plugin's last readings, taken 2026-09-27 13:17:22 (14m ago); --refresh reads every account live

- [0] work@example.com id:c487c4
  Weekly limit:     100% used
  Renews:           2026-09-30 15:14:08 (in 3d 22h)
  Plan:             Pro (20x)
  Resets:           1 applicable now

- [1] team@example.com id:989a40
  Business account: Example Corp
  Weekly limit:     0% used
  Renews:           not started (the window opens on first use)
  Plan:             Business Premium (5x)
  Read:             2026-09-27 13:31:05 (just now), live

Pool:     93% used of 81x across 11 accounts
```

`limits` does not ask ChatGPT for anything by default. The plugin already
polls every account's usage for the [pool status line](configuration.md#pool-wide-quota-status)
and keeps its last readings in `oc-codex-multi-auth-tui-quota-overview.json`
in the OpenCode state directory (`$OPENCODE_STATE_DIR`, else
`$XDG_STATE_HOME/opencode` or `~/.local/state/opencode`), and the request
path records its newer reading of the account serving requests beside it.
`limits` reports those, which keeps it instant on a large pool and spares the
pool a burst of usage requests. `Readings:` says when they were taken; an
account read at a different moment carries its own `Read:` line.

An account the plugin holds no reading for (added since its last poll, or a
pool it has not polled) is read live, and so is every account when there is no
snapshot at all. `--refresh` reads every account live. A live read of the whole
pool is written back as the plugin's snapshot, so the status line and the next
`limits` start from it; a `--tag` subset, or a snapshot that describes a
different pool, is never written. A reading from the snapshot has no credit
balance, and its reset-credit line shows only the redeemable count the snapshot
keeps. `--json` marks each account's `source` (`cache` or `live`) and `readAt`,
and the whole report's `readings`.

Every value in an account's block starts in one column, shared by all
accounts, and the header and pool total share another.

A Business seat names the workspace it belongs to, as its owner titled it in
ChatGPT. The name comes from the Codex backend's account list
(`/wham/accounts/check`), which one request per login answers for every
workspace that login is a member of. Names are remembered in
`oc-codex-multi-auth-workspace-names.json` beside the quota snapshot, so an
account is asked about only the first time it is seen or under `--refresh`. A
personal account has no workspace name and gets no such line, and a failed or
slow lookup (it gives up after 5 seconds) only drops the line. `--json` carries
it as `workspaceName`.

Each window's renewal is printed on the line below it as a local timestamp and
a countdown. Seconds are shown only when the backend reported an exact reset
time. A window that has not been drawn from since it last reset reports a
reset of "now plus the window length" that moves forward on every read, so it
is shown as `not started` instead of a date nothing is scheduled for. A renewal
that has already passed since a cached reading was taken says so.

On a terminal the percentage is coloured by how much of the window is used:
green below 60%, yellow from 60%, orange from 80%, red from 99%. The colour
follows consumption whichever way `quotaDisplay` words the number. `NO_COLOR`
turns it off and `FORCE_COLOR` turns it on without a terminal.

Accounts are listed by account number. `--sort` changes the order:

| Flag | Order |
| --- | --- |
| `--sort account` | account number (default) |
| `--sort usage` | least used first |
| `--sort reset` | earliest renewal first |
| `--asc` / `--desc` | direction for any of the above (default `--asc`) |

Both are judged by the account's governing window, the one with the least
headroom, since that is the one that stops a request; between two equally spent
windows the later reset governs, because the account is usable only once both
have renewed. An account with no known value for the chosen key (a failed
fetch, a window that has not started) sorts last in either direction. To make an order the
default, set `limitsSort` in `~/.opencode/openai-codex-auth-config.json`; the
flags still override each half:

```json
{
  "limitsSort": { "by": "reset", "direction": "asc" }
}
```

The ratio is appended only when the plan publishes one, so Free, Go and
Enterprise carry no badge rather than asserting a `1x` baseline OpenAI never
set. They still weigh one baseline seat in the total.

`81x` is what those accounts add up to in 1x seats, and the percentage is a
**weighted** mean taken over exactly that sum, not a plain average: a spent Pro
seat costs the pool twenty times what a spent Plus seat does. Each account is
judged by whichever of its windows has the least headroom, since that is the
one that would stop a request. An account whose usage could not be read is left
out of both figures rather than counted as full or as empty. Percentages follow
[`quotaDisplay`](configuration.md#quota-percentage-display), so the same pool
reads `7% left` under the default wording. See
[plan allotments](plan-allotments.md) for the per-seat ratios and their source.

`--json` carries the same figures as data, with both percentages stated so a
consumer never has to know which way `quotaDisplay` was pointing:

```json
{
  "pool": {
    "leftPercent": 7,
    "usedPercent": 93,
    "allotment": 81,
    "countedAccounts": 11
  },
  "poolSummary": "93% used of 81x across 11 accounts",
  "accounts": [
    { "planType": "pro", "planMultiplier": "20x" }
  ]
}
```

`pool` is `null` when no account reported a readable window. The `codex-limits`
tool renders the same `Pool:` line and carries the same `pool` object in
`format="json"`.

A successful warm request can clear unchanged cooldown state, the responding
model's own rate-limit marker, and that family's blanket marker, not other
models' or other families' markers. If the account
already has a subscription-quota block, warm checks live usage before clearing
it; a successful response alone can be paid for with Credits and does not prove
that subscription quota recovered. A failed usage check leaves the quota block
in place but still clears the unchanged model and cooldown state, and the
failure is reported separately. Cleanup failures are reported separately from
the warm result, and newer concurrent block writes are preserved.

### Installer flags

| Flag | Effect |
|------|--------|
| (default) / `--plugin-only` | Register plugin/TUI entries without changing `provider.openai` |
| `--modern` | Install compact modern config (10 bases + variants) |
| `--full` | Compact bases plus explicit selector entries |
| `--legacy` | Explicit-only catalog (53 entries) |
| `--dry-run` | Show changed config paths without values or writes |
| `--no-cache-clear` | Skip clearing OpenCode plugin cache |

Choose only one of `--plugin-only`, `--modern`, `--full`, or `--legacy`. Use `update [--dry-run]` when refreshing the package. It clears the managed OpenCode cache without reading or writing `opencode.json` or `tui.json`.

### Standalone options

| Flag | Effect |
|------|--------|
| `--json` | Machine-readable JSON output |
| `--include-sensitive` | Include sensitive identity fields in JSON where applicable |
| `--deep` | Deeper diagnostics (used with `doctor`; implied by `diag`) |
| `--fix` | With `doctor`, refresh enabled accounts and clear stale cooldown, rate-limit, and quota-exhaustion markers only after successful verification. A cleared quota stamp re-establishes itself on the next quota 429 or usage poll. Exit nonzero if any repair fails, or if the storage file cannot be read (unparseable, wrong shape, or a newer schema version). |
| `--tag <tag>` | Filter accounts by tag when listing |
| `--config-path <path>` | Point at a specific accounts storage path |
| `--help` / `-h` | Print usage |

Examples:

```bash
oc-codex-multi-auth status --json
oc-codex-multi-auth list --tag work
oc-codex-multi-auth warm --json
oc-codex-multi-auth doctor --deep
oc-codex-multi-auth doctor --fix --config-path ./accounts.json
npx -y oc-codex-multi-auth@latest warm
```

For `doctor --fix`, an explicit `--config-path` repairs only the selected JSON pool and bypasses keychain routing. Without `--config-path`, repair preserves enabled keychain routing, and a corrupt default storage file fails with a parse error instead of reporting an empty pool.

---

## Related runtime concepts

- **Rotation.** `rotationStrategy` is `hybrid` (default), `sticky`, or `round-robin`, set in `~/.opencode/openai-codex-auth-config.json` or `CODEX_AUTH_ROTATION_STRATEGY`.
- **Model pools.** `modelAccountPools` + `codex-pool` route effective model IDs through specific accounts. `preferred` mode falls back to the general pool. `strict` mode never leaves its configured pool.
- **Per-project accounts.** Default `true` under `~/.opencode/projects/<project-key>/`.
- **Stateless Codex contract:** `store: false` and `reasoning.encrypted_content`.
- **GPT-5.6.** Responses-lite path; client identity defaults to the host identity (`opencode`) for 5.6.

See also:

- [architecture.md](architecture.md)
- [getting-started.md](getting-started.md)
- [configuration.md](configuration.md)
- [faq.md](faq.md)
