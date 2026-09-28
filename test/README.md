# Test Suite

Vitest suites for `oc-codex-multi-auth`.

The tree evolves frequently. Use `rg --files test` (or `find test -name '*.test.ts'`)
as the source of truth rather than any list committed here; this file describes
the **shape** of the suite, not an exhaustive inventory.

Current size: 159 test files, 141 at the top level plus `chaos/` (9),
`property/` (6), and `contracts/` (3).

## Layout

```text
test/
├── AGENTS.md                 # agent-facing conventions
├── README.md                 # this file
├── *.test.ts                 # unit + integration suites, one per module/concern
├── chaos/                    # fault injection and stress under adverse conditions
├── contracts/                # upstream wire-shape contracts (chat, SSE, token)
└── property/                 # fast-check property-based tests + shared helpers
```

Top-level suites are named after the module or behavior they cover, so
`storage-keychain.test.ts` covers `lib/storage/keychain.ts`, and
`tools-codex-pool.test.ts` covers `lib/tools/codex-pool.ts`.

## Running Tests

```bash
npm test                 # run all tests once
npm run test:watch       # re-run on file changes
npm run test:ui          # visual test UI
npm run test:coverage    # coverage report + threshold gate
```

Target a subset by substring:

```bash
npm test -- storage
npm test -- test/doc-parity.test.ts
```

## What The Suite Covers

### Auth and OAuth
`auth.test.ts`, `auth-menu.test.ts`, `login-runner.test.ts`, `device-code.test.ts`,
`token-utils.test.ts`, `oauth-constants.test.ts`, `server.unit.test.ts`, and
`oauth-server.integration.test.ts` (binds the real callback port `1455`).
Covers PKCE state generation, authorization-input parsing, JWT decoding,
device-code and manual-paste login paths, and workspace/account selection.

### Request pipeline
`request-transformer.test.ts`, `fetch-helpers.test.ts`, `response-handler.test.ts`,
`responses-lite.test.ts`, `input-utils.test.ts`, `retry-budget.test.ts`, and
`rate-limit-backoff.test.ts`. Covers URL/body/header shaping, the stateless
Codex invariants (`store: false`, `reasoning.encrypted_content`), the GPT-5.6
responses-lite reshape, SSE parsing, empty-response detection, bounded retry
classes, and exponential backoff.

### Model catalog and routing
`model-map.test.ts`, `gpt54-models.test.ts`, `gpt55-release.test.ts`,
`gpt56-models.test.ts`, `gpt56-sol-wire-parity.test.ts`, and
`model-pool-config.test.ts`. Covers model normalization, per-family defaults,
fallback chains, and `modelAccountPools` resolution.

### Accounts, rotation, and health
`accounts*.test.ts`, `rotation*.test.ts`, `refresh-queue.test.ts`,
`proactive-refresh.test.ts`, `health.test.ts`, `parallel-probe.test.ts`,
`circuit-breaker*.test.ts`, and `stale-state.test.ts`. Covers health scoring,
token-bucket consumption, cooldowns, the `hybrid`/`sticky`/`round-robin`
strategies, refresh serialization, and failure isolation.

### Storage
`storage.test.ts`, `storage-async.test.ts`, `storage-keychain.test.ts`,
`storage-v2-migration.test.ts`, `storage-worktree-lock.test.ts`,
`credential-clobber.test.ts`, and `paths.test.ts`. Covers the V3 format,
V1/V2 migration, per-project vs global path resolution, atomic writes,
the opt-in keychain backend, and import/export safety defaults.

### Tools and CLI
`index.test.ts` (registry wiring), `tools-codex-*.test.ts` (per-tool
regressions), `standalone-cli.test.ts`, `cli.test.ts`,
`install-oc-codex-multi-auth.test.ts`, and `codex-reset.test.ts`.

### TUI and UI
`tui-status.test.ts`, `tui-quota-cache.test.ts`, `tui-refresh-events.test.ts`,
`account-display.test.ts`, `table-formatter.test.ts`, `beginner-ui.test.ts`,
and `ui-*.test.ts`.

### Recovery
`recovery.test.ts`, `recovery-storage.test.ts`, and `recovery-constants.test.ts`
cover session recovery classes and auto-resume behavior.

### Docs parity
`doc-parity.test.ts` pins documentation claims that must match runtime
behavior: the stateless request contract, the shipped config templates, the
live `lib/tools` registry and its documented tool count, installer catalog
counts, the docs tree layout, internal link resolution, quoted package
versions, and npm scripts named in docs.

### `contracts/`
`codex-chat.test.ts`, `codex-sse.test.ts`, and `openai-token.test.ts` pin the
upstream wire shapes the plugin depends on.

### `property/`
fast-check property tests for rotation invariants, transformer edge cases,
refresh/rotation interaction, tracker remapping, and redaction. Shared
configuration lives in `property/setup.ts` (a vitest `setupFiles` entry).

`FC_SEED=<integer>` pins the fast-check seed for the whole run so a failing
property case can be replayed exactly:

```bash
FC_SEED=12345 npx vitest run test/property
```

Unset or empty means the default random-per-run seeding. A non-integer value
fails at setup rather than silently running unseeded.

### `chaos/`
Fault injection and stress: auth faults, invalidated-401 storms, concurrent
storage access, request faults, storage faults, rotation-strategy stress, and
warm-path stress.

## Test Philosophy

1. **Comprehensive coverage** — normal cases, edge cases, and error conditions.
2. **Fast and deterministic** — no real network calls; no reliance on wall-clock timing.
3. **Source, not `dist/`** — tests import from `lib/`, `index.ts`, and `tui.ts`.
4. **Type safety** — all tests are TypeScript under strict checking.
5. **Property-based testing** — critical paths get randomized inputs.

## Adding New Tests

1. Create or update the suite matching the module you changed.
2. Follow the existing `describe` / `it` structure.
3. Keep tests isolated and free of shared mutable state.
4. Run `npm test` and `npm run typecheck`.
5. If you changed a documented contract (tool count, config key, storage path,
   catalog size), update `doc-parity.test.ts` and the affected docs in the same
   change.

## Example Configurations

See `config/` for working examples:

- `opencode-modern.json` — variant-based template for OpenCode v1.0.210+
- `opencode-legacy.json` — explicit-entry template for older OpenCode
- `minimal-opencode.json` — minimal debug template
