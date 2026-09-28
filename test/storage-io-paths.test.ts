/**
 * Path hardening for project-scope resolution:
 *
 *   - `$HOME` must never be treated as a project root merely because
 *     `~/.opencode` exists — that directory is this plugin's own state dir,
 *     so every first-run home directory would otherwise become one giant
 *     "project" scope;
 *   - other markers (`.git`, `package.json`, …) still make $HOME a legitimate
 *     project root (dotfiles repos);
 *   - project keys are canonical-path based, so a project reached through a
 *     symlinked directory and the same project reached directly share one
 *     storage scope.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	findProjectRoot,
	getProjectStorageKey,
	isProjectDirectory,
} from "../lib/storage/paths.js";

describe("storage I/O: path canonicalization + home guard", () => {
	let workDir: string;
	const originalHome = process.env.HOME;
	const originalUserProfile = process.env.USERPROFILE;

	beforeEach(async () => {
		workDir = join(
			tmpdir(),
			`storage-io-paths-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await fs.mkdir(workDir, { recursive: true });
	});

	afterEach(async () => {
		process.env.HOME = originalHome;
		process.env.USERPROFILE = originalUserProfile;
		await fs.rm(workDir, { recursive: true, force: true });
	});

	it("does not treat $HOME as a project just because ~/.opencode exists", async () => {
		const fakeHome = join(workDir, "home");
		await fs.mkdir(join(fakeHome, ".opencode"), { recursive: true });
		// A real marker ABOVE home makes the assertion deterministic: the walk
		// must skip home and land on the ancestor that is an actual project.
		await fs.writeFile(join(workDir, "package.json"), "{}", "utf-8");
		process.env.HOME = fakeHome;
		process.env.USERPROFILE = fakeHome;

		const root = findProjectRoot(fakeHome);
		// The walk canonicalizes, so compare against the real path (matters on
		// platforms where tmpdir itself is a symlink, e.g. macOS /tmp).
		expect(root).toBe(await fs.realpath(workDir));
	});

	it("still treats $HOME as a project when a real marker exists there", async () => {
		const fakeHome = join(workDir, "home-dotfiles");
		await fs.mkdir(join(fakeHome, ".opencode"), { recursive: true });
		await fs.mkdir(join(fakeHome, ".git"), { recursive: true });
		process.env.HOME = fakeHome;
		process.env.USERPROFILE = fakeHome;

		expect(findProjectRoot(fakeHome)).toBe(await fs.realpath(fakeHome));
	});

	it("keeps isProjectDirectory honest about raw marker presence", async () => {
		const fakeHome = join(workDir, "home-raw");
		await fs.mkdir(join(fakeHome, ".opencode"), { recursive: true });
		// The low-level probe still reports marker presence; the home exclusion
		// lives in the root-candidate check, not in the raw probe.
		expect(isProjectDirectory(fakeHome)).toBe(true);
	});

	it("gives a symlinked project directory the same storage key", async () => {
		const realProject = join(workDir, "real-project");
		await fs.mkdir(join(realProject, ".git"), { recursive: true });
		const linkPath = join(workDir, "project-link");
		await fs.symlink(realProject, linkPath, "dir");

		expect(getProjectStorageKey(linkPath)).toBe(getProjectStorageKey(realProject));
		// And the root walk resolves through the link rather than stopping at
		// the link's lexical parents.
		const nested = join(linkPath, "src", "pkg");
		await fs.mkdir(nested, { recursive: true });
		expect(findProjectRoot(nested)).toBe(await fs.realpath(realProject));
	});
});
