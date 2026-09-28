# TEST KNOWLEDGE BASE

## OVERVIEW

Vitest suites covering the OAuth flow, request transforms, response handling,
model catalog, rotation logic, storage, tools/CLI, TUI, and recovery.

The suite is large and evolves frequently. Use the current test tree and local
commands as the source of truth instead of hard-coded totals or committed file
lists. As of this writing the suite is 159 test files: 141 top-level plus
`chaos/` (9), `property/` (6), and `contracts/` (3).

```bash
find test -name '*.test.ts' | sort     # current inventory
npm test -- <substring>                # target a subset
```

## STRUCTURE

```text
test/
├── AGENTS.md                 # this file
├── README.md                 # human-facing suite guide
├── *.test.ts                 # unit + integration suites, named after the module under test
├── chaos/                    # fault injection and adverse-condition stress
├── contracts/                # upstream wire-shape contracts (chat, SSE, token)
└── property/                 # fast-check property tests + shared helpers
```

Naming convention: a suite is named after what it covers, so
`lib/storage/keychain.ts` → `storage-keychain.test.ts`, and
`lib/tools/codex-pool.ts` → `tools-codex-pool.test.ts`. Follow this when adding
coverage.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| OAuth flow | `auth.test.ts`, `login-runner.test.ts`, `device-code.test.ts` | PKCE, JWT decoding, browser/device/manual login |
| OAuth server | `oauth-server.integration.test.ts`, `server.unit.test.ts` | binds port 1455 |
| Token utils | `token-utils.test.ts` | validation, parsing, refresh skew |
| Request transforms | `request-transformer.test.ts`, `input-utils.test.ts` | model normalization, stateless filtering |
| Fetch pipeline | `fetch-helpers.test.ts` | URL rewrite, headers, error mapping, fallback |
| Responses-lite | `responses-lite.test.ts`, `gpt56-sol-wire-parity.test.ts` | GPT-5.6 body reshape + wire parity |
| SSE handling | `response-handler.test.ts` | stream parsing, empty-response detection |
| Retry / backoff | `retry-budget.test.ts`, `rate-limit-backoff.test.ts` | bounded retry classes |
| Model catalog | `model-map.test.ts`, `gpt5{4,5,6}-*.test.ts` | normalization and family defaults |
| Rotation logic | `rotation*.test.ts`, `refresh-queue.test.ts` | selection, strategies, refresh serialization |
| Health checks | `health.test.ts`, `parallel-probe.test.ts` | scoring and concurrent probes |
| Circuit breaker | `circuit-breaker*.test.ts` | failure isolation and wiring |
| Storage | `storage*.test.ts`, `paths.test.ts`, `credential-clobber.test.ts` | V3 format, migration, per-project paths, keychain |
| Model pools | `model-pool-config.test.ts`, `tools-codex-pool.test.ts` | `modelAccountPools` resolution and mutation |
| Tools + registry | `index.test.ts`, `tools-codex-*.test.ts` | per-tool behavior and registry wiring |
| Standalone CLI | `standalone-cli.test.ts`, `cli.test.ts`, `install-oc-codex-multi-auth.test.ts` | bin commands and installer |
| TUI quota | `tui-*.test.ts` | prompt status, shared cache, refresh events |
| UI helpers | `ui-*.test.ts`, `account-display.test.ts`, `beginner-ui.test.ts` | formatting, theme, no-color, checklists |
| Recovery | `recovery*.test.ts` | session recovery and auto-resume |
| Docs parity | `doc-parity.test.ts` | docs/config/tool-registry/link/version drift |
| Property tests | `property/` | fast-check randomized invariants |
| Contracts | `contracts/` | upstream wire shapes |
| Chaos | `chaos/` | fault injection and stress |

## CONVENTIONS

- Vitest globals are enabled (`describe`, `it`, `expect`).
- Coverage thresholds are enforced by `vitest.config.ts`: an 80% global floor
  plus per-directory `perFile` floors, with deliberately low floors for the
  terminal-UI and pure-barrel surfaces.
- Lint rules are relaxed for tests (see `eslint.config.js`).
- Property tests use fast-check for randomized testing; `FC_SEED=<integer>`
  replays a failing run with a fixed seed.

## ANTI-PATTERNS

- Avoid hardcoding ports other than 1455 for OAuth server tests.
- Do not rely on `dist/` in tests; import from source.
- Do not skip tests without justification.
- Do not assert on wall-clock timing; use fake timers or injected clocks.
- Do not commit an exhaustive test-file list into docs. It goes stale. Point at
  `find test -name '*.test.ts'` instead.
- When changing a documented contract (tool count, config key, storage path,
  catalog size), update `doc-parity.test.ts` and the affected docs in the same
  change.
