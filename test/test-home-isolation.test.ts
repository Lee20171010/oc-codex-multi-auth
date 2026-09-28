import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { LOG_DIR } from "../lib/logger.js";
import { ACCOUNTS_FILE_NAME } from "../lib/constants.js";
import { loadAccounts, saveAccounts } from "../lib/storage/load-save.js";
import { getConfigDir } from "../lib/storage/paths.js";
import {
	getStoragePath,
	setStoragePath,
	setStoragePathDirect,
} from "../lib/storage/state.js";
import { MINTED_HOME_PREFIX, teardown } from "./global-setup.js";

function realUserHome(): string {
	return userInfo().homedir;
}

/**
 * The real account pool lives in `~/.opencode`, not across the whole home tree.
 *
 * Isolation cannot be expressed as "outside the real home": on Windows
 * `tmpdir()` sits under the user profile, so the sandbox is legitimately a
 * descendant of it and that assertion would fail while isolation was working
 * perfectly. Containment in the sandbox, and separation from the real store,
 * hold on every platform.
 */
function realStoreDir(): string {
	return resolve(realUserHome(), ".opencode");
}

function sandboxHome(): string {
	const home = process.env.OC_CODEX_TEST_HOME;
	if (!home) {
		throw new Error("OC_CODEX_TEST_HOME is unset; vitest.config.ts must mint a sandbox home");
	}
	return home;
}

function isUnder(baseDir: string, targetPath: string): boolean {
	const rel = relative(resolve(baseDir), resolve(targetPath));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function expectSandboxed(path: string): void {
	expect(isUnder(sandboxHome(), path)).toBe(true);
	expect(isUnder(realStoreDir(), path)).toBe(false);
}

describe("test home isolation", () => {
	it("redirects homedir() into the sandbox", () => {
		expect(homedir()).toBe(sandboxHome());
		expect(resolve(homedir())).not.toBe(resolve(realUserHome()));
	});

	it("keeps every resolved account storage path inside the sandbox", () => {
		setStoragePath(null);
		expectSandboxed(getStoragePath());

		// Per-project storage is namespaced under `getConfigDir()` rather than
		// under the project itself, so this follows the redirected home even
		// when the checkout sits inside the real one, as it does on CI.
		setStoragePath(process.cwd());
		expectSandboxed(getStoragePath());

		setStoragePath(null);
		expectSandboxed(getConfigDir());
	});

	// LOG_DIR is captured at module scope from homedir(), so it only lands in
	// the sandbox if the override beat the import. That is the property a
	// setupFiles entry cannot provide and this whole mechanism exists for.
	it("beats module-scope homedir() capture", () => {
		expectSandboxed(LOG_DIR);
	});

	// Where the sandbox is a descendant of the real home, a guard keyed on the
	// home tree alone would refuse this and redden the whole Windows job.
	it("still allows account writes inside the sandbox", async () => {
		// A private path, not the sandbox's own global store: every test file
		// shares this HOME, so writing the real one would hand another file an
		// empty pool mid-run.
		const probeDir = join(sandboxHome(), "sandbox-write-probe");
		const probe = join(probeDir, ACCOUNTS_FILE_NAME);
		setStoragePathDirect(probe);
		try {
			expectSandboxed(probe);
			await expect(
				saveAccounts({ version: 3, accounts: [], activeIndex: 0 }),
			).resolves.toBeUndefined();
			expect(existsSync(probe)).toBe(true);
		} finally {
			setStoragePathDirect(null);
			rmSync(probeDir, { recursive: true, force: true });
		}
	});

	it("refuses to write account storage that escapes into the real home", async () => {
		const escaped = resolve(realUserHome(), ".opencode", ACCOUNTS_FILE_NAME);
		setStoragePathDirect(escaped);
		try {
			await expect(
				saveAccounts({ version: 3, accounts: [], activeIndex: 0 }),
			).rejects.toMatchObject({ code: "TEST_HOME_ESCAPE" });
		} finally {
			setStoragePathDirect(null);
		}
	});

	// A missing project store no longer sends the loader to the global one —
	// global-to-project seeding was removed because it duplicated single-use
	// refresh tokens across scopes. The escape vector this test used to
	// exercise (a flipped HOME re-resolving the global path mid-load) is
	// therefore gone: a project-scoped load must resolve `null` and touch
	// nothing outside the sandbox, even with HOME pointed at the real home.
	it("never reads global storage for a project-scoped miss, even under a leaked HOME", async () => {
		const projectRoot = join(sandboxHome(), "fallback-probe-project");
		mkdirSync(join(projectRoot, ".opencode"), { recursive: true });
		setStoragePath(projectRoot);
		expectSandboxed(getStoragePath());

		// A directory that does not exist, never the real store: should the
		// seeding regression ever return, the read path below would resolve
		// into the real home and the guard would (correctly) throw.
		const restoredHome = join(realUserHome(), `.oc-codex-guard-probe-${process.pid}`);
		const previousHome = process.env.HOME;
		const previousProfile = process.env.USERPROFILE;
		process.env.HOME = restoredHome;
		process.env.USERPROFILE = restoredHome;
		try {
			expect(isUnder(realUserHome(), getConfigDir())).toBe(true);
			await expect(loadAccounts()).resolves.toBeNull();
			expect(existsSync(restoredHome)).toBe(false);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousProfile;
			setStoragePath(null);
			rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	// Guarding writes is not sufficient: a leaked HOME must also fail a READ
	// whose own path escapes the sandbox. `loadAccounts` probes the worktree
	// lock for the active path before reading, and that probe refuses
	// real-home paths — so an escaped global-scope path (re-resolved from a
	// restored HOME at that moment) still trips the guard.
	it("refuses to read account storage that escapes into the real home", async () => {
		const previousHome = process.env.HOME;
		const previousProfile = process.env.USERPROFILE;
		const escaped = join(realUserHome(), `.oc-codex-guard-probe-${process.pid}`);
		process.env.HOME = escaped;
		process.env.USERPROFILE = escaped;
		setStoragePathDirect(null);
		try {
			expect(isUnder(realUserHome(), getConfigDir())).toBe(true);
			await expect(loadAccounts()).rejects.toMatchObject({
				code: "TEST_HOME_ESCAPE",
			});
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousProfile;
			setStoragePathDirect(null);
		}
	});
});

describe("test home teardown", () => {
	// Every case drives `teardown` against a directory this test made, never
	// against the live run's own home, so a broken gate can only destroy scratch.
	const runTeardown = async (
		home: string | undefined,
		owned: boolean,
	): Promise<void> => {
		const previousHome = process.env.OC_CODEX_TEST_HOME;
		const previousOwned = process.env.OC_CODEX_TEST_HOME_OWNED;
		if (home === undefined) delete process.env.OC_CODEX_TEST_HOME;
		else process.env.OC_CODEX_TEST_HOME = home;
		if (owned) process.env.OC_CODEX_TEST_HOME_OWNED = "1";
		else delete process.env.OC_CODEX_TEST_HOME_OWNED;
		try {
			await teardown();
		} finally {
			if (previousHome === undefined) delete process.env.OC_CODEX_TEST_HOME;
			else process.env.OC_CODEX_TEST_HOME = previousHome;
			if (previousOwned === undefined) delete process.env.OC_CODEX_TEST_HOME_OWNED;
			else process.env.OC_CODEX_TEST_HOME_OWNED = previousOwned;
		}
	};

	const mintedLookalike = (): string =>
		mkdtempSync(join(tmpdir(), MINTED_HOME_PREFIX));

	// `vitest.config.ts` spells the prefix as a literal and this module exports
	// it as a constant. Were the two to drift apart, teardown would simply stop
	// matching the home the config minted and the leak would return silently.
	it("agrees with the prefix the config actually minted", () => {
		if (process.env.OC_CODEX_TEST_HOME_OWNED !== "1") return;
		const home = process.env.OC_CODEX_TEST_HOME as string;
		expect(resolve(home).startsWith(resolve(tmpdir(), MINTED_HOME_PREFIX))).toBe(true);
	});

	it("removes a home it minted itself", async () => {
		const home = mintedLookalike();
		expect(existsSync(home)).toBe(true);
		await runTeardown(home, true);
		expect(existsSync(home)).toBe(false);
	});

	// Identical path shape to the case above, so the ownership flag is the only
	// thing left deciding it. A home handed in through the environment belongs
	// to whoever set it.
	it("keeps an inherited home that looks exactly like a minted one", async () => {
		const home = mintedLookalike();
		try {
			await runTeardown(home, false);
			expect(existsSync(home)).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	// The case above only holds while nothing sets the flag for an inherited
	// home. A caller exporting both variables would otherwise have its own
	// directory recursively deleted, so the config must clear what it inherits.
	it("clears an inherited ownership flag rather than trusting it", async () => {
		const previousOwned = process.env.OC_CODEX_TEST_HOME_OWNED;
		process.env.OC_CODEX_TEST_HOME_OWNED = "1";
		try {
			// Re-runs the config's env setup. OC_CODEX_TEST_HOME is already set,
			// so it takes the inherited branch and mints no directory.
			await import("../vitest.config.js");
			expect(process.env.OC_CODEX_TEST_HOME_OWNED).toBeUndefined();
		} finally {
			if (previousOwned === undefined) delete process.env.OC_CODEX_TEST_HOME_OWNED;
			else process.env.OC_CODEX_TEST_HOME_OWNED = previousOwned;
		}
	});

	it("keeps a path outside the temp directory", async () => {
		const scratchRoot = join(process.cwd(), "tmp");
		mkdirSync(scratchRoot, { recursive: true });
		const outside = mkdtempSync(join(scratchRoot, MINTED_HOME_PREFIX));
		try {
			await runTeardown(outside, true);
			expect(existsSync(outside)).toBe(true);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("keeps a temp path that does not carry the minted prefix", async () => {
		const foreign = mkdtempSync(join(tmpdir(), "oc-codex-unrelated-"));
		try {
			await runTeardown(foreign, true);
			expect(existsSync(foreign)).toBe(true);
		} finally {
			rmSync(foreign, { recursive: true, force: true });
		}
	});

	// An interrupted run can leave the env half-set or the directory already
	// gone. Neither may throw, or the failure outlives the run it came from.
	it("tolerates a missing home and an already-removed one", async () => {
		await expect(runTeardown(undefined, true)).resolves.toBeUndefined();

		const home = mintedLookalike();
		await runTeardown(home, true);
		expect(existsSync(home)).toBe(false);
		await expect(runTeardown(home, true)).resolves.toBeUndefined();
	});
});
