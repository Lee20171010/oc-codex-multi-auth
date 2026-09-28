import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join, resolve } from "node:path";

vi.mock("node:fs", () => ({
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	rmSync: vi.fn(),
	renameSync: vi.fn(),
	realpathSync: vi.fn(),
}));

describe("auto-update-checker", () => {
	let fs: typeof import("node:fs");
	let checkForUpdates: typeof import("../lib/auto-update-checker.js").checkForUpdates;
	let checkAndNotify: typeof import("../lib/auto-update-checker.js").checkAndNotify;
	let clearUpdateCache: typeof import("../lib/auto-update-checker.js").clearUpdateCache;
	let clearManagedOpenCodePluginCache: typeof import("../lib/auto-update-checker.js").clearManagedOpenCodePluginCache;

	const mockPackageJson = { version: "4.12.0" };

	beforeEach(async () => {
		vi.resetModules();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-30T12:00:00Z"));

		fs = await import("node:fs");
		vi.clearAllMocks();
		vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
			if (String(path).includes("package.json")) {
				return JSON.stringify(mockPackageJson);
			}
			throw new Error("File not found");
		});
		vi.mocked(fs.existsSync).mockReturnValue(false);

		globalThis.fetch = vi.fn();

		const module = await import("../lib/auto-update-checker.js");
		checkForUpdates = module.checkForUpdates;
		checkAndNotify = module.checkAndNotify;
		clearUpdateCache = module.clearUpdateCache;
		clearManagedOpenCodePluginCache = module.clearManagedOpenCodePluginCache;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe("compareVersions (tested via checkForUpdates)", () => {
		it("returns hasUpdate=true when latest > current", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "5.0.0" }),
			} as Response);

			const result = await checkForUpdates(true);

			expect(result.hasUpdate).toBe(true);
			expect(result.currentVersion).toBe("4.12.0");
			expect(result.latestVersion).toBe("5.0.0");
		});

		it("returns hasUpdate=false when latest < current", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "3.0.0" }),
			} as Response);

			const result = await checkForUpdates(true);

			expect(result.hasUpdate).toBe(false);
		});

		it("returns hasUpdate=false when versions are equal", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "4.12.0" }),
			} as Response);

			const result = await checkForUpdates(true);

			expect(result.hasUpdate).toBe(false);
		});

		it("handles semver with different segment counts", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "4.12.0.1" }),
			} as Response);

			const result = await checkForUpdates(true);

			expect(result.hasUpdate).toBe(true);
		});
	});

	describe("checkForUpdates", () => {
		it("uses cache when check is recent", async () => {
			const cacheData = {
				lastCheck: Date.now() - 1000 * 60 * 60,
				latestVersion: "5.0.0",
				currentVersion: "4.12.0",
			};
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
				if (String(path).includes("package.json")) {
					return JSON.stringify(mockPackageJson);
				}
				if (String(path).includes("update-check-cache.json")) {
					return JSON.stringify(cacheData);
				}
				throw new Error("File not found");
			});

			const result = await checkForUpdates();

			expect(globalThis.fetch).not.toHaveBeenCalled();
			expect(result.hasUpdate).toBe(true);
			expect(result.latestVersion).toBe("5.0.0");
		});

		it("fetches when cache is expired", async () => {
			const oldCache = {
				lastCheck: Date.now() - 1000 * 60 * 60 * 25,
				latestVersion: "4.11.0",
				currentVersion: "4.12.0",
			};
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
				if (String(path).includes("package.json")) {
					return JSON.stringify(mockPackageJson);
				}
				if (String(path).includes("update-check-cache.json")) {
					return JSON.stringify(oldCache);
				}
				throw new Error("File not found");
			});
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "5.0.0" }),
			} as Response);

			const result = await checkForUpdates();

			expect(globalThis.fetch).toHaveBeenCalled();
			expect(result.latestVersion).toBe("5.0.0");
		});

		it("fetches when force=true regardless of cache", async () => {
			const freshCache = {
				lastCheck: Date.now(),
				latestVersion: "4.12.0",
				currentVersion: "4.12.0",
			};
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
				if (String(path).includes("package.json")) {
					return JSON.stringify(mockPackageJson);
				}
				if (String(path).includes("update-check-cache.json")) {
					return JSON.stringify(freshCache);
				}
				throw new Error("File not found");
			});
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "6.0.0" }),
			} as Response);

			const result = await checkForUpdates(true);

			expect(globalThis.fetch).toHaveBeenCalled();
			expect(result.latestVersion).toBe("6.0.0");
		});

		it("handles fetch failure gracefully", async () => {
			vi.mocked(globalThis.fetch).mockRejectedValue(new Error("Network error"));

			const result = await checkForUpdates(true);

			expect(result.hasUpdate).toBe(false);
			expect(result.latestVersion).toBe(null);
		});

		it("handles non-ok response", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: false,
				status: 500,
			} as Response);

			const result = await checkForUpdates(true);

			expect(result.hasUpdate).toBe(false);
			expect(result.latestVersion).toBe(null);
		});

		it("saves cache after successful fetch", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "5.0.0" }),
			} as Response);

			await checkForUpdates(true);

			expect(fs.writeFileSync).toHaveBeenCalled();
			const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
			const savedData = JSON.parse(writeCall[1] as string) as {
				latestVersion: string;
			};
			expect(savedData.latestVersion).toBe("5.0.0");
		});

		it("creates cache directory if missing", async () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "5.0.0" }),
			} as Response);

			await checkForUpdates(true);

			expect(fs.mkdirSync).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ recursive: true, mode: 0o700 }),
			);
		});

		it("includes updateCommand in result", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "5.0.0" }),
			} as Response);

			const result = await checkForUpdates(true);

			expect(result.updateCommand).toBe("npx -y oc-codex-multi-auth@latest update");
		});

		it("ignores a malformed version string from the registry", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				// ANSI escapes / arbitrary text must never reach the toast or cache.
				json: async () => ({ version: "5.0.0\u001b[31m<script>" }),
			} as Response);

			const result = await checkForUpdates(true);

			expect(result.latestVersion).toBe(null);
			expect(result.hasUpdate).toBe(false);
		});

		it("ignores a cached latestVersion that is not a version string", async () => {
			const poisonedCache = {
				lastCheck: Date.now() - 1000 * 60 * 60,
				latestVersion: "\u001b[7m run rm -rf \u001b[0m",
				currentVersion: "4.12.0",
			};
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
				if (String(path).includes("package.json")) {
					return JSON.stringify(mockPackageJson);
				}
				if (String(path).includes("update-check-cache.json")) {
					return JSON.stringify(poisonedCache);
				}
				throw new Error("File not found");
			});
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "5.0.0" }),
			} as Response);

			const result = await checkForUpdates();

			// The planted cache is treated as absent, so a real fetch happens
			// rather than trusting the injected string.
			expect(globalThis.fetch).toHaveBeenCalled();
			expect(result.latestVersion).toBe("5.0.0");
		});

		it("ignores a cache entry stamped in the future", async () => {
			const futureCache = {
				lastCheck: Date.now() + 1000 * 60 * 60 * 24 * 30,
				latestVersion: "99.0.0",
				currentVersion: "4.12.0",
			};
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
				if (String(path).includes("package.json")) {
					return JSON.stringify(mockPackageJson);
				}
				if (String(path).includes("update-check-cache.json")) {
					return JSON.stringify(futureCache);
				}
				throw new Error("File not found");
			});
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "5.0.0" }),
			} as Response);

			const result = await checkForUpdates();

			expect(globalThis.fetch).toHaveBeenCalled();
			expect(result.latestVersion).toBe("5.0.0");
		});

		it("cleans up the temp file when the atomic rename fails", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "5.0.0" }),
			} as Response);
			vi.mocked(fs.renameSync).mockImplementation(() => {
				throw new Error("EXDEV: cross-device rename");
			});

			await checkForUpdates(true);

			expect(fs.rmSync).toHaveBeenCalledWith(
				expect.stringContaining("update-check-cache.json"),
				expect.objectContaining({ force: true }),
			);
		});
	});

	describe("checkAndNotify", () => {
		it("shows restart toast and schedules cache clear when update available", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "5.0.0" }),
			} as Response);
			const showToast = vi.fn().mockResolvedValue(undefined);
			const scheduleCacheClear = vi.fn(() => true);

			await checkAndNotify(showToast, { scheduleCacheClear });

			expect(showToast).toHaveBeenCalledWith(
				expect.stringContaining("Restart OpenCode to install it automatically"),
				"info"
			);
			expect(scheduleCacheClear).toHaveBeenCalledOnce();
		});

		it("keeps manual update command when autoUpdate is disabled", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "5.0.0" }),
			} as Response);
			const showToast = vi.fn().mockResolvedValue(undefined);
			const scheduleCacheClear = vi.fn(() => true);

			await checkAndNotify(showToast, {
				autoUpdate: false,
				scheduleCacheClear,
			});

			expect(showToast).toHaveBeenCalledWith(
				expect.stringContaining("Run: npx -y oc-codex-multi-auth@latest update"),
				"info"
			);
			expect(scheduleCacheClear).not.toHaveBeenCalled();
		});

		it("does not show toast when no update", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "4.12.0" }),
			} as Response);
			const showToast = vi.fn().mockResolvedValue(undefined);

			await checkAndNotify(showToast);

			expect(showToast).not.toHaveBeenCalled();
		});

		it("handles missing showToast callback", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "5.0.0" }),
			} as Response);

			await expect(checkAndNotify()).resolves.toBeUndefined();
		});

		it("catches and ignores errors", async () => {
			vi.mocked(globalThis.fetch).mockRejectedValue(new Error("Network error"));
			const showToast = vi.fn().mockResolvedValue(undefined);

			await expect(checkAndNotify(showToast)).resolves.toBeUndefined();
			expect(showToast).not.toHaveBeenCalled();
		});

		it("offers nothing for a build loaded from a local checkout", async () => {
			vi.mocked(globalThis.fetch).mockResolvedValue({
				ok: true,
				json: async () => ({ version: "5.0.0" }),
			} as Response);
			const showToast = vi.fn().mockResolvedValue(undefined);
			const scheduleCacheClear = vi.fn(() => true);

			await checkAndNotify(showToast, { localCheckout: true, scheduleCacheClear });

			expect(globalThis.fetch).not.toHaveBeenCalled();
			expect(showToast).not.toHaveBeenCalled();
			expect(scheduleCacheClear).not.toHaveBeenCalled();
		});
	});

	describe("clearUpdateCache", () => {
		it("writes empty object when cache exists", () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.writeFileSync).mockClear();

			clearUpdateCache();

			expect(fs.writeFileSync).toHaveBeenCalledWith(
				expect.stringContaining("update-check-cache.json"),
				"{}",
				expect.objectContaining({ encoding: "utf8", mode: 0o600 }),
			);
		});

		it("does nothing when cache does not exist", () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);
			vi.mocked(fs.writeFileSync).mockClear();

			clearUpdateCache();

			expect(fs.writeFileSync).not.toHaveBeenCalled();
		});
	});

	describe("clearManagedOpenCodePluginCache", () => {
		// resolve(), not join(): isEvictableCachePath resolves its input before
		// calling resolveRealPath, and on Windows a drive-less "\tmp\..." resolves
		// to "C:\tmp\...", so a join()-built fixture never matches the mock below.
		const cacheRoot = resolve("/tmp", "opencode-cache");
		const resolveRealPath = (path: string) => path;
		const packagesPath = join(cacheRoot, "packages", "oc-codex-multi-auth@latest");
		const nodeModulesPath = join(cacheRoot, "node_modules", "oc-codex-multi-auth");
		const checkoutPath = resolve("/home", "dev", "src", "oc-codex-multi-auth");

		it("removes managed OpenCode package cache paths", () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);

			const cleared = clearManagedOpenCodePluginCache([packagesPath, nodeModulesPath], {
				cacheRoot,
				resolveRealPath,
			});

			expect(cleared).toBe(true);
			expect(fs.rmSync).toHaveBeenCalledWith(packagesPath, { recursive: true, force: true });
			expect(fs.rmSync).toHaveBeenCalledWith(nodeModulesPath, { recursive: true, force: true });
		});

		it("returns false when no managed cache paths exist", () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);

			const cleared = clearManagedOpenCodePluginCache([packagesPath], {
				cacheRoot,
				resolveRealPath,
			});

			expect(cleared).toBe(false);
			expect(fs.rmSync).not.toHaveBeenCalled();
		});

		it("refuses a cache entry that resolves onto a linked working checkout", () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);

			const cleared = clearManagedOpenCodePluginCache([nodeModulesPath], {
				cacheRoot,
				resolveRealPath: (path) => (path === nodeModulesPath ? checkoutPath : path),
			});

			expect(cleared).toBe(false);
			expect(fs.rmSync).not.toHaveBeenCalled();
		});

		it("refuses every path when the cache root itself resolves through a symlink", () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			// `~/.cache/opencode -> ~`: the resolved root is the whole home
			// directory, so a realpath containment check would call anything under
			// ~ "inside the cache".
			const linkedRoot = join("/home", "dev", ".cache", "opencode");
			const managedPath = join(linkedRoot, "node_modules", "oc-codex-multi-auth");

			const cleared = clearManagedOpenCodePluginCache([managedPath], {
				cacheRoot: linkedRoot,
				resolveRealPath: (path) =>
					path === resolve(linkedRoot) ? join("/home", "dev") : path,
			});

			expect(cleared).toBe(false);
			expect(fs.rmSync).not.toHaveBeenCalled();
		});

		it("refuses a path outside the OpenCode cache directory", () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);

			const cleared = clearManagedOpenCodePluginCache([checkoutPath], {
				cacheRoot,
				resolveRealPath,
			});

			expect(cleared).toBe(false);
			expect(fs.rmSync).not.toHaveBeenCalled();
		});

		it("refuses the cache directory itself", () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);

			const cleared = clearManagedOpenCodePluginCache([cacheRoot], {
				cacheRoot,
				resolveRealPath,
			});

			expect(cleared).toBe(false);
			expect(fs.rmSync).not.toHaveBeenCalled();
		});

		it("refuses every path when the cache directory cannot be resolved", () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);

			const cleared = clearManagedOpenCodePluginCache([packagesPath], {
				cacheRoot,
				resolveRealPath: () => {
					throw new Error("ENOENT");
				},
			});

			expect(cleared).toBe(false);
			expect(fs.rmSync).not.toHaveBeenCalled();
		});
	});
});
