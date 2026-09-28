import { defineConfig } from 'vitest/config';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Per-run throwaway home. The suite writes real account storage, so without
 * this a `npm test` resolves `~/.opencode/oc-codex-multi-auth-accounts.json`
 * against the developer's actual home and overwrites live ChatGPT credentials
 * with fixtures.
 *
 * This must be `test.env`, not a `setupFiles` entry: vitest applies `test.env`
 * before the worker imports any test module, and `lib/config.ts`,
 * `lib/accounts/recovery.ts` and `lib/logger.ts` capture `homedir()` at module
 * scope, so anything later than import time is too late for them.
 */
const inheritedHome = process.env.OC_CODEX_TEST_HOME;
const isolatedHome =
  inheritedHome ?? mkdtempSync(join(tmpdir(), 'oc-codex-multi-auth-test-home-'));
process.env.OC_CODEX_TEST_HOME = isolatedHome;
// Only a home this config minted may be removed once the run ends. One handed
// in through the environment belongs to whoever set it.
if (!inheritedHome) process.env.OC_CODEX_TEST_HOME_OWNED = '1';
else delete process.env.OC_CODEX_TEST_HOME_OWNED;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: {
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      OC_CODEX_TEST_HOME: isolatedHome,
      // The OS credential store is the one place the HOME redirect cannot
      // reach. An inherited opt-in would route fixture writes into the
      // developer's real keychain; tests that need the backend opt in per test.
      CODEX_KEYCHAIN: '0',
    },
    // Four suites import the real `index.ts`, and the first one scheduled pays
    // the transform of a 4900-line entry plus its dependency graph: measured at
    // 3.2s-6.7s on an idle machine, against a 5s default. Whichever suite loses
    // that race times out under full-suite CPU contention, which is flakiness in
    // the harness rather than in any assertion (a warm re-import costs ~400ms).
    testTimeout: 15_000,
    hookTimeout: 15_000,
    globalSetup: ['./test/global-setup.ts'],
    // Shared fast-check configuration (FC_SEED reproducibility, run limits).
    setupFiles: ['./test/property/setup.ts'],
    include: ['test/**/*.test.ts'],
    exclude: [
      'node_modules/**',
      '.opencode/**',
      'dist/**',
      'tmp/**',
      '**/node_modules/**',
      '**/.opencode/**',
      '**/dist/**',
      '**/tmp/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // Production sources only: test files, scripts, configs, and generated
      // output never belong in the instrumented set.
      include: ['lib/**/*.ts', 'index.ts', 'tui.ts'],
      exclude: [
        'node_modules/',
        'dist/',
        'test/',
        'scripts/',
        '*.config.*',
        '**/*.config.*',
      ],
      thresholds: {
        // Vitest evaluates `perFile` globally: when true, EVERY threshold
        // group — including the global one — is checked file by file, so a
        // bare glob floor can no longer let one well-covered module hide a
        // sibling at near-zero coverage. `perFile` inside a glob entry is
        // dead config and lives here, top-level, instead.
        perFile: true,
        // Because the global group also becomes per-file, its floor can only
        // assert "no instrumented file is entirely unmeasured" — any higher
        // value would fail the intentionally untested TUI surface called out
        // below. The real regression gates live in the per-directory globs:
        // each sits a few points under the weakest file it matches today, so
        // a real drop trips the gate without blocking routine drift.
        statements: 0,
        branches: 0,
        functions: 0,
        lines: 0,
        // Top-level lib modules (cli.ts ~70, opencode-v2.ts branches ~64 and
        // quotation-state.ts functions ~67 pin the floor).
        'lib/*.ts': {
          statements: 64,
          branches: 58,
          functions: 60,
          lines: 68,
        },
        // accounts/recovery.ts (~48 stmts, ~25 branches) and pool-identity.ts
        // functions (~83) pin this floor.
        'lib/accounts/**/*.ts': {
          statements: 41,
          branches: 18,
          functions: 76,
          lines: 43,
        },
        // device-code.ts (~76 stmts, ~74 branches) pins this floor.
        'lib/auth/**/*.ts': {
          statements: 70,
          branches: 68,
          functions: 80,
          lines: 75,
        },
        // codex-opencode-bridge.ts branches (~67) pins this floor.
        'lib/prompts/**/*.ts': {
          statements: 84,
          branches: 60,
          functions: 80,
          lines: 86,
        },
        'lib/recovery/**/*.ts': {
          statements: 91,
          branches: 84,
          functions: 91,
          lines: 95,
        },
        // request-transformer.ts (~90 stmts) and helpers/effort-suffix.ts
        // branches (~83) pin this floor.
        'lib/request/**/*.ts': {
          statements: 84,
          branches: 78,
          functions: 88,
          lines: 90,
        },
        // keychain.ts and flagged.ts (~51 each) pin this floor: the OS
        // credential store is opt-in and flagged-account handling is only
        // partially exercised, so this floor is intentionally the weakest of
        // the directory gates until more tests land.
        'lib/storage/**/*.ts': {
          statements: 45,
          branches: 48,
          functions: 52,
          lines: 45,
        },
        // codex-dashboard.ts (~43 stmts, ~40 branches) pins this floor; the
        // remaining tools sit at ~64+.
        'lib/tools/**/*.ts': {
          statements: 36,
          branches: 33,
          functions: 54,
          lines: 36,
        },
        'index.ts': {
          statements: 69,
          branches: 50,
          functions: 70,
          lines: 70,
        },
        // Intentionally low floors: these surfaces are terminal UI (ANSI
        // rendering, interactive menus, the prompt-status plugin) and pure
        // re-export barrels. The ui/ floor is 0 because interactive widgets
        // (confirm.ts, select.ts) cannot run under the test harness at all;
        // the barrels compile to zero statements so any floor is a no-op
        // until real code lands there. Keeping both instrumented — rather
        // than excluded — keeps the gap visible so coverage can trend UP
        // from here. Track increases in
        // https://github.com/ndycode/oc-codex-multi-auth/issues/149.
        'tui.ts': {
          statements: 25,
          branches: 30,
          functions: 22,
          lines: 26,
        },
        'lib/ui/**/*.ts': {
          statements: 0,
          branches: 0,
          functions: 0,
          lines: 0,
        },
        'lib/index.ts': {
          statements: 25,
          branches: 15,
          functions: 25,
          lines: 25,
        },
        'lib/recovery.ts': {
          statements: 25,
          branches: 15,
          functions: 25,
          lines: 25,
        },
        'lib/storage.ts': {
          statements: 25,
          branches: 15,
          functions: 25,
          lines: 25,
        },
      },
    },
  },
});

