import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "./logger.js";

const log = createLogger("update-checker");

const PACKAGE_NAME = "oc-codex-multi-auth";
const LEGACY_PACKAGE_NAMES = ["oc-chatgpt-multi-auth"];
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CACHE_DIR = join(homedir(), ".opencode", "cache");
const CACHE_FILE = join(CACHE_DIR, "update-check-cache.json");
const OPENCODE_CACHE_DIR = join(homedir(), ".cache", "opencode");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Process-level guard for the exit-time cache eviction listener. A module
 * scope flag is not enough: a package can be loaded twice (e.g. once from the
 * plugin path and once from a bundled copy), and each instance would register
 * its own `process.once("exit")` listener — leaking one listener per module
 * instance and eventually tripping the listener-count warning.
 */
const CACHE_EVICTION_SCHEDULED = Symbol.for(
  "oc-codex-multi-auth.cacheEvictionScheduled",
);

/**
 * Registry `version` strings are interpolated into toast text and written to
 * the cache, so they must look like a version — not carry arbitrary text
 * (ANSI escapes included). Accepts dotted-numeric forms beyond strict
 * three-part semver (e.g. a four-segment "4.12.0.1") since `compareVersions`
 * handles arbitrary segment counts, plus prerelease/build metadata — while
 * still rejecting anything outside the version charset.
 */
const VERSION_PATTERN = /^\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isValidVersionString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    VERSION_PATTERN.test(value)
  );
}

interface UpdateCheckCache {
  lastCheck: number;
  latestVersion: string | null;
  currentVersion: string;
}

interface NpmPackageInfo {
  version: string;
  name: string;
}

function getCurrentVersion(): string {
  try {
    const packageJsonPath = join(import.meta.dirname ?? __dirname, "..", "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };
    // Interpolated into the update toast — a hand-edited package.json must not
    // turn arbitrary text into notification content.
    return isValidVersionString(packageJson.version) ? packageJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function loadCache(): UpdateCheckCache | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const parsed = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const cache = parsed as Partial<UpdateCheckCache>;
    // The cache file is same-UID writable: a `lastCheck` in the future would
    // hold the freshness check forever, and a non-version `latestVersion`
    // would be interpolated into the update toast verbatim.
    if (
      typeof cache.lastCheck !== "number" ||
      !Number.isFinite(cache.lastCheck) ||
      cache.lastCheck < 0 ||
      cache.lastCheck > Date.now()
    ) {
      return null;
    }
    if (cache.latestVersion !== null && !isValidVersionString(cache.latestVersion)) {
      return null;
    }
    if (typeof cache.currentVersion !== "string") return null;
    return {
      lastCheck: cache.lastCheck,
      latestVersion: cache.latestVersion ?? null,
      currentVersion: cache.currentVersion,
    };
  } catch {
    return null;
  }
}

function saveCache(cache: UpdateCheckCache): void {
  let tempPath: string | null = null;
  try {
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    }
    // Atomic 0600 write: a plain writeFileSync leaves the file world-readable
    // on permissive umasks and torn if the process dies mid-write.
    tempPath = `${CACHE_FILE}.${process.pid}.tmp`;
    writeFileSync(tempPath, JSON.stringify(cache, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, CACHE_FILE);
    tempPath = null;
  } catch (error) {
    // A failed rename leaves the temp file behind — remove it so repeated
    // failures do not litter the cache dir.
    if (tempPath) {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // best effort
      }
    }
    log.warn("Failed to save update cache", { error: (error as Error).message });
  }
}

function compareVersions(current: string, latest: string): number {
  const currentParts = current.split(".").map((p) => parseInt(p, 10) || 0);
  const latestParts = latest.split(".").map((p) => parseInt(p, 10) || 0);

  for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
    const c = currentParts[i] ?? 0;
    const l = latestParts[i] ?? 0;
    if (l > c) return 1;
    if (l < c) return -1;
  }
  return 0;
}

async function fetchLatestVersion(): Promise<string | null> {
  const controller = new AbortController();
  // unref so a pending timer can never hold the process open, and clear in a
  // finally so a rejected fetch does not leave a dangling timer behind.
  const timeout = setTimeout(() => controller.abort(), 5000);
  timeout.unref();
  try {
    const response = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      log.debug("Failed to fetch npm registry", { status: response.status });
      return null;
    }

    const data = (await response.json()) as Partial<NpmPackageInfo>;
    if (!isValidVersionString(data?.version)) {
      if (data?.version !== undefined) {
        log.warn("Ignoring malformed version string from npm registry");
      }
      return null;
    }
    return data.version;
  } catch (error) {
    log.debug("Failed to check for updates", { error: (error as Error).message });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string | null;
  updateCommand: string;
}

export interface CheckAndNotifyOptions {
  autoUpdate?: boolean;
  scheduleCacheClear?: () => boolean;
  localCheckout?: boolean;
}

function getManagedPackageNames(): string[] {
  return [PACKAGE_NAME, ...LEGACY_PACKAGE_NAMES];
}

function getManagedCachePaths(): string[] {
  return getManagedPackageNames().flatMap((name) => [
    join(OPENCODE_CACHE_DIR, "packages", name),
    join(OPENCODE_CACHE_DIR, "packages", `${name}@latest`),
    join(OPENCODE_CACHE_DIR, "node_modules", name),
  ]);
}

function isInsideDirectory(candidate: string, directory: string): boolean {
  const relativePath = relative(directory, candidate);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

export interface EvictionScope {
  cacheRoot?: string;
  resolveRealPath?: (path: string) => string;
}

/**
 * Cache eviction deletes recursively, so it must never act on a path that only
 * looks like cache. Resolving symlinks before the containment check is the part
 * that matters: a developer who links their working checkout into the cache
 * would otherwise have it deleted on exit by a name match alone.
 *
 * The cache root itself must not resolve through a symlink either. When
 * `~/.cache/opencode` is a link to `~`, comparing realpaths makes the whole
 * home directory "inside the cache" and containment proves nothing.
 */
export function isEvictableCachePath(cachePath: string, scope: EvictionScope = {}): boolean {
  const { cacheRoot = OPENCODE_CACHE_DIR, resolveRealPath = realpathSync } = scope;
  const absolutePath = resolve(cachePath);
  const absoluteRoot = resolve(cacheRoot);
  if (!isInsideDirectory(absolutePath, absoluteRoot)) return false;

  try {
    const realRoot = resolveRealPath(absoluteRoot);
    const rootIsSymlinked =
      process.platform === "win32"
        ? realRoot.toLowerCase() !== absoluteRoot.toLowerCase()
        : realRoot !== absoluteRoot;
    if (rootIsSymlinked) return false;
    return isInsideDirectory(resolveRealPath(absolutePath), realRoot);
  } catch {
    return false;
  }
}

export function clearManagedOpenCodePluginCache(
  paths = getManagedCachePaths(),
  scope: EvictionScope = {},
): boolean {
  let cleared = false;

  for (const cachePath of paths) {
    try {
      if (!existsSync(cachePath)) continue;
      if (!isEvictableCachePath(cachePath, scope)) {
        log.warn("Refused to clear a plugin cache path that resolves outside the OpenCode cache", {
          path: cachePath,
        });
        continue;
      }
      rmSync(cachePath, { recursive: true, force: true });
      cleared = true;
      log.info("Cleared OpenCode plugin cache for update", { path: cachePath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn("Failed to clear OpenCode plugin cache for update", {
        path: cachePath,
        error: message,
      });
    }
  }

  return cleared;
}

export function scheduleOpenCodePluginCacheClearOnExit(): boolean {
  const proc = process as unknown as Record<symbol, boolean | undefined>;
  if (proc[CACHE_EVICTION_SCHEDULED]) return true;
  proc[CACHE_EVICTION_SCHEDULED] = true;
  process.once("exit", () => {
    clearManagedOpenCodePluginCache();
  });
  return true;
}

export async function checkForUpdates(force = false): Promise<UpdateCheckResult> {
  const currentVersion = getCurrentVersion();
  const cache = loadCache();
  const now = Date.now();

  if (!force && cache && now - cache.lastCheck < CHECK_INTERVAL_MS) {
    const hasUpdate = cache.latestVersion ? compareVersions(currentVersion, cache.latestVersion) > 0 : false;
    return {
      hasUpdate,
      currentVersion,
      latestVersion: cache.latestVersion,
      updateCommand: `npx -y ${PACKAGE_NAME}@latest update`,
    };
  }

  const latestVersion = await fetchLatestVersion();

  saveCache({
    lastCheck: now,
    latestVersion,
    currentVersion,
  });

  const hasUpdate = latestVersion ? compareVersions(currentVersion, latestVersion) > 0 : false;

  return {
    hasUpdate,
    currentVersion,
    latestVersion,
    updateCommand: `npx -y ${PACKAGE_NAME}@latest update`,
  };
}

export async function checkAndNotify(
  showToast?: (message: string, variant: "info" | "warning") => Promise<void>,
  options: CheckAndNotifyOptions = {},
): Promise<void> {
  try {
    // The published version says nothing about a build loaded from a checkout,
    // and evicting the cache would not update it. Offering either is noise at
    // best and an invitation to overwrite the checkout at worst.
    if (options.localCheckout) {
      log.debug("Skipping the update check for a plugin loaded from a local checkout");
      return;
    }

    const result = await checkForUpdates();

    if (result.hasUpdate && result.latestVersion) {
      const message = `Update available: ${PACKAGE_NAME} v${result.latestVersion} (current: v${result.currentVersion})`;
      log.info(message);
      const autoUpdate = options.autoUpdate ?? true;
      const scheduled = autoUpdate
        ? (options.scheduleCacheClear ?? scheduleOpenCodePluginCacheClearOnExit)()
        : false;

      if (showToast) {
        const instruction = scheduled
          ? "Restart OpenCode to install it automatically."
          : `Run: ${result.updateCommand}`;
        await showToast(`Plugin update available: v${result.latestVersion}. ${instruction}`, "info");
      }
    }
  } catch (error) {
    log.debug("Update check failed", { error: (error as Error).message });
  }
}

export function clearUpdateCache(): void {
  const tempPath = `${CACHE_FILE}.${process.pid}.tmp`;
  try {
    if (existsSync(CACHE_FILE)) {
      writeFileSync(tempPath, "{}", { encoding: "utf8", mode: 0o600 });
      renameSync(tempPath, CACHE_FILE);
    }
  } catch {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Ignore errors
    }
  }
}
