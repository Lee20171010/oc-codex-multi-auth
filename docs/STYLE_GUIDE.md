# Documentation Style Guide

Style contract for all docs in this repository. Enforcement is partially executable — `test/doc-parity.test.ts` pins catalog counts, tool counts, auth labels, repo-path references, markdown links, npm scripts, and package metadata.

---

## Goals

1. Fast onboarding for first-time users.
2. Precise references for maintainers and automation users.
3. Stable wording for tools, commands, flags, paths, and version policy.
4. Consistent structure across user and maintainer docs.
5. High-confidence discoverability without keyword stuffing or unsupported ranking claims.

---

## Page Template

User-facing docs should generally follow:

1. Title and one-line lead.
2. Quick path commands.
3. Core operational workflow.
4. Troubleshooting or failure handling.
5. Related links.

Use short sections and scan-friendly tables where they improve clarity. Simple ASCII diagrams are welcome for request/storage flows — keep them inside fenced `text` blocks.

---

## Writing Rules

1. Prefer direct, actionable language.
2. Use runnable command examples.
3. Explain expected outcomes after critical commands.
4. Keep terminology consistent with runtime names (`account pool`, `rotation`, `flagged account`, `quota`, `warm`, `V1 plugin`, `V2 adapter`).
5. Avoid speculative language when behavior is deterministic; mark advisory/best-effort behavior (health scores, quota figures, auto-refresh) explicitly instead of overstating guarantees.
6. Put the user problem in the first paragraph before implementation detail.
7. Cite real module paths (`lib/rotation.ts`) in maintainer docs so claims stay greppable.

---

## Formatting Rules

1. Table separator rows use the spaced `| --- |` form.
2. User-facing docs end with a `## Related` section listing filename-labeled links (`[tools-and-cli.md](tools-and-cli.md)`), not descriptive titles.
3. Admonitions use GitHub alert syntax (`[!NOTE]`, `[!CAUTION]`), not blockquote-bold emulations.
4. Index/portal tables link to filenames as the link label; descriptive labels are acceptable inline in prose.

---

## Discoverability Rules

1. Root README and docs landing pages should naturally include `OpenCode`, `ChatGPT Plus/Pro OAuth`, `multi-account rotation`, `account switching`, `quota`, `diagnostics`, and `recovery` when those topics are in scope.
2. Use descriptive page titles such as `oc-codex-multi-auth Tools and CLI` instead of generic titles on public docs.
3. Do not promise search rankings. Improve discoverability through accurate titles, first paragraphs, package metadata, internal links, and GitHub topics.
4. Do not repeat keyword lists in every section. Search terms should appear only where they help a developer understand the page.
5. Keep the repository description, package description, README lead, and `docs/development/GITHUB_DISCOVERABILITY.md` aligned.

---

## Command and Path Rules

1. Canonical package name is `oc-codex-multi-auth` — always as one hyphenated word, in prose and in examples. The standalone CLI uses the same name.
2. The in-session surface is the 24 `codex-*` tool names — always lowercase with the `codex-` prefix (`codex-status`, not `Codex Status`). OpenCode V2 normalizes them to `codex_status` form inside the host; describe that normalization only where V2 behavior is the topic.
3. Canonical runtime state root is `~/.opencode`; OpenCode host config lives under `~/.config/opencode`, and the OAuth host token at `~/.local/share/opencode/auth.json` (`$XDG_DATA_HOME/opencode/auth.json`).
4. OpenCode compatibility claims: the V1 plugin supports OpenCode 1.18.29+; the V2 adapter requires OpenCode 2.0.16+.
5. Retired package names (`oc-chatgpt-multi-auth`, `opencode-openai-codex-auth-*`) belong only in migration and rename-history contexts (`README.md` callout, `upgrade.md`, `faq.md`, `troubleshooting.md`, `CHANGELOG.md` history).
6. Keep tool names and flags aligned with `lib/tools/` and the standalone CLI help in `scripts/install-oc-codex-multi-auth-core.js` — the parity test derives catalog counts and auth labels from source.
7. Account numbering: in-session tool inputs and tool JSON `index`/`activeIndex` are 1-based; standalone CLI `[N]` labels and `--json` `index` are raw 0-based storage positions. Document this distinction wherever numbering is mentioned.

---

## Maintainer Rules

1. Behavior changes must update docs and tests together.
2. New tools, config keys, or environment variables must be reflected in `docs/tools-and-cli.md`, `docs/configuration.md`, or `docs/development/CONFIG_FIELDS.md` — the parity test extracts documented names and checks them against source.
3. Migration-impacting changes must update `docs/upgrade.md`.
4. Governance-impacting changes must review `SECURITY.md` and `CONTRIBUTING.md`.
5. Keep PR/issue templates aligned with validation gates.
6. Historical snapshots (archived plans, dated audits) are append-only; correct them with new artifacts, not rewrites.

---

## Anti-Patterns

Avoid:

- non-runnable command snippets
- conflicting path guidance across docs
- legacy-name-first onboarding language
- undocumented behavior drift between runtime and docs
- absolute claims about advisory behavior (health scores are heuristics, quota figures are estimates; say so)
- naming the package in any form besides `oc-codex-multi-auth` outside the allowed rename-history scopes above
