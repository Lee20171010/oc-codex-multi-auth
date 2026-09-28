/**
 * OpenCode Codex Prompt Fetcher
 *
 * Fetches and caches the codex.txt system prompt from OpenCode's GitHub repository.
 * Uses ETag-based caching to efficiently track updates.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir, readFile } from "node:fs/promises";
import { CodexTimeoutError, PromptError } from "../errors.js";
import { logDebug, logWarn } from "../logger.js";
import { writeFileAtomic } from "../storage/atomic-write.js";

const DEFAULT_OPENCODE_CODEX_URLS = [
	"https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/prompt/codex.txt",
	"https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/session/prompt/codex.txt",
	"https://raw.githubusercontent.com/anomalyco/opencode/main/packages/opencode/src/session/prompt/codex.txt",
	"https://raw.githubusercontent.com/sst/opencode/main/packages/opencode/src/session/prompt/codex.txt",
	"https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/prompt/codex.md",
	"https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/session/prompt/codex.md",
	"https://raw.githubusercontent.com/anomalyco/opencode/main/packages/opencode/src/session/prompt/codex.md",
	"https://raw.githubusercontent.com/sst/opencode/main/packages/opencode/src/session/prompt/codex.md",
] as const;
const OPENCODE_CODEX_URL_OVERRIDE_ENV = "OPENCODE_CODEX_PROMPT_URL";
const CACHE_DIR = join(homedir(), ".opencode", "cache");
const CACHE_FILE = join(CACHE_DIR, "opencode-codex.txt");
const CACHE_META_FILE = join(CACHE_DIR, "opencode-codex-meta.json");
const CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Fetch bound for prompt downloads — same pattern as the update-checker's 5s
 * timeout, scaled for a ~4KB text file.
 */
const PROMPT_FETCH_TIMEOUT_MS = 10_000;

/**
 * Minimum believable size for a codex.txt body. The real prompt is several
 * KB; a shorter payload is an error stub, an empty 200, or a truncated
 * download — and, worse, a short cached body becomes a short strip-needle for
 * `isOpenCodeSystemPrompt`, where `content.startsWith(cachedPrompt)` would
 * then drop arbitrary developer/system messages that merely share the prefix.
 */
const MIN_PROMPT_CONTENT_LENGTH = 128;

/** HTML document openers — a served error page must not become a prompt. */
const HTML_DOCUMENT_MARKER = /^\s*<(?:!doctype|html|head|body|\?xml)\b/i;

function isUsablePromptContent(content: string): boolean {
	const trimmed = content.trim();
	if (trimmed.length < MIN_PROMPT_CONTENT_LENGTH) return false;
	return !HTML_DOCUMENT_MARKER.test(trimmed.slice(0, 512));
}

/**
 * `fetch()` resolves when response headers arrive, so its abort signal stops
 * guarding once `fetch` returns — a connection that stalls mid-body would
 * hang `response.text()` forever. Race the body read against the same bound.
 */
async function responseTextWithTimeout(response: Response): Promise<string> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			response.text(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					reject(
						new CodexTimeoutError(
							`Prompt body read timed out after ${PROMPT_FETCH_TIMEOUT_MS}ms`,
							{ timeoutMs: PROMPT_FETCH_TIMEOUT_MS },
						),
					);
				}, PROMPT_FETCH_TIMEOUT_MS);
				timer.unref();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * `lastChecked` comes from a same-UID-writable cache file, so it is not
 * trustworthy: a stamp in the future makes `isFresh` hold forever and the
 * planted cache gets served indefinitely without a single fetch.
 */
function isUsableCacheTimestamp(lastChecked: unknown, now: number): lastChecked is number {
	return (
		typeof lastChecked === "number" &&
		Number.isFinite(lastChecked) &&
		lastChecked >= 0 &&
		lastChecked <= now
	);
}

interface CacheMeta {
	etag: string;
	lastFetch?: string; // Legacy field for backwards compatibility
	lastChecked: number; // Timestamp for rate limit protection
	sourceUrl?: string;
}

interface CacheSnapshot {
	content: string;
	meta: CacheMeta;
}

let memoryCache: CacheSnapshot | null = null;
let refreshPromise: Promise<void> | null = null;

function isFresh(lastChecked: number): boolean {
	const now = Date.now();
	return isUsableCacheTimestamp(lastChecked, now) && now - lastChecked < CACHE_TTL_MS;
}

function parseSourceUrl(source: string | undefined): string | undefined {
	if (!source) return undefined;
	const trimmed = source.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			logDebug("Ignoring OpenCode codex prompt source override due to protocol", {
				source: trimmed,
			});
			return undefined;
		}
		return trimmed;
	} catch {
		logDebug("Ignoring invalid OpenCode codex prompt source override", {
			source: trimmed,
		});
		return undefined;
	}
}

function resolvePromptSources(): string[] {
	const sources: string[] = [];
	const seen = new Set<string>();

	const add = (source: string | undefined) => {
		const parsed = parseSourceUrl(source);
		if (!parsed || seen.has(parsed)) return;
		seen.add(parsed);
		sources.push(parsed);
	};

	add(process.env[OPENCODE_CODEX_URL_OVERRIDE_ENV]);
	// `cachedMeta.sourceUrl` is deliberately NOT a fetch source: the meta file
	// is same-UID writable, so re-trusting it would let a planted meta file
	// redirect the next run's prompt fetch to an attacker-controlled URL. The
	// stored value still matters — it scopes ETag replay to the URL that
	// actually issued it — but it is only ever compared, never fetched.
	for (const source of DEFAULT_OPENCODE_CODEX_URLS) {
		add(source);
	}
	return sources;
}

async function readDiskCache(): Promise<CacheSnapshot | null> {
	try {
		const [content, metaContent] = await Promise.all([
			readFile(CACHE_FILE, "utf-8"),
			readFile(CACHE_META_FILE, "utf-8"),
		]);
		const meta = JSON.parse(metaContent) as CacheMeta;
		if (!isUsableCacheTimestamp(meta.lastChecked, Date.now())) {
			return null;
		}
		if (!isUsablePromptContent(content)) {
			return null;
		}
		return { content, meta };
	} catch {
		return null;
	}
}

async function saveDiskCache(
	content: string,
	etag: string,
	sourceUrl: string,
): Promise<CacheMeta> {
	// 0700 dir + 0600 atomic writes: this file is served back as a system
	// prompt and compared as a strip-needle, so it must not be world-readable
	// or torn by a concurrent write.
	await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
	const meta: CacheMeta = {
		etag,
		lastFetch: new Date().toISOString(),
		lastChecked: Date.now(),
		sourceUrl,
	};
	await Promise.all([
		writeFileAtomic(CACHE_FILE, content),
		writeFileAtomic(CACHE_META_FILE, JSON.stringify(meta, null, 2)),
	]);
	return meta;
}

async function refreshPrompt(
	cachedMeta: CacheMeta | null,
	cachedContent: string | null,
): Promise<string> {
	const sources = resolvePromptSources();
	let lastFailure: string | null = null;

	for (const sourceUrl of sources) {
		const headers: Record<string, string> = {};
		const canUseConditionalRequest =
			!!cachedMeta?.etag &&
			(!cachedMeta.sourceUrl || cachedMeta.sourceUrl === sourceUrl);
		if (canUseConditionalRequest) {
			headers["If-None-Match"] = cachedMeta.etag;
		}

		let response: Response;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), PROMPT_FETCH_TIMEOUT_MS);
		timeout.unref();
		try {
			response = await fetch(sourceUrl, { headers, signal: controller.signal });
		} catch (error) {
			lastFailure = `${sourceUrl}: ${String(error)}`;
			logDebug("OpenCode prompt source fetch failed", {
				sourceUrl,
				error: String(error),
			});
			continue;
		} finally {
			clearTimeout(timeout);
		}

		if (response.status === 304 && cachedContent) {
			const refreshedMeta: CacheMeta = {
				etag: cachedMeta?.etag ?? "",
				lastFetch: cachedMeta?.lastFetch ?? new Date().toISOString(),
				lastChecked: Date.now(),
				sourceUrl,
			};
			memoryCache = { content: cachedContent, meta: refreshedMeta };
			await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
			await writeFileAtomic(
				CACHE_META_FILE,
				JSON.stringify(refreshedMeta, null, 2),
			);
			return cachedContent;
		}

		if (!response.ok) {
			lastFailure = `${sourceUrl}: HTTP ${response.status}`;
			logDebug("OpenCode prompt source returned non-OK response", {
				sourceUrl,
				status: response.status,
			});
			continue;
		}

		let content: string;
		try {
			content = await responseTextWithTimeout(response);
		} catch (error) {
			// A mid-body stall is a per-source failure, not a loop-killer.
			lastFailure = `${sourceUrl}: ${String(error)}`;
			logDebug("OpenCode prompt source body read failed", {
				sourceUrl,
				error: String(error),
			});
			continue;
		}
		if (!isUsablePromptContent(content)) {
			lastFailure = `${sourceUrl}: response failed sanity checks`;
			logWarn("OpenCode prompt source returned unusable content", {
				sourceUrl,
				contentLength: content.trim().length,
			});
			continue;
		}
		const etag = response.headers.get("etag") || "";
		const meta = await saveDiskCache(content, etag, sourceUrl);
		memoryCache = { content, meta };
		return content;
	}

	throw new PromptError(
		`Failed to fetch OpenCode codex prompt from all sources${lastFailure ? ` (${lastFailure})` : ""}`,
		{ code: "FETCH_ALL_SOURCES_FAILED" },
	);
}

function scheduleRefresh(cachedMeta: CacheMeta | null, cachedContent: string | null): void {
	if (refreshPromise) return;
	refreshPromise = refreshPrompt(cachedMeta, cachedContent)
		.then(() => undefined)
		.catch((error) => {
			logDebug("OpenCode prompt background refresh failed", {
				error: String(error),
			});
		})
		.finally(() => {
			refreshPromise = null;
		});
}

/**
 * Fetch OpenCode's codex.txt prompt with ETag-based caching
 * Uses HTTP conditional requests to efficiently check for updates
 *
 * Rate limit protection: Only checks GitHub if cache is older than 15 minutes
 * @returns The codex.txt content
 */
export async function getOpenCodeCodexPrompt(): Promise<string> {
	if (memoryCache && isFresh(memoryCache.meta.lastChecked)) {
		return memoryCache.content;
	}

	const diskCache = await readDiskCache();
	if (diskCache) {
		memoryCache = diskCache;
		if (isFresh(diskCache.meta.lastChecked)) {
			return diskCache.content;
		}
		// Serve stale content immediately and refresh in the background.
		memoryCache = {
			content: diskCache.content,
			meta: { ...diskCache.meta, lastChecked: Date.now() },
		};
		scheduleRefresh(diskCache.meta, diskCache.content);
		return diskCache.content;
	}

	try {
		return await refreshPrompt(memoryCache?.meta ?? null, memoryCache?.content ?? null);
	} catch (error) {
		const staleContent = memoryCache?.content;
		if (staleContent) {
			return staleContent;
		}
		throw new PromptError(
			`Failed to fetch OpenCode codex.txt and no cache available: ${error}`,
			{ code: "FETCH_AND_NO_CACHE", cause: error },
		);
	}
}

/**
 * Get first N characters of the cached OpenCode prompt for verification
 * @param chars Number of characters to get (default: 50)
 * @returns First N characters or null if not cached
 */
export async function getCachedPromptPrefix(chars = 50): Promise<string | null> {
	try {
		const content = await readFile(CACHE_FILE, "utf-8");
		// A too-short cache would make an unreliable prefix probe — and its
		// callers compare prefixes against request items, so refuse it outright.
		if (!isUsablePromptContent(content)) {
			return null;
		}
		return content.substring(0, chars);
	} catch {
		return null;
	}
}

/**
 * Prewarm the OpenCode prompt cache without blocking startup.
 */
export function prewarmOpenCodeCodexPrompt(): void {
	void getOpenCodeCodexPrompt().catch((error) => {
		logDebug("OpenCode prompt prewarm failed", { error: String(error) });
	});
}
