# ChatGPT plan allotments

Every account the plugin holds reports a `plan_type`, and those plans do not
carry the same amount of Codex capacity. This page is the reference map from
that slug to the plan's name, its allotment relative to a 1x seat, and the
per-seat monthly price OpenAI lists it at.

The map lives in code at [`lib/plan-allotment.ts`](../lib/plan-allotment.ts)
and is covered by `test/plan-allotment.test.ts`. Update both together.

## Where `plan_type` comes from

Two places, which agree:

- the `chatgpt_plan_type` claim inside the OAuth access token, read by
  `lib/auth/plan-tier.ts` and stored with the account, and
- the `plan_type` field on the `/wham/usage` response, read live by
  `codex-limits` and the TUI.

`lib/auth/plan-tier.ts` turns the slug into the subscription name OpenAI shows.
`lib/plan-allotment.ts` turns the same slug into the allotment. The two are
deliberately separate: naming a plan needs the token decoder, and weighting one
needs nothing at all, so the status line can weight a pool without pulling JWT
handling into its render path.

## The map

| `plan_type` | Plan | Allotment | Monthly (USD) |
| --- | --- | --- | --- |
| `free` | ChatGPT Free | — | 0 |
| `go` | ChatGPT Go | — | — |
| `plus` | ChatGPT Plus | 1x | 20 |
| `team` | ChatGPT Business (still emitted under the old name) | 1x | 25 |
| `business` | ChatGPT Business, seat unstated | — | — |
| `business_standard` | ChatGPT Business Standard | 1x | 25 |
| `self_serve_business_prolite` | ChatGPT Business Premium | 5x | 125 |
| `prolite` | ChatGPT Pro Lite | 5x | 100 |
| `pro` | ChatGPT Pro | 20x | 200 |
| `pro 5x`, `pro 100`, `pro legacy`, `legacy pro`, `legacy pro 5x`, `pro legacy 5x` | ChatGPT Pro (legacy $100) | 5x | 100 |
| `enterprise` | ChatGPT Enterprise | — | negotiated |

Three entries are not derivable from their text and are matched explicitly:

- **`team` is Business.** OpenAI renamed the product and kept the slug.
- **`self_serve_business_prolite` is the premium Business *seat*,** not the
  personal Pro Lite tier that shares the `prolite` token. They are priced
  differently ($125 against $100), so the `business` qualifier decides.
- **A bare `business` names the workspace, not the seat.** The two seats inside
  it are 5x apart, so no ratio can be stated for it.

An unrecognized slug states no ratio rather than guessing one.

## What the allotment is

The published per-seat ratio against the 1x Plus / Business Standard seat,
taken from the monthly price: Pro is $200 against $20 and is marketed as 20x.
It describes the *subscription*, which is the only ratio OpenAI states — not a
measured token allowance.

## What uses it

A pool of mixed plans has no single "percent used": a Pro seat spent to 50% has
given up twenty times the capacity a Business Standard seat does at 50%, so
every pool figure in this project is a mean weighted by these allotments rather
than a plain average.

A plan that states no ratio is weighted as one baseline seat. That
under-weights it, which understates one account; weighting it higher would let
a plan the code failed to recognize dominate the figure the whole pool is
judged by.

**The pool-wide prompt status line** (`quotaStatus.mode: "overview"`, see
[configuration](configuration.md#pool-wide-quota-status)). Turn
`quotaStatus.multipliers` on to print the badge beside each account:

```text
24%: #1 5x 13%, #2 20x 100% 3d, #3 1x 12%
```

**`codex-limits` and the standalone `limits` CLI**, which name the ratio beside
each plan and close with what the pool holds between them:

```text
  Plan: Pro (20x)
  ...
Pool: 93% used of 81x across 11 accounts
```

Both surfaces take the same weighting from the same module, so the figure
`limits` prints and the figure the status line shows cannot drift apart.

## Keeping it current

OpenAI changes plans and prices. When that happens, update
`lib/plan-allotment.ts`, this table, and `test/plan-allotment.test.ts` in one
commit. The same map is mirrored outside this repository in DreamHost's
`ai-api-usage-tracker` (`src/plan-tier.ts`, `web/src/planTier.ts`, and
`extension/src/plan/codex/labels.ts`), which is where these figures were taken
from; that project keeps its three copies in sync with parity tests.
