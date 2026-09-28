import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * OpenCode resolves its data root as `XDG_DATA_HOME || ~/.local/share` on
 * every platform — its `Global.Path.data` goes through the `xdg-basedir`
 * package unconditionally, so on Windows session storage is
 * `%USERPROFILE%\.local\share\opencode`, not `%APPDATA%`. These tests pin
 * that cross-platform contract; an APPDATA branch made recovery a silent
 * no-op on Windows.
 */
describe("recovery/constants.ts", () => {
  const originalPlatform = process.platform;
  const originalAppData = process.env.APPDATA;
  const originalXdgDataHome = process.env.XDG_DATA_HOME;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.XDG_DATA_HOME;
    delete process.env.APPDATA;
  });

  afterEach(() => {
    vi.resetModules();
    process.env.APPDATA = originalAppData;
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  describe("getXdgData on non-Windows", () => {
    it("should use XDG_DATA_HOME when set", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      process.env.XDG_DATA_HOME = "/custom/xdg/data";

      const { OPENCODE_STORAGE } = await import("../lib/recovery/constants.js");

      expect(OPENCODE_STORAGE).toBe(join("/custom/xdg/data", "opencode", "storage"));
    });

    it("should fallback to ~/.local/share when XDG_DATA_HOME is not set", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      delete process.env.XDG_DATA_HOME;

      const { OPENCODE_STORAGE } = await import("../lib/recovery/constants.js");

      expect(OPENCODE_STORAGE).toBe(join(homedir(), ".local", "share", "opencode", "storage"));
    });
  });

  describe("getXdgData on Windows", () => {
    it("should still use XDG_DATA_HOME when set", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      process.env.XDG_DATA_HOME = "D:\\custom\\xdg";

      const { OPENCODE_STORAGE } = await import("../lib/recovery/constants.js");

      expect(OPENCODE_STORAGE).toBe(join("D:\\custom\\xdg", "opencode", "storage"));
    });

    it("should fallback to ~/.local/share, not APPDATA, when XDG_DATA_HOME is not set", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      process.env.APPDATA = "C:\\Users\\Test\\AppData\\Roaming";

      const { OPENCODE_STORAGE } = await import("../lib/recovery/constants.js");

      expect(OPENCODE_STORAGE).toBe(join(homedir(), ".local", "share", "opencode", "storage"));
    });

    it("should resolve the same directory as POSIX", async () => {
      delete process.env.XDG_DATA_HOME;

      Object.defineProperty(process, "platform", { value: "win32" });
      const windows = (await import("../lib/recovery/constants.js")).OPENCODE_STORAGE;

      vi.resetModules();
      Object.defineProperty(process, "platform", { value: "linux" });
      const linux = (await import("../lib/recovery/constants.js")).OPENCODE_STORAGE;

      expect(windows).toBe(linux);
    });
  });

  describe("exported type sets", () => {
    it("should export THINKING_TYPES with correct values", async () => {
      const { THINKING_TYPES } = await import("../lib/recovery/constants.js");

      expect(THINKING_TYPES.has("thinking")).toBe(true);
      expect(THINKING_TYPES.has("redacted_thinking")).toBe(true);
      expect(THINKING_TYPES.has("reasoning")).toBe(true);
      expect(THINKING_TYPES.has("text")).toBe(false);
    });

    it("should export META_TYPES with correct values", async () => {
      const { META_TYPES } = await import("../lib/recovery/constants.js");

      expect(META_TYPES.has("step-start")).toBe(true);
      expect(META_TYPES.has("step-finish")).toBe(true);
      expect(META_TYPES.has("text")).toBe(false);
    });

    it("should export CONTENT_TYPES with correct values", async () => {
      const { CONTENT_TYPES } = await import("../lib/recovery/constants.js");

      expect(CONTENT_TYPES.has("text")).toBe(true);
      expect(CONTENT_TYPES.has("tool")).toBe(true);
      expect(CONTENT_TYPES.has("tool_use")).toBe(true);
      expect(CONTENT_TYPES.has("tool_result")).toBe(true);
      expect(CONTENT_TYPES.has("thinking")).toBe(false);
    });
  });
});
