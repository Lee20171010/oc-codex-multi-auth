# Test Suite

Vitest suites for `oc-codex-multi-auth`. This file describes the shape of the suite — for the live inventory use `find test -name '*.test.ts' | sort`; committed counts go stale.

## Layout

```text
test/
├── AGENTS.md                 # agent-facing conventions
├── README.md                 # this file
├── *.test.ts                 # unit + integration suites, named after the module under test
├── helpers/                  # shared helpers (e.g. the port-1455 lock)
├── chaos/                    # fault injection and adverse-condition stress
├── contracts/                # upstream wire-shape contracts (chat, SSE, token)
├── property/                 # fast-check property tests + shared setup
└── global-setup.ts           # teardown for the minted test home
```

Naming convention: a suite is named after what it covers — `lib/storage/keychain.ts` → `storage-keychain.test.ts`, `lib/tools/codex-pool.ts` → `tools-codex-pool.test.ts`. Follow this when adding coverage.

## Running

```bash
npm test                          # whole suite once (vitest run)
npm run test:watch                # watch mode
npm run test:coverage             # coverage + threshold gate
npm test -- <substring>           # targeted subset, e.g. `npm test -- storage`
npx vitest run test/doc-parity.test.ts   # one file
```

Vitest globals are on (`describe`, `it`, `expect`); `testTimeout`/`hookTimeout` are 15 s. Suites import from source (`lib/`, `index.ts`, `tui.ts`) — never `dist/`.

## Property seeds

`property/setup.ts` (a vitest `setupFiles` entry) reads `FC_SEED`:

- `FC_SEED=<integer>` pins the fast-check seed for the whole run — replay a failing case exactly (`FC_SEED=12345 npx vitest run test/property`).
- Unset/empty → random per run; a non-integer fails at setup. `numRuns` is 100.

## Coverage floors (`vitest.config.ts`)

V8 coverage over `lib/**/*.ts`, `index.ts`, `tui.ts`. `perFile: true` makes every threshold — including the global one — apply file by file, so the global floor is 0 (no instrumented file may be entirely unmeasured) and the real gates are per-directory:

| Glob | stmts | branches | funcs | lines |
|------|------:|---------:|------:|------:|
| `lib/*.ts` | 64 | 58 | 60 | 68 |
| `lib/accounts/**` | 41 | 18 | 76 | 43 |
| `lib/auth/**` | 70 | 68 | 80 | 75 |
| `lib/prompts/**` | 84 | 60 | 80 | 86 |
| `lib/recovery/**` | 91 | 84 | 91 | 95 |
| `lib/request/**` | 84 | 78 | 88 | 90 |
| `lib/storage/**` | 45 | 48 | 52 | 45 |
| `lib/tools/**` | 36 | 33 | 54 | 36 |
| `index.ts` | 69 | 50 | 70 | 70 |
| `tui.ts` | 25 | 30 | 22 | 26 |
| `lib/ui/**` | 0 | 0 | 0 | 0 |
| `lib/recovery.ts`, `lib/storage.ts` (barrels) | 25 | 15 | 25 | 25 |

The `lib/ui/**` floor is intentionally 0 (interactive widgets can't run headless) and the barrel files sit at 25 — both stay instrumented so the gap is visible and coverage can only trend up.

## Real port 1455

Two suites bind the actual OAuth callback port — `oauth-server.integration.test.ts` and `chaos/auth-faults.test.ts`. Vitest runs files in parallel, so both serialize on `helpers/oauth-port-lock.ts` (`acquireOAuthPortLock()`, a lock dir under `tmpdir()`). Any new suite that binds 1455 must take the same lock; never hardcode a different port.

## Isolated HOME (minted-home guard)

`vitest.config.ts` `test.env` points `HOME`/`USERPROFILE`/`OC_CODEX_TEST_HOME` at a `mkdtemp` dir **before any module loads** (several modules capture `homedir()` at import time) and forces `CODEX_KEYCHAIN=0` so fixture writes can't reach the real OS keychain. Hand a home in via `OC_CODEX_TEST_HOME` to reuse one.

Two guards make that safe:

- `test/global-setup.ts` removes the throwaway home after the run — but only when the config minted it (`OC_CODEX_TEST_HOME_OWNED=1`), the path sits under `tmpdir()`, and it carries the `oc-codex-multi-auth-test-home-` prefix.
- `lib/storage/test-home-guard.ts` throws `TEST_HOME_ESCAPE` on any account-storage write that would land inside the developer's real home during a vitest run, regardless of `$HOME`.

## Adding tests

1. Name the file after the module/behavior under the existing convention.
2. Keep tests isolated; no shared mutable state, no wall-clock timing (use fake timers or injected clocks), no real network.
3. Don't rely on `dist/`; don't skip tests without justification.
4. Changed a documented contract (tool count, config key, storage path, catalog size)? Update `doc-parity.test.ts` and the affected docs in the same change.
5. Run `npm test` and `npm run typecheck`.

## Example configs

`config/` holds working examples: `opencode-modern.json` (variant-based), `opencode-legacy.json` (explicit entries), `minimal-opencode.json` (minimal).
