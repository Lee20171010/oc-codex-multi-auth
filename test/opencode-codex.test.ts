import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
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

const FIRST_SOURCE =
  "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/prompt/codex.txt";
const SECOND_SOURCE =
  "https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/session/prompt/codex.txt";

// `raw.githubusercontent.com` etags are the content's git blob SHA; a 304 only
// proves upstream still serves that blob, so the disk body must hash to it.
const gitBlobEtag = (content: string): string => {
  const payload = Buffer.from(content, "utf8");
  const sha = createHash("sha1")
    .update(`blob ${payload.length}\0`)
    .update(payload)
    .digest("hex");
  return `"${sha}"`;
};

const okResponse = (body: string, etag = '"etag"') => ({
  ok: true,
  status: 200,
  text: () => Promise.resolve(body),
  headers: new Map([["etag", etag]]),
});

const statusResponse = (status: number) => ({
  ok: false,
  status,
  text: () => Promise.resolve(""),
  headers: new Map(),
});

describe("opencode-codex", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  describe("getOpenCodeCodexPrompt", () => {
    it("fetches fresh content when no cache exists", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
      mockFetch.mockResolvedValue(okResponse(padPrompt("Fresh prompt content"), '"abc123"'));

      const result = await getOpenCodeCodexPrompt();

      expect(result).toContain("Fresh prompt content");
      expect(mockFetch).toHaveBeenCalled();
      expect(writeFileAtomic).toHaveBeenCalledTimes(2);
    });

    it("serves process-verified content within the TTL without refetching", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      // A disk cache — even one with a fresh-looking lastChecked — cannot
      // serve until this process has verified it against a trusted source.
      vi.mocked(readFile)
        .mockResolvedValueOnce(padPrompt("Planted disk content"))
        .mockResolvedValueOnce(JSON.stringify({
          etag: '"old-etag"',
          lastChecked: Date.now() - 1000,
        }));
      mockFetch.mockResolvedValue(okResponse(padPrompt("Verified upstream content")));

      const first = await getOpenCodeCodexPrompt();
      expect(first).toContain("Verified upstream content");
      expect(first).not.toContain("Planted disk content");

      // The second call serves the verified in-memory snapshot — no fetch.
      const callsAfterFirst = mockFetch.mock.calls.length;
      const second = await getOpenCodeCodexPrompt();
      expect(second).toContain("Verified upstream content");
      expect(mockFetch.mock.calls.length).toBe(callsAfterFirst);
    });

    it("uses ETag for a conditional request and serves the hash-bound disk body on 304", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      const diskContent = padPrompt("Cached content");
      vi.mocked(readFile)
        .mockResolvedValueOnce(diskContent)
        .mockResolvedValueOnce(JSON.stringify({
          // The real blob etag: a 304 acknowledgment now genuinely binds
          // these disk bytes to upstream's content.
          etag: gitBlobEtag(diskContent),
          sourceUrl: FIRST_SOURCE,
          lastChecked: Date.now() - 20 * 60 * 1000,
        }));

      mockFetch.mockResolvedValue(statusResponse(304));

      const result = await getOpenCodeCodexPrompt();

      expect(result).toContain("Cached content");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        FIRST_SOURCE,
        expect.objectContaining({
          headers: { "If-None-Match": gitBlobEtag(diskContent) },
        })
      );
    });

    it("refetches unconditionally when the disk body fails the 304 hash check", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      vi.mocked(readFile)
        .mockResolvedValueOnce(padPrompt("Planted body"))
        .mockResolvedValueOnce(JSON.stringify({
          // A well-formed etag that cannot match the planted bytes — a
          // forger can pick a hex shape but not a colliding blob.
          etag: `"${"0".repeat(40)}"`,
          sourceUrl: FIRST_SOURCE,
          lastChecked: Date.now() - 20 * 60 * 1000,
        }));

      mockFetch.mockImplementation((url, init) => {
        const conditional = Boolean(
          (init as { headers?: Record<string, string> } | undefined)?.headers?.["If-None-Match"],
        );
        if (conditional) return Promise.resolve(statusResponse(304));
        return Promise.resolve(okResponse(padPrompt("Real upstream body"), '"real"'));
      });

      const result = await getOpenCodeCodexPrompt();

      expect(result).toContain("Real upstream body");
      expect(result).not.toContain("Planted body");
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const secondInit = mockFetch.mock.calls[1]?.[1] as { headers?: Record<string, string> };
      expect(secondInit?.headers?.["If-None-Match"]).toBeUndefined();
    });

    it("does not let a stored sourceUrl redirect the next fetch", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      const diskContent = padPrompt("Cached content");
      vi.mocked(readFile)
        .mockResolvedValueOnce(diskContent)
        .mockResolvedValueOnce(JSON.stringify({
          // Hash-binds the disk body so the 304 can serve it — but the
          // stored sourceUrl points at an attacker host and must still be
          // ignored for the conditional request itself.
          etag: gitBlobEtag(diskContent),
          sourceUrl: "https://attacker.example/prompt.txt",
          lastChecked: Date.now() - 20 * 60 * 1000,
        }));

      mockFetch.mockResolvedValue(statusResponse(304));

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

      const diskContent = padPrompt("Cached content");
      vi.mocked(readFile)
        .mockResolvedValueOnce(diskContent)
        .mockResolvedValueOnce(JSON.stringify({
          etag: gitBlobEtag(diskContent),
          // Exactly the SECOND default source — the conditional request must
          // attach the ETag there and nowhere else.
          sourceUrl: SECOND_SOURCE,
          lastChecked: Date.now() - 20 * 60 * 1000,
        }));

      mockFetch.mockImplementation((url) => {
        if (String(url) === FIRST_SOURCE) {
          return Promise.resolve(statusResponse(404));
        }
        return Promise.resolve(statusResponse(304));
      });

      const result = await getOpenCodeCodexPrompt();

      expect(result).toContain("Cached content");
      const calls = mockFetch.mock.calls;
      const firstInit = calls[0]?.[1] as { headers?: Record<string, string> };
      expect(firstInit?.headers?.["If-None-Match"]).toBeUndefined();
      expect(mockFetch).toHaveBeenCalledWith(
        SECOND_SOURCE,
        expect.objectContaining({
          headers: { "If-None-Match": gitBlobEtag(diskContent) },
        }),
      );
    });

    it("falls back to next source when first source returns 404", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
      mockFetch
        .mockResolvedValueOnce(statusResponse(404))
        .mockResolvedValueOnce(okResponse(padPrompt("Prompt from fallback source"), '"fallback-etag"'));

      const result = await getOpenCodeCodexPrompt();

      expect(result).toContain("Prompt from fallback source");
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0]?.[0]).not.toBe(mockFetch.mock.calls[1]?.[0]);
      expect(writeFileAtomic).toHaveBeenCalledTimes(2);
    });

    it("aborts a stalled body read and moves to the next source", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
      mockFetch.mockImplementation((url, init) => {
        if (String(url) === FIRST_SOURCE) {
          const signal = (init as RequestInit).signal as AbortSignal;
          expect(signal).toBeInstanceOf(AbortSignal);
          // Headers arrive instantly; the body read stalls until the
          // fetch's own deadline aborts the connection.
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Map(),
            text: () =>
              new Promise<string>((_resolve, reject) => {
                signal.addEventListener("abort", () =>
                  reject(new Error("socket aborted")),
                );
              }),
          });
        }
        return Promise.resolve(
          okResponse(padPrompt("Prompt from the next source"), '"next-etag"'),
        );
      });

      vi.useFakeTimers();
      const pending = getOpenCodeCodexPrompt();
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      // The stalled socket was cancelled, then source two answered — the
      // fallback only runs after the first connection is released.
      expect(result).toContain("Prompt from the next source");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("uses OPENCODE_CODEX_PROMPT_URL override before default sources", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
      vi.stubEnv("OPENCODE_CODEX_PROMPT_URL", "https://example.com/custom-codex.txt");
      mockFetch.mockResolvedValueOnce(okResponse(padPrompt("Prompt from env override"), '"env-etag"'));

      const result = await getOpenCodeCodexPrompt();

      expect(result).toContain("Prompt from env override");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0]?.[0]).toBe("https://example.com/custom-codex.txt");
    });

    it("refreshes an unverified stale disk cache synchronously, not stale-while-revalidate", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      vi.mocked(readFile)
        .mockResolvedValueOnce(padPrompt("Old cached content"))
        .mockResolvedValueOnce(JSON.stringify({
          etag: '"old-etag"',
          lastChecked: Date.now() - 20 * 60 * 1000,
        }));

      mockFetch.mockResolvedValue(okResponse(padPrompt("New content"), '"new-etag"'));

      const first = await getOpenCodeCodexPrompt();

      // Disk bytes a same-UID writer could plant never serve ahead of the
      // upstream exchange — the first caller already gets fetched content.
      expect(first).toContain("New content");
      expect(first).not.toContain("Old cached content");
      const second = await getOpenCodeCodexPrompt();
      expect(second).toContain("New content");
      expect(writeFileAtomic).toHaveBeenCalledWith(
        expect.stringContaining("opencode-codex.txt"),
        expect.stringContaining("New content"),
      );
    });

    it("falls back to a hash-bound cache on network error, then suppresses retries for the TTL", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      const diskContent = padPrompt("Cached fallback content");
      const seedCache = () =>
        vi.mocked(readFile)
          .mockResolvedValueOnce(diskContent)
          .mockResolvedValueOnce(JSON.stringify({
            etag: gitBlobEtag(diskContent),
            lastChecked: Date.now() - 20 * 60 * 1000,
          }));
      seedCache();

      mockFetch.mockRejectedValue(new Error("Network error"));

      const result = await getOpenCodeCodexPrompt();
      expect(result).toContain("Cached fallback content");

      // An offline window must not pay a full source-list sweep per call:
      // the recorded failure suppresses the next fetch for the TTL.
      seedCache();
      const callsAfterFirst = mockFetch.mock.calls.length;
      const second = await getOpenCodeCodexPrompt();
      expect(second).toContain("Cached fallback content");
      expect(mockFetch.mock.calls.length).toBe(callsAfterFirst);
    });

    it("throws when no cache and fetch fails", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
      mockFetch.mockRejectedValue(new Error("Network error"));

      await expect(getOpenCodeCodexPrompt()).rejects.toThrow(
        "Failed to fetch OpenCode codex.txt and no verifiable cache available"
      );
      expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
    });

    it("falls back to a hash-bound cache on non-OK response", async () => {
      const { getOpenCodeCodexPrompt } = await import("../lib/prompts/opencode-codex.js");

      const diskContent = padPrompt("Cached content for 500");
      vi.mocked(readFile)
        .mockResolvedValueOnce(diskContent)
        .mockResolvedValueOnce(JSON.stringify({
          etag: gitBlobEtag(diskContent),
          lastChecked: Date.now() - 20 * 60 * 1000,
        }));

      mockFetch.mockResolvedValue(statusResponse(500));

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

      mockFetch.mockResolvedValue(okResponse(padPrompt("Fresh content"), '"new-etag"'));

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

      mockFetch.mockResolvedValue(okResponse(padPrompt("Replacement content"), '"new-etag"'));

      const result = await getOpenCodeCodexPrompt();

      expect(result).toContain("Replacement content");
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe("getCachedPromptPrefix", () => {
    it("returns first N characters of content this process verified", async () => {
      const { getOpenCodeCodexPrompt, getCachedPromptPrefix } = await import(
        "../lib/prompts/opencode-codex.js"
      );

      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
      mockFetch.mockResolvedValue(
        okResponse(padPrompt("This is a long cached prompt content")),
      );

      await getOpenCodeCodexPrompt();
      const result = await getCachedPromptPrefix(10);

      expect(result).toBe("This is a ");
    });

    it("returns null for planted disk content that was never verified upstream", async () => {
      const { getCachedPromptPrefix } = await import("../lib/prompts/opencode-codex.js");

      // The strip-needle must come from verified bytes only — a same-UID
      // writer cannot seed it by dropping a file plus a plausible meta.
      vi.mocked(readFile)
        .mockResolvedValueOnce(padPrompt("Planted prompt body"))
        .mockResolvedValueOnce(JSON.stringify({
          etag: '"planted"',
          lastChecked: Date.now() - 1000,
        }));

      const result = await getCachedPromptPrefix(10);

      expect(result).toBeNull();
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
      const { getOpenCodeCodexPrompt, getCachedPromptPrefix } = await import(
        "../lib/prompts/opencode-codex.js"
      );

      const longContent = "A".repeat(200);
      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
      mockFetch.mockResolvedValue(okResponse(longContent));

      await getOpenCodeCodexPrompt();
      const result = await getCachedPromptPrefix();

      expect(result).toBe("A".repeat(50));
    });
  });
});
