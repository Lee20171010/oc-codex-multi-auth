import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

// `resolvePath` guards against a path that merely shares a string prefix with
// an allowed root, so the lookalike cases below build a sibling of one root and
// require it to be outside all three. Against the real layout that only holds
// by accident: the suite runs with HOME redirected under the temp dir, which
// makes every sibling of home a child of tmpdir() and turns the assertion into
// a no-op. Fixed roots keep these cases meaningful wherever HOME points.
//
// This mock and the isolated HOME in `vitest.config.ts` are load-bearing
// together. Removing the mock as redundant silently turns both lookalike
// assertions into no-ops rather than failing them.
const FAKE_HOME = path.resolve("/fake-storage-paths-home");
const FAKE_TMPDIR = path.resolve("/fake-storage-paths-tmp");

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: vi.fn(),
		realpathSync: vi.fn(actual.realpathSync),
	};
});

vi.mock("node:os", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:os")>()),
	homedir: () => FAKE_HOME,
	tmpdir: () => FAKE_TMPDIR,
}));

import { existsSync, realpathSync } from "node:fs";
import {
	getConfigDir,
	getProjectConfigDir,
	getProjectGlobalConfigDir,
	getProjectStorageKey,
	isProjectDirectory,
	findProjectRoot,
	resolvePath,
} from "../lib/storage/paths.js";

const mockedExistsSync = vi.mocked(existsSync);

describe("Storage Paths Module", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.resetAllMocks();
	});

	describe("getConfigDir", () => {
		it("should return ~/.opencode", () => {
			const result = getConfigDir();
			expect(result).toBe(path.join(homedir(), ".opencode"));
		});
	});

	describe("getProjectConfigDir", () => {
		it("should return project path with .opencode appended", () => {
			const projectPath = "/home/user/myproject";
			const result = getProjectConfigDir(projectPath);
			expect(result).toBe(path.join(projectPath, ".opencode"));
		});

		it("should handle Windows-style paths", () => {
			const projectPath = "C:\\Users\\test\\project";
			const result = getProjectConfigDir(projectPath);
			expect(result).toBe(path.join(projectPath, ".opencode"));
		});
	});

	describe("getProjectStorageKey", () => {
		it("returns deterministic key for same project path", () => {
			const projectPath = "/home/user/myproject";
			const first = getProjectStorageKey(projectPath);
			const second = getProjectStorageKey(projectPath);
			expect(first).toBe(second);
			expect(first).toMatch(/^myproject-[a-f0-9]{12}$/);
		});
	});

	describe("getProjectGlobalConfigDir", () => {
		it("returns ~/.opencode/projects/<key>", () => {
			const projectPath = "/home/user/myproject";
			const result = getProjectGlobalConfigDir(projectPath);
			expect(result).toContain(path.join(homedir(), ".opencode", "projects"));
			expect(result).toContain("myproject-");
		});
	});

	describe("isProjectDirectory", () => {
		const markers = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", ".opencode"];

		it.each(markers)("should return true when %s exists", (marker) => {
			mockedExistsSync.mockImplementation((p) => {
				return typeof p === "string" && p.endsWith(marker);
			});
			const result = isProjectDirectory("/test/project");
			expect(result).toBe(true);
		});

		it("should return false when no project markers exist", () => {
			mockedExistsSync.mockReturnValue(false);
			const result = isProjectDirectory("/test/random");
			expect(result).toBe(false);
		});

		it("should check multiple markers", () => {
			mockedExistsSync.mockReturnValue(false);
			isProjectDirectory("/test/dir");
			expect(mockedExistsSync).toHaveBeenCalledTimes(markers.length);
		});
	});

	describe("findProjectRoot", () => {
		it("should return the directory if it is a project root", () => {
			mockedExistsSync.mockImplementation((p) => {
				return typeof p === "string" && p.includes(".git");
			});
			const result = findProjectRoot("/home/user/myproject");
			expect(result).toBe("/home/user/myproject");
		});

		it("should walk up the directory tree to find project root", () => {
			mockedExistsSync.mockImplementation((p) => {
				return typeof p === "string" && p === path.join("/home/user", ".git");
			});
			const result = findProjectRoot("/home/user/myproject/src/lib");
			expect(result).toBe("/home/user");
		});

		it("should return null when no project root found", () => {
			mockedExistsSync.mockReturnValue(false);
			const result = findProjectRoot("/some/random/path");
			expect(result).toBeNull();
		});

		it("should handle root directory correctly", () => {
			mockedExistsSync.mockReturnValue(false);
			const root = path.parse(process.cwd()).root;
			const result = findProjectRoot(root);
			expect(result).toBeNull();
		});

		it("should stop at filesystem root", () => {
			mockedExistsSync.mockReturnValue(false);
			const callCount = mockedExistsSync.mock.calls.length;
			findProjectRoot("/a/b/c/d/e");
			expect(mockedExistsSync.mock.calls.length).toBeGreaterThan(callCount);
		});
	});

	describe("resolvePath", () => {
		it("should expand tilde to home directory", () => {
			const result = resolvePath("~/.opencode/config.json");
			expect(result).toBe(path.join(homedir(), ".opencode/config.json"));
		});

		it("should resolve relative paths", () => {
			const cwd = process.cwd();
			const result = resolvePath("./test.json");
			expect(result).toBe(path.resolve(cwd, "./test.json"));
		});

		it("should accept paths within home directory", () => {
			const homePath = path.join(homedir(), "projects", "myapp");
			expect(() => resolvePath(homePath)).not.toThrow();
		});

		it("should accept paths within current working directory", () => {
			const cwdPath = path.join(process.cwd(), "subdir", "file.txt");
			expect(() => resolvePath(cwdPath)).not.toThrow();
		});

		it("should accept paths within temp directory", () => {
			const tempPath = path.join(tmpdir(), "test-file.json");
			expect(() => resolvePath(tempPath)).not.toThrow();
		});

		it("should throw for paths outside allowed directories", () => {
			const outsidePath = "/definitely/not/allowed/path";
			
			if (process.platform === "win32") {
				return;
			}
			
			const home = homedir();
			const cwd = process.cwd();
			const tmp = tmpdir();
			
			if (!outsidePath.startsWith(home) && !outsidePath.startsWith(cwd) && !outsidePath.startsWith(tmp)) {
				expect(() => resolvePath(outsidePath)).toThrow("Access denied");
			}
		});

		it("rejects lookalike prefix paths outside home directory", () => {
			const home = homedir();
			const parent = path.dirname(home);
			const outsideLookalike = path.join(parent, `${path.basename(home)}-outside`, "file.json");
			expect(() => resolvePath(outsideLookalike)).toThrow("Access denied");
		});

		it("rejects nested targets whose not-yet-existing parent sits under a symlinked escape", () => {
			// `~/link -> /escape-root`; the export target `~/link/newdir/out.json`
			// exists nowhere, so realpath on it AND on its immediate parent both
			// fail. The containment check must still resolve the symlinked
			// ancestor, or the lexical path under home sneaks the write out.
			const linkPath = path.join(FAKE_HOME, "link");
			const mockedRealpath = vi.mocked(realpathSync);
			mockedRealpath.mockImplementation((candidate) => {
				if (String(candidate) === linkPath) return "/escape-root";
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			});
			expect(() =>
				resolvePath(path.join(linkPath, "newdir", "out.json")),
			).toThrow("Access denied");
		});

		it("accepts a valid export when an allowed root is itself a symlink", () => {
			// Home lives behind a symlink (`/fake-storage-paths-home ->
			// /data/home/user`). The new-nested-directory target resolves its
			// existing ancestor to the PHYSICAL home, so the boundary roots must
			// be realpathed the same way — comparing physical-canonical against
			// the lexical home rejects an export that is genuinely inside it.
			const physicalHome = "/data/home/user";
			const mockedRealpath = vi.mocked(realpathSync);
			mockedRealpath.mockImplementation((candidate) => {
				if (String(candidate) === FAKE_HOME) return physicalHome;
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			});
			expect(() =>
				resolvePath(path.join(FAKE_HOME, "newdir", "out.json")),
			).not.toThrow();
		});

		it("rejects lookalike prefix paths outside current working directory", () => {
			const cwd = process.cwd();
			const parent = path.dirname(cwd);
			const outsideLookalike = path.join(parent, `${path.basename(cwd)}-outside`, "file.json");
			const home = homedir();
			const tmp = tmpdir();
			if (
				outsideLookalike.startsWith(home) ||
				outsideLookalike.startsWith(tmp) ||
				outsideLookalike.startsWith(cwd)
			) {
				return;
			}
			expect(() => resolvePath(outsideLookalike)).toThrow("Access denied");
		});

		it("should handle tilde-only path", () => {
			const result = resolvePath("~");
			expect(result).toBe(homedir());
		});

		it("should handle paths with tilde in subdirectory", () => {
			const result = resolvePath("~/subdir/deep/path");
			expect(result).toBe(path.join(homedir(), "subdir/deep/path"));
		});
	});
});
