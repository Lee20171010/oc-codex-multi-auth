/**
 * Schema normalization, forward-compat guard, and V2 detection for account
 * storage files.
 *
 * Split out of `lib/storage.ts` in RC-2. This module does not touch disk: it
 * takes already-parsed JSON and returns a canonical `AccountStorageV3` (or
 * throws a typed `StorageError` for schemas we can't safely read).
 */

import { createLogger } from "../logger.js";
import { extractAccountUserId, isStaleGeneratedAccountLabel } from "../auth/token-utils.js";
import { MODEL_FAMILIES, type ModelFamily } from "../prompts/codex.js";
import { MAX_QUOTA_RESET_HORIZON_MS } from "../quota-windows.js";
import { nowMs } from "../utils.js";
import { AccountStorageV2DetectionSchema } from "../schemas.js";
import { StorageError } from "./errors.js";
import {
  clampIndex,
  deduplicateAccountsForStorage,
  extractActiveKeys,
  findAccountIndexByIdentityKeys,
  isRecord,
} from "./identity.js";
import {
  buildV2RecoveryHint,
  buildV2RejectionMessage,
  migrateV1ToV3,
  UNKNOWN_V2_FORMAT_CODE,
  type AccountMetadataV3,
  type AccountStorageV1,
  type AccountStorageV3,
} from "./migrations.js";

const log = createLogger("storage");

type AnyAccountStorage = AccountStorageV1 | AccountStorageV3;

/**
 * Drops a label an earlier build generated from an API-platform organization.
 *
 * Builds up to 6.17 named a ChatGPT account after an organization read from
 * the `id_token_add_organizations` claims, storing a personal subscription as
 * "<api org> (role:owner) [id:c487c4]". 6.18 stopped generating that label and
 * clears it on login, since every surface prints `accountLabel` verbatim while
 * the email and account id already render from their own fields.
 *
 * Login is the only thing that clears it, and a refresh token rotates for
 * months without one, so a pool written by an older build shows the wrong
 * organization indefinitely. Doing it here instead means the first read or
 * write by a build that no longer generates the label drops it, with no
 * re-authentication.
 *
 * Only the generated shape goes. `isStaleGeneratedAccountLabel` requires the
 * trailing `[id:…]` marker to hold this account's own id suffix, which is what
 * every generator here emits, so a name someone typed with `codex-label` is
 * left alone even when it happens to end in `[id:mine]`. Deleting a label has
 * no undo, so the looser `isGeneratedAccountLabel` - which governs whether a
 * login may *replace* a label - is deliberately not the predicate used here.
 *
 * This runs on every read and write rather than once behind a storage-version
 * bump: v3 carries no marker to gate on, and adding one would mean a v4
 * migration for a check that is a single regex per account and idempotent
 * once the label is gone. The cost of retiring it later is a code deletion,
 * not a data migration.
 */
function dropStaleGeneratedLabel(account: AccountMetadataV3): AccountMetadataV3 {
  const label = account.accountLabel;
  if (typeof label !== "string" || !label.trim()) return account;
  if (!isStaleGeneratedAccountLabel(label, account.accountId)) return account;
  const next = { ...account };
  delete next.accountLabel;
  // A user-visible field is disappearing, so say so: without this an account
  // renaming itself from "DreamHost API (role:owner) [id:c487c4]" to
  // "Account 1" leaves nothing behind to diagnose.
  log.info("dropping stale generated account label", {
    accountIdSuffix: account.accountId?.slice(-6),
  });
  return next;
}

/**
 * Boundary guard for the numeric timing fields on a stored account record.
 *
 * `JSON.parse` happily produces `Infinity` (from literals like `1e400`), and a
 * hand-edited file can hold anything at all. The declared types say `number`,
 * but nothing below the storage layer re-checks that, and a single non-finite
 * value poisons rotation math in both directions:
 *
 *  - `Infinity` in `rateLimitResetTimes` blocks the account forever
 *    (`nowMs() < Infinity` and `clearExpiredRateLimits` can never fire), and
 *    `getMinWaitTimeForFamily` then returns `Infinity`, which the retry loop
 *    feeds to `addJitter` — producing `NaN` (instant-return sleep, hot retry)
 *    or `Infinity` (countdown that never ends).
 *  - A non-number `quotaExhaustedUntil` fails every `typeof === "number"`
 *    check, so rotation serves the account while diagnostics still report it.
 *
 * This runs on every load AND every save (the write path normalizes first), so
 * a poisoned file is healed by the next persist even if a pre-sanitize build
 * wrote it.
 */
function sanitizeAccountNumericState(account: AccountMetadataV3): AccountMetadataV3 {
  const next = { ...account };

  for (const key of [
    "expiresAt",
    "tokenRotatedAt",
    "coolingDownUntil",
    "quotaExhaustedUntil",
    "quotaExhaustedStampAt",
    "quotaExhaustedClearedAt",
  ] as const) {
    const value = next[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      delete next[key];
    }
  }

  // A finite-but-huge future stamp strands the account exactly like the
  // non-finite values above: expiry can never fire, so rotation serves null
  // and getMinWaitTimeForFamily counts down for centuries. The same 30-day
  // horizon the header and stamp writers enforce bounds what a corrupt or
  // unit-mangled file can claim.
  const horizon = nowMs() + MAX_QUOTA_RESET_HORIZON_MS;
  for (const key of ["coolingDownUntil", "quotaExhaustedUntil"] as const) {
    const value = next[key];
    if (typeof value === "number" && value > horizon) {
      delete next[key];
    }
  }

  for (const key of ["addedAt", "lastUsed"] as const) {
    const value = next[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      next[key] = 0;
    }
  }

  // The spread above is shallow, so `next.rateLimitResetTimes` still aliases
  // the caller's map. Rebuild it instead of deleting keys on the shared
  // object — pruning the caller's copy in place would leak "sanitized" state
  // back through the original reference while other poisoned fields on the
  // input keep their raw values.
  if (next.rateLimitResetTimes) {
    const cleaned: Record<string, number | undefined> = {};
    for (const [key, value] of Object.entries(next.rateLimitResetTimes)) {
      if (typeof value === "number" && Number.isFinite(value) && value <= horizon) {
        cleaned[key] = value;
      }
    }
    if (Object.keys(cleaned).length > 0) {
      next.rateLimitResetTimes = cleaned;
    } else {
      delete next.rateLimitResetTimes;
    }
  }

  return next;
}

/**
 * Seed V3 family-keyed rate-limit state from the V1 global stamp. Mirrors
 * the mapping in {@link migrateV1ToV3} so the rebuilt account list keeps the
 * migration's per-account output.
 */
function seedV1RateLimitState(account: AccountMetadataV3): AccountMetadataV3 {
  const legacy = (account as AccountMetadataV3 & { rateLimitResetTime?: unknown })
    .rateLimitResetTime;
  if (typeof legacy !== "number" || !Number.isFinite(legacy) || legacy <= nowMs()) {
    return account;
  }
  const rateLimitResetTimes: Record<string, number> = {};
  for (const family of MODEL_FAMILIES) {
    rateLimitResetTimes[family] = legacy;
  }
  return { ...account, rateLimitResetTimes };
}

/**
 * Normalizes and validates account storage data, migrating from v1 to v3 if needed.
 * Handles deduplication, index clamping, and per-family active index mapping.
 * @param data - Raw storage data (unknown format)
 * @param sourcePath - Optional origin path used for error diagnostics
 * @returns Normalized AccountStorageV3 or null if invalid
 * @throws StorageError (code `UNSUPPORTED_SCHEMA_VERSION`) when `data.version`
 *   is a finite number greater than the newest format this plugin understands.
 *   Throwing prevents a downgraded plugin from silently discarding future
 *   schemas that still contain valid credentials.
 */
export function normalizeAccountStorage(
  data: unknown,
  sourcePath?: string,
): AccountStorageV3 | null {
  if (!isRecord(data)) {
    log.warn("Invalid storage format, ignoring");
    return null;
  }

  const rawVersion = (data as { version?: unknown }).version;

  // Forward-compat guard: a finite version above the newest supported schema
  // signals a file written by a newer plugin build. Returning null here would
  // make the caller treat the data as corrupt and overwrite it with an empty
  // or downgraded payload, permanently destroying the user's accounts.
  if (typeof rawVersion === "number" && Number.isFinite(rawVersion) && rawVersion > 3) {
    const resolvedPath = sourcePath ?? "<unknown>";
    const hint =
      `The storage file at ${resolvedPath} was written by a newer version ` +
      `of this plugin (schema v${rawVersion}). Upgrade the plugin to a build ` +
      `that understands schema v${rawVersion}, or back up and remove the ` +
      `file to start fresh.`;
    throw new StorageError(
      `Unsupported account storage schema version ${rawVersion}; this plugin supports up to version 3.`,
      "UNSUPPORTED_SCHEMA_VERSION",
      resolvedPath,
      hint,
    );
  }

  // V2 files were produced by an intermediate 4.x build whose shape was never
  // documented and for which no forward-migrator shipped. Silently treating
  // them as "unknown version" (the previous behaviour) meant users with a V2
  // file had their credentials discarded without any signal. Detect V2
  // explicitly and throw a typed StorageError so the caller can surface the
  // recovery hint to the user. Audit top-20 #8; see
  // `lib/storage/migrations.ts:buildV2RejectionMessage` for copy.
  if (AccountStorageV2DetectionSchema.safeParse(data).success) {
    throw new StorageError(
      buildV2RejectionMessage(),
      UNKNOWN_V2_FORMAT_CODE,
      "",
      buildV2RecoveryHint(""),
    );
  }

  if (data.version !== 1 && data.version !== 3) {
    log.warn("Unknown storage version, ignoring", {
      version: rawVersion,
    });
    return null;
  }

  const rawAccounts = data.accounts;
  if (!Array.isArray(rawAccounts)) {
    log.warn("Invalid storage format, ignoring");
    return null;
  }

  const activeIndexValue =
    typeof data.activeIndex === "number" && Number.isFinite(data.activeIndex)
      ? data.activeIndex
      : 0;

  const rawActiveIndex = clampIndex(activeIndexValue, rawAccounts.length);
  const activeKeys = extractActiveKeys(rawAccounts, rawActiveIndex);

  const fromVersion = data.version as AnyAccountStorage["version"];
  const baseStorage: AccountStorageV3 =
    fromVersion === 1
      ? migrateV1ToV3(data as unknown as AccountStorageV1)
      : (data as unknown as AccountStorageV3);

  const validAccounts = rawAccounts.filter(
    (account): account is AccountMetadataV3 =>
      isRecord(account) && typeof account.refreshToken === "string" && !!account.refreshToken.trim(),
  );

  const accountsWithMemberIdentity = validAccounts.map((account) => {
    // migrateV1ToV3 maps the V1 global rate-limit stamp onto every family
    // key, but the account rebuild below starts from the raw records, so
    // that mapped state must be seeded here or the migration's per-account
    // output is silently discarded.
    const seeded =
      fromVersion === 1 ? seedV1RateLimitState(account) : account;
    const sanitized = sanitizeAccountNumericState(seeded);
    const named = dropStaleGeneratedLabel(sanitized);
    if (named.accountUserId?.trim()) return named;
    const accountUserId = extractAccountUserId(named.accessToken);
    return accountUserId ? { ...named, accountUserId } : named;
  });
  const deduplicatedAccounts = deduplicateAccountsForStorage(accountsWithMemberIdentity);

  const activeIndex = (() => {
    if (deduplicatedAccounts.length === 0) return 0;

    if (activeKeys.length > 0) {
      const mappedIndex = findAccountIndexByIdentityKeys(deduplicatedAccounts, activeKeys);
      if (mappedIndex >= 0) return mappedIndex;
    }

    return clampIndex(rawActiveIndex, deduplicatedAccounts.length);
  })();

  const activeIndexByFamily: Partial<Record<ModelFamily, number>> = {};
  const rawFamilyIndices = isRecord(baseStorage.activeIndexByFamily)
    ? (baseStorage.activeIndexByFamily as Record<string, unknown>)
    : {};

  for (const family of MODEL_FAMILIES) {
    const rawIndexValue = rawFamilyIndices[family];
    const rawIndex =
      typeof rawIndexValue === "number" && Number.isFinite(rawIndexValue)
        ? rawIndexValue
        : rawActiveIndex;

    const clampedRawIndex = clampIndex(rawIndex, rawAccounts.length);
    const familyKeys = extractActiveKeys(rawAccounts, clampedRawIndex);

    let mappedIndex = clampIndex(rawIndex, deduplicatedAccounts.length);
    if (familyKeys.length > 0 && deduplicatedAccounts.length > 0) {
      const idx = findAccountIndexByIdentityKeys(deduplicatedAccounts, familyKeys);
      if (idx >= 0) {
        mappedIndex = idx;
      }
    }

    activeIndexByFamily[family] = mappedIndex;
  }

  return {
    version: 3,
    accounts: deduplicatedAccounts,
    activeIndex,
    activeIndexByFamily,
  };
}
