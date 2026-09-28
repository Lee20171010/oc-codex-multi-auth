import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, readFile } from "node:fs/promises";
import { writeFileAtomic } from "../lib/storage/atomic-write.js";

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/storage/atomic-write.js", () => ({
  writeFileAtomic: vi.fn(async () => undefined),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Fixture bodies must clear the 128-char minimum prompt length — a shorter
// body is rejected as an error stub and, worse, a short cache would make an
// over-broad strip-needle for isOpenCodeSystemPrompt.
const padPrompt = (label: string): string => `${label}\n\n${"p".repeat(160)}`;

describe("opencode-codex", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe("getOpenCodeCodexPrompt", () => {
    it("fetches fresh content when no cache exists", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(padPrompt("Fresh prompt content")),
        headers: new Map([["etag", '"abc123"']]),
      });

      const result = await getOpenCodeCodexPrompt();

      expect(result).toContain("Fresh prompt content");
      expect(mockFetch).toHaveBeenCalled();
      expect(writeFileAtomic).toHaveBeenCalledTimes(2);
    });

    it("uses cache when TTL not expired", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      vi.mocked(readFile)
        .mockResolvedValueOnce(padPrompt("Cached content"))
        .mockResolvedValueOnce(JSON.stringify({
          etag: '"old-etag"',
          lastChecked: Date.now() - 1000,
        }));

      const result = await getOpenCodeCodexPrompt();

      expect(result).toContain("Cached content");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("uses ETag for conditional request when cache expired", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      vi.mocked(readFile)
        .mockResolvedValueOnce(padPrompt("Cached content"))
        .mockResolvedValueOnce(JSON.stringify({
          etag: '"old-etag"',
          lastChecked: Date.now() - 20 * 60 * 1000,
        }));

      mockFetch.mockResolvedValue({
        ok: false,
        status: 304,
        headers: new Map(),
      });

      const result = await getOpenCodeCodexPrompt();

      expect(result).toContain("Cached content");
      // With no stored sourceUrl, the ETag replays to the first default source.
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("raw.githubusercontent.com"),
        expect.objectContaining({
          headers: { "If-None-Match": '"old-etag"' },
        })
      );
    });

    it("does not let a stored sourceUrl redirect the next fetch", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      vi.mocked(readFile)
        .mockResolvedValueOnce(padPrompt("Cached content"))
        .mockResolvedValueOnce(JSON.stringify({
          etag: '"old-etag"',
          // A planted meta file pointing at an attacker host.
          sourceUrl: "https://attacker.example/prompt.txt",
          lastChecked: Date.now() - 20 * 60 * 1000,
        }));

      mockFetch.mockResolvedValue({
        ok: false,
        status: 304,
        headers: new Map(),
      });

      const result = await getOpenCodeCodexPrompt();

      expect(result).toContain("Cached content");
      const fetchedUrls = mockFetch.mock.calls.map((call) => String(call[0]));
      expect(fetchedUrls.some((url) => url.includes("attacker.example"))).toBe(false);
      // The stored sourceUrl matches no trusted default, so the stale ETag is
      // not replayed anywhere either.
      for (const call of mockFetch.mock.calls) {
        const init = call[1] as { headers?: Record<string, string> };
        expect(init?.headers?.["If-None-Match"]).toBeUndefined();
      }
    });

    it("replays the stored ETag only to the source that issued it", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      vi.mocked(readFile)
        .mockResolvedValueOnce(padPrompt("Cached content"))
        .mockResolvedValueOnce(JSON.stringify({
          etag: '"old-etag"',
          // Exactly the first default source — the conditional request must
          // attach the ETag here and nowhere else.
          sourceUrl:
            "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/prompt/codex.txt",
          lastChecked: Date.now() - 20 * 60 * 1000,
        }));

      mockFetch.mockResolvedValue({
        ok: false,
        status: 304,
        headers: new Map(),
      });

      const result = await getOpenCodeCodexPrompt();

      expect(result).toContain("Cached content");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/prompt/codex.txt",
        expect.objectContaining({
          headers: { "If-None-Match": '"old-etag"' },
        }),
      );
    });

    it("falls back to next source when first source returns 404", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          headers: new Map(),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(padPrompt("Prompt from fallback source")),
          headers: new Map([["etag", '"fallback-etag"']]),
        });

      const result = await getOpenCodeCodexPrompt();

      expect(result).toContain("Prompt from fallback source");
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0]?.[0]).not.toBe(mockFetch.mock.calls[1]?.[0]);
      expect(writeFileAtomic).toHaveBeenCalledTimes(2);
    });

    it("uses OPENCODE_CODEX_PROMPT_URL override before default sources", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
      vi.stubEnv("OPENCODE_CODEX_PROMPT_URL", "https://example.com/custom-codex.txt");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(padPrompt("Prompt from env override")),
        headers: new Map([["etag", '"env-etag"']]),
      });

      const result = await getOpenCodeCodexPrompt();

      expect(result).toContain("Prompt from env override");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0]?.[0]).toBe("https://example.com/custom-codex.txt");
    });

    it("serves stale content immediately and refreshes cache in background", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      vi.mocked(readFile)
        .mockResolvedValueOnce(padPrompt("Old cached content"))
        .mockResolvedValueOnce(JSON.stringify({
          etag: '"old-etag"',
          lastChecked: Date.now() - 20 * 60 * 1000,
        }));

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(padPrompt("New content")),
        headers: new Map([["etag", '"new-etag"']]),
      });

      const first = await getOpenCodeCodexPrompt();

      expect(first).toContain("Old cached content");
      await new Promise((resolve) => setTimeout(resolve, 0));
      const second = await getOpenCodeCodexPrompt();
      expect(second).toContain("New content");
      expect(writeFileAtomic).toHaveBeenCalledWith(
        expect.stringContaining("opencode-codex.txt"),
        expect.stringContaining("New content"),
      );
    });

    it("falls back to cache on network error", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      vi.mocked(readFile)
        .mockResolvedValueOnce(padPrompt("Cached fallback content"))
        .mockResolvedValueOnce(JSON.stringify({
          etag: '"etag"',
          lastChecked: Date.now() - 20 * 60 * 1000,
        }));

      mockFetch.mockRejectedValue(new Error("Network error"));

      const result = await getOpenCodeCodexPrompt();

      expect(result).toContain("Cached fallback content");
    });

    it("throws when no cache and fetch fails", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
      mockFetch.mockRejectedValue(new Error("Network error"));

      await expect(getOpenCodeCodexPrompt()).rejects.toThrow(
        "Failed to fetch OpenCode codex.txt and no cache available"
      );
      expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
    });

    it("falls back to cache on non-OK response", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      vi.mocked(readFile)
        .mockResolvedValueOnce(padPrompt("Cached content for 500"))
        .mockResolvedValueOnce(JSON.stringify({
          etag: '"etag"',
          lastChecked: Date.now() - 20 * 60 * 1000,
        }));

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        headers: new Map(),
      });

      const result = await getOpenCodeCodexPrompt();

      expect(result).toContain("Cached content for 500");
    });

    it("ignores a planted meta file with a future lastChecked", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      vi.mocked(readFile)
        .mockResolvedValueOnce(padPrompt("Cached content"))
        .mockResolvedValueOnce(JSON.stringify({
          etag: '"old-etag"',
          // A future stamp would otherwise satisfy isFresh forever.
          lastChecked: Date.now() + 60 * 60 * 1000,
        }));

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(padPrompt("Fresh content")),
        headers: new Map([["etag", '"new-etag"']]),
      });

      const result = await getOpenCodeCodexPrompt();

      // The poisoned meta is treated as absent, so a real fetch happens and
      // its content — not the planted cache — is served.
      expect(result).toContain("Fresh content");
      expect(mockFetch).toHaveBeenCalled();
    });

    it("rejects a too-short cached body as a strip-needle source", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      vi.mocked(readFile)
        .mockResolvedValueOnce("short")
        .mockResolvedValueOnce(JSON.stringify({
          etag: '"old-etag"',
          lastChecked: Date.now() - 1000,
        }));

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(padPrompt("Replacement content")),
        headers: new Map([["etag", '"new-etag"']]),
      });

      const result = await getOpenCodeCodexPrompt();

      expect(result).toContain("Replacement content");
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe("getCachedPromptPrefix", () => {
    it("returns first N characters of cached content", async () => {
      const { getCachedPromptPrefix } = await import("../lib/prompts/opencode-codex.js");

      vi.mocked(readFile).mockResolvedValue(padPrompt("This is a long cached prompt content"));

      const result = await getCachedPromptPrefix(10);

      expect(result).toBe("This is a ");
    });

    it("returns null when cache does not exist", async () => {
      const { getCachedPromptPrefix } = await import("../lib/prompts/opencode-codex.js");

      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));

      const result = await getCachedPromptPrefix();

      expect(result).toBeNull();
    });

    it("returns null for a too-short cached body", async () => {
      const { getCachedPromptPrefix } = await import("../lib/prompts/opencode-codex.js");

      vi.mocked(readFile).mockResolvedValue("short");

      const result = await getCachedPromptPrefix();

      expect(result).toBeNull();
    });

    it("uses default of 50 characters", async () => {
      const { getCachedPromptPrefix } = await import("../lib/prompts/opencode-codex.js");

      const longContent = "A".repeat(200);
      vi.mocked(readFile).mockResolvedValue(longContent);

      const result = await getCachedPromptPrefix();

      expect(result).toBe("A".repeat(50));
    });
  });
});
