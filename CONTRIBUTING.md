# Contributing

`oc-codex-multi-auth` accepts improvements that make the OpenCode plugin
clearer, safer, and more useful for personal development workflows.

## Compliance (required)

- Use only official OAuth authentication flows. No session/cookie scraping, no
  undocumented-API reverse engineering, no rate-limit or auth-control bypass.
- Personal-use scope: individual productivity, terminal workflows, education.
  No commercial resale, multi-user/credential sharing, or TOS violations.
- Do not open public issues for security problems — see `SECURITY.md`.
- Never commit real tokens, account ids, org ids, emails, or JWT payloads —
  including in tests and fixtures.

## Local development

Prerequisites: Node.js ≥ 22.19 (per `package.json` `engines`), npm ≥ 9, Git.

```bash
git clone https://github.com/ndycode/oc-codex-multi-auth.git
cd oc-codex-multi-auth
npm ci
```

Quality gates (the same commands CI runs):

```bash
npm run typecheck    # strict tsc --noEmit
npm run lint         # eslint, no warnings allowed (lint-staged uses --max-warnings=0)
npm test             # full vitest suite
npm run build        # compile to dist/
npm run audit:ci     # prod audit + dev allowlist
```

Focused runs:

```bash
npx vitest run test/<file>.test.ts   # one suite
npx vitest watch                     # watch mode
```

## Commits and hooks

- `pre-commit` runs `lint-staged`: `eslint --fix` on changed `*.ts` and
  `scripts/*.js`.
- `commit-msg` enforces Conventional Commits:
  `type(scope)!: description` with subject ≤ 100 chars; types:
  `feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert|deps|deps-dev`.
- Merge, revert, `fixup!`, `squash!`, `amend!` subjects are exempt.
- `--no-verify` exists but is discouraged.

## Code standards

- TypeScript strict; no `as any`, `@ts-ignore`, `@ts-expect-error`. Unused args
  get a `_` prefix. ESM only — internal imports use `.js` specifiers.
- Tests import from source, never `dist/`; use fake timers, not wall-clock
  assertions. For a new `lib/<module>.ts`, add `test/<module>.test.ts` matching
  the closest existing suite (see `test/AGENTS.md`).
- Boolean env overrides are truthy only for `"1"` — document them that way.
- Keep the stateless contract (`store: false`, `reasoning.encrypted_content`)
  and atomic 0600 credential writes intact.
- Add dependencies only when the benefit is clear.

## Contract fixtures

`test/contracts/` pins upstream response shapes (OAuth token, Codex chat, Codex
SSE) via sanitized fixtures in `test/contracts/fixtures/`, parsed by the real
production schemas. When a shape drifts upstream, update the fixture and the
parser/test in the same commit; sanitize everything (`FAKE_*` placeholders).

## Keychain backend

`lib/storage/keychain.ts` is opt-in (`CODEX_KEYCHAIN=1`). The suite forces
`CODEX_KEYCHAIN: '0'` via `vitest.config.ts` `test.env`, and contract tests use
an in-memory `_setBackendForTests` mock — real-keychain runs must opt in inside
the test rather than through a shell env override.

## Pull requests

- Fork, branch, write clear "why" commit messages, include tests for behavioral
  changes, update docs for user-facing changes.
- Fill in the PR template (summary, testing, compliance). Low-signal PRs may be
  flagged for maintainer review; a maintainer can override with the `exempt`
  label.

## Issues

Check for duplicates; include reproduction steps, `opencode --version`, plugin
version, OS, and logs (`DEBUG_CODEX_PLUGIN=1 CODEX_CONSOLE_LOG=1`, or
`ENABLE_PLUGIN_REQUEST_LOGGING=1` for request metadata under
`~/.opencode/logs/codex-plugin/`). Confirm the report concerns personal use on
your own subscription.

All contributors follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Contributions
are MIT-licensed (see [LICENSE](LICENSE)).
