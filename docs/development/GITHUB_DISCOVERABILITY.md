# GitHub Discoverability Guide

How to present `oc-codex-multi-auth` on GitHub so developers searching for it actually find it. Meta-repo guidance — nothing here ships in the package.

## Positioning

- **What it is**: an OpenCode plugin for ChatGPT Plus/Pro OAuth, Codex/GPT-5 routing, multi-account rotation, account switching, health checks, quota status, diagnostics, and recovery tools.
- **Who it is for**: individual OpenCode users who want ChatGPT OAuth-backed Codex workflows with visible local account state.
- **What it is not**: a hosted auth service, shared multi-user credential pool, generic API-key tool, or a production path — that is the OpenAI Platform API.

## Search Terms

Terms developers plausibly search: `opencode chatgpt oauth`, `opencode codex plugin`, `opencode multi account oauth`, `opencode chatgpt plus plugin`, `codex oauth opencode`, `opencode account switching`, `opencode quota status`, `opencode pkce oauth`, `gpt 5 codex opencode`, `opencode recovery tools`.

Use them naturally in the README intro, feature list, docs landing pages, package keywords, and GitHub topics — do not stuff every heading.

## Recommended Metadata

- **Repo description**: `OpenCode plugin for ChatGPT Plus/Pro OAuth with Codex/GPT-5 routing, multi-account rotation, account switching, health checks, diagnostics, and recovery tools`
- **README H1**: `oc-codex-multi-auth: ChatGPT OAuth and multi-account Codex routing for OpenCode`
- **Topics** (≤20): `opencode`, `opencode-plugin`, `codex`, `gpt-5`, `openai`, `chatgpt`, `chatgpt-plus`, `oauth`, `oauth2`, `pkce`, `multi-account`, `account-switching`, `account-health`, `quota-management`, `diagnostics`, `recovery-tools`, `terminal-ui`, `typescript`, `nodejs`
- **Badges**: npm version, npm downloads, CI status, license. Skip vanity badges.

`test/doc-parity.test.ts` pins `package.json` `description` and the `keywords` set (`opencode-plugin`, `codex-oauth`, `account-switching`, `account-health`, `quota-management`, `diagnostics`, `recovery-tools`), so drift there fails the suite.

## Wording Rules

- First paragraph: what it is, who it is for, how it relates to OpenCode and ChatGPT OAuth.
- Feature bullets lead with outcomes: account switching, health checks, quota visibility, diagnostics, recovery, Codex/GPT-5 routing.
- Trust signals: local-only storage, redacted diagnostics, keychain opt-in, independent/non-official status, OpenAI Platform API boundary.
- Explain `store: false` + `reasoning.encrypted_content` (stateless requests) — it is the detail that convinces technical readers the plugin is real.
- Do not claim GitHub ranking. Relevance and click confidence are improvable; placement is not.

## Surfaces To Keep Aligned

When positioning changes, update all of these together so the repo does not present different descriptions of itself:

| Surface | What to update |
| --- | --- |
| `README.md` | H1, intro paragraph, feature bullets |
| `package.json` | `description`, `keywords` |
| `.codex-plugin/plugin.json` | `description` |
| GitHub About | description + topics (set in the GitHub UI) |
| `AGENTS.md`, `lib/AGENTS.md` | overview paragraphs |
| `docs/README.md`, `docs/index.md`, `docs/DOCUMENTATION.md` | portal copy |
| `docs/architecture.md`, `docs/development/ARCHITECTURE.md` | architecture summaries |
| `docs/_config.yml` | docs site title/description |

## What Loses A Developer

- README reads like a model catalog before it explains the product.
- Plugin entry, installer, TUI plugin, and `codex-*` tools blurred together.
- Stale package names or release versions — signals an abandoned repo.
- Safety language missing or sounding like a hosted credential service.
