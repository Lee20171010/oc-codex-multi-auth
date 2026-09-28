# TEST KNOWLEDGE BASE

Vitest suites covering the OAuth flow, request transforms, response handling,
model catalog, rotation, storage, tools/CLI, TUI, and recovery.

The suite is large and evolves. Use the live tree, not committed counts — as of
this writing it is 170 test files: 152 top-level plus `chaos/` (9),
`property/` (6), and `contracts/` (3).

```bash
find test -name '*.test.ts' | sort     # current inventory
npx vitest run test/<name>.test.ts     # one suite
npm test -- <substring>                # filter by file name
```

## STRUCTURE

```text
test/
├── AGENTS.md / README.md     # this file + human-facing suite guide
├── *.test.ts                 # unit + integration suites, named after the module under test
├── chaos/                    # fault injection and adverse-condition stress
├── contracts/                # upstream wire-shape contracts (chat, SSE, token) + sanitized fixtures/
├── property/                 # fast-check property tests + shared helpers + setup.ts (vitest setupFiles)
├── helpers/                  # shared helpers (oauth-port-lock.ts — real-port mutex)
├── fixtures/                 # storage fixtures (v2/v3 account files)
└── support/                  # non-test utilities (wait-for-file.ts)
```

Naming: a suite is named after what it covers — `lib/storage/keychain.ts` →
`storage-keychain.test.ts`, `lib/tools/codex-pool.ts` →
`tools-codex-pool.test.ts`.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| OAuth flow | `auth.test.ts`, `login-runner.test.ts`, `device-code.test.ts`, `loopback-flow.test.ts` | PKCE, JWT decode, browser/device/manual login, listener lifecycle |
| OAuth server | `oauth-server.integration.test.ts`, `server.unit.test.ts` | real port-1455 bind (integration); mocked `http.createServer` (unit) |
| Request pipeline | `request-transformer.test.ts`, `input-utils.test.ts`, `fetch-helpers.test.ts`, `response-handler.test.ts`, `responses-lite.test.ts`, `retry-budget.test.ts`, `rate-limit-backoff.test.ts` | transforms, headers, SSE, retries |
| Model catalog | `model-map.test.ts`, `gpt54-models.test.ts`, `gpt55-release.test.ts`, `gpt56-*.test.ts`, `gpt6-*.test.ts` | normalization + family defaults + wire parity |
| Rotation/accounts | `rotation*.test.ts`, `accounts*.test.ts`, `refresh-queue.test.ts`, `parallel-probe*.test.ts`, `health.test.ts` | selection, strategies, probes, refresh serialization |
| Storage | `storage*.test.ts`, `paths.test.ts`, `credential-clobber.test.ts`, `refresh-coordination.test.ts` | V3 format, migration, keychain, locks, atomic writes |
| Tools + registry | `tools-*.test.ts`, `index.test.ts`, `tools-registry.test.ts` | per-tool behavior and registry wiring |
| Standalone CLI / installer | `standalone-cli.test.ts`, `cli.test.ts`, `install-oc-codex-multi-auth.test.ts`, `installer-jsonc.test.ts` | bin commands and config merge |
| TUI / UI | `tui-*.test.ts`, `ui-*.test.ts`, `account-display.test.ts`, `beginner-ui.test.ts` | quota status, slots, theme, menus |
| V2 adapter | `opencode-v2*.test.ts` | provider reroute, aisdk hooks, status RPC, TUI slots |
| Recovery | `recovery*.test.ts` | session recovery and auto-resume |
| Config | `config*.test.ts`, `schemas*.test.ts`, `plugin-config.test.ts` | env overrides, stat-gate, hot reload |
| Docs drift | `doc-parity.test.ts` | docs/config/tool-registry/link/version parity — fix docs, not this test |

## CONVENTIONS

- Vitest globals on (`describe`, `it`, `expect`); lint rules relaxed for tests.
- `vitest.config.ts` `test.env` points `HOME`/`USERPROFILE` at a per-run
  `mkdtemp` home (cleaned up by `test/global-setup.ts`) so suites can write real
  account storage without touching the developer's credentials; it also forces
  `CODEX_KEYCHAIN: '0'` — keychain tests opt in per test via `_setBackendForTests`.
- Coverage: `npm run test:coverage` enforces per-file floors
  (`thresholds.perFile: true`). The global floor is 0 — it only asserts no
  instrumented file is entirely unmeasured. The real gates are per-directory
  globs under `lib/**` plus `index.ts`/`tui.ts`; `lib/ui/` is deliberately 0
  (interactive widgets can't run under the harness).
- Property tests use fast-check; `test/property/setup.ts` configures the run
  globally (100 runs default). `FC_SEED=<integer>` replays a failing seed —
  a non-integer value fails loudly instead of silently going random.
- **Port 1455 is bound for real** by `oauth-server.integration.test.ts` and
  `chaos/auth-faults.test.ts`. The redirect URI is registered, so the port
  cannot be parameterized. Both suites serialize through
  `helpers/oauth-port-lock.ts` (`acquireOAuthPortLock` in `beforeAll`, release
  in `afterAll`; an `mkdir` mutex in tmpdir with 60 s stale reclaim). Any new
  suite binding the real port must take the same lock. Everything else mocks
  `http.createServer` or the listener.

## ANTI-PATTERNS

- No ports other than 1455; never bind it without `acquireOAuthPortLock`.
- No `dist/` imports — test source only.
- No wall-clock assertions — fake timers or injected clocks.
- No skipped tests without justification.
- No committed exhaustive test-file list — point at `find test -name '*.test.ts'`.
- When a documented contract changes (tool count, config key, storage path,
  catalog size), update `doc-parity.test.ts` and the docs in the same change.
- Never commit real tokens, account ids, org ids, emails, or JWTs — contract
  fixtures use `FAKE_*` placeholders.
