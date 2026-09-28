import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import {
	lookupCodexCliTokensByEmail,
	setCodexCliTokenCacheForTests,
	type CodexCliTokenCacheEntry,
} from "../lib/accounts/recovery.js";
import type { AccountStorageV3 } from "../lib/storage.js";

const mocks = vi.hoisted(() => ({
	saveAccounts: vi.fn().mockResolvedValue(undefined),
	loadAccounts: vi.fn<(typeof import("../lib/storage.js"))["loadAccounts"]>(),
}));

// Hydration persists through the debounced-save surface; stub the transaction
// layer so the assertion is "did a save run" rather than a real file write.
vi.mock("../lib/storage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/storage.js")>();
	return {
		...actual,
		saveAccounts: mocks.saveAccounts,
		loadAccounts: mocks.loadAccounts,
		withAccountStorageTransaction: vi.fn(
			async (
				handler: (
					current: null,
					persist: (storage: unknown) => Promise<void>,
				) => Promise<unknown>,
			) => handler(null, mocks.saveAccounts as (storage: unknown) => Promise<void>),
		),
	};
});

const T0 = new Date("2026-02-01T12:00:00Z").getTime();
const EMAIL = "user@example.com";
const HOUR = 60 * 60 * 1000;

function storageWith(
	account: Partial<AccountStorageV3["accounts"][number]>,
): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		accounts: [
			{
				refreshToken: "rt-0",
				accountId: "acct-0",
				email: EMAIL,
				addedAt: T0 - HOUR,
				lastUsed: T0 - HOUR,
				...account,
			},
		],
	};
}

function cliCache(
	entries: Record<string, CodexCliTokenCacheEntry>,
): Map<string, CodexCliTokenCacheEntry> {
	return new Map(Object.entries(entries));
}

/**
 * `hydrateFromCodexCli` runs only inside `AccountManager.loadFromDisk` — and
 * the cache read normally early-exits under vitest. The injected override is
 * what makes this path exercisable at all.
 */
describe("Codex CLI hydration (injected cache seam)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		vi.clearAllMocks();
	});

	afterEach(() => {
		setCodexCliTokenCacheForTests(undefined);
		vi.useRealTimers();
	});

	it("hydrates an expired in-memory credential from a fresh cache token", async () => {
		mocks.loadAccounts.mockResolvedValue(
			storageWith({ accessToken: "stale-access", expiresAt: T0 - 1_000 }),
		);
		setCodexCliTokenCacheForTests(
			cliCache({
				[EMAIL]: { accessToken: "cli-fresh", expiresAt: T0 + HOUR },
			}),
		);

		const manager = await AccountManager.loadFromDisk();
		const account = manager.getAccountsSnapshot()[0]!;

		expect(account.access).toBe("cli-fresh");
		expect(account.expires).toBe(T0 + HOUR);
		expect(mocks.saveAccounts).toHaveBeenCalled();
	});

	it("does not overwrite a fresh in-memory credential", async () => {
		mocks.loadAccounts.mockResolvedValue(
			storageWith({ accessToken: "live-access", expiresAt: T0 + 2 * HOUR }),
		);
		setCodexCliTokenCacheForTests(
			cliCache({
				// Fresh but LESS fresh than what we already hold — still no swap.
				[EMAIL]: { accessToken: "cli-fresh", expiresAt: T0 + HOUR },
			}),
		);

		const manager = await AccountManager.loadFromDisk();
		const account = manager.getAccountsSnapshot()[0]!;

		expect(account.access).toBe("live-access");
		expect(account.expires).toBe(T0 + 2 * HOUR);
		expect(mocks.saveAccounts).not.toHaveBeenCalled();
	});

	it("skips an expired cache token even when the in-memory credential is dead", async () => {
		mocks.loadAccounts.mockResolvedValue(
			storageWith({ accessToken: "dead-access", expiresAt: T0 - 1_000 }),
		);
		setCodexCliTokenCacheForTests(
			cliCache({
				[EMAIL]: { accessToken: "cli-expired", expiresAt: T0 - 1 },
			}),
		);

		const manager = await AccountManager.loadFromDisk();
		const account = manager.getAccountsSnapshot()[0]!;

		expect(account.access).toBe("dead-access");
		expect(account.expires).toBe(T0 - 1_000);
		expect(mocks.saveAccounts).not.toHaveBeenCalled();
	});

	it("an UNDATED cache token cannot displace a held credential of unknown expiry", async () => {
		// `expires === undefined` means "unknown", not "expired": the record's
		// access token may be perfectly live. An undated cache entry cannot
		// prove it is fresher, so it must not win — that swap was the freshness
		// inversion.
		mocks.loadAccounts.mockResolvedValue(
			storageWith({ accessToken: "live-undated" }),
		);
		setCodexCliTokenCacheForTests(
			cliCache({ [EMAIL]: { accessToken: "cli-undated" } }),
		);

		const manager = await AccountManager.loadFromDisk();
		const account = manager.getAccountsSnapshot()[0]!;

		expect(account.access).toBe("live-undated");
		expect(account.expires).toBeUndefined();
		expect(mocks.saveAccounts).not.toHaveBeenCalled();
	});

	it("an undated cache token still rescues a KNOWN-expired credential", async () => {
		// The in-memory token is provably dead; a maybe-live cached token is a
		// strictly better bet, so hydration proceeds and leaves `expires` alone
		// for the refresh path to re-derive.
		mocks.loadAccounts.mockResolvedValue(
			storageWith({ accessToken: "dead-access", expiresAt: T0 - 5 }),
		);
		setCodexCliTokenCacheForTests(
			cliCache({ [EMAIL]: { accessToken: "cli-undated" } }),
		);

		const manager = await AccountManager.loadFromDisk();
		const account = manager.getAccountsSnapshot()[0]!;

		expect(account.access).toBe("cli-undated");
		expect(account.expires).toBe(T0 - 5);
		expect(mocks.saveAccounts).toHaveBeenCalled();
	});

	it("a DATED fresh cache token may displace a held credential of unknown expiry", async () => {
		mocks.loadAccounts.mockResolvedValue(
			storageWith({ accessToken: "live-undated" }),
		);
		setCodexCliTokenCacheForTests(
			cliCache({
				[EMAIL]: { accessToken: "cli-dated", expiresAt: T0 + HOUR },
			}),
		);

		const manager = await AccountManager.loadFromDisk();
		const account = manager.getAccountsSnapshot()[0]!;

		expect(account.access).toBe("cli-dated");
		expect(account.expires).toBe(T0 + HOUR);
	});

	it("hydrates an account with no access token at all", async () => {
		mocks.loadAccounts.mockResolvedValue(storageWith({}));
		setCodexCliTokenCacheForTests(
			cliCache({
				[EMAIL]: { accessToken: "cli-fresh", expiresAt: T0 + HOUR },
			}),
		);

		const manager = await AccountManager.loadFromDisk();
		const account = manager.getAccountsSnapshot()[0]!;

		expect(account.access).toBe("cli-fresh");
		expect(account.expires).toBe(T0 + HOUR);
	});

	it("restores the vitest gate when the override is cleared", async () => {
		mocks.loadAccounts.mockResolvedValue(
			storageWith({ accessToken: "stale-access", expiresAt: T0 - 1_000 }),
		);
		// Explicitly cleared: under vitest the real read early-exits, so nothing
		// hydrates and no save runs.
		setCodexCliTokenCacheForTests(undefined);

		const manager = await AccountManager.loadFromDisk();
		const account = manager.getAccountsSnapshot()[0]!;

		expect(account.access).toBe("stale-access");
		expect(mocks.saveAccounts).not.toHaveBeenCalled();
	});

	it("exposes injected entries through lookupCodexCliTokensByEmail", async () => {
		setCodexCliTokenCacheForTests(
			cliCache({
				[EMAIL]: {
					accessToken: "cli-fresh",
					expiresAt: T0 + HOUR,
					accountId: "acct-0",
				},
			}),
		);

		expect(await lookupCodexCliTokensByEmail(EMAIL)).toEqual({
			accessToken: "cli-fresh",
			expiresAt: T0 + HOUR,
			accountId: "acct-0",
		});
		expect(await lookupCodexCliTokensByEmail("nobody@example.com")).toBeNull();
	});
});
