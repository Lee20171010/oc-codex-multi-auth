import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    // `coverage/` holds vitest's generated HTML report, including vendored JS.
    // It is gitignored but was still being linted, so `npm run lint` reported
    // warnings from generated files after any `npm run test:coverage`.
    //
    // `.worktrees/**` holds full CHECKOUTS of this repository -- a worktree is
    // not a symlink to a checkout, it is a second one, so it contains a
    // complete copy of `lib/`, `test/` and `scripts/`. Linting it produced 312
    // errors, none of which belong to the tree being worked on, and the gate
    // was unusable in practice. `.worktrees/` is now gitignored as well.
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      ".worktrees/**",
      "winston/**",
      "*.cjs",
      "*.mjs",
    ],
  },
  {
    files: ["index.ts", "tui.ts", "lib/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        project: "./tsconfig.json",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      // TypeScript strict rules
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-non-null-assertion": "warn",
      
      // Promise handling (catch unhandled promises and misuse)
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/require-await": "warn",
      
      // General best practices
      "no-console": "off", // Allow console for CLI tool
      "prefer-const": "error",
      "no-var": "error",
      "eqeqeq": ["error", "always"],
      "no-duplicate-imports": "error",
    },
  },
  {
    files: ["scripts/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-console": "off",
      "prefer-const": "error",
      "no-var": "error",
      "eqeqeq": ["error", "always"],
      "no-duplicate-imports": "error",
    },
  },
  {
    files: ["test/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      // Relax rules for test files
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-duplicate-imports": "off",
    },
  },
];
