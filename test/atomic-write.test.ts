/**
 * Crash-durability coverage for the shared atomic-write path.
 *
 * `writeFileAtomic` is the single primitive every credential write funnels
 * through: temp file (0600) -> fd fsync -> rename -> parent-directory fsync.
 * Temp+rename alone is atomic for readers but NOT durable across a crash —
 * the rename can hit disk while the payload pages are still in writeback,
 * leaving an empty or torn file under the canonical name, which reads back
 * as a wiped account pool. These tests pin the fsync calls (which are the
 * durability half), the 0600 mode, and the export path's atomic+chmod
 * contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	fsyncParentDirectory,
	writeFileAtomic,
	writeFileWithTimeout,
} from "../lib/storage/atomic-write.js";
import {
	clearAccounts,
	exportAccounts,
	saveAccounts,
	setStoragePathDirect,
} from "../lib/storage.js";

async function allocateDir(): Promise<string> {
	const dir = join(
		tmpdir(),
		`atomic-write-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

/** Spy on FileHandle.prototype.sync — both file and directory fsyncs hit it. */
async function spyOnFileSync(): Promise<{
	syncSpy: ReturnType<typeof vi.fn>;
	restore: () => void;
}> {
	const probePath = join(tmpdir(), `atomic-write-probe-${Date.now()}-${Math.random()}`);
	const probe = await fs.open(probePath, "w");
	const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
	await probe.close();
	await fs.unlink(probePath);
	const syncSpy = vi.spyOn(proto, "sync");
	return { syncSpy, restore: () => syncSpy.mockRestore() };
}

describe("writeFileAtomic", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await allocateDir();
	});
	afterEach(async () => {
		try {
			await fs.rm(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("writes content atomically: no temp files left behind", async () => {
		const target = join(dir, "out.json");
		await writeFileAtomic(target, `{"a":1}`);
		expect(await fs.readFile(target, "utf-8")).toBe(`{"a":1}`);
		const leftovers = (await fs.readdir(dir)).filter((n) => n.endsWith(".tmp"));
		expect(leftovers).toHaveLength(0);
	});

	it("overwrites an existing file", async () => {
		const target = join(dir, "out.json");
		await writeFileAtomic(target, "first");
		await writeFileAtomic(target, "second");
		expect(await fs.readFile(target, "utf-8")).toBe("second");
	});

	it.skipIf(process.platform === "win32")(
		"creates the file with mode 0600 (POSIX)",
		async () => {
			const target = join(dir, "out.json");
			await writeFileAtomic(target, "secret");
			const st = await fs.stat(target);
			expect(st.mode & 0o777).toBe(0o600);
		},
	);

	it("fsyncs the temp file before rename AND the parent directory after", async () => {
		const { syncSpy, restore } = await spyOnFileSync();
		try {
			const target = join(dir, "out.json");
			await writeFileAtomic(target, "payload");
			// One fsync on the temp fd before close+rename, one on the directory
			// handle opened by fsyncParentDirectory after the rename.
			expect(syncSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
		} finally {
			restore();
		}
	});

	it("fsyncParentDirectory fsyncs the holding directory", async () => {
		const { syncSpy, restore } = await spyOnFileSync();
		try {
			await fsyncParentDirectory(join(dir, "anything.json"));
			expect(syncSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
		} finally {
			restore();
		}
	});

	it("cleans up the temp file when the rename fails", async () => {
		const target = join(dir, "out.json");
		const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async () => {
			throw Object.assign(new Error("simulated rename failure"), { code: "EXDEV" });
		});
		try {
			await expect(writeFileAtomic(target, "payload")).rejects.toThrow();
		} finally {
			renameSpy.mockRestore();
		}
		expect(existsSync(target)).toBe(false);
		const leftovers = (await fs.readdir(dir)).filter((n) => n.endsWith(".tmp"));
		expect(leftovers).toHaveLength(0);
	});
});

describe("writeFileWithTimeout", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await allocateDir();
	});
	afterEach(async () => {
		try {
			await fs.rm(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("writes content and fsyncs before close", async () => {
		const { syncSpy, restore } = await spyOnFileSync();
		try {
			const target = join(dir, "backup.json");
			await writeFileWithTimeout(target, "payload", 5_000);
			expect(await fs.readFile(target, "utf-8")).toBe("payload");
			expect(syncSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
		} finally {
			restore();
		}
	});

	it("times out when the post-write fsync stalls instead of blocking forever", async () => {
		const { syncSpy, restore } = await spyOnFileSync();
		// A wedged disk most often stalls inside fsync itself: make every
		// FileHandle.sync hang and confirm the write still surfaces ETIMEDOUT
		// on the caller's budget rather than outliving it.
		syncSpy.mockImplementation(() => new Promise<void>(() => {}));
		try {
			const target = join(dir, "backup.json");
			await expect(writeFileWithTimeout(target, "payload", 100)).rejects.toThrow(
				/Timed out/i,
			);
		} finally {
			restore();
		}
	});
});

describe("storage-level crash durability", () => {
	let dir: string;
	let storagePath: string;

	beforeEach(async () => {
		dir = await allocateDir();
		storagePath = join(dir, "accounts.json");
		setStoragePathDirect(storagePath);
	});
	afterEach(async () => {
		setStoragePathDirect(null);
		try {
			await fs.rm(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("saveAccounts goes through the fsynced atomic write path", async () => {
		const { syncSpy, restore } = await spyOnFileSync();
		try {
			await saveAccounts({
				version: 3,
				activeIndex: 0,
				accounts: [{ refreshToken: "rt", addedAt: 1, lastUsed: 1 }],
			});
			expect(existsSync(storagePath)).toBe(true);
			// temp-fd fsync + directory fsync at minimum.
			expect(syncSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
		} finally {
			restore();
		}
	});

	it("clearAccounts fsyncs the directory after the unlink so the deletion is durable", async () => {
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [{ refreshToken: "rt", addedAt: 1, lastUsed: 1 }],
		});
		const { syncSpy, restore } = await spyOnFileSync();
		try {
			await clearAccounts();
			expect(existsSync(storagePath)).toBe(false);
			expect(syncSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
		} finally {
			restore();
		}
	});
});

describe("exportAccounts durability + mode", () => {
	let dir: string;
	let storagePath: string;

	beforeEach(async () => {
		dir = await allocateDir();
		storagePath = join(dir, "accounts.json");
		setStoragePathDirect(storagePath);
		await saveAccounts({
			version: 3,
			activeIndex: 0,
			accounts: [{ refreshToken: "rt", addedAt: 1, lastUsed: 1 }],
		});
	});
	afterEach(async () => {
		setStoragePathDirect(null);
		try {
			await fs.rm(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("exports atomically into a nested directory with parseable content", async () => {
		const exportPath = join(dir, "nested", "export.json");
		await exportAccounts(exportPath);
		const parsed = JSON.parse(await fs.readFile(exportPath, "utf-8"));
		expect(parsed.accounts).toHaveLength(1);
		const nestedLeftovers = (await fs.readdir(join(dir, "nested"))).filter((n) =>
			n.endsWith(".tmp"),
		);
		expect(nestedLeftovers).toHaveLength(0);
	});

	it.skipIf(process.platform === "win32")(
		"export file is 0600, including on force-overwrite of a world-readable file (POSIX)",
		async () => {
			const exportPath = join(dir, "export.json");
			await exportAccounts(exportPath);
			let st = await fs.stat(exportPath);
			expect(st.mode & 0o777).toBe(0o600);

			// Simulate an export that drifted readable, then re-export over it:
			// the mode must be re-asserted, not inherited.
			await fs.chmod(exportPath, 0o644);
			await exportAccounts(exportPath, true);
			st = await fs.stat(exportPath);
			expect(st.mode & 0o777).toBe(0o600);
		},
	);

	it("re-export without force still refuses to overwrite", async () => {
		const exportPath = join(dir, "export.json");
		await exportAccounts(exportPath);
		await expect(exportAccounts(exportPath)).rejects.toThrow(/overwrite/i);
	});
});
