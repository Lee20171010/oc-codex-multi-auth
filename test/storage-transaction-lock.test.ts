import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { lock } from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	getFlaggedAccountsPath,
	setStoragePathDirect,
	withAccountStorageTransaction,
	withFlaggedAccountStorageTransaction,
} from "../lib/storage.js";

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

describe("storage transaction leases", () => {
	let directory: string;
	let storagePath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "oc-codex-transaction-lock-"));
		storagePath = join(directory, "accounts.json");
		await writeFile(
			storagePath,
			JSON.stringify({ version: 3, activeIndex: 0, accounts: [] }),
			{ mode: 0o600 },
		);
		setStoragePathDirect(storagePath);
	});

	afterEach(async () => {
		setStoragePathDirect(null);
		await rm(directory, { recursive: true, force: true });
	});

	it("reports transaction lease contention as a retryable typed error", async () => {
		// given
		const release = await lock(storagePath, {
			realpath: false,
			lockfilePath: `${storagePath}.transaction.lock`,
			stale: 10_000,
			update: 2_000,
		});

		try {
			// when
			const transaction = withAccountStorageTransaction(async () => "unexpected");

			// then
			await expect(transaction).rejects.toMatchObject({
				name: "StorageTransactionContentionError",
				retryable: true,
			});
		} finally {
			await release();
		}
		// The acquisition budget deliberately sums past the 10s stale window
		// (~15s without jitter, up to ~30s with it), so this test has to outlast
		// that rather than the default 5s.
	}, 45_000);

	it("waits out a burst of contention instead of failing fast", async () => {
		// given a holder that keeps the lease for longer than the old ~0.5s budget
		const release = await lock(storagePath, {
			realpath: false,
			lockfilePath: `${storagePath}.transaction.lock`,
			stale: 10_000,
			update: 2_000,
		});
		setTimeout(() => {
			void release();
		}, 1_500);

		// when
		const observed = await withAccountStorageTransaction(async () => "committed");

		// then
		expect(observed).toBe("committed");
	}, 20_000);

	it("creates the storage directory when acquiring a lease for the first time", async () => {
		// given a project-scoped storage path whose directory does not exist yet
		const freshPath = join(directory, "nested", "project", "accounts.json");
		setStoragePathDirect(freshPath);

		// when
		const observed = await withAccountStorageTransaction(async () => {
			// `proper-lockfile` mkdirs the lockfile non-recursively, so acquiring the
			// lease used to fail with a raw ENOENT before the directory existed.
			await access(`${freshPath}.transaction.lock`);
			return "lease-acquired";
		});

		// then
		expect(observed).toBe("lease-acquired");
	});

	it("uses a distinct lease while an advisory storage lock file exists", async () => {
		// given
		await writeFile(`${storagePath}.lock`, JSON.stringify({ pid: 999_999 }), "utf8");

		// when
		const leaseObserved = await withAccountStorageTransaction(async () => {
			await access(`${storagePath}.transaction.lock`);
			return true;
		});

		// then
		expect(leaseObserved).toBe(true);
	});

	it("preserves a committed result when lease release later fails", async () => {
		// given
		const leasePath = `${storagePath}.transaction.lock`;

		// when
		const result = await withAccountStorageTransaction(async (current, persist) => {
			if (!current) throw new Error("Expected account storage fixture");
			current.activeIndex = -1;
			await persist(current);
			await rm(leasePath, { recursive: true, force: true });
			return "committed";
		});

		// then
		expect(result).toBe("committed");
	});

	it("applies an independent lease policy to flagged-account mutations", async () => {
		// given
		const flaggedPath = getFlaggedAccountsPath();
		await mkdir(dirname(flaggedPath), { recursive: true });
		await writeFile(flaggedPath, JSON.stringify({ version: 1, accounts: [] }), { mode: 0o600 });

		// when
		const leaseObserved = await withFlaggedAccountStorageTransaction(async () => {
			await access(`${flaggedPath}.transaction.lock`);
			return true;
		});

		// then
		expect(leaseObserved).toBe(true);
	});

	it("removes the transaction lease after a successful mutation", async () => {
		// given
		const leasePath = `${storagePath}.transaction.lock`;

		// when
		await withAccountStorageTransaction(async () => undefined);

		// then
		await expect(access(leasePath)).rejects.toSatisfy(isMissingFile);
	});
});
