import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/refresh-queue.js", () => ({
	queuedRefresh: vi.fn(),
}));

import { queuedRefresh } from "../lib/refresh-queue.js";
import {
	loadAccounts,
	saveAccounts,
	setStoragePathDirect,
	withAccountStorageTransaction,
} from "../lib/storage.js";
import { refreshAndPersistAccount } from "../lib/tools/refresh-account.js";

const identity = {
	organizationId: "organization-1",
	accountId: "workspace-1",
	accountUserId: "member-1",
	refreshToken: "refresh-0",
} as const;

describe("persisted refresh coordination", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "oc-codex-refresh-coordination-"));
		setStoragePathDirect(join(directory, "accounts.json"));
		vi.mocked(queuedRefresh).mockReset().mockRejectedValue(
			new Error("Unexpected OAuth exchange"),
		);
	});

	afterEach(async () => {
		setStoragePathDirect(null);
		await rm(directory, { recursive: true, force: true });
	});

	async function seedAccount(overrides: Readonly<Record<string, unknown>> = {}): Promise<void> {
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					...identity,
					accessToken: "access-0",
					expiresAt: 0,
					addedAt: 1,
					lastUsed: 1,
					...overrides,
				},
			],
		});
	}

	it("adopts a rotation already committed for the same stable workspace identity", async () => {
		// given
		await seedAccount({
			refreshToken: "refresh-1",
			accessToken: "access-1",
			expiresAt: 2_000_000_000_000,
			tokenRotatedAt: 10,
		});

		// when
		const outcome = await refreshAndPersistAccount({ index: 0, identity });

		// then
		expect(outcome).toMatchObject({
			status: "refreshed",
			result: {
				refreshToken: "refresh-1",
				accessToken: "access-1",
				rotatedAt: 10,
			},
		});
		expect(queuedRefresh).not.toHaveBeenCalled();
	});

	it("fails closed when only a consumed token could match multiple rotated accounts", async () => {
		// given
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "refresh-1a",
					accessToken: "access-1a",
					expiresAt: 2_000_000_000_000,
					addedAt: 1,
					lastUsed: 1,
				},
				{
					refreshToken: "refresh-1b",
					accessToken: "access-1b",
					expiresAt: 2_000_000_000_000,
					addedAt: 2,
					lastUsed: 2,
				},
			],
		});

		// when
		const outcome = await refreshAndPersistAccount({
			index: 0,
			identity: { refreshToken: "refresh-0" },
		});

		// then
		expect(outcome).toMatchObject({
			status: "failed",
			error: expect.stringMatching(/ambiguous/i),
		});
		expect(queuedRefresh).not.toHaveBeenCalled();
	});

	it("advances tokenRotatedAt monotonically when the wall clock is behind", async () => {
		// given
		const futureRotation = Date.now() + 60_000;
		await seedAccount({ tokenRotatedAt: futureRotation });
		vi.mocked(queuedRefresh).mockResolvedValue({
			type: "success",
			access: "access-1",
			refresh: "refresh-1",
			expires: 2_000_000_000_000,
		});

		// when
		await refreshAndPersistAccount({ index: 0, identity });

		// then
		const stored = await loadAccounts();
		expect(stored?.accounts[0]?.tokenRotatedAt).toBeGreaterThan(futureRotation);
	});

	it("preserves a metadata mutation committed before the rotated token", async () => {
		// given
		await seedAccount();
		let finishRefresh: ((value: {
			type: "success";
			access: string;
			refresh: string;
			expires: number;
		}) => void) | undefined;
		let notifyRefreshStarted: (() => void) | undefined;
		const refreshStarted = new Promise<void>((resolve) => {
			notifyRefreshStarted = resolve;
		});
		vi.mocked(queuedRefresh).mockImplementation(
			() =>
				new Promise((resolve) => {
					finishRefresh = resolve;
					notifyRefreshStarted?.();
				}),
		);
		const refresh = refreshAndPersistAccount({ index: 0, identity });
		await refreshStarted;
		const metadataMutation = withAccountStorageTransaction(async (current, persist) => {
			if (!current?.accounts[0]) throw new Error("Expected account fixture");
			current.accounts[0].accountLabel = "metadata-update";
			await persist(current);
		});

		// when
		if (!finishRefresh) throw new Error("Expected refresh to start");
		finishRefresh({
			type: "success",
			access: "access-1",
			refresh: "refresh-1",
			expires: 2_000_000_000_000,
		});
		await Promise.all([refresh, metadataMutation]);

		// then
		const stored = await loadAccounts();
		expect(stored?.accounts[0]).toMatchObject({
			accountLabel: "metadata-update",
			refreshToken: "refresh-1",
		});
	});

	it("refuses to spend the token when the refresh lease was compromised", async () => {
		// given a lease that is reclaimed by another process before the exchange
		await seedAccount();
		const { withRefreshLease } = await import("../lib/storage/transaction-lock.js");
		const { StorageTransactionContentionError } = await import("../lib/errors.js");
		const realLease = vi.mocked(withRefreshLease).getMockImplementation?.();
		const leaseSpy = vi
			.spyOn(await import("../lib/storage/transaction-lock.js"), "withRefreshLease")
			.mockImplementation(async (storagePath, operation) =>
				operation({
					assertValid() {
						throw new StorageTransactionContentionError(storagePath);
					},
				}),
			);

		// when
		const outcome = await refreshAndPersistAccount({ index: 0, identity });

		// then the single-use token is never exchanged
		expect(queuedRefresh).not.toHaveBeenCalled();
		expect(outcome.status).toBe("failed");
		const stored = await loadAccounts();
		expect(stored?.accounts[0]?.refreshToken).toBe("refresh-0");

		leaseSpy.mockRestore();
		if (realLease) vi.mocked(withRefreshLease).mockImplementation(realLease);
	});

	it("blocks a new exchange when a pending rotation journal could not be fully replayed", async () => {
		// given: a leftover journal whose flagged-store replay cannot land
		// (the flagged file is structurally corrupt), plus a healthy pool.
		await seedAccount();
		await writeFile(
			join(directory, "oc-codex-multi-auth-flagged-accounts.json"),
			"{ not valid json",
			"utf-8",
		);
		const journalPath = join(directory, "accounts.json.refresh.pending");
		const journal = {
			version: 1,
			consumedRefreshToken: "consumed-other",
			rotatedRefreshToken: "rotated-other",
			memberId: "member-1",
			recordedAt: Date.now(),
		};
		await writeFile(journalPath, JSON.stringify(journal), "utf-8");

		// when
		const outcome = await refreshAndPersistAccount({ index: 0, identity });

		// then: the refresh refuses rather than spend a fresh token — writing a
		// new journal would overwrite the only record of the earlier rotation.
		expect(outcome.status).toBe("failed");
		expect(outcome.error).toMatch(/locked|journal|pending/i);
		expect(queuedRefresh).not.toHaveBeenCalled();
		// The journal is preserved, not superseded.
		expect(existsSync(journalPath)).toBe(true);
		const preserved = JSON.parse(await readFile(journalPath, "utf-8"));
		expect(preserved.rotatedRefreshToken).toBe("rotated-other");
		// And the healthy account's token was never touched.
		const stored = await loadAccounts();
		expect(stored?.accounts[0]?.refreshToken).toBe("refresh-0");
	});

	it("replays every per-token pending journal and deletes each after its own heal", async () => {
		// given: two stranded rotations by different writers — the per-token
		// journal naming is exactly what lets both survive instead of fighting
		// over one slot (greptile P1 on PR #280: a lease-lost writer used to
		// overwrite the lease holder's only recovery mapping).
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				{ ...identity, accessToken: "access-0", expiresAt: 0, addedAt: 1, lastUsed: 1 },
				{
					...identity,
					accountId: "workspace-2",
					refreshToken: "refresh-stranded",
					accessToken: "access-s",
					expiresAt: 0,
					addedAt: 1,
					lastUsed: 1,
				},
			],
		});
		const journalA = join(directory, "accounts.json.refresh.pending.aaaa1111");
		const journalB = join(directory, "accounts.json.refresh.pending.bbbb2222");
		await writeFile(journalA, JSON.stringify({
			version: 1,
			consumedRefreshToken: "refresh-0",
			rotatedRefreshToken: "refresh-0r",
			memberId: "member-1",
			recordedAt: Date.now(),
		}), "utf-8");
		await writeFile(journalB, JSON.stringify({
			version: 1,
			consumedRefreshToken: "refresh-stranded",
			rotatedRefreshToken: "refresh-stranded-r",
			memberId: "member-1",
			recordedAt: Date.now(),
		}), "utf-8");

		// when
		const outcome = await refreshAndPersistAccount({ index: 0, identity });

		// then: both rotations healed their records before anything spent a
		// token, and both journals are gone — each deleted by its own replay.
		const stored = await loadAccounts();
		expect(stored?.accounts[0]?.refreshToken).toBe("refresh-0r");
		expect(stored?.accounts[1]?.refreshToken).toBe("refresh-stranded-r");
		expect(existsSync(journalA)).toBe(false);
		expect(existsSync(journalB)).toBe(false);
		// The probe picked up the healed record — the exchange spends the
		// ROTATED token (journals stamp expired-access), never the consumed
		// refresh-0.
		expect(queuedRefresh).toHaveBeenCalledTimes(1);
		expect(vi.mocked(queuedRefresh).mock.calls[0]?.[0]).toBe("refresh-0r");
		expect(outcome.status).toBe("failed"); // the exchange mock rejects; the healing already landed
	});

	it("deletes healed journals even when a sibling journal cannot be replayed", async () => {
		// given: one journal that only heals a main-store record (replay lands
		// everywhere it needs to) and one whose replay MUST write the flagged
		// store — where writes are failing. The successful journal must still
		// be retired; a global 'complete' flag would leak it forever.
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				{ ...identity, accessToken: "access-0", expiresAt: 0, addedAt: 1, lastUsed: 1 },
			],
		});
		const flaggedPath = join(directory, "oc-codex-multi-auth-flagged-accounts.json");
		await writeFile(flaggedPath, JSON.stringify({
			version: 1,
			accounts: [{
				refreshToken: "consumed-elsewhere",
				accountUserId: "member-1",
				flaggedAt: 1,
				addedAt: 1,
				lastUsed: 1,
			}],
		}), "utf-8");
		const healed = join(directory, "accounts.json.refresh.pending.aaaa1111");
		const stuck = join(directory, "accounts.json.refresh.pending.zzzz9999");
		await writeFile(healed, JSON.stringify({
			version: 1,
			consumedRefreshToken: "refresh-0",
			rotatedRefreshToken: "refresh-0r",
			memberId: "member-1",
			recordedAt: Date.now() - 1000,
		}), "utf-8");
		await writeFile(stuck, JSON.stringify({
			version: 1,
			consumedRefreshToken: "consumed-elsewhere",
			rotatedRefreshToken: "rotated-elsewhere",
			memberId: "member-1",
			recordedAt: Date.now(),
		}), "utf-8");

		const realRename = fs.rename.bind(fs);
		const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (src, dst) => {
			if (String(dst).includes("flagged-accounts")) {
				throw Object.assign(new Error("simulated flagged write failure"), {
					code: "EIO",
				});
			}
			return realRename(src as string, dst as string);
		});
		try {
			// when
			const outcome = await refreshAndPersistAccount({ index: 0, identity });

			// then: the refresh still refuses (stuck journal survives), but
			// the journal whose replay DID land is already deleted.
			expect(outcome.status).toBe("failed");
			expect(queuedRefresh).not.toHaveBeenCalled();
			expect(existsSync(stuck)).toBe(true);
			expect(existsSync(healed)).toBe(false);
			const stored = await loadAccounts();
			expect(stored?.accounts[0]?.refreshToken).toBe("refresh-0r");
		} finally {
			renameSpy.mockRestore();
		}
	});

	it("replays chained journals in producer order — successors wait", async () => {
		// given: a lost-lease refresh left an `a→b` journal while another
		// holder left `b→c`. A directory-order replay could run `b→c` first,
		// heal nothing, delete it, then `a→b` heals a record onto `b` — and
		// with `b→c` already gone the account strands on a dead token
		// (greptile P1 on PR #280).
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					...identity,
					refreshToken: "a",
					accessToken: "access-a",
					expiresAt: 0,
					addedAt: 1,
					lastUsed: 1,
				},
			],
		});
		// Name the successor so it sorts FIRST — the hostile ordering.
		const successor = join(directory, "accounts.json.refresh.pending.0000aaaa");
		const producer = join(directory, "accounts.json.refresh.pending.zzzz9999");
		await writeFile(successor, JSON.stringify({
			version: 1,
			consumedRefreshToken: "b",
			rotatedRefreshToken: "c",
			memberId: "member-1",
			recordedAt: Date.now(),
		}), "utf-8");
		await writeFile(producer, JSON.stringify({
			version: 1,
			consumedRefreshToken: "a",
			rotatedRefreshToken: "b",
			memberId: "member-1",
			recordedAt: Date.now(),
		}), "utf-8");

		// when
		await refreshAndPersistAccount({ index: 0, identity });

		// then: the record rode the whole chain to `c` — the LIVE token —
		// and both journals retired only after their own heals landed.
		const stored = await loadAccounts();
		expect(stored?.accounts[0]?.refreshToken).toBe("c");
		expect(existsSync(producer)).toBe(false);
		expect(existsSync(successor)).toBe(false);
		// Nothing downstream may ever spend the consumed `a`.
		expect(queuedRefresh).not.toHaveBeenCalledWith("a");
	});

	it("keeps a successor journal pending when its producer cannot replay", async () => {
		// given: `a→b` cannot complete (the flagged store is unreachable) —
		// `b→c` must stay so a later successful replay of `a→b` can still be
		// followed by `b→c` rather than stranding the record on `b`.
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					...identity,
					refreshToken: "a",
					accessToken: "access-a",
					expiresAt: 0,
					addedAt: 1,
					lastUsed: 1,
				},
			],
		});
		await writeFile(
			join(directory, "oc-codex-multi-auth-flagged-accounts.json"),
			"{ not valid json",
			"utf-8",
		);
		const producer = join(directory, "accounts.json.refresh.pending.zzzz9999");
		const successor = join(directory, "accounts.json.refresh.pending.0000aaaa");
		await writeFile(producer, JSON.stringify({
			version: 1,
			consumedRefreshToken: "a",
			rotatedRefreshToken: "b",
			memberId: "member-1",
			recordedAt: Date.now(),
		}), "utf-8");
		await writeFile(successor, JSON.stringify({
			version: 1,
			consumedRefreshToken: "b",
			rotatedRefreshToken: "c",
			memberId: "member-1",
			recordedAt: Date.now(),
		}), "utf-8");

		// when
		const outcome = await refreshAndPersistAccount({ index: 0, identity });

		// then: the refresh refuses; both journals survive for the retry.
		expect(outcome.status).toBe("failed");
		expect(queuedRefresh).not.toHaveBeenCalled();
		expect(existsSync(producer)).toBe(true);
		expect(existsSync(successor)).toBe(true);
		// The main-store half of `a→b` still landed — replay is per-store.
		const stored = await loadAccounts();
		expect(stored?.accounts[0]?.refreshToken).toBe("b");
	});

	it("adopts a serial rotation committed while the exchange was in flight instead of clobbering it", async () => {
		// given: the provider exchange stalls long enough for a serial rotation
		// (another lease holder's commit) to land on the same record.
		await seedAccount();
		let finishRefresh: ((value: {
			type: "success";
			access: string;
			refresh: string;
			expires: number;
		}) => void) | undefined;
		let notifyRefreshStarted: (() => void) | undefined;
		const refreshStarted = new Promise<void>((resolve) => {
			notifyRefreshStarted = resolve;
		});
		vi.mocked(queuedRefresh).mockImplementation(
			() =>
				new Promise((resolve) => {
					finishRefresh = resolve;
					notifyRefreshStarted?.();
				}),
		);
		const refresh = refreshAndPersistAccount({ index: 0, identity });
		await refreshStarted;

		// Another process rotated refresh-0 -> refresh-9 and committed while our
		// exchange of refresh-0 was still in flight.
		await withAccountStorageTransaction(async (current, persist) => {
			if (!current?.accounts[0]) throw new Error("Expected account fixture");
			current.accounts[0].refreshToken = "refresh-9";
			current.accounts[0].accessToken = "access-9";
			current.accounts[0].expiresAt = 2_000_000_000_000;
			current.accounts[0].tokenRotatedAt = 42;
			await persist(current);
		});

		// when our stalled exchange finally returns refresh-1
		if (!finishRefresh) throw new Error("Expected refresh to start");
		finishRefresh({
			type: "success",
			access: "access-1",
			refresh: "refresh-1",
			expires: 2_000_000_000_000,
		});
		const outcome = await refresh;

		// then: the commit refuses to overwrite the live refresh-9 with the
		// now-consumed refresh-1 — the exact dead-account outcome this guard
		// exists for.
		const stored = await loadAccounts();
		expect(stored?.accounts[0]?.refreshToken).toBe("refresh-9");
		expect(outcome).toMatchObject({
			status: "refreshed",
			result: { refreshToken: "refresh-9" },
		});
		// The journal was retargeted at the adopted token so records still
		// holding refresh-0 get healed with a LIVE credential on replay. It is
		// keyed by the consumed token (`refresh.pending.<sha256-16>`), so glob
		// the family rather than a fixed name.
		const journals = (await readdir(directory)).filter((n) =>
			n.startsWith("accounts.json.refresh.pending"),
		);
		expect(journals).toHaveLength(1);
		const journalPath = join(directory, journals[0]!);
		const journal = JSON.parse(await readFile(journalPath, "utf-8"));
		expect(journal).toMatchObject({
			consumedRefreshToken: "refresh-0",
			rotatedRefreshToken: "refresh-9",
		});
	});

	it("does not hold the storage lease across the provider exchange", async () => {
		// given a provider exchange that outlasts the lease acquisition budget
		await seedAccount();
		let finishRefresh: ((value: {
			type: "success";
			access: string;
			refresh: string;
			expires: number;
		}) => void) | undefined;
		let notifyRefreshStarted: (() => void) | undefined;
		const refreshStarted = new Promise<void>((resolve) => {
			notifyRefreshStarted = resolve;
		});
		vi.mocked(queuedRefresh).mockImplementation(
			() =>
				new Promise((resolve) => {
					finishRefresh = resolve;
					notifyRefreshStarted?.();
				}),
		);
		const refresh = refreshAndPersistAccount({ index: 0, identity });
		await refreshStarted;

		// when an unrelated storage write runs while the exchange is still open
		const noteCommitted = await Promise.race([
			withAccountStorageTransaction(async (current, persist) => {
				if (!current?.accounts[0]) throw new Error("Expected account fixture");
				current.accounts[0].accountNote = "written-mid-exchange";
				await persist(current);
				return true;
			}),
			// If the exchange still held the lease, acquisition would burn its whole
			// retry budget and then throw, so a bounded timer is enough to prove the
			// write is not queued behind the network call.
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000)),
		]);

		// then it completes without waiting for the exchange to finish
		expect(noteCommitted).toBe(true);

		if (!finishRefresh) throw new Error("Expected refresh to start");
		finishRefresh({
			type: "success",
			access: "access-1",
			refresh: "refresh-1",
			expires: 2_000_000_000_000,
		});
		await refresh;

		// and the rotated credential still commits on top of it
		const stored = await loadAccounts();
		expect(stored?.accounts[0]).toMatchObject({
			accountNote: "written-mid-exchange",
			refreshToken: "refresh-1",
		});
	}, 20_000);
});
