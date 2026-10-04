# Local enhancements

This checkout uses the `oc-codex-multi-auth` package and CLI name and is based on upstream v6.27.0, with the following maintained enhancements for OpenCode 2.0.22.

## Subscription models and long context

The plugin discovers models using the selected account's OAuth credential and workspace. It refreshes expired credentials through upstream coordination and isolates the model cache by project storage, account and credential.

Candidate selection reloads the provider when the discovered catalog changes. Reusing an identical completed catalog avoids a reload; failed reloads can be retried.

Normal selectors use the account's reported `context_window`. A `-long` selector is available when `max_context_window` is larger, and sends the same original model ID. If the host or a custom configuration already owns a selector, a `-subscription` selector exposes the discovered limits alongside it. Existing definitions retain their settings.

Requests verify the selected account can serve the model and chosen context size. A catalog entry describes capability, not a successful generation. Unsupported requests return an actionable error rather than silently changing models; explicitly configured fallback chains remain available. Failed discovery preserves the host catalog and supplies no speculative subscription additions.

Saved accounts whose OAuth refresh is rejected must be reconnected using `opencode auth login`. The host catalog remains available while subscription discovery has no usable credential. Successful account connection refreshes the subscription catalog.

## Interactive confirmation

Account deletion, reset-credit redemption and keychain rollback require an Allow once / Deny form even when a tool argument supplies `confirm=true`. The form includes the operation, project and target and is associated with the tool call. Denial, cancellation, timeout, abort, unavailable transport and disposal prevent execution. Dry-run and preview requests do not spend credits or delete accounts.

Forms use the running host's loopback API and native clients. No separate frontend or custom account storage is required. Automatic reset redemption and paid-credit spending are upstream opt-in features; manual-tool confirmation applies to manual operations.

## Context repair and bounded retry

The plugin repairs missing, orphaned or duplicate tool results in outgoing context and handles recognized reasoning-format errors. It preserves stored messages and does not execute tools again. With `sessionRecovery` enabled, context repair is registered; `autoResume` permits recovery only at the host's first retry, attempt 2. Attempt 3 is not automatically resumed by this enhancement.

## CLI account management and quota repair

The CLI supports `switch`, `label`, `tag`, `note` and `pool`. Account mutations share durable storage transactions with agent tools; model-pool operations use the same tool implementation and save stable identities. Switches select the account for every model family. OpenCode observes account-file changes, and model-pool configuration is read on subsequent requests.

Account numbers start at 1 in command inputs and terminal listings. Existing inventory JSON retains its 0-based `index` and `activeIndex` for script compatibility, with `accountNumber` and `activeAccountNumber` exposing the command numbers. Management and limits JSON use 1-based indexes.

Run commands from the target project's directory. Project account pools are independent and require login from that project; `--config-path` explicitly selects an existing account file. Model-pool rules remain in the shared plugin configuration, matching `codex-pool`. Labels, tags and notes can be cleared with an empty string. Pool mutations support `--dry-run`.

Tag and note edits preserve quota snapshots. Switches and label changes invalidate the displayed account information so it can be rebuilt.

`doctor --fix` clears unchanged local cooldown, rate-limit and quota-exhaustion markers after successful credential verification. It also invalidates both account and pool quota caches so old reset times are fetched again. New quota evidence written during repair is preserved. A failed refresh leaves blocking records intact and requires `opencode auth login`; `limits --refresh` verifies current server usage.

For manual recovery, run `oc-codex-multi-auth doctor --fix` from the target project's directory, then retry the request. Use `oc-codex-multi-auth limits --refresh` to read current official usage. Quota checks use upstream scheduling, including background monitoring and existing waiting checks.

Successful manual reset-credit redemption invalidates both quota display caches immediately, including when the courtesy usage refresh fails. Cache-cleanup failures are reported separately from the completed redemption so they never invite spending another credit.

## Installation and maintenance

The maintained repository is `https://github.com/Lee20171010/oc-codex-multi-auth`. Use a standalone clone on `main`, with `origin` pointing to this fork and `upstream` pointing to `ndycode/oc-codex-multi-auth`. The repository owns its `.git` directory and does not depend on a worktree parent.

After `npm ci` and `npm run build`, run `npm install --global .` inside the clone. npm links the `oc-codex-multi-auth` CLI to this checkout. Run `oc-codex-multi-auth install --v2` to register the same checkout's `dist` by file URL. It preserves other plugins, provider settings and explicit local registrations, and backs up changed configuration. JSONC configurations and V1 registrations require explicit migration before this V2 command can run. Update through `git pull --ff-only origin main`, `npm ci`, `npm run build`, and a host restart. Local-checkout builds skip the upstream npm update check. The package's `private: true` applies to registry publishing, while local npm installation remains supported.

Keep account files under their existing paths; repository migration does not require a credential or session migration.

Build with `npm run build`, verify with `npm run typecheck`, `npm run lint`, `npm test` and `npm run audit:ci`. The enhancement modules are `lib/v2-model-discovery.ts`, `lib/v2-native-form.ts`, `lib/v2-recovery.ts` and `lib/v2-request-scope.ts`; `v2` in internal module names denotes the OpenCode host API.

Deployment evidence and rollback data are saved separately from this source tree.
