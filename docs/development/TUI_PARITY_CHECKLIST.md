# TUI Parity Checklist

Manual QA checklist for the interactive auth dashboard (`lib/ui/auth-menu.ts`, `lib/cli.ts`) and the quota status surface (`tui.ts`). Run through it before releases that touch the auth menu, account actions, or quota display — the items below mirror the live code, so a drift here is a real regression.

## Dashboard Structure

`opencode auth login` on a TTY opens the account dashboard (`showAuthMenu`); non-TTY falls back to a readline menu (`(a)dd, (f)resh, (c)heck, (d)eep, (v)erify flagged, or (q)uit`), and non-interactive mode defaults to add.

- Sections render in order: `Actions`, `Accounts`, `Danger zone`.
- Actions, in order: `Add account`, `Check quotas`, `Deep check accounts`, `Verify flagged accounts` (suffixed with the flagged count when non-zero), `Start fresh`, then `Delete all accounts` under Danger zone.
- Each account row shows: numeric index, email (masked when `maskEmail`), `workspace:<label>`, `id:`/`seat:` suffixes when present, state badge, and a `used <relative time>` hint.

## Account Badges

`statusBadge` renders `[active]`/`[ok]` (success), `[rate-limited]`/`[cooldown]` (warning), `[flagged]`/`[disabled]`/`[error]` (danger); `[current]` marks the serving account. V2 styling (`codexTuiV2`, default on) paints the same badges through `formatUiBadge` instead of raw ANSI.

## Navigation

- Up/Down moves selection; Enter confirms; Esc backs out; Ctrl+C exits without corrupting terminal state; cursor visibility is restored on exit.
- Selecting an account opens the detail menu: `Back`, `Enable/Disable account` (label flips with state), `Refresh account`, `Delete this account`.
- Destructive actions confirm first: `Delete all accounts` and `Start fresh` both require typing `DELETE` at the `Type DELETE to confirm removing all accounts:` prompt.

## Health / Quota Checks

- `Check quotas` iterates enabled accounts printing `[i/N] <label>: <status>` lines (`OK`, `OK (cached access)`, `OK (Codex CLI cache)`, `DISABLED`, `ERROR (<reason>)`), then a summary count line.
- `Deep check accounts` performs stricter per-account validation with richer diagnostic output on the same `[i/N]` progress format.
- `Verify flagged accounts` re-probes flagged entries and prints `[i/N] <label>: RESTORED` or `STILL FLAGGED (<reason>)`.

## Disabled / Flagged Semantics

- Disabled accounts stay visible in the dashboard but are skipped by rotation and by health-check iteration.
- Accounts whose refresh token is rejected move to flagged storage beside the active pool file; `Verify flagged accounts` restores ones that refresh successfully.
- Deleting clears both the active pool and flagged state for that account.

## Visual / Privacy Controls

- `codexTuiV2` / `CODEX_TUI_V2` (default on) selects the V2-styled menu; `0`/`false` falls back to the legacy look.
- `codexTuiColorProfile`: `truecolor` (default) / `ansi256` / `ansi16`.
- `codexTuiGlyphMode`: `ascii` (default) / `unicode` / `auto`.
- `maskEmail: true` / `CODEX_TUI_MASK_EMAIL=1` masks the account email on every human-facing surface — auth menu, `codex-list`/`codex-status`/`codex-limits`/`codex-health`/`codex-dashboard`, runtime/log messages, standalone CLI login menu, and the prompt quota line. A user-defined account label wins over the email where one exists. `maskEmailInQuotaDetails: true` / `CODEX_TUI_MASK_EMAIL_DETAILS=1` additionally masks the quota **details** view. Shared helpers live in `lib/account-display.ts` — new surfaces must route through them.

## Quota Status Line

- `quotaStatus.mode` selects `active`, `overview`, `resets`, or a list rotated every `rotateMs`; empty screens are skipped, `resets` appears only at `resetsMinUsedPercent` (default 100) weighted usage.
- The prompt slot width is measured from the rendered row (`measureStatusSlot`), so an open sidebar shrinks the line correctly; `rows` (1–4, default 1) is a ceiling, not a measurement.
- Quota percentages use the shared `quotaDisplay` free/used wording across the TUI, `codex-limits`, the standalone CLI, and notifications.

## Release Smoke

- [ ] `npm run typecheck` and `npm test` pass
- [ ] Login → dashboard appears with Actions / Accounts / Danger zone
- [ ] Add account completes an OAuth round trip into the pool
- [ ] Check quotas prints `[i/N]` lines and a summary
- [ ] Disable account removes it from rotation candidates
- [ ] Verify flagged restores a recoverable account
- [ ] Delete-all requires typed `DELETE` and clears active + flagged pools
- [ ] `maskEmail` on → no raw email anywhere
- [ ] `codexTuiV2` off → legacy menu still works
