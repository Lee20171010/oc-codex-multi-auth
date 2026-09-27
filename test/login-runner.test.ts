import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyAccountSelectionFallbacks,
	mergeStoredAccountPair,
	persistAccountPool,
	persistResolvedAccountSelection,
	resolveAccountSelection,
	resolveAndPersistAccountSelection,
	type AccountSelectionResult,
	type TokenSuccessWithAccount,
} from "../lib/auth/login-runner.js";
import { JWT_CLAIM_PATH } from "../lib/constants.js";
import { loadAccounts, saveAccounts, setStoragePathDirect } from "../lib/storage.js";
import type { AccountMetadataV3, AccountStorageV3 } from "../lib/storage.js";
import * as loadSaveModule from "../lib/storage/load-save.js";
import * as loggerModule from "../lib/logger.js";

function createTokenResult(
	accountId: string,
	refreshToken: string,
): TokenSuccessWithAccount {
	return {
		type: "success",
		access: `access-${accountId}`,
		refresh: refreshToken,
		expires: Date.now() + 60_000,
		accountIdOverride: accountId,
		accountIdSource: "manual",
		accountLabel: accountId,
	};
}

describe("login-runner persistAccountPool", () => {
	let testDir: string;
	let storagePath: string;

	beforeEach(async () => {
		testDir = join(
			tmpdir(),
			`login-runner-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		storagePath = join(testDir, "oc-codex-multi-auth-accounts.json");
		await fs.mkdir(testDir, { recursive: true });
		setStoragePathDirect(storagePath);
	});

	afterEach(async () => {
		setStoragePathDirect(null);
		vi.restoreAllMocks();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	// Build a minimal JWT (header.payload.sig) whose payload carries an email
	// claim, so extractAccountEmail/decodeJWT resolve a real address.
	const jwtWithEmail = (email: string): string => {
		const b64 = (o: unknown) =>
			Buffer.from(JSON.stringify(o)).toString("base64url");
		return `${b64({ alg: "none" })}.${b64({ email })}.sig`;
	};

	it("treats a mixed-case re-login as the same identity end-to-end (#171 email case)", async () => {
		// Seed a stored email-only (no org/accountId) account with MixedCase email.
		await persistAccountPool(
			[
				{
					type: "success",
					access: jwtWithEmail("User@Example.com"),
					refresh: "refresh-old",
					expires: Date.now() + 60_000,
				},
			],
			false,
		);
		const first = await loadAccounts();
		expect(first?.accounts).toHaveLength(1);

		// Re-login: same person, lowercase email, fresh refresh token.
		await persistAccountPool(
			[
				{
					type: "success",
					access: jwtWithEmail("user@example.com"),
					refresh: "refresh-new",
					expires: Date.now() + 60_000,
				},
			],
			false,
		);
		const second = await loadAccounts();
		// Case-insensitive email index => merged into the existing entry, not appended.
		expect(second?.accounts).toHaveLength(1);
		expect(second?.accounts[0]?.refreshToken).toBe("refresh-new");
	});

	it("re-enables a disabled slot on re-login and clears its re-auth note", async () => {
		// A slot parked by auth-failure disabling keeps its credentials but
		// stays out of rotation until a login repairs it.
		await saveAccounts({
			version: 3,
			accounts: [
				{
					accountId: "acct-1",
					refreshToken: "rt-old",
					accessToken: "at-old",
					expiresAt: Date.now() + 3_600_000,
					enabled: false,
					accountNote: "Re-auth required for missing OAuth scope(s): profile.",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 0,
		});

		await persistAccountPool([createTokenResult("acct-1", "rt-new")], false);

		const loaded = await loadAccounts();
		expect(loaded?.accounts).toHaveLength(1);
		expect(loaded?.accounts[0]?.refreshToken).toBe("rt-new");
		expect(loaded?.accounts[0]?.enabled).not.toBe(false);
		expect(loaded?.accounts[0]?.accountNote).toBeUndefined();
	});

	// Issue #213: a blank scope reaching storage is indistinguishable from
	// "granted nothing" at load time, and would disable the account.
	it("never persists a blank oauthScope for a fresh login", async () => {
		await persistAccountPool(
			[
				{
					type: "success",
					access: jwtWithEmail("user@example.com"),
					refresh: "refresh-blank-scope",
					expires: Date.now() + 60_000,
					scope: "   ",
				},
			],
			false,
		);

		const loaded = await loadAccounts();
		expect(loaded?.accounts).toHaveLength(1);
		expect(loaded?.accounts[0]?.oauthScope).toBeUndefined();
	});

	it("does not let a blank scope overwrite a stored one on re-login", async () => {
		await persistAccountPool(
			[
				{
					type: "success",
					access: jwtWithEmail("user@example.com"),
					refresh: "refresh-scoped",
					expires: Date.now() + 60_000,
					scope: "openid profile email offline_access",
				},
			],
			false,
		);
		await persistAccountPool(
			[
				{
					type: "success",
					access: jwtWithEmail("user@example.com"),
					refresh: "refresh-scoped-2",
					expires: Date.now() + 60_000,
					scope: "",
				},
			],
			false,
		);

		const loaded = await loadAccounts();
		expect(loaded?.accounts).toHaveLength(1);
		expect(loaded?.accounts[0]?.oauthScope).toBe("openid profile email offline_access");
	});

	it("normalizes a padded scope before persisting it", async () => {
		await persistAccountPool(
			[
				{
					type: "success",
					access: jwtWithEmail("user@example.com"),
					refresh: "refresh-padded",
					expires: Date.now() + 60_000,
					scope: "  openid   profile\temail offline_access  ",
				},
			],
			false,
		);

		const loaded = await loadAccounts();
		expect(loaded?.accounts[0]?.oauthScope).toBe("openid profile email offline_access");
	});

	it("keeps two genuinely distinct emails as separate accounts (control)", async () => {
		await persistAccountPool(
			[{ type: "success", access: jwtWithEmail("user@example.com"), refresh: "r-a", expires: Date.now() + 60_000 }],
			false,
		);
		await persistAccountPool(
			[{ type: "success", access: jwtWithEmail("other@example.com"), refresh: "r-b", expires: Date.now() + 60_000 }],
			false,
		);
		const loaded = await loadAccounts();
		// Distinct emails must NOT be merged — proves the merge test is non-vacuous.
		expect(loaded?.accounts).toHaveLength(2);
	});


	it("serializes overlapping login persists without losing accounts", async () => {
		const originalRename = fs.rename.bind(fs);
		let firstRenameReleased = false;
		let resolveFirstRename: (() => void) | undefined;
		const firstRenameBlocked = new Promise<void>((resolve) => {
			resolveFirstRename = resolve;
		});
		let resolveFirstRenameStarted: (() => void) | undefined;
		const firstRenameStarted = new Promise<void>((resolve) => {
			resolveFirstRenameStarted = resolve;
		});
		let renameCount = 0;

		const renameSpy = vi
			.spyOn(fs, "rename")
			.mockImplementation(async (sourcePath, destinationPath) => {
				renameCount += 1;
				if (renameCount === 1 && !firstRenameReleased) {
					resolveFirstRenameStarted?.();
					await firstRenameBlocked;
					firstRenameReleased = true;
				}
				return originalRename(sourcePath, destinationPath);
			});

		try {
			const firstPersist = persistAccountPool(
				[createTokenResult("acct-a", "refresh-a")],
				false,
			);
			await firstRenameStarted;

			const secondPersist = persistAccountPool(
				[createTokenResult("acct-b", "refresh-b")],
				false,
			);

			resolveFirstRename?.();
			await Promise.all([firstPersist, secondPersist]);

			// Count only the renames that publish the accounts file. The
			// pre-write credential snapshotter swaps its own file through the
			// same `fs.rename`, so a raw call count also counts snapshots.
			const accountFileRenames = renameSpy.mock.calls.filter(
				([, destinationPath]) => destinationPath === storagePath,
			);
			expect(accountFileRenames).toHaveLength(2);
			const loaded = await loadAccounts();
			expect(loaded?.accounts).toHaveLength(2);
			expect(
				new Set(loaded?.accounts.map((account) => account.accountId)),
			).toEqual(new Set(["acct-a", "acct-b"]));
		} finally {
			resolveFirstRename?.();
		}
	});
});

describe("login-runner selection finalization", () => {
	it("applies flagged-account fallbacks without overwriting resolved ids", () => {
		const selection = resolveAccountSelection({
			type: "success",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			idToken: "id-token",
			accountIdOverride: "resolved-account",
			organizationIdOverride: "resolved-org",
			accountLabel: "Resolved label",
		});

		const updated = applyAccountSelectionFallbacks(selection, {
			accountIdOverride: "flagged-account",
			accountIdSource: "manual",
			organizationIdOverride: "flagged-org",
			accountLabel: "Flagged label",
		});

		expect(updated.primary.accountIdOverride).toBe("resolved-account");
		expect(updated.primary.organizationIdOverride).toBe("resolved-org");
		expect(updated.primary.accountLabel).toBe("Resolved label");
		expect(updated.variantsForPersistence).toHaveLength(selection.variantsForPersistence.length);
	});

	it("updates cloned primary variants without relying on object identity", () => {
		const primary: TokenSuccessWithAccount = {
			type: "success",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			idToken: "id-token",
			accountIdOverride: "resolved-account",
			accountIdSource: "token",
		};
		const selection: AccountSelectionResult = {
			primary,
			variantsForPersistence: [{ ...primary }],
		};

		const updated = applyAccountSelectionFallbacks(selection, {
			organizationIdOverride: "resolved-org",
			accountLabel: "Resolved label",
		});

		expect(updated.primary.organizationIdOverride).toBe("resolved-org");
		expect(updated.primary.accountLabel).toBe("Resolved label");
		expect(updated.variantsForPersistence).toHaveLength(1);
		expect(updated.variantsForPersistence[0]).toBe(updated.primary);
		expect(updated.variantsForPersistence[0]?.organizationIdOverride).toBe("resolved-org");
		expect(updated.variantsForPersistence[0]?.accountLabel).toBe("Resolved label");
	});

	it("resolves and persists the selected variants through the shared callback", async () => {
		const persistSelections = vi.fn(async () => {});
		const result = await resolveAndPersistAccountSelection(
			{
				type: "success",
				access: "persist-access",
				refresh: "persist-refresh",
				expires: Date.now() + 60_000,
				idToken: "persist-id",
			},
			{
				persistSelections,
				replaceAll: true,
				fallbacks: {
					accountIdOverride: "flagged-account",
					accountIdSource: "manual",
					accountLabel: "Flagged label",
				},
			},
		);

		expect(result.primary.accountIdOverride).toBe("flagged-account");
		expect(result.primary.accountLabel).toBe("Flagged label");
		expect(persistSelections).toHaveBeenCalledTimes(1);
		expect(persistSelections).toHaveBeenCalledWith(result.variantsForPersistence, true);
	});

	it("returns the selection unchanged when no persist callback is provided", async () => {
		const selection = resolveAccountSelection({
			type: "success",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			idToken: "id-token",
		});

		await expect(persistResolvedAccountSelection(selection)).resolves.toBe(selection);
	});

	it("propagates persist callback failures", async () => {
		const selection = resolveAccountSelection({
			type: "success",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			idToken: "id-token",
		});
		const persistError = new Error("persist failed");
		const persistSelections = vi.fn(async () => {
			throw persistError;
		});

		const result = persistResolvedAccountSelection(selection, { persistSelections });
		await expect(
			result,
		).rejects.toThrow("Failed to persist authenticated account selections.");
		await expect(
			result,
		).rejects.not.toThrow("persist failed");
		const wrapped = await result.catch((error) => error as Error & { cause?: unknown });

		expect(wrapped.cause).toBe(persistError);
		expect(wrapped.message).not.toContain("persist failed");
		expect(
			wrapped.message,
		).toBe("Failed to persist authenticated account selections.");
		expect(persistSelections).toHaveBeenCalledTimes(1);
	});

	it("redacts sensitive persistence callback failure details", async () => {
		const selection = resolveAccountSelection({
			type: "success",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			idToken: "id-token",
		});
		const persistSelections = vi.fn(async () => {
			throw new Error(
				"EPERM: rename C:\\Users\\neil\\.opencode\\secrets\\token-file.json for acct-123",
			);
		});

		const wrapped = await persistResolvedAccountSelection(selection, {
			persistSelections,
		}).catch((error) => error as Error & { cause?: unknown });

		expect(wrapped.message).toBe("Failed to persist authenticated account selections.");
		expect(wrapped.message).not.toContain("token-file");
		expect(wrapped.message).not.toContain("acct-123");
		expect(persistSelections).toHaveBeenCalledTimes(1);
	});
});

describe("mergeStoredAccountPair (credential merge semantics)", () => {
	// Audit top-20 #10: `||` allowed an intentionally cleared (empty-string)
	// token on the newer record to fall back to the older record's stale token,
	// effectively resurrecting credentials the caller had already cleared.
	it("does not resurrect an older token when the newer record has an explicit empty-string token", () => {
		const base = {
			addedAt: 1_000,
			lastUsed: 1_000,
			rateLimitResetTimes: {},
		};
		const older = {
			...base,
			refreshToken: "older-refresh",
			accessToken: "older-access",
			expiresAt: 2_000,
		};
		const newer = {
			...base,
			lastUsed: 2_000,
			refreshToken: "",
			accessToken: "",
			expiresAt: 3_000,
		};

		const merged = mergeStoredAccountPair(older, newer);

		// Newer wins on recency. Empty strings are NOT null/undefined, so
		// nullish-coalescing keeps them — the stale older token stays buried.
		expect(merged.refreshToken).toBe("");
		expect(merged.accessToken).toBe("");
		expect(merged.expiresAt).toBe(3_000);
	});

	it("falls back to the older token when the newer token is genuinely absent (undefined)", () => {
		const older = {
			addedAt: 1_000,
			lastUsed: 1_000,
			rateLimitResetTimes: {},
			refreshToken: "older-refresh",
			accessToken: "older-access",
			expiresAt: 2_000,
		};
		const newer = {
			addedAt: 2_000,
			lastUsed: 2_000,
			rateLimitResetTimes: {},
			// tokens undefined (not empty string)
		};

		const merged = mergeStoredAccountPair(older, newer);

		expect(merged.refreshToken).toBe("older-refresh");
		expect(merged.accessToken).toBe("older-access");
		expect(merged.expiresAt).toBe(2_000);
	});

	it("prefers the newer record's token over the older record's token when both are non-empty", () => {
		const older = {
			addedAt: 1_000,
			lastUsed: 1_000,
			rateLimitResetTimes: {},
			refreshToken: "older-refresh",
		};
		const newer = {
			addedAt: 2_000,
			lastUsed: 2_000,
			rateLimitResetTimes: {},
			refreshToken: "newer-refresh",
		};

		expect(mergeStoredAccountPair(older, newer).refreshToken).toBe("newer-refresh");
	});

	it("disables the merged record if either input had enabled:false (fail-closed)", () => {
		const a = {
			addedAt: 1,
			lastUsed: 1,
			rateLimitResetTimes: {},
			enabled: true,
		};
		const b = {
			addedAt: 2,
			lastUsed: 2,
			rateLimitResetTimes: {},
			enabled: false,
		};

		expect(mergeStoredAccountPair(a, b).enabled).toBe(false);
		expect(mergeStoredAccountPair(b, a).enabled).toBe(false);
	});

	it("carries the winning stamp's provenance through the quota-exhaustion merge", () => {
		const now = Date.now();
		const a = {
			addedAt: 1,
			lastUsed: 1,
			rateLimitResetTimes: {},
			quotaExhaustedUntil: now + 86_400_000,
			quotaExhaustedStampAt: now - 3_600_000,
		};
		const b = {
			addedAt: 2,
			lastUsed: 2,
			rateLimitResetTimes: {},
			quotaExhaustedUntil: now + 43_200_000,
			quotaExhaustedStampAt: now - 60_000,
		};

		const merged = mergeStoredAccountPair(a, b);

		// Longest stamp wins; its write time travels with it so a later
		// cross-process save still compares correctly against a doctor clear.
		expect(merged.quotaExhaustedUntil).toBe(now + 86_400_000);
		expect(merged.quotaExhaustedStampAt).toBe(now - 3_600_000);
		expect(merged.quotaExhaustedClearedAt).toBeUndefined();
	});

	it("keeps the later doctor-clear tombstone when no stamp survives the merge", () => {
		const now = Date.now();
		const a = {
			addedAt: 1,
			lastUsed: 1,
			rateLimitResetTimes: {},
			quotaExhaustedClearedAt: now - 3_600_000,
		};
		const b = {
			addedAt: 2,
			lastUsed: 2,
			rateLimitResetTimes: {},
			quotaExhaustedClearedAt: now - 60_000,
		};

		const merged = mergeStoredAccountPair(a, b);

		// No stamp on either side: the later clear wins, so a re-login cannot
		// resurrect what doctor cleared.
		expect(merged.quotaExhaustedUntil).toBeUndefined();
		expect(merged.quotaExhaustedStampAt).toBeUndefined();
		expect(merged.quotaExhaustedClearedAt).toBe(now - 60_000);
	});
});

describe("login-runner account and quota identities", () => {
	let testDir: string;
	let storagePath: string;

	beforeEach(async () => {
		testDir = join(
			tmpdir(),
			`login-runner-identity-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		storagePath = join(testDir, "oc-codex-multi-auth-accounts.json");
		await fs.mkdir(testDir, { recursive: true });
		setStoragePathDirect(storagePath);
	});

	afterEach(async () => {
		setStoragePathDirect(null);
		vi.restoreAllMocks();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	const encodeJwt = (payload: Record<string, unknown>): string => {
		const b64 = (value: unknown) =>
			Buffer.from(JSON.stringify(value)).toString("base64url");
		return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
	};

	const businessAccessTokenFor = (
		chatgptAccountId: string,
		accountUserId: string,
		email: string,
	): string =>
		encodeJwt({
			[JWT_CLAIM_PATH]: {
				chatgpt_account_id: chatgptAccountId,
				chatgpt_account_user_id: accountUserId,
				email,
			},
		});

	it("keeps two Business members with the same workspace account id separate", async () => {
		const persistMember = async (
			memberId: string,
			email: string,
			refresh: string,
		): Promise<void> => {
			await persistAccountPool(
				[
					{
						type: "success",
						access: businessAccessTokenFor("business-account", memberId, email),
						refresh,
						expires: Date.now() + 60_000,
					},
				],
				false,
			);
		};

		await persistMember("member-owner", "owner@example.com", "refresh-owner");
		await persistMember("member-invited", "invited@example.com", "refresh-invited");

		let stored = await loadAccounts();
		expect(stored?.accounts).toHaveLength(2);
		expect(stored?.accounts.map((account) => account.accountId)).toEqual([
			"business-account",
			"business-account",
		]);
		expect(stored?.accounts.map((account) => account.accountUserId)).toEqual([
			"member-owner",
			"member-invited",
		]);
		expect(stored?.accounts.map((account) => account.refreshToken)).toEqual([
			"refresh-owner",
			"refresh-invited",
		]);

		await persistMember("member-owner", "owner@example.com", "refresh-owner-new");
		stored = await loadAccounts();
		expect(stored?.accounts).toHaveLength(2);
		expect(stored?.accounts.map((account) => account.refreshToken)).toEqual([
			"refresh-owner-new",
			"refresh-invited",
		]);
	});

	const loginAs = async (
		workspaceId: string,
		memberId: string,
		email: string,
		refresh: string,
	): Promise<void> => {
		await persistAccountPool(
			[
				{
					type: "success",
					access: businessAccessTokenFor(workspaceId, memberId, email),
					refresh,
					expires: Date.now() + 60_000,
				},
			],
			false,
		);
	};

	it("reports a re-login of a stored seat as an in-place update", async () => {
		const infoSpy = vi.spyOn(loggerModule, "logInfo");
		await loginAs("workspace-a", "member-a", "a@example.com", "refresh-a");
		infoSpy.mockClear();

		await loginAs("workspace-a", "member-a", "a@example.com", "refresh-a-new");

		expect(await loadAccounts().then((stored) => stored?.accounts)).toHaveLength(1);
		expect(infoSpy).toHaveBeenCalledWith(
			expect.stringContaining("Login updated Account 1"),
		);
		expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("in place"));
		expect(infoSpy).not.toHaveBeenCalledWith(
			expect.stringContaining("as a NEW account"),
		);
	});

	it("reports a new seat in a stored workspace as an addition, naming the slot it did not repair", async () => {
		const infoSpy = vi.spyOn(loggerModule, "logInfo");
		await loginAs("workspace-a", "member-a", "first@example.com", "refresh-a");
		infoSpy.mockClear();

		await loginAs("workspace-a", "member-b", "second@example.com", "refresh-b");

		expect(await loadAccounts().then((stored) => stored?.accounts)).toHaveLength(2);
		expect(infoSpy).toHaveBeenCalledWith(
			expect.stringContaining("Login added Account 2"),
		);
		expect(infoSpy).toHaveBeenCalledWith(
			expect.stringContaining("as a NEW account"),
		);
		expect(infoSpy).toHaveBeenCalledWith(
			expect.stringContaining("Same workspace id as Account 1."),
		);
		// Only slots are named. An email on this line would be the one identity
		// surface that ignores `maskEmail`.
		const messages = infoSpy.mock.calls.map(([message]) => String(message));
		expect(messages.join("\n")).not.toContain("example.com");
	});

	it("names the slot sharing an email when a new seat is added under a different workspace", async () => {
		const infoSpy = vi.spyOn(loggerModule, "logInfo");
		await loginAs("workspace-a", "member-a", "shared@example.com", "refresh-a");
		infoSpy.mockClear();

		await loginAs("workspace-b", "member-b", "shared@example.com", "refresh-b");

		expect(await loadAccounts().then((stored) => stored?.accounts)).toHaveLength(2);
		expect(infoSpy).toHaveBeenCalledWith(
			expect.stringContaining("Same email as Account 1."),
		);
		expect(infoSpy).not.toHaveBeenCalledWith(
			expect.stringContaining("Same workspace id as"),
		);
	});

	// Reads the array the runner hands to `persist`, because reading it back
	// through the storage layer cannot see this: `saveAccounts` normalizes on
	// write using the same org|account|member seat key, so it merges same-seat
	// records itself and hides whether the prune did anything.
	const prunedAccountsFor = async (
		stored: AccountMetadataV3[],
		result: TokenSuccessWithAccount,
	): Promise<AccountMetadataV3[]> => {
		let persisted: AccountStorageV3 | undefined;
		const transaction = vi
			.spyOn(loadSaveModule, "withAccountStorageTransaction")
			.mockImplementation(<T>(
				handler: (
					current: AccountStorageV3 | null,
					persist: (storage: AccountStorageV3) => Promise<void>,
				) => Promise<T>,
			): Promise<T> =>
				handler(
					{ version: 3, accounts: stored, activeIndex: 0, activeIndexByFamily: {} },
					async (storage) => {
						persisted = storage;
					},
				));
		try {
			await persistAccountPool([result], false);
		} finally {
			transaction.mockRestore();
		}
		return persisted?.accounts ?? [];
	};

	/** A login for a seat none of the seeded records hold, so only the prune acts on them. */
	const unrelatedSeatLogin = (): TokenSuccessWithAccount => ({
		type: "success",
		access: businessAccessTokenFor("workspace-z", "member-z", "z@example.com"),
		refresh: "refresh-z",
		expires: Date.now() + 60_000,
	});

	it("merges two records of one seat that carry different refresh tokens", async () => {
		const accounts = await prunedAccountsFor(
			[
				{
					accountId: "workspace-a",
					accountUserId: "member-a",
					email: "a@example.com",
					refreshToken: "refresh-stale",
					addedAt: 1_000,
					lastUsed: 1_000,
				},
				{
					accountId: "workspace-a",
					accountUserId: "member-a",
					email: "a@example.com",
					refreshToken: "refresh-current",
					addedAt: 2_000,
					lastUsed: 2_000,
				},
			],
			unrelatedSeatLogin(),
		);

		const seat = accounts.filter((account) => account.accountUserId === "member-a");
		expect(seat).toHaveLength(1);
		expect(seat[0]?.refreshToken).toBe("refresh-current");
		expect(accounts).toHaveLength(2);
	});

	it("keeps two email-only records with different refresh tokens apart", async () => {
		const accounts = await prunedAccountsFor(
			[
				{
					email: "shared@example.com",
					refreshToken: "refresh-1",
					addedAt: 1_000,
					lastUsed: 1_000,
				},
				{
					email: "shared@example.com",
					refreshToken: "refresh-2",
					addedAt: 2_000,
					lastUsed: 2_000,
				},
			],
			unrelatedSeatLogin(),
		);

		expect(accounts.map((account) => account.refreshToken)).toEqual([
			"refresh-1",
			"refresh-2",
			"refresh-z",
		]);
	});

	/** An access token that names one ChatGPT account, the unit the backend meters. */
	const accessTokenFor = (chatgptAccountId: string): string =>
		encodeJwt({ [JWT_CLAIM_PATH]: { chatgpt_account_id: chatgptAccountId } });

	/**
	 * An id_token from a login with `id_token_add_organizations=true`: it lists
	 * every organization the Apple ID belongs to, not just the active one.
	 */
	const idTokenFor = (
		organizations: Array<Record<string, unknown>>,
		extra: Record<string, unknown> = {},
	): string => encodeJwt({ [JWT_CLAIM_PATH]: { organizations, ...extra } });

	it("persists the token account, not one entry per organization", () => {
		const selection = resolveAccountSelection({
			type: "success",
			access: accessTokenFor("chatgpt-team-account"),
			refresh: "refresh-team",
			expires: Date.now() + 60_000,
			idToken: idTokenFor([
				{
					organization_id: "org-acme",
					name: "Acme",
					is_default: true,
					is_personal: false,
				},
				{
					organization_id: "org-personal",
					name: "Personal",
					is_personal: true,
				},
			]),
		});

		// Two organizations, one OAuth token, therefore one quota pool.
		expect(selection.variantsForPersistence).toHaveLength(1);
		expect(selection.variantsForPersistence[0]).toBe(selection.primary);
		expect(selection.primary.accountIdOverride).toBe("chatgpt-team-account");
		expect(selection.primary.accountIdSource).toBe("token");
		// The active organization still supplies the org id used for dedupe.
		expect(selection.primary.organizationIdOverride).toBe("org-acme");
		// ...but not the label: those organizations are the API-platform orgs
		// `id_token_add_organizations=true` returns, not ChatGPT workspaces.
		expect(selection.primary.accountLabel).toBeUndefined();
	});

	it("never names an account after an API organization", () => {
		const selection = resolveAccountSelection({
			type: "success",
			access: encodeJwt({
				[JWT_CLAIM_PATH]: {
					chatgpt_account_id: "2aae3eeb-f7fd-4b2d-96c1-413d33c487c4",
					chatgpt_plan_type: "pro",
				},
				email: "oferty@nowaker.net",
			}),
			refresh: "refresh-personal",
			expires: Date.now() + 60_000,
			idToken: idTokenFor([
				{
					organization_id: "org-yRC81tihk0WYRlMQpBEW4A2Q",
					name: "DreamHost API",
					role: "owner",
					is_default: true,
					is_personal: false,
				},
			]),
		});

		// No label at all: "DreamHost API (role:owner)" named an API-platform
		// organization rather than the ChatGPT subscription, and restating the
		// email and account id here would print each identity twice and put the
		// unmasked address back on every surface that renders a label verbatim.
		expect(selection.primary.accountLabel).toBeUndefined();
		expect(selection.primary.accountIdOverride).toBe(
			"2aae3eeb-f7fd-4b2d-96c1-413d33c487c4",
		);
		expect(selection.primary.planType).toBe("pro");
	});

	it("gives each workspace login its own entry, token and quota", async () => {
		// The #226 repro: one Apple ID, two workspace subscriptions, one
		// `auth login` per workspace.
		await persistAccountPool(
			[
				resolveAccountSelection({
					type: "success",
					access: accessTokenFor("account-team"),
					refresh: "refresh-team",
					expires: Date.now() + 60_000,
					idToken: idTokenFor([
						{ organization_id: "org-acme", name: "Acme", is_default: true },
					]),
				}).primary,
			],
			false,
		);
		await persistAccountPool(
			[
				resolveAccountSelection({
					type: "success",
					access: accessTokenFor("account-plus"),
					refresh: "refresh-plus",
					expires: Date.now() + 60_000,
					idToken: idTokenFor([
						{ organization_id: "org-solo", name: "Solo", is_default: true },
					]),
				}).primary,
			],
			false,
		);

		const stored = await loadAccounts();
		expect(stored?.accounts).toHaveLength(2);
		// Distinct ChatGPT account ids are what make these distinct quota pools;
		// distinct refresh tokens are what stop the second login overwriting the
		// first.
		expect(stored?.accounts.map((account) => account.accountId)).toEqual([
			"account-team",
			"account-plus",
		]);
		expect(stored?.accounts.map((account) => account.refreshToken)).toEqual([
			"refresh-team",
			"refresh-plus",
		]);
	});

	it("re-logging in under the same workspace updates in place", async () => {
		for (const refresh of ["refresh-first", "refresh-second"]) {
			await persistAccountPool(
				[
					resolveAccountSelection({
						type: "success",
						access: accessTokenFor("account-team"),
						refresh,
						expires: Date.now() + 60_000,
						idToken: idTokenFor([
							{ organization_id: "org-acme", name: "Acme", is_default: true },
						]),
					}).primary,
				],
				false,
			);
		}

		const stored = await loadAccounts();
		expect(stored?.accounts).toHaveLength(1);
		expect(stored?.accounts[0]?.refreshToken).toBe("refresh-second");
	});

	it("falls back to the id_token account when the access token carries no account id", () => {
		const selection = resolveAccountSelection({
			type: "success",
			access: encodeJwt({ [JWT_CLAIM_PATH]: {} }),
			refresh: "refresh-idtoken",
			expires: Date.now() + 60_000,
			idToken: encodeJwt({
				[JWT_CLAIM_PATH]: {
					chatgpt_account_id: "id-token-account",
					organizations: [
						{ organization_id: "org-acme", name: "Acme", is_default: true },
					],
				},
			}),
		});

		expect(selection.variantsForPersistence).toHaveLength(1);
		expect(selection.primary.accountIdOverride).toBe("id-token-account");
		expect(selection.primary.accountIdSource).toBe("id_token");
	});

	it("still persists two records that share a refresh token but differ by accountId", async () => {
		// Guards the persistAccountPool dedup path directly. resolveAccountSelection
		// no longer emits shared-token variants, but stored pools written before
		// this change - or by an explicit multi-record persist - must not collapse.
		await persistAccountPool(
			[
				{
					type: "success",
					access: accessTokenFor("account-one"),
					refresh: "refresh-shared",
					expires: Date.now() + 60_000,
					accountIdOverride: "account-one",
					accountIdSource: "token",
				},
				{
					type: "success",
					access: accessTokenFor("account-two"),
					refresh: "refresh-shared",
					expires: Date.now() + 60_000,
					accountIdOverride: "account-two",
					accountIdSource: "token",
				},
			],
			false,
		);

		const stored = await loadAccounts();
		expect(stored?.accounts.map((account) => account.accountId).sort()).toEqual([
			"account-one",
			"account-two",
		]);
	});
});
