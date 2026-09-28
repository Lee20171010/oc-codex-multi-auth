import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

vi.mock("node:fs", () => ({
	promises: {
		readFile: vi.fn(),
		writeFile: vi.fn(),
		mkdir: vi.fn(),
	},
}));

vi.mock("../lib/storage/atomic-write.js", () => ({
	writeFileAtomic: vi.fn(async () => undefined),
}));

const originalFetch = global.fetch;
let mockFetch: ReturnType<typeof vi.fn>;

import { getModelFamily, getCodexInstructions, ensureInstructionIdentity, MODEL_FAMILIES, TOOL_REMAP_MESSAGE, __clearCacheForTesting } from "../lib/prompts/codex.js";
import { BUNDLED_CODEX_INSTRUCTIONS } from "../lib/prompts/codex-instructions.js";
import { writeFileAtomic } from "../lib/storage/atomic-write.js";

const mockedReadFile = vi.mocked(fs.readFile);
const mockedWriteFileAtomic = vi.mocked(writeFileAtomic);
const mockedMkdir = vi.mocked(fs.mkdir);

// Fixture bodies must clear the 128-char minimum-length sanity check real
// prompts are held to — pad a recognizable label with filler so assertions
// can still `toContain` the label.
const padPrompt = (label: string): string => `${label}\n\n${"x".repeat(200)}`;

/**
 * URL-aware fetch stub matching the response surface the production code
 * actually reads — `text()` on every hop (the tag API, the HTML fallback, the
 * catalog, and prompt bodies), plus `url` and `headers.get` where used.
 */
const stubOkFetch = (opts: {
	tag?: string;
	catalog?: string;
	prompt?: string;
	etag?: string;
} = {}): void => {
	const tag = opts.tag ?? "rust-v0.111.0";
	mockFetch.mockImplementation((url: unknown) => {
		const href = String(url);
		if (href.includes("api.github.com")) {
			return Promise.resolve({
				ok: true,
				status: 200,
				text: () => Promise.resolve(JSON.stringify({ tag_name: tag })),
				headers: { get: () => null },
			});
		}
		if (href.includes("github.com/openai/codex/releases")) {
			return Promise.resolve({
				ok: true,
				status: 200,
				url: `https://github.com/openai/codex/releases/tag/${tag}`,
				text: () => Promise.resolve("<html></html>"),
				headers: { get: () => null },
			});
		}
		const body = href.includes("models.json")
			? (opts.catalog ?? JSON.stringify({ models: [] }))
			: (opts.prompt ?? padPrompt("content"));
		return Promise.resolve({
			ok: true,
			status: 200,
			text: () => Promise.resolve(body),
			headers: { get: () => opts.etag ?? "etag" },
		});
	});
};

/**
 * git blob SHA of a body — `sha1("blob <len>\0<body>")` — which is what
 * `raw.githubusercontent.com` etags contain and what the 304 path verifies
 * disk bytes against before serving them.
 */
const gitBlobSha1 = (content: string): string => {
	const payload = Buffer.from(content, "utf8");
	return createHash("sha1")
		.update(`blob ${payload.length}\0`)
		.update(payload)
		.digest("hex");
};

describe("Codex Prompts Module", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__clearCacheForTesting();
		mockFetch = vi.fn();
		global.fetch = mockFetch as unknown as typeof fetch;
	});

	afterEach(() => {
		global.fetch = originalFetch;
	});

			describe("MODEL_FAMILIES constant", () => {
			it("should export all model families", () => {
				expect(MODEL_FAMILIES).toContain("gpt-5-codex");
				expect(MODEL_FAMILIES).toContain("codex-max");
				expect(MODEL_FAMILIES).toContain("codex");
				expect(MODEL_FAMILIES).toContain("gpt-5.4");
				expect(MODEL_FAMILIES).toContain("gpt-5.4-mini");
				expect(MODEL_FAMILIES).toContain("gpt-5.4-pro");
				expect(MODEL_FAMILIES).toContain("gpt-5.2");
				expect(MODEL_FAMILIES).toContain("gpt-5.1");
			});

			it("should be a readonly array", () => {
				expect(Array.isArray(MODEL_FAMILIES)).toBe(true);
				expect(MODEL_FAMILIES.length).toBeGreaterThanOrEqual(8);
				expect(new Set(MODEL_FAMILIES).size).toBe(MODEL_FAMILIES.length);
			});
		});

		describe("TOOL_REMAP_MESSAGE constant", () => {
			it("should include schema guidance, illustrative note, and patch/apply_patch mentions", () => {
			expect(TOOL_REMAP_MESSAGE).toContain("exact tool names listed in the active tool schema/manifest");
			expect(TOOL_REMAP_MESSAGE).toContain("This list is illustrative. Always defer to the active tool schema/manifest");
			expect(TOOL_REMAP_MESSAGE).toContain("apply_patch");
			expect(TOOL_REMAP_MESSAGE).toContain("patch");
			expect(TOOL_REMAP_MESSAGE).toContain("edit");
			});

		it("should avoid hard-forcing apply_patch to patch", () => {
			expect(TOOL_REMAP_MESSAGE).not.toContain("Never call a tool literally named apply_patch/applyPatch");
			expect(TOOL_REMAP_MESSAGE).toContain("use the exact tool name from the active schema");
		});

		it("should contain update_plan replacement instruction", () => {
			expect(TOOL_REMAP_MESSAGE).toContain("UPDATE_PLAN DOES NOT EXIST");
			expect(TOOL_REMAP_MESSAGE).toContain("todowrite");
		});

		it("should list available tools", () => {
			expect(TOOL_REMAP_MESSAGE).toContain("write");
			expect(TOOL_REMAP_MESSAGE).toContain("edit");
			expect(TOOL_REMAP_MESSAGE).toContain("apply_patch");
			expect(TOOL_REMAP_MESSAGE).toContain("read");
			expect(TOOL_REMAP_MESSAGE).toContain("bash");
			expect(TOOL_REMAP_MESSAGE).toContain("grep");
		});
	});

			describe("getModelFamily", () => {
			it("should detect gpt-5.4, gpt-5.4-mini, and gpt-5.4-pro", () => {
				expect(getModelFamily("gpt-5.4")).toBe("gpt-5.4");
				expect(getModelFamily("gpt-5.4-high")).toBe("gpt-5.4");
				expect(getModelFamily("gpt-5.4-2026-03-05-high")).toBe("gpt-5.4");
				expect(getModelFamily("gpt-5.4-mini")).toBe("gpt-5.4-mini");
				expect(getModelFamily("gpt 5.4 mini high")).toBe("gpt-5.4-mini");
				expect(getModelFamily("gpt-5.4-mini-2026-03-05-high")).toBe("gpt-5.4-mini");
				expect(getModelFamily("gpt-5.4-pro")).toBe("gpt-5.4-pro");
				expect(getModelFamily("gpt 5.4 pro")).toBe("gpt-5.4-pro");
				expect(getModelFamily("gpt-5.4-pro-2026-03-05-high")).toBe("gpt-5.4-pro");
			});

			it("should not classify gpt-5.40 style names as gpt-5.4 family", () => {
				expect(getModelFamily("gpt-5.40")).toBe("gpt-5.1");
			});

			it("should detect gpt-5.3-codex-spark", () => {
				expect(getModelFamily("gpt-5.3-codex-spark")).toBe("gpt-5-codex");
			});

			it("should detect gpt-5.3-codex with space separator", () => {
				expect(getModelFamily("gpt 5.3 codex")).toBe("gpt-5-codex");
			});

			it("should detect gpt-5.2-codex with space separator", () => {
				expect(getModelFamily("gpt 5.2 codex")).toBe("gpt-5-codex");
			});

			it("should classify gpt-5 codex mini aliases under gpt-5-codex family", () => {
				expect(getModelFamily("gpt-5-codex-mini-low")).toBe("gpt-5-codex");
				expect(getModelFamily("gpt-5.1-codex-mini-low")).toBe("gpt-5-codex");
			});

		it("should detect models starting with codex-", () => {
			expect(getModelFamily("codex-mini")).toBe("codex");
			expect(getModelFamily("codex-latest")).toBe("codex");
		});
	});

	describe("getCodexInstructions", () => {
		describe("Memory cache behavior", () => {
			it("should return cached content within TTL", async () => {
				const recentTimestamp = Date.now() - 5 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "cached-etag",
							tag: "rust-v0.43.0",
							lastChecked: recentTimestamp,
							url: "https://example.com",
						}));
					}
					return Promise.resolve(padPrompt("cached instructions"));
				});

				const first = await getCodexInstructions("gpt-5.1-codex");
				const second = await getCodexInstructions("gpt-5.1-codex");
				
				expect(first).toContain("cached instructions");
				expect(second).toBe(first);
			});
		});

		describe("Disk cache with TTL", () => {
			it("should use disk cache if within TTL", async () => {
				const recentTimestamp = Date.now() - 5 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "cached-etag",
							tag: "rust-v0.43.0",
							lastChecked: recentTimestamp,
							url: "https://example.com",
						}));
					}
					return Promise.resolve(padPrompt("disk cached instructions"));
				});

				const result = await getCodexInstructions("gpt-5.2");
				expect(result).toContain("disk cached instructions");
			});

			it("prepends backend identity when native instructions have no model identity", () => {
				const result = ensureInstructionIdentity(
					"Existing native instructions.",
					"gpt-5.5",
				);

				expect(result).toContain(
					"You are the model identified to the backend as gpt-5.5, running in the Codex CLI, a terminal-based coding assistant.",
				);
				expect(result).toContain("Existing native instructions.");
			});

			it("rewrites the instruction identity to the exact backend model id", async () => {
				const recentTimestamp = Date.now() - 5 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "cached-etag",
							tag: "rust-v0.43.0",
							lastChecked: recentTimestamp,
							url: "https://example.com",
						}));
					}
					return Promise.resolve(
						padPrompt("You are GPT-5.2 running in the Codex CLI, a terminal-based coding assistant."),
					);
				});

				const result = await getCodexInstructions("gpt-5.5");
				expect(result).toContain(
					"You are the model identified to the backend as gpt-5.5, running in the Codex CLI, a terminal-based coding assistant.",
				);
				expect(result).not.toContain("You are GPT-5.2 running in the Codex CLI");
			});

			it("keeps the backend model id accurate for legacy aliases too", async () => {
				const recentTimestamp = Date.now() - 5 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "cached-etag",
							tag: "rust-v0.43.0",
							lastChecked: recentTimestamp,
							url: "https://example.com",
						}));
					}
					return Promise.resolve(
						padPrompt("You are GPT-5.2 running in the Codex CLI, a terminal-based coding assistant."),
					);
				});

				const result = await getCodexInstructions("gpt-5-codex");
				expect(result).toContain(
					"You are the model identified to the backend as gpt-5-codex, running in the Codex CLI, a terminal-based coding assistant.",
				);
			});

			it.each([
				"gpt-5.5",
				"gpt-5.4",
				"gpt-5.4-mini",
				"gpt-5.4-nano",
				"gpt-5.4-pro",
				"gpt-5.2",
				"gpt-5.1",
				"gpt-5-codex",
				"gpt-5.1-codex-max",
				"gpt-5.1-codex-mini",
			])("rewrites stale prompt-family identity for backend %s", async (backendModel) => {
				const recentTimestamp = Date.now() - 5 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "cached-etag",
							tag: "rust-v0.43.0",
							lastChecked: recentTimestamp,
							url: "https://example.com",
						}));
					}
					return Promise.resolve(
						padPrompt("You are GPT-5.2 running in the Codex CLI, a terminal-based coding assistant."),
					);
				});

				const result = await getCodexInstructions(backendModel);
				expect(result).toContain(
					`You are the model identified to the backend as ${backendModel}, running in the Codex CLI, a terminal-based coding assistant.`,
				);
				expect(result).not.toContain("You are GPT-5.2 running in the Codex CLI");
			});

			it("rewrites the current Codex-family identity line to the backend model id", async () => {
				const recentTimestamp = Date.now() - 5 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "cached-etag",
							tag: "rust-v0.43.0",
							lastChecked: recentTimestamp,
							url: "https://example.com",
						}));
					}
					return Promise.resolve(
						padPrompt("You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user's computer."),
					);
				});

				const result = await getCodexInstructions("gpt-5-codex");
				expect(result).toContain(
					"You are the model identified to the backend as gpt-5-codex, running in the Codex CLI, a terminal-based coding assistant.",
				);
				expect(result).not.toContain("You are Codex, based on GPT-5.");
			});
		});

		describe("GitHub fetch with ETag", () => {
			it("should fetch from GitHub API for latest release tag", async () => {
				mockedReadFile.mockRejectedValue(new Error("ENOENT"));
				stubOkFetch({
					tag: "rust-v0.50.0",
					prompt: padPrompt("new instructions from github"),
					etag: "new-etag",
				});
				mockedMkdir.mockResolvedValue(undefined);
				mockedWriteFileAtomic.mockResolvedValue(undefined);

				const result = await getCodexInstructions("codex-max");
				expect(result).toContain("new instructions from github");
				// Tag lookup plus the prompt fetch — and no more.
				expect(mockFetch).toHaveBeenCalledTimes(2);
			});

			it("should handle 304 Not Modified response", async () => {
				const oldTimestamp = Date.now() - 20 * 60 * 1000;
				const diskBody = padPrompt("disk cached content");
				// The 304 path serves disk bytes only when they hash to the
				// etag the server just confirmed — this meta carries the real
				// git blob SHA, so the conditional refetch can trust the file.
				const etag = `"${gitBlobSha1(diskBody)}"`;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag,
							tag: "rust-v0.43.0",
							lastChecked: oldTimestamp,
							url: "https://example.com",
						}));
					}
					return Promise.resolve(diskBody);
				});
				mockFetch.mockImplementation((url: unknown) => {
					const href = String(url);
					if (href.includes("api.github.com")) {
						return Promise.resolve({
							ok: true,
							status: 200,
							text: () => Promise.resolve(JSON.stringify({ tag_name: "rust-v0.43.0" })),
							headers: { get: () => null },
						});
					}
					return Promise.resolve({
						ok: false,
						status: 304,
						text: () => Promise.resolve(""),
						headers: { get: () => null },
					});
				});

				const result = await getCodexInstructions("gpt-5.1");
				expect(result).toContain("disk cached content");
				// The 304 needed no body, and the hash-verified disk body needed
				// no unconditional refetch — two calls total.
				expect(mockFetch).toHaveBeenCalledTimes(2);
			});

			it("should refetch unconditionally when the disk body does not hash to the confirmed etag", async () => {
				const oldTimestamp = Date.now() - 20 * 60 * 1000;
				// Planted body + forged meta: the etag acknowledges *some*
				// upstream content, but the planted bytes can never hash to it.
				const etag = `"${"0".repeat(40)}"`;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag,
							tag: "rust-v0.43.0",
							lastChecked: oldTimestamp,
							url: "https://example.com",
						}));
					}
					return Promise.resolve(padPrompt("planted body"));
				});
				mockFetch.mockImplementation((url: unknown) => {
					const href = String(url);
					if (href.includes("api.github.com")) {
						return Promise.resolve({
							ok: true,
							status: 200,
							text: () => Promise.resolve(JSON.stringify({ tag_name: "rust-v0.43.0" })),
							headers: { get: () => null },
						});
					}
					const conditional = mockFetch.mock.calls.length <= 2;
					if (conditional) {
						return Promise.resolve({
							ok: false,
							status: 304,
							text: () => Promise.resolve(""),
							headers: { get: () => null },
						});
					}
					return Promise.resolve({
						ok: true,
						status: 200,
						text: () => Promise.resolve(padPrompt("real upstream body")),
						headers: { get: () => '"fresh-etag"' },
					});
				});
				mockedMkdir.mockResolvedValue(undefined);
				mockedWriteFileAtomic.mockResolvedValue(undefined);

				const result = await getCodexInstructions("gpt-5.1");

				// The forged etag passed a 304, the planted body failed the hash
				// check, and the unconditional refetch supplied real bytes.
				expect(result).toContain("real upstream body");
				expect(result).not.toContain("planted body");
				const rawCalls = mockFetch.mock.calls.filter(
					(call) => typeof call[0] === "string" && call[0].includes("raw.githubusercontent.com"),
				);
				expect(rawCalls.length).toBe(2);
				const secondInit = rawCalls[1]?.[1] as { headers?: Record<string, string> } | undefined;
				expect(secondInit?.headers?.["If-None-Match"]).toBeUndefined();
			});

			it("should fetch synchronously when the cached copy is stale and unverified", async () => {
				const oldTimestamp = Date.now() - 20 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "old-etag",
							tag: "rust-v0.40.0",
							lastChecked: oldTimestamp,
							url: "https://example.com",
						}));
					}
					return Promise.resolve(padPrompt("old content"));
				});
				stubOkFetch({
					tag: "rust-v0.50.0",
					prompt: padPrompt("new version content"),
					etag: "new-etag",
				});
				mockedMkdir.mockResolvedValue(undefined);
				mockedWriteFileAtomic.mockResolvedValue(undefined);

				// A stale same-UID-writable cache never serves until this process
				// has hit the trusted source — the fetch is synchronous, not
				// stale-while-revalidate.
				const first = await getCodexInstructions("gpt-5.1-codex");
				expect(first).toContain("new version content");
				const callsAfterFirst = mockFetch.mock.calls.length;
				const second = await getCodexInstructions("gpt-5.1-codex");
				expect(second).toContain("new version content");
				expect(mockFetch.mock.calls.length).toBe(callsAfterFirst);
			});
		});

		describe("GitHub HTML fallback", () => {
			it("should fall back to HTML releases page when API fails", async () => {
				mockedReadFile.mockRejectedValue(new Error("ENOENT"));
				mockFetch.mockImplementation((url: unknown) => {
					const href = String(url);
					if (href.includes("api.github.com")) {
						return Promise.resolve({
							ok: false,
							status: 403,
							text: () => Promise.resolve(""),
							headers: { get: () => null },
						});
					}
					if (href.includes("github.com/openai/codex/releases")) {
						return Promise.resolve({
							ok: true,
							status: 200,
							url: "https://github.com/openai/codex/releases/tag/rust-v0.45.0",
							text: () => Promise.resolve(""),
							headers: { get: () => null },
						});
					}
					return Promise.resolve({
						ok: true,
						status: 200,
						text: () => Promise.resolve(padPrompt("fallback instructions")),
						headers: { get: () => "fallback-etag" },
					});
				});
				mockedMkdir.mockResolvedValue(undefined);
				mockedWriteFileAtomic.mockResolvedValue(undefined);

				const result = await getCodexInstructions("gpt-5.2-codex");
				expect(result).toContain("fallback instructions");
			});

			it("should parse tag from HTML content if URL parsing fails", async () => {
				mockedReadFile.mockRejectedValue(new Error("ENOENT"));
				mockFetch.mockImplementation((url: unknown) => {
					const href = String(url);
					if (href.includes("api.github.com")) {
						return Promise.resolve({
							ok: false,
							status: 500,
							text: () => Promise.resolve(""),
							headers: { get: () => null },
						});
					}
					if (href.includes("github.com/openai/codex/releases")) {
						return Promise.resolve({
							ok: true,
							status: 200,
							url: "https://github.com/openai/codex/releases/latest",
							text: () => Promise.resolve('<a href="/openai/codex/releases/tag/rust-v0.47.0">Release</a>'),
							headers: { get: () => null },
						});
					}
					return Promise.resolve({
						ok: true,
						status: 200,
						text: () => Promise.resolve(padPrompt("html parsed instructions")),
						headers: { get: () => "html-etag" },
					});
				});
				mockedMkdir.mockResolvedValue(undefined);
				mockedWriteFileAtomic.mockResolvedValue(undefined);

				const result = await getCodexInstructions("codex");
				expect(result).toContain("html parsed instructions");
			});

		it("should fall back to bundled when HTML fallback page request fails", async () => {
			mockedReadFile.mockRejectedValue(new Error("ENOENT"));
			mockFetch.mockImplementation((url: unknown) => {
				const href = String(url);
				const status = href.includes("api.github.com") ? 403 : 500;
				return Promise.resolve({
					ok: false,
					status,
					text: () => Promise.resolve(""),
					headers: { get: () => null },
				});
			});

			const result = await getCodexInstructions("gpt-5.2");
			// The identity line is rewritten per model; the rest of the vendored
			// prompt body must come through verbatim.
			expect(result).toContain(
				"You are the model identified to the backend as",
			);
			expect(result).toContain("apply_patch");
			expect(result.length).toBeGreaterThan(
				BUNDLED_CODEX_INSTRUCTIONS.length - 500,
			);
		});

		it("should fall back to bundled when both URL parsing and HTML regex fail", async () => {
			mockedReadFile.mockRejectedValue(new Error("ENOENT"));
			mockFetch.mockImplementation((url: unknown) => {
				const href = String(url);
				if (href.includes("api.github.com")) {
					return Promise.resolve({
						ok: false,
						status: 403,
						text: () => Promise.resolve(""),
						headers: { get: () => null },
					});
				}
				return Promise.resolve({
					ok: true,
					status: 200,
					url: "https://github.com/openai/codex/releases/latest",
					text: () => Promise.resolve("no matching content here"),
					headers: { get: () => null },
				});
			});

			const result = await getCodexInstructions("gpt-5.1");
			expect(result).toContain(
				"You are the model identified to the backend as",
			);
			expect(result).toContain("apply_patch");
		});
	});

		describe("Fallback behavior", () => {
			it("should fall back to disk cache on fetch error", async () => {
				const oldTimestamp = Date.now() - 20 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "cached",
							tag: "old",
							lastChecked: oldTimestamp,
						}));
					}
					return Promise.resolve(padPrompt("fallback disk content"));
				});
				mockFetch.mockRejectedValue(new Error("Network error"));

				const result = await getCodexInstructions("gpt-5.1");
				expect(result).toContain("fallback disk content");
			});

			it("should fall back to disk cache on HTTP error response", async () => {
				const oldTimestamp = Date.now() - 20 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "cached",
							tag: "rust-v0.43.0",
							lastChecked: oldTimestamp,
						}));
					}
					return Promise.resolve(padPrompt("disk cache fallback"));
				});
				mockFetch.mockImplementation((url: unknown) => {
					const href = String(url);
					if (href.includes("api.github.com")) {
						return Promise.resolve({
							ok: true,
							status: 200,
							text: () => Promise.resolve(JSON.stringify({ tag_name: "rust-v0.43.0" })),
							headers: { get: () => null },
						});
					}
					return Promise.resolve({
						ok: false,
						status: 500,
						text: () => Promise.resolve(""),
						headers: { get: () => null },
					});
				});

				const result = await getCodexInstructions("gpt-5.2");
				expect(result).toContain("disk cache fallback");
			});

			it("should fall back to bundled instructions when all else fails", async () => {
				mockedReadFile.mockRejectedValue(new Error("ENOENT"));
				mockFetch.mockRejectedValue(new Error("Network error"));

				const result = await getCodexInstructions("gpt-5.1");
				expect(result).toContain(
					"You are the model identified to the backend as",
				);
				expect(result).toContain("apply_patch");
			});

			it("bundled fallback is non-empty and carries the Codex identity line", async () => {
				mockedReadFile.mockRejectedValue(new Error("ENOENT"));
				mockFetch.mockRejectedValue(new Error("offline"));

				const result = await getCodexInstructions("gpt-5-codex");

				// A dead bundled read used to ENOENT here, so the request shipped
				// upstream with no instructions at all (transform returned undefined).
				expect(BUNDLED_CODEX_INSTRUCTIONS.trim().length).toBeGreaterThan(0);
				expect(result).toContain(
					"You are the model identified to the backend as gpt-5-codex",
				);
			});
		});

		describe("Cache poisoning defenses", () => {
			it("treats a future lastChecked as absent and fetches fresh", async () => {
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: '"planted"',
							tag: "rust-v0.43.0",
							url: "https://raw.githubusercontent.com/openai/codex/rust-v0.43.0/codex-rs/core/gpt_5_codex_prompt.md",
							// A stamp in the future satisfies `now - lastChecked < TTL`
							// forever; it must not pin the planted body in place.
							lastChecked: Date.now() + 60 * 60 * 1000,
						}));
					}
					return Promise.resolve(padPrompt("planted disk content"));
				});
				stubOkFetch({
					tag: "rust-v0.99.0",
					prompt: padPrompt("freshly fetched"),
					etag: '"new-etag"',
				});
				mockedMkdir.mockResolvedValue(undefined);

				const result = await getCodexInstructions("gpt-5-codex");

				expect(mockFetch).toHaveBeenCalled();
				expect(result).toContain("freshly fetched");
			});

			it("never serves a plausible planted body without an upstream exchange", async () => {
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: '"planted-etag"',
							tag: "rust-v0.43.0",
							url: "https://example.com/prompt.md",
							// Past stamp inside the TTL window — the exact cache the
							// review planted and had served with zero fetches.
							lastChecked: Date.now() - 60 * 1000,
						}));
					}
					return Promise.resolve(padPrompt("planted instructions body"));
				});
				stubOkFetch({
					tag: "rust-v0.43.0",
					prompt: padPrompt("verified upstream body"),
					etag: '"real-etag"',
				});
				mockedMkdir.mockResolvedValue(undefined);

				const result = await getCodexInstructions("gpt-5-codex");

				// The plant fails the conditional handshake: its forged etag gets
				// a 200 (not a confirming 304) and real bytes replace it.
				expect(mockFetch).toHaveBeenCalled();
				expect(result).toContain("verified upstream body");
				expect(result).not.toContain("planted instructions body");
			});

			it("serves a planted cache only inside a genuine offline window", async () => {
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: '"planted-etag"',
							tag: "rust-v0.43.0",
							url: "https://example.com/prompt.md",
							lastChecked: Date.now() - 60 * 1000,
						}));
					}
					return Promise.resolve(padPrompt("offline planted body"));
				});
				mockFetch.mockRejectedValue(new Error("offline"));

				const first = await getCodexInstructions("gpt-5-codex");
				expect(first).toContain("offline planted body");

				// A recent failure suppresses retry for the TTL window — the
				// second call must not pay another doomed fetch.
				const callsAfterFirst = mockFetch.mock.calls.length;
				const second = await getCodexInstructions("gpt-5-codex");
				expect(second).toContain("offline planted body");
				expect(mockFetch.mock.calls.length).toBe(callsAfterFirst);
			});

			it("never interpolates a malformed release tag into the prompt URL", async () => {
				mockedReadFile.mockRejectedValue(new Error("ENOENT"));
				mockFetch.mockImplementation((url) => {
					const href = String(url);
					if (href.includes("api.github.com")) {
						return Promise.resolve({
							ok: true,
							status: 200,
							// A tag with path separators would escape the pinned
							// openai/codex path via WHATWG URL normalization.
							text: () => Promise.resolve(JSON.stringify({ tag_name: "../../evil/repo" })),
							headers: { get: () => null },
						});
					}
					if (href.includes("github.com/openai/codex/releases")) {
						return Promise.resolve({
							ok: true,
							status: 200,
							url: "https://github.com/openai/codex/releases/tag/rust-v0.99.0",
							text: () => Promise.resolve("<html></html>"),
							headers: { get: () => null },
						});
					}
					return Promise.resolve({
						ok: true,
						status: 200,
						text: () => Promise.resolve(padPrompt("freshly fetched")),
						headers: { get: () => '"etag"' },
					});
				});
				mockedMkdir.mockResolvedValue(undefined);

				const result = await getCodexInstructions("gpt-5-codex");

				const fetchedUrls = mockFetch.mock.calls.map((call) => String(call[0]));
				expect(fetchedUrls.some((u) => u.includes("evil") || u.includes(".."))).toBe(false);
				expect(result).toContain("freshly fetched");
			});

			it("rejects an HTML error page served as the prompt body", async () => {
				mockedReadFile.mockRejectedValue(new Error("ENOENT"));
				const htmlErrorPage =
					"<!DOCTYPE html><html><body>404 Not Found" + "x".repeat(200) + "</body></html>";
				mockFetch.mockImplementation((url) => {
					const href = String(url);
					if (href.includes("api.github.com")) {
						return Promise.resolve({
							ok: true,
							status: 200,
							text: () => Promise.resolve(JSON.stringify({ tag_name: "rust-v0.99.0" })),
							headers: { get: () => null },
						});
					}
					return Promise.resolve({
						ok: true,
						status: 200,
						text: () => Promise.resolve(htmlErrorPage),
						headers: { get: () => '"etag"' },
					});
				});
				mockedMkdir.mockResolvedValue(undefined);

				const result = await getCodexInstructions("gpt-5-codex");

				expect(result).not.toContain("404 Not Found");
				expect(result).toContain(
					"You are the model identified to the backend as gpt-5-codex",
				);
				// The rejected body must never reach the cache.
				expect(
					mockedWriteFileAtomic.mock.calls.some(([, contents]) =>
						String(contents).includes("404 Not Found"),
					),
				).toBe(false);
			});

			it("does not serve a too-short or HTML disk cache body", async () => {
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: '"e"',
							tag: "rust-v0.43.0",
							url: "https://example.com/prompt.md",
							lastChecked: Date.now() - 60 * 1000,
						}));
					}
					// Fresh meta over a stub body: the stub would otherwise be served
					// verbatim as a system prompt.
					return Promise.resolve("short");
				});
				mockFetch.mockRejectedValue(new Error("offline"));

				const result = await getCodexInstructions("gpt-5.1");

				expect(result).not.toBe("short");
				expect(result).toContain(
					"You are the model identified to the backend as gpt-5.1",
				);
			});
		});

		describe("Cache size management", () => {
			it("should handle multiple model families without exceeding cache size", async () => {
				mockedReadFile.mockResolvedValue("instructions");
				
				for (const family of MODEL_FAMILIES) {
					const result = await getCodexInstructions(family);
					expect(result).toBeDefined();
				}
			});

			it("should evict oldest entry when cache exceeds max size", async () => {
				const recentTimestamp = Date.now() - 5 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "cached-etag",
							tag: "rust-v0.43.0",
							lastChecked: recentTimestamp,
							url: "https://example.com",
						}));
					}
					return Promise.resolve(padPrompt("cached instructions"));
				});

				for (let i = 0; i < 55; i++) {
					await getCodexInstructions(`test-model-${i}`);
				}
				
				const result = await getCodexInstructions("gpt-5.1-codex");
				expect(result).toContain("cached instructions");
			});
		});

			describe("Model family mapping", () => {
				it("should use correct prompt file for each model family", async () => {
				mockedReadFile.mockRejectedValue(new Error("ENOENT"));
				stubOkFetch({ tag: "rust-v0.43.0", prompt: padPrompt("content") });
				mockedMkdir.mockResolvedValue(undefined);
				mockedWriteFileAtomic.mockResolvedValue(undefined);

				await getCodexInstructions("gpt-5-codex");
				
				const fetchCalls = mockFetch.mock.calls;
				const rawGitHubCall = fetchCalls.find(call => 
					typeof call[0] === "string" && call[0].includes("raw.githubusercontent.com")
				);
					expect(rawGitHubCall?.[0]).toContain("gpt_5_codex_prompt.md");
				});

				it("should map gpt-5.3-codex prompts to the current codex prompt file", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					stubOkFetch({ tag: "rust-v0.98.0", prompt: padPrompt("content") });
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFileAtomic.mockResolvedValue(undefined);

					await getCodexInstructions("gpt-5.3-codex");
					const fetchCalls = mockFetch.mock.calls;
					const rawGitHubCall = fetchCalls.find(
						(call) =>
							typeof call[0] === "string" &&
							call[0].includes("raw.githubusercontent.com"),
					);
					expect(rawGitHubCall?.[0]).toContain("gpt_5_codex_prompt.md");
				});

				// Modern Codex sends per-model `base_instructions` from the model
				// catalog. gpt_5_2_prompt.md would open "You are GPT-5.2 running in
				// the Codex CLI", which is not what the backend expects for 5.4/5.5.
				const catalogPayload = JSON.stringify({
					models: [
						{ slug: "gpt-5.4", base_instructions: padPrompt("GPT54 CATALOG PROMPT") },
						{ slug: "gpt-5.4-mini", base_instructions: padPrompt("GPT54MINI CATALOG PROMPT") },
						{ slug: "gpt-5.5", base_instructions: padPrompt("GPT55 CATALOG PROMPT") },
					],
				});

				it("should source gpt-5.4 instructions from the model catalog", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					stubOkFetch({ tag: "rust-v0.111.0", catalog: catalogPayload });
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFileAtomic.mockResolvedValue(undefined);

					const result = await getCodexInstructions("gpt-5.4");
					const fetchCalls = mockFetch.mock.calls;
					const rawGitHubCall = fetchCalls.find(
						(call) =>
							typeof call[0] === "string" &&
							call[0].includes("raw.githubusercontent.com"),
					);
					expect(rawGitHubCall?.[0]).toContain("models-manager/models.json");
					expect(result).toContain("GPT54 CATALOG PROMPT");
					// No prompt-file fetch when the catalog has the slug.
					expect(
						fetchCalls.some(
							(call) =>
								typeof call[0] === "string" && call[0].includes("gpt_5_2_prompt.md"),
						),
					).toBe(false);
				});

				it("should give gpt-5.5 its own catalog text and cache file, not gpt-5.4's", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					stubOkFetch({ tag: "rust-v0.111.0", catalog: catalogPayload });
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFileAtomic.mockResolvedValue(undefined);

					// gpt-5.5 and gpt-5.4 share the `gpt-5.4` model family, so a
					// family-keyed cache would let one serve the other's prompt.
					const result = await getCodexInstructions("gpt-5.5");
					expect(result).toContain("GPT55 CATALOG PROMPT");
					expect(result).not.toContain("GPT54 CATALOG PROMPT");

					const writeTargets = mockedWriteFileAtomic.mock.calls.map(([target]) =>
						String(target),
					);
					expect(
						writeTargets.some((target) =>
							target.includes("catalog-gpt-5.5-instructions.md"),
						),
					).toBe(true);
					expect(
						writeTargets.some((target) =>
							target.includes("catalog-gpt-5.4-instructions.md"),
						),
					).toBe(false);
				});

				// Regression: slug-space and family-space overlap. gpt-5.4-nano has no
				// catalog entry and lives in the `gpt-5.4` family, which IS a catalog
				// slug. An un-namespaced cache key let them serve each other's
				// instructions in-process within the TTL window.
				it("should not serve gpt-5.4 catalog text to gpt-5.4-nano within one TTL", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					mockFetch.mockImplementation((url: unknown) => {
						const href = String(url);
						if (href.includes("api.github.com")) {
							return Promise.resolve({
								ok: true,
								status: 200,
								text: () => Promise.resolve(JSON.stringify({ tag_name: "rust-v0.111.0" })),
								headers: { get: () => null },
							});
						}
						const body = href.includes("models.json")
							? catalogPayload
							: padPrompt("PROMPT FILE CONTENT");
						return Promise.resolve({
							ok: true,
							status: 200,
							text: () => Promise.resolve(body),
							headers: { get: () => "etag" },
						});
					});
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFileAtomic.mockResolvedValue(undefined);

					// Warm the catalog entry first, exactly as prewarmCodexInstructions does.
					const catalogResult = await getCodexInstructions("gpt-5.4");
					expect(catalogResult).toContain("GPT54 CATALOG PROMPT");

					// nano must NOT pick up the memory-cached catalog text.
					const nanoResult = await getCodexInstructions("gpt-5.4-nano");
					expect(nanoResult).toContain(padPrompt("PROMPT FILE CONTENT"));
					expect(nanoResult).not.toContain("GPT54 CATALOG PROMPT");
				});

				it("should not let a prompt-file model poison a catalog model's cache", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					mockFetch.mockImplementation((url: unknown) => {
						const href = String(url);
						if (href.includes("api.github.com")) {
							return Promise.resolve({
								ok: true,
								status: 200,
								text: () => Promise.resolve(JSON.stringify({ tag_name: "rust-v0.111.0" })),
								headers: { get: () => null },
							});
						}
						const body = href.includes("models.json")
							? catalogPayload
							: padPrompt("PROMPT FILE CONTENT");
						return Promise.resolve({
							ok: true,
							status: 200,
							text: () => Promise.resolve(body),
							headers: { get: () => "etag" },
						});
					});
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFileAtomic.mockResolvedValue(undefined);

					// Reverse order: nano first, then gpt-5.4.
					const nanoResult = await getCodexInstructions("gpt-5.4-nano");
					expect(nanoResult).toContain(padPrompt("PROMPT FILE CONTENT"));

					const catalogResult = await getCodexInstructions("gpt-5.4");
					expect(catalogResult).toContain("GPT54 CATALOG PROMPT");
					expect(catalogResult).not.toContain(padPrompt("PROMPT FILE CONTENT"));
				});

				// prewarmCodexInstructions fires every catalog model concurrently, so a
				// memo that is only populated after the await lets each caller start
				// its own ~300KB models.json download.
				it("should fetch models.json once when catalog models are requested concurrently", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					let resolveCatalog: ((value: unknown) => void) | undefined;
					const catalogGate = new Promise((resolve) => {
						resolveCatalog = resolve;
					});

					mockFetch.mockImplementation((url: unknown) => {
						const href = String(url);
						if (href.includes("models.json")) {
							// Hold the fetch open so every caller arrives before it resolves.
							return catalogGate.then(() => ({
								ok: true,
								status: 200,
								text: () => Promise.resolve(catalogPayload),
								headers: { get: () => "etag" },
							}));
						}
						if (href.includes("api.github.com")) {
							return Promise.resolve({
								ok: true,
								status: 200,
								text: () => Promise.resolve(JSON.stringify({ tag_name: "rust-v0.111.0" })),
								headers: { get: () => null },
							});
						}
						return Promise.resolve({
							ok: true,
							status: 200,
							text: () => Promise.resolve(padPrompt("PROMPT FILE CONTENT")),
							headers: { get: () => "etag" },
						});
					});
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFileAtomic.mockResolvedValue(undefined);

					const pending = Promise.all([
						getCodexInstructions("gpt-5.4"),
						getCodexInstructions("gpt-5.5"),
						getCodexInstructions("gpt-5.4-mini"),
					]);
					// Let all three reach fetchCatalogText before the fetch resolves.
					await new Promise((resolve) => setTimeout(resolve, 0));
					resolveCatalog?.(undefined);

					const [a, b, c] = await pending;
					expect(a).toContain("GPT54 CATALOG PROMPT");
					expect(b).toContain("GPT55 CATALOG PROMPT");
					expect(c).toContain("GPT54MINI CATALOG PROMPT");

					const catalogFetches = mockFetch.mock.calls.filter(
						(call) => typeof call[0] === "string" && call[0].includes("models.json"),
					);
					expect(catalogFetches).toHaveLength(1);
				});

				it("should fall back to the prompt file when the tag has no catalog entry", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					// Catalog without gpt-5.4 — simulates a release predating the slug.
					stubOkFetch({ tag: "rust-v0.111.0", catalog: JSON.stringify({ models: [] }) });
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFileAtomic.mockResolvedValue(undefined);

					await getCodexInstructions("gpt-5.4");
					const fetchCalls = mockFetch.mock.calls;
					expect(
						fetchCalls.some(
							(call) =>
								typeof call[0] === "string" && call[0].includes("gpt_5_2_prompt.md"),
						),
					).toBe(true);
				});

				it("should still use the prompt file for models absent from the catalog", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					stubOkFetch({ tag: "rust-v0.111.0", prompt: padPrompt("content") });
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFileAtomic.mockResolvedValue(undefined);

					// gpt-5.1 has no catalog entry; it must not fetch models.json at all.
					await getCodexInstructions("gpt-5.1");
					const fetchCalls = mockFetch.mock.calls;
					expect(
						fetchCalls.some(
							(call) =>
								typeof call[0] === "string" && call[0].includes("models.json"),
						),
					).toBe(false);
					expect(
						fetchCalls.some(
							(call) =>
								typeof call[0] === "string" && call[0].includes("gpt_5_1_prompt.md"),
						),
					).toBe(true);
				});

				it("should map gpt-5.4-pro prompts to gpt_5_2 prompt file with isolated cache key", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					stubOkFetch({ tag: "rust-v0.111.0", prompt: padPrompt("content") });
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFileAtomic.mockResolvedValue(undefined);

					await getCodexInstructions("gpt-5.4-pro");
					const fetchCalls = mockFetch.mock.calls;
					const rawGitHubCall = fetchCalls.find(
						(call) =>
							typeof call[0] === "string" &&
							call[0].includes("raw.githubusercontent.com"),
					);
					const writeTargets = mockedWriteFileAtomic.mock.calls.map(([target]) => String(target));
					expect(rawGitHubCall?.[0]).toContain("gpt_5_2_prompt.md");
					expect(writeTargets.some((target) => target.includes("gpt-5.4-pro-instructions.md"))).toBe(true);
					expect(
						writeTargets.some((target) => /gpt-5\.4-instructions\.md$/.test(target)),
					).toBe(false);
				});

				it("should source gpt-5.4-mini from the catalog with an isolated cache key", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					stubOkFetch({ tag: "rust-v0.111.0", catalog: catalogPayload });
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFileAtomic.mockResolvedValue(undefined);

					const result = await getCodexInstructions("gpt-5.4-mini");
					const fetchCalls = mockFetch.mock.calls;
					const rawGitHubCall = fetchCalls.find(
						(call) =>
							typeof call[0] === "string" &&
							call[0].includes("raw.githubusercontent.com"),
					);
					const writeTargets = mockedWriteFileAtomic.mock.calls.map(([target]) => String(target));
					expect(rawGitHubCall?.[0]).toContain("models-manager/models.json");
					expect(result).toContain("GPT54MINI CATALOG PROMPT");
					expect(
						writeTargets.some((target) =>
							target.includes("catalog-gpt-5.4-mini-instructions.md"),
						),
					).toBe(true);
					expect(
						writeTargets.some((target) => /catalog-gpt-5\.4-instructions\.md$/.test(target)),
					).toBe(false);
					expect(
						writeTargets.some((target) => /gpt-5\.4-pro-instructions\.md$/.test(target)),
					).toBe(false);
				});

				it("should map gpt-5.3-codex-spark prompts to the current codex prompt file", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					stubOkFetch({ tag: "rust-v0.101.0", prompt: padPrompt("content") });
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFileAtomic.mockResolvedValue(undefined);

					await getCodexInstructions("gpt-5.3-codex-spark");
					const fetchCalls = mockFetch.mock.calls;
					const rawGitHubCall = fetchCalls.find(
						(call) =>
							typeof call[0] === "string" &&
							call[0].includes("raw.githubusercontent.com"),
					);
					expect(rawGitHubCall?.[0]).toContain("gpt_5_codex_prompt.md");
				});
			});
		});
	});
