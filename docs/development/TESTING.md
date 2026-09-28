# Testing Guide

Validation surface for `oc-codex-multi-auth`. For suite layout and conventions (naming, directories, anti-patterns), see `test/AGENTS.md`; this file covers the commands and the checks that matter when changing things.

## Release-Gate Commands

Run all of these before opening a PR — the same six commands run in CI (`.github/workflows/ci.yml`):

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run audit:ci
```

| Command | What it checks |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint flat config (`no-explicit-any`; tests linted under relaxed rules) |
| `npm test` | Vitest suite — auth, config, transforms, storage, rotation, tools, TUI, recovery, docs parity |
| `npm run test:coverage` | Coverage thresholds from `vitest.config.ts` |
| `npm run build` | clean `dist/`, compile, copy OAuth success page |
| `npm run audit:ci` | production audit + dev-advisory allowlist |

## Suite Layout

`find test -name '*.test.ts'` is the inventory — do not hardcode counts or file lists anywhere. Roughly: top-level `test/*.test.ts` unit/integration suites (named after the module under test, e.g. `lib/storage/keychain.ts` → `storage-keychain.test.ts`), plus `test/chaos/` fault injection, `test/property/` fast-check tests (`FC_SEED=<n>` replays a run), `test/contracts/` upstream wire shapes, and `test/tools-codex-*.test.ts` per-tool regressions.

Conventions: vitest globals on; `vitest.config.ts` redirects `HOME` to a per-run throwaway dir so suites never touch real credentials (`OC_CODEX_TEST_HOME` to opt into your own); OAuth tests bind the real port `1455`; fake timers over wall-clock assertions; source imports only, never `dist/`.

## Coverage Floors

`vitest.config.ts` enforces `perFile` thresholds per directory glob — each floor sits under the weakest file it matches today, so a real drop trips the gate without blocking routine drift. Deliberately low: `lib/ui/**` (interactive widgets can't run under the harness), `tui.ts`, and the re-export barrels. Keeping them instrumented keeps the gap visible.

## Documentation-Adjacent Checks

When docs touch setup/config/tooling claims, verify against the live surface:

1. Confirm commands exist in `lib/tools/index.ts` and each has a matching `lib/tools/codex-*.ts` module.
2. Confirm config examples match `config/opencode-modern.json`, `config/opencode-legacy.json`, `config/minimal-opencode.json`.
3. Confirm install/update guidance matches `scripts/install-oc-codex-multi-auth.js`.
4. Confirm repo scripts quoted in docs still exist in `package.json`.

`npm test -- test/doc-parity.test.ts` automates most of this — catalog counts, tool counts, path references, npm scripts, auth labels, version strings.

## Manual Smoke Checks

```bash
npx -y oc-codex-multi-auth@latest --dry-run      # install + config merge
opencode debug config                          # merged provider.openai + plugin entry
ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "ping" --model=openai/gpt-5.5 --variant=medium
```

Verify the last one writes logs under `~/.opencode/logs/codex-plugin/` and keeps `store: false` + `reasoning.encrypted_content`. For payload-level debugging add `DEBUG_CODEX_PLUGIN=1 CODEX_PLUGIN_LOG_BODIES=1` — it can log sensitive request/response bodies, so use it only when needed.

Interactive commands worth a manual pass when the auth menu or account flows change: `codex-setup`, `codex-doctor`, `codex-next`, `codex-list`, `codex-dashboard`.

## Failure Triage

| Surface | Command |
| --- | --- |
| lint/style | `npm run lint` |
| type drift | `npm run typecheck` |
| transform/request behavior | `npm test -- request-transformer` |
| storage/migration | `npm test -- storage` |
| tool output | `npm test -- tools-codex-<name>` or `npm test -- index` |
| docs/metadata drift | `npm test -- doc-parity` |

## See Also

- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [CONFIG_FLOW.md](./CONFIG_FLOW.md)
- [../../test/README.md](../../test/README.md)
- `test/AGENTS.md`
