/**
 * OpenCode Codex Prompt Fetcher
 *
 * Fetches and caches the codex.txt system prompt from OpenCode's GitHub repository.
 * Uses ETag-based caching to efficiently track updates.
 */

import { createHash } from "node:crypto";
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
 * `raw.githubusercontent.com` serves the git blob SHA as the ETag, so a 304
 * acknowledging our stored etag only proves the *upstream* content is
 * unchanged — the same-UID-writable disk body beside it still has to hash to
 * that etag (`sha1|sha256 "blob <len>\0<body>"`) before its bytes may serve.
 * Any other etag shape cannot bind content and fails closed to a refetch.
 */
function isContentBoundToEtag(content: string, etag: string | null): boolean {
	if (!etag) return false;
	const cleaned = etag.trim().replace(/^W\//i, "").replace(/^"|"$/g, "");
	const hex = cleaned.match(/^(?:sha1|sha256):([0-9a-f]+)$/i)?.[1] ?? cleaned;
	if (!/^[0-9a-f]{40}$/i.test(hex) && !/^[0-9a-f]{64}$/i.test(hex)) {
		return false;
	}
	const algorithm = hex.length === 64 ? "sha256" : "sha1";
	const payload = Buffer.from(content, "utf8");
	const digest = createHash(algorithm)
		.update(`blob ${payload.length}\0`)
		.update(payload)
		.digest("hex");
	return digest === hex.toLowerCase();
}

/**
 * One deadline and one controller cover request AND body: `fetch()` resolves
 * when headers arrive, so a signal scoped to `fetch` alone stops guarding
 * mid-body, and a timeout that only rejects the reader leaves the connection
 * open. Aborting this controller on timeout cancels the socket itself, which
 * is what actually releases the stalled connection before the next source is
 * tried.
 */
async function fetchTextWithTimeout(
	url: string,
	init?: RequestInit,
): Promise<{ response: Response; text: string }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), PROMPT_FETCH_TIMEOUT_MS);
	timeout.unref();
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		const text = await response.text();
		return { response, text };
	} catch (error) {
		if (controller.signal.aborted) {
			throw new CodexTimeoutError(
				`Prompt fetch timed out after ${PROMPT_FETCH_TIMEOUT_MS}ms`,
				{ cause: error, timeoutMs: PROMPT_FETCH_TIMEOUT_MS },
			);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
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

/**
 * `memoryCache` holds only content this process fetched (or hash-verified
 * through a 304). Disk bytes are never stored here unverified: a same-UID
 * planter can write the cache and a plausible meta, but cannot populate this
 * snapshot without a real upstream exchange.
 */
let memoryCache: CacheSnapshot | null = null;
let refreshPromise: Promise<void> | null = null;
/**
 * Timestamp of the last failed upstream exchange. A failure suppresses
 * retries for `CACHE_TTL_MS` so an offline window does not pay a fetch stall
 * on every call. Inside that window a disk body serves only when the
 * recorded etag hash-binds it — plausibility alone is what a same-UID
 * planter writes (greptile P1 on PR #281).
 */
let lastFetchFailedAt: number | null = null;

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
		let text: string;
		try {
			({ response, text } = await fetchTextWithTimeout(sourceUrl, { headers }));
		} catch (error) {
			lastFailure = `${sourceUrl}: ${String(error)}`;
			logDebug("OpenCode prompt source fetch failed", {
				sourceUrl,
				error: String(error),
			});
			continue;
		}

		if (response.status === 304 && cachedContent) {
			// The 304 confirms the etag is current, but the disk body is
			// same-UID writable: it serves only if its git-blob hash matches
			// the acknowledged etag. Anything else is planted or torn — drop
			// the conditional and refetch the real body.
			if (isContentBoundToEtag(cachedContent, cachedMeta?.etag ?? null)) {
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
			try {
				({ response, text } = await fetchTextWithTimeout(sourceUrl));
			} catch (error) {
				lastFailure = `${sourceUrl}: ${String(error)}`;
				logDebug("OpenCode prompt source refetch failed", {
					sourceUrl,
					error: String(error),
				});
				continue;
			}
		}

		if (!response.ok) {
			lastFailure = `${sourceUrl}: HTTP ${response.status}`;
			logDebug("OpenCode prompt source returned non-OK response", {
				sourceUrl,
				status: response.status,
			});
			continue;
		}

		const content = text;
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
			// Mark upstream as recently failed so the next caller serves the
			// stale verified snapshot instead of scheduling a doomed refresh
			// on every call through an offline window.
			lastFetchFailedAt = Date.now();
			logDebug("OpenCode prompt background refresh failed", {
				error: String(error),
			});
		})
		.finally(() => {
			refreshPromise = null;
		});
}

function upstreamRecentlyFailed(now: number): boolean {
	return (
		lastFetchFailedAt !== null && now - lastFetchFailedAt < CACHE_TTL_MS
	);
}

/**
 * Fetch OpenCode's codex.txt prompt with ETag-based caching
 * Uses HTTP conditional requests to efficiently check for updates
 *
 * Rate limit protection: Only checks GitHub if cache is older than 15 minutes
 * @returns The codex.txt content
 */
export async function getOpenCodeCodexPrompt(): Promise<string> {
	const now = Date.now();
	// Memory entries exist only because this process fetched them — serving
	// one never involves trusting a writable file.
	if (memoryCache && isFresh(memoryCache.meta.lastChecked)) {
		return memoryCache.content;
	}
	if (memoryCache) {
		// Stale but fetched-here content: serve it while revalidating, unless a
		// very recent refresh already failed.
		if (!upstreamRecentlyFailed(now)) {
			scheduleRefresh(memoryCache.meta, memoryCache.content);
		}
		return memoryCache.content;
	}

	// No verified content: the trusted sources must be hit before any cache
	// bytes may serve. A same-UID planter can write a plausible body plus a
	// past `lastChecked`, but cannot make GitHub acknowledge it — the fetch
	// either returns real content (or a 304 whose etag binds the disk body by
	// hash) or fails, and only then does the disk cache become a fallback.
	const diskCache = await readDiskCache();
	if (!upstreamRecentlyFailed(now)) {
		try {
			return await refreshPrompt(diskCache?.meta ?? null, diskCache?.content ?? null);
		} catch {
			lastFetchFailedAt = Date.now();
		}
	}

	// A disk body is servable offline only when the recorded etag hash-binds
	// it — the same proof the 304 path requires. `isUsablePromptContent`
	// alone checks plausibility, which is exactly what a same-UID planter
	// produces; without the binding a failed fetch would open a 15-minute
	// window that trusts planted bytes.
	if (diskCache && isContentBoundToEtag(diskCache.content, diskCache.meta.etag)) {
		return diskCache.content;
	}
	throw new PromptError(
		"Failed to fetch OpenCode codex.txt and no verifiable cache available",
		{ code: "FETCH_AND_NO_CACHE" },
	);
}

/**
 * Get first N characters of the cached OpenCode prompt for verification
 * @param chars Number of characters to get (default: 50)
 * @returns First N characters or null if not cached
 */
export function getCachedPromptPrefix(chars = 50): Promise<string | null> {
	// Only content this process verified upstream may seed a prefix probe:
	// callers compare the result against request items, and a planted cache
	// body would become a planted strip-needle. Until a fetch verifies, there
	// is no prefix worth trusting.
	const content = memoryCache?.content;
	if (!content || !isUsablePromptContent(content)) {
		return Promise.resolve(null);
	}
	return Promise.resolve(content.substring(0, chars));
}

/**
 * Prewarm the OpenCode prompt cache without blocking startup.
 */
export function prewarmOpenCodeCodexPrompt(): void {
	void getOpenCodeCodexPrompt().catch((error) => {
		logDebug("OpenCode prompt prewarm failed", { error: String(error) });
	});
}
