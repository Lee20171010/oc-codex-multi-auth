/**
 * `accountUserId` healing inside `normalizeAccountStorage`.
 *
 * The field is untrusted input: a hand-edited or corrupted file can hold a
 * non-string or whitespace-only value. `.trim()` on a non-string would throw
 * (reading as a corrupt file), and a whitespace value would poison identity
 * keys. Both are stripped and the seat id is re-derived from the access token
 * when one is available.
 */

import { describe, expect, it } from "vitest";

import { normalizeAccountStorage } from "../lib/storage.js";

function accountRecord(overrides: Record<string, unknown>) {
	return {
		refreshToken: "refresh-x",
		accountId: "acct-x",
		addedAt: 1,
		lastUsed: 1,
		...overrides,
	};
}

function storageWith(account: Record<string, unknown>) {
	return {
		version: 3,
		activeIndex: 0,
		accounts: [account],
	};
}

describe("storage I/O: accountUserId normalization", () => {
	it("drops a non-string accountUserId instead of throwing", () => {
		const normalized = normalizeAccountStorage(
			storageWith(accountRecord({ accountUserId: 12345 })),
		);
		expect(normalized).not.toBeNull();
		expect(normalized?.accounts[0]?.accountUserId).toBeUndefined();
	});

	it("treats a whitespace-only accountUserId as absent", () => {
		const normalized = normalizeAccountStorage(
			storageWith(accountRecord({ accountUserId: "   " })),
		);
		expect(normalized?.accounts[0]?.accountUserId).toBeUndefined();
	});

	it("trims a padded accountUserId in place", () => {
		const normalized = normalizeAccountStorage(
			storageWith(accountRecord({ accountUserId: "  member-1  " })),
		);
		expect(normalized?.accounts[0]?.accountUserId).toBe("member-1");
	});

	it("keeps a well-formed accountUserId untouched", () => {
		const normalized = normalizeAccountStorage(
			storageWith(accountRecord({ accountUserId: "member-2" })),
		);
		expect(normalized?.accounts[0]?.accountUserId).toBe("member-2");
	});

	it("drops a null accountUserId without touching the account otherwise", () => {
		const normalized = normalizeAccountStorage(
			storageWith(accountRecord({ accountUserId: null })),
		);
		expect(normalized?.accounts[0]?.accountUserId).toBeUndefined();
		expect(normalized?.accounts[0]?.accountId).toBe("acct-x");
	});
});
