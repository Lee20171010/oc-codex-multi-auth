# ChatGPT plan allotments

Reference map from `plan_type` to plan name, seat weight, and monthly price, as implemented in [`lib/plan-allotment.ts`](../lib/plan-allotment.ts) and covered by `test/plan-allotment.test.ts`. Update all three together.

`plan_type` arrives from two places that agree: the `chatgpt_plan_type` claim in the OAuth access token (named via `lib/auth/plan-tier.ts`) and the `plan_type` field on `/wham/usage` (read live by `codex-limits` and the TUI).

## Normalization

`normalizePlanSlug` reduces a raw slug before matching: lowercased, a leading `chatgpt` prefix stripped, `_`/`-`/spaces folded to single spaces, and a trailing `plan` word dropped. So `team`, `chatgptteamplan`, and `ChatGPT_Team_Plan` all land on `team`.

## The map

| Accepted `plan_type` (normalized) | Plan | Weight | Multiplier | Monthly (USD) |
| --- | --- | --- | --- | --- |
| `plus` | ChatGPT Plus | 1 | `1x` | 20 |
| `team` | ChatGPT Business (old slug, still emitted) | 1 | `1x` | 25 |
| `business … standard` (e.g. `business_standard`) | ChatGPT Business Standard | 1 | `1x` | 25 |
| `business … prolite` / `pro lite` / `premium` (e.g. `self_serve_business_prolite`) | ChatGPT Business Premium | 5 | `5x` | 125 |
| `pro`, `pro 20x`, `pro 200` | ChatGPT Pro | 20 | `20x` | 200 |
| `prolite`, `pro lite` | ChatGPT Pro Lite | 5 | `5x` | 100 |
| `pro 5x`, `pro 100`, `pro legacy`, `legacy pro`, `legacy pro 5x`, `pro legacy 5x` | ChatGPT Pro (legacy $100 tier) | 5 | `5x` | 100 |
| `business` (bare) | Business workspace, seat unstated | — | — | — |
| `free` | ChatGPT Free | — | — | — |
| `go` | ChatGPT Go | — | — | — |
| `enterprise` | ChatGPT Enterprise | — | — | negotiated per contract |
| anything else | unrecognized | — | — | — |

Explicit-match notes:

- `team` is matched before the business matcher because OpenAI kept the slug while renaming the product to Business.
- `self_serve_business_prolite` is the premium Business **seat** ($125), not the personal Pro Lite tier ($100) that shares the `prolite` token — the `business` word in the slug decides.
- The six legacy spellings are the $100 Pro that predates the $200 Pro; they are matched before `pro` claims the bare word.
- A bare `business` names the workspace, not a seat, and its two seats are 5x apart, so no ratio is stated.

## The math

- The weight is OpenAI's published per-seat ratio against the 1x seat, taken from monthly price (Pro $200 vs Plus $20, marketed as 20x). It describes the *subscription*, not a measured token allowance.
- Every pool figure is a **weighted mean** over the summed weights, not a plain average: a Pro seat spent to 50% gives up twenty times what a Business Standard seat does at 50%.
- A plan with no ratio (`—` rows) counts as **one baseline seat** in the total (`DEFAULT_PLAN_WEIGHT = 1`) so it cannot remove the other accounts, and prints no `Nx` badge rather than asserting a `1x` OpenAI never published.

## Where it shows up

- **Pool status line** (`quotaStatus.mode: "overview"`; `quotaStatus.multipliers` prints the badge): `24%: #1 5x 13%, #2 20x 100% 3d, #3 1x 12%`
- **`codex-limits` / `limits` CLI**: `Plan: Pro (20x)` per account, closing with `Pool: 93% used of 81x across 11 accounts` — the `81x` is the summed weight.

Both read the same module, so the two figures cannot drift apart.

## Related

- [tools-and-cli.md](tools-and-cli.md)
- [configuration.md](configuration.md)
- [faq.md](faq.md)
