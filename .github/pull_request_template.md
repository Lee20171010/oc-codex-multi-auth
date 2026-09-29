<!-- Maintainer note: the anti-slop canary token is configured in .github/workflows/pr-quality.yml under blocked-terms. Keep the template and workflow in sync, and do not put the raw token in contributor-facing files. -->

## Summary

- What changed?
- Why is this needed?

## Testing

- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm test -- test/doc-parity.test.ts`
- [ ] Not applicable

## Docs and Governance Checklist

- [ ] README updated (if user-visible behavior changed)
- [ ] `docs/getting-started.md` updated (if onboarding flow changed)
- [ ] `docs/tools-and-cli.md` updated (if the `codex-*` tool or CLI surface changed)
- [ ] `docs/configuration.md` / `docs/development/CONFIG_FIELDS.md` updated (if config keys or env vars changed)
- [ ] `docs/upgrade.md` updated (if migration or rename behavior changed)
- [ ] `SECURITY.md` and `CONTRIBUTING.md` reviewed for alignment

## Compliance Confirmation

- [ ] This change stays within the repository scope and OpenAI Terms of Service expectations.
- [ ] This change uses official authentication flows only and does not add bypass, scraping, or credential-sharing behavior.
- [ ] I updated tests and documentation when the change affected users, maintainers, or repository behavior.

## Notes

- Linked issue:
- Follow-up work or rollout notes:
