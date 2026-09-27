import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_NAME = "oc-codex-multi-auth";
const LEGACY_PACKAGE_NAMES = ["oc-chatgpt-multi-auth"];
const ORIGIN_HISTORY_FILE_NAME = "oc-codex-multi-auth-origin.json";
const WINDOWS_RENAME_RETRY_ATTEMPTS = 5;
const WINDOWS_RENAME_RETRY_BASE_DELAY_MS = 10;
const STALE_MANAGED_MODEL_KEYS = new Set([
	"gpt-5.2",
	"gpt-5.3-codex",
	"gpt-5.4",
	// Retired per OpenAI's docs and dropped from the templates: gpt-5.4-mini left
	// Codex (ChatGPT sign-in) on 2026-08-31; gpt-5-codex and the gpt-5.1-codex
	// family were shut down on 2026-07-23 (developers.openai.com/api/docs/deprecations).
	"gpt-5.4-mini",
	"gpt-5-codex",
	"gpt-5.1-codex",
	"gpt-5.1-codex-max",
	"gpt-5.1-codex-mini",
	...["none", "low", "medium", "high", "xhigh"].map((e) => `gpt-5.4-mini-${e}`),
	...["low", "medium", "high"].map((e) => `gpt-5-codex-${e}`),
	...["low", "medium", "high"].map((e) => `gpt-5.1-codex-${e}`),
	...["low", "medium", "high", "xhigh"].map((e) => `gpt-5.1-codex-max-${e}`),
	...["medium", "high"].map((e) => `gpt-5.1-codex-mini-${e}`),
]);
const STANDALONE_COMMANDS = new Set(["doctor", "status", "list", "limits", "dashboard", "health", "diag", "warm"]);
const INSTALLER_COMMANDS = new Set(["install"]);
const UPDATE_COMMANDS = new Set(["update"]);

function splitCommandArgv(argv) {
	const [first, ...rest] = argv;
	if (!first) return { kind: "install", argv };
	if (INSTALLER_COMMANDS.has(first)) return { kind: "install", argv: rest };
	if (UPDATE_COMMANDS.has(first)) return { kind: "update", argv: rest };
	if (STANDALONE_COMMANDS.has(first)) return { kind: "standalone", command: first, argv: rest };
	if (first.startsWith("-")) return { kind: "install", argv };
	return { kind: "unknown", command: first, argv: rest };
}

function parseStandaloneArgs(argv) {
	const options = {
		json: false,
		includeSensitive: false,
		deep: false,
		fix: false,
		tag: undefined,
		configPath: undefined,
		sort: undefined,
		direction: undefined,
		refresh: false,
		help: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--json") options.json = true;
		else if (arg === "--refresh") options.refresh = true;
		else if (arg === "--sort") options.sort = parseLimitsSortField(argv[++index]);
		else if (arg.startsWith("--sort=")) options.sort = parseLimitsSortField(arg.slice("--sort=".length));
		else if (arg === "--asc") options.direction = "asc";
		else if (arg === "--desc") options.direction = "desc";
		else if (arg === "--include-sensitive") options.includeSensitive = true;
		else if (arg === "--deep") options.deep = true;
		else if (arg === "--fix") options.fix = true;
		else if (arg === "--tag") options.tag = argv[++index];
		else if (arg.startsWith("--tag=")) options.tag = arg.slice("--tag=".length);
		else if (arg === "--config-path") options.configPath = argv[++index];
		else if (arg.startsWith("--config-path=")) options.configPath = arg.slice("--config-path=".length);
		else if (arg === "--help" || arg === "-h") options.help = true;
		else throw new Error(`Unknown option for standalone command: ${arg}`);
	}
	return options;
}

const LIMITS_SORT_ALIASES = new Map([
	["account", "account"],
	["number", "account"],
	["usage", "usage"],
	["used", "usage"],
	["reset", "reset"],
	["renewal", "reset"],
]);

function parseLimitsSortField(value) {
	const field = LIMITS_SORT_ALIASES.get(String(value ?? "").trim().toLowerCase());
	if (!field) {
		throw new Error(`Unknown --sort value: ${value ?? "(missing)"} (expected account, usage, or reset)`);
	}
	return field;
}

function getManagedPackageNames() {
	return [PACKAGE_NAME, ...LEGACY_PACKAGE_NAMES];
}

export function normalizePathForCompare(path, resolveRealPath = realpathSync) {
	const resolved = resolve(path);
	try {
		const realPath = resolveRealPath(resolved);
		return process.platform === "win32" ? realPath.toLowerCase() : realPath;
	} catch {
		return process.platform === "win32" ? resolved.toLowerCase() : resolved;
	}
}

export function isDirectRunPath(argvPath, modulePath, resolveRealPath = realpathSync) {
	if (!argvPath || !modulePath) return false;
	return (
		normalizePathForCompare(argvPath, resolveRealPath) ===
		normalizePathForCompare(modulePath, resolveRealPath)
	);
}

function printHelp() {
	console.log(`Usage: ${PACKAGE_NAME} [command] [options]\n\n` +
		"Commands:\n" +
		"  install             Register plugin entries (default with no command)\n" +
		"  update              Refresh the cached package without changing OpenCode config\n" +
		"  doctor              Run local account/config diagnostics\n" +
		"  status              Show account/config status\n" +
		"  list                List configured accounts\n" +
		"  limits              Show 5-hour and weekly usage for each account\n" +
		"  dashboard           Print dashboard guidance\n" +
		"  health              Check local token/account health\n" +
		"  diag                Alias for doctor --deep\n" +
		"  warm                Open every enabled account's usage window now (one request each)\n\n" +
		"Limits options:\n" +
		"  --sort account|usage|reset  Order accounts by number, by usage, or by next reset\n" +
		"  --asc, --desc               Direction (default --asc: lowest number, least used, earliest reset)\n" +
		"  --refresh                   Read every account live instead of the plugin's last readings\n\n" +
		`Installer usage: ${PACKAGE_NAME} install [--plugin-only|--modern|--full|--legacy] [--dry-run] [--no-cache-clear]\n` +
		`Updater usage:   ${PACKAGE_NAME} update [--dry-run]\n\n` +
		"Default behavior:\n" +
		"  - Registers plugin entries without changing provider.openai\n" +
		"  - Enables the prompt status bar TUI plugin at ~/.config/opencode/tui.json\n" +
		"  - Installs model catalogs only with --modern, --full, or --legacy\n" +
		"  - Ensures plugin is unpinned (latest)\n" +
		"  - Clears OpenCode plugin cache\n\n" +
		"Options:\n" +
		"  --plugin-only      Register plugins without changing provider.openai\n" +
		"  --v2               Register for OpenCode V2 (includes automatic quota UI loading)\n" +
		"  --modern           Force compact modern config (10 base OAuth models + --variant presets)\n" +
		"  --full             Install compact base models plus 53 explicit selector entries\n" +
		"  --legacy           Force explicit legacy config (53 preset model entries)\n" +
		"  --dry-run          Show actions without writing\n" +
		"  --no-cache-clear   Skip clearing OpenCode cache\n"
	);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const modernTemplatePath = join(repoRoot, "config", "opencode-modern.json");
const legacyTemplatePath = join(repoRoot, "config", "opencode-legacy.json");

function log(message) {
	console.log(message);
}

function delay(ms) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isWindowsLockError(error) {
	const code = error?.code;
	return code === "EPERM" || code === "EBUSY";
}

function formatErrorForLog(error) {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function resolveHomeDirectory(env = process.env) {
	return env.HOME || env.USERPROFILE || homedir();
}

/** Resolve both JSON and JSONC config locations before changing V2 registration. */
function buildPaths(homeDir) {
	const configDir = join(homeDir, ".config", "opencode");
	const cacheDir = join(homeDir, ".cache", "opencode");
	return {
		configDir,
		configPath: join(configDir, "opencode.json"),
		jsoncConfigPath: join(configDir, "opencode.jsonc"),
		tuiConfigPath: join(configDir, "tui.json"),
		cacheDir,
		cacheNodeModulesPaths: getManagedPackageNames().map((name) => join(cacheDir, "node_modules", name)),
		cachePackagePaths: getManagedPackageNames().flatMap((name) => [
			join(cacheDir, "packages", name),
			join(cacheDir, "packages", `${name}@latest`),
		]),
		cacheBunLock: join(cacheDir, "bun.lock"),
		cachePackageJson: join(cacheDir, "package.json"),
		originHistoryPath: join(homeDir, ".opencode", ORIGIN_HISTORY_FILE_NAME),
		modernTemplatePath,
		legacyTemplatePath,
	};
}

/** Keep V2 plugin-only installation separate from V1 model catalog modes. */
function parseCliArgs(argv = process.argv.slice(2)) {
	const args = new Set(argv);
	if (args.has("--help") || args.has("-h")) {
		return {
			wantsHelp: true,
		};
	}

	const requestedModern = args.has("--modern");
	const requestedFull = args.has("--full");
	const requestedLegacy = args.has("--legacy");
	const explicitPluginOnly = args.has("--plugin-only");

	const requestedModes = [requestedModern, requestedFull, requestedLegacy]
		.filter(Boolean).length;
	if (requestedModes > 1) {
		throw new Error("Choose only one of --modern, --full, or --legacy.");
	}
	if (explicitPluginOnly && requestedModes > 0) {
		throw new Error("--plugin-only cannot be combined with --modern, --full, or --legacy.");
	}
	const pluginOnly = explicitPluginOnly || requestedModes === 0;
	if (args.has("--v2") && !pluginOnly) {
		throw new Error("--v2 registers the plugin only; omit --modern, --full, and --legacy.");
	}

	return {
		wantsHelp: false,
		dryRun: args.has("--dry-run"),
		skipCacheClear: args.has("--no-cache-clear"),
		pluginOnly,
		v2: args.has("--v2"),
		configMode: requestedFull ? "full" : requestedLegacy ? "legacy" : "modern",
	};
}

function parseUpdateArgs(argv) {
	const args = new Set(argv);
	const supported = new Set(["--dry-run", "--help", "-h"]);
	const unknown = argv.find((arg) => !supported.has(arg));
	if (unknown) {
		throw new Error(`Unknown option for update command: ${unknown}`);
	}
	return {
		wantsHelp: args.has("--help") || args.has("-h"),
		dryRun: args.has("--dry-run"),
	};
}

const MANAGED_PACKAGE_ENTRY = "managed-package";
const LOCAL_CHECKOUT_ENTRY = "local-checkout";
const UNRELATED_ENTRY = "unrelated";
const DECLARED_NAME_LOOKUP_DEPTH = 3;

/** Extract a package/path from V1 tuples or native V2 plugin objects. */
function pluginEntrySpecifier(entry) {
	if (typeof entry === "string") return entry;
	if (isPlainObject(entry) && typeof entry.package === "string") return entry.package;
	// `[specifier, options]` configures a plugin without changing where it loads from.
	if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0];
	return null;
}

/**
 * Spellings that can only mean a location on disk: absolute paths, `~`,
 * `./`/`../`, Windows drive letters, and UNC shares. Anything else that merely
 * contains a separator (`@scope/name`, git URLs, `npm:` aliases) is ambiguous
 * and counts as a path only when it resolves on this machine.
 */
function isExplicitPathSpecifier(specifier) {
	return (
		/^[a-zA-Z]:[\\/]/.test(specifier) ||
		/^[\\/]/.test(specifier) ||
		/^~[\\/]/.test(specifier) ||
		/^\.\.?[\\/]/.test(specifier)
	);
}

/**
 * The path an entry names, exactly as the config spells it - and only when the
 * specifier actually is a path. A `/` alone does not make one: registry and
 * URL spellings can end in `oc-codex-multi-auth` without naming this package's
 * checkout, so an ambiguous specifier counts only when it resolves on disk.
 */
function pluginEntryPath(specifier, baseDirectory) {
	const trimmed = specifier.trim();
	if (!trimmed) return null;
	if (/^file:\/\//i.test(trimmed)) {
		try {
			return fileURLToPath(trimmed);
		} catch {
			return null;
		}
	}
	if (isExplicitPathSpecifier(trimmed)) return trimmed;
	if (!trimmed.includes("/") && !trimmed.includes("\\")) return null;
	const inspectionPath = resolveInspectionPath(trimmed, baseDirectory);
	return inspectionPath && existsSync(inspectionPath) ? trimmed : null;
}

function pluginPathSegments(entryPath) {
	return entryPath.replaceAll("\\", "/").replace(/\/+$/, "").split("/").filter(Boolean);
}

/**
 * Compared as written, without resolving symlinks: this asks whether an entry
 * names something `clearCache` removes, and `clearCache` removes the paths
 * exactly as it spells them - `rm` unlinks a symlink rather than descending
 * into it. Cache eviction resolves symlinks because it decides the opposite
 * question, whether a recursive delete is safe.
 */
function isInsideDirectory(candidate, directory, platform) {
	const fold = (value) => (platform === "win32" ? value.toLowerCase() : value);
	const relativePath = relative(fold(resolve(directory)), fold(resolve(candidate)));
	return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function isPackageManagerPath(entryPath, options = {}) {
	const { platform = process.platform, cacheDirectory, inspectionPath } = options;
	// Windows reaches one directory under many spellings, so `NODE_MODULES`
	// there is the same package-manager output as `node_modules`. Elsewhere the
	// two are different directories and must stay so.
	const segments = pluginPathSegments(entryPath).map((segment) =>
		platform === "win32" ? segment.toLowerCase() : segment,
	);
	if (
		segments.some(
			(segment, index) =>
				segment === "node_modules" ||
				// OpenCode's plugin cache spells the version into the directory name.
				// A `packages/` directory without one is an ordinary monorepo.
				(segments[index - 1] === "packages" && segment.includes("@")),
		)
	) {
		return true;
	}
	// The cache is where this installer puts its own copies, and `clearCache`
	// empties it on the same run. Reading spelling alone leaves the cache's
	// unversioned `packages/<name>` looking like somebody's monorepo, so the
	// entry is kept while the directory under it is deleted - a config left
	// pointing at nothing. Whose directory it is settles that; the spelling
	// cannot.
	return Boolean(
		cacheDirectory &&
			inspectionPath &&
			isInsideDirectory(inspectionPath, cacheDirectory, platform),
	);
}

/**
 * Where an entry points, for reading metadata about it only. OpenCode resolves
 * a relative entry against the config file that declares it, so that directory
 * is what makes such a path mean anything; the installer's working directory
 * would name somewhere else entirely. Null when a relative entry arrives with
 * no declaring directory to resolve it against.
 */
function resolveInspectionPath(entryPath, baseDirectory) {
	if (isAbsolute(entryPath)) return entryPath;
	return baseDirectory ? resolve(baseDirectory, entryPath) : null;
}

/**
 * Last-resort identification for a path that is not present on this machine.
 * Spelling alone never authorizes deleting an entry; it only names the package a
 * missing path was probably meant to point at.
 */
function managedNameFromPathSpelling(entryPath) {
	const segments = pluginPathSegments(entryPath);
	const last = segments.at(-1) === "dist" ? segments.at(-2) : segments.at(-1);
	if (!last) return null;
	let candidate = last.toLowerCase();
	try {
		candidate = decodeURIComponent(candidate);
	} catch {
		// Keep the raw segment when it carries a malformed escape.
	}
	const versionSuffix = candidate.indexOf("@");
	if (versionSuffix > 0) candidate = candidate.slice(0, versionSuffix);
	return getManagedPackageNames().find((name) => name.toLowerCase() === candidate) ?? null;
}

function readDeclaredPackageName(directoryPath) {
	try {
		const parsed = JSON.parse(readFileSync(join(directoryPath, "package.json"), "utf8"));
		const name = parsed?.name;
		return typeof name === "string" && name.trim() ? name.trim() : null;
	} catch {
		return null;
	}
}

/** An entry may point at a build output inside the package, so walk upwards. */
function resolveDeclaredPackageName(entryPath) {
	if (!isAbsolute(entryPath)) return null;
	let current = resolve(entryPath);
	for (let depth = 0; depth <= DECLARED_NAME_LOOKUP_DEPTH; depth += 1) {
		const name = readDeclaredPackageName(current);
		if (name) return name;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
	return null;
}

/**
 * Decides what a plugin entry is, by identity rather than by spelling.
 *
 * The distinction that matters is not which package an entry names but who
 * chose the location. A bare specifier or a path inside `node_modules` is a
 * reference the installer itself produced and may retire. Any other path is
 * somewhere a human deliberately pointed OpenCode - a checkout of this package
 * being developed on, most often - and is never the installer's to remove.
 */
function classifyPluginEntry(entry, options = {}) {
	const {
		resolveDeclaredName = resolveDeclaredPackageName,
		baseDirectory,
		cacheDirectory,
		platform = process.platform,
	} = options;
	const specifier = pluginEntrySpecifier(entry);
	if (specifier === null) return { kind: UNRELATED_ENTRY, name: null };

	const entryPath = pluginEntryPath(specifier, baseDirectory);
	if (entryPath === null) {
		const bare = specifier.trim().toLowerCase();
		const name = getManagedPackageNames().find(
			(managed) =>
				bare === managed.toLowerCase() || bare.startsWith(`${managed.toLowerCase()}@`),
		);
		return name
			? { kind: MANAGED_PACKAGE_ENTRY, name }
			: { kind: UNRELATED_ENTRY, name: null };
	}

	const inspectionPath = resolveInspectionPath(entryPath, baseDirectory);
	const declaredName = inspectionPath ? resolveDeclaredName(inspectionPath) : null;
	const managedName = declaredName
		? getManagedPackageNames().find(
			(managed) => managed.toLowerCase() === declaredName.toLowerCase(),
		) ?? null
		: managedNameFromPathSpelling(entryPath);

	if (!managedName) return { kind: UNRELATED_ENTRY, name: null };

	return isPackageManagerPath(entryPath, { platform, cacheDirectory, inspectionPath })
		? { kind: MANAGED_PACKAGE_ENTRY, name: managedName }
		: {
			kind: LOCAL_CHECKOUT_ENTRY,
			name: managedName,
			path: inspectionPath ?? entryPath,
			resolvesOnDisk: Boolean(inspectionPath && existsSync(inspectionPath)),
		};
}

/**
 * Ensures this plugin is registered exactly once, without changing how an
 * existing registration is spelled. Appending the published package name is the
 * fallback for a config that does not reference the plugin at all, not the
 * canonical form every config is rewritten into.
 */
function normalizePluginList(list, onNotice, options = {}) {
	const entries = Array.isArray(list)
		? list.filter((entry) => entry !== null && entry !== undefined && entry !== "")
		: [];
	const classifications = entries.map((entry) => classifyPluginEntry(entry, options));
	// A checkout of this package already IS the registration, so a published
	// entry beside it is a second copy of the same plugin for OpenCode to load.
	// `options.checkoutRegistered` carries the same fact across config files: a
	// checkout registered only in opencode.json still suppresses the published
	// name in tui.json, and vice versa. Only a checkout of the CURRENT package
	// counts: the former name is valid for cleanup, never as the registration
	// the installer exists to ensure.
	const checkoutRegistered = options.checkoutRegistered === true || classifications.some(
		(classification) =>
			classification.kind === LOCAL_CHECKOUT_ENTRY && classification.name === PACKAGE_NAME,
	);
	const kept = [];
	let keptPublishedName = false;

	entries.forEach((entry, index) => {
		const classification = classifications[index];

		if (classification.kind === LOCAL_CHECKOUT_ENTRY) {
			kept.push(entry);
			if (classification.resolvesOnDisk === false) {
				onNotice?.(
					`Warning: keeping ${classification.path} registered, but it does not resolve on disk; ` +
						"the plugin may not load until the path exists again.",
				);
			} else {
				onNotice?.(
					`Keeping the local ${classification.name} checkout registered at ${classification.path}`,
				);
			}
			return;
		}

		if (classification.kind === MANAGED_PACKAGE_ENTRY) {
			// Retire stale duplicates, version pins, renamed packages, and paths
			// into package-manager output; keep one published-name entry in place
			// unless a checkout already covers it.
			const isPublishedName = pluginEntrySpecifier(entry) === PACKAGE_NAME;
			if (isPublishedName && !checkoutRegistered && !keptPublishedName) {
				keptPublishedName = true;
				kept.push(entry);
			}
			return;
		}

		kept.push(entry);
	});

	return checkoutRegistered || keptPublishedName ? kept : [...kept, PACKAGE_NAME];
}

function readLocalCheckoutSightings(historyPath) {
	try {
		const parsed = JSON.parse(readFileSync(historyPath, "utf8"));
		const sightings = parsed?.sightings;
		if (!Array.isArray(sightings)) return [];
		return sightings.filter(
			(sighting) =>
				sighting &&
				typeof sighting === "object" &&
				sighting.isLocalCheckout === true &&
				typeof sighting.root === "string" &&
				typeof sighting.lastSeen === "string" &&
				getManagedPackageNames().includes(sighting.name),
		);
	} catch {
		return [];
	}
}

/**
 * A checkout the plugin has run from that the finished config does not
 * register. Reported rather than restored: config history is evidence of what
 * happened, not authority over what the user wants registered now.
 */
function findUnregisteredLocalCheckout(pluginList, historyPath, options = {}) {
	const entries = Array.isArray(pluginList) ? pluginList : [];
	if (entries.some((entry) => classifyPluginEntry(entry, options).kind === LOCAL_CHECKOUT_ENTRY)) {
		return null;
	}
	const latest = readLocalCheckoutSightings(historyPath)
		.sort((left, right) => (Date.parse(left.lastSeen) || 0) - (Date.parse(right.lastSeen) || 0))
		.at(-1);
	if (!latest) return null;
	// The directory has to still hold the package that was recorded there. A
	// path gets reused - a checkout deleted and something else cloned into its
	// place - and a recorded path that now declares another project would
	// otherwise be offered as somewhere to point OpenCode back at.
	const declaredName = resolveDeclaredPackageName(latest.root);
	if (!declaredName || declaredName.toLowerCase() !== String(latest.name).toLowerCase()) {
		return null;
	}
	return latest;
}

function mergeTuiConfig(existingConfig, onNotice, options = {}) {
	const existing = isPlainObject(existingConfig) ? { ...existingConfig } : {};
	const next = { ...existing };
	if (typeof next.$schema !== "string" || !next.$schema.trim()) {
		next.$schema = "https://opencode.ai/tui.json";
	}
	next.plugin = normalizePluginList(existing.plugin, onNotice, options);
	return next;
}

function formatJson(obj) {
	return `${JSON.stringify(obj, null, 2)}\n`;
}

function getStandaloneStoragePath(options, env = process.env) {
	if (options.configPath) return resolve(options.configPath);
	return join(resolveHomeDirectory(env), ".opencode", "oc-codex-multi-auth-accounts.json");
}

async function readStandaloneStorage(path) {
	try {
		const raw = await readFile(path, "utf-8");
		const parsed = JSON.parse(raw);
		// Shape validation, not just parse validation: a JSON array, scalar, or
		// object without an `accounts` array is unreadable by the plugin runtime
		// too (normalizeAccountStorage rejects it), so reporting it as a healthy
		// empty pool (exit 0, "No accounts configured") hides the corruption
		// from scripted callers that key on exit codes.
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { storage: null, error: "Storage file must be a JSON object with an accounts array." };
		}
		// Forward-compat mirror of the runtime guard: a newer schema version
		// must not be shown as readable accounts by this build.
		const version = parsed.version;
		if (typeof version === "number" && Number.isFinite(version) && version > 3) {
			return {
				storage: null,
				error: `Unsupported account storage schema version ${version}; this build supports up to version 3.`,
			};
		}
		if (!Array.isArray(parsed.accounts)) {
			return { storage: null, error: "Storage file must be a JSON object with an accounts array." };
		}
		return {
			storage: normalizeStandaloneStorage(parsed),
			error: null,
		};
	} catch (error) {
		if (error?.code === "ENOENT") return { storage: null, error: null };
		return { storage: null, error: formatErrorForLog(error) };
	}
}

function normalizeStandaloneIdentityPart(value) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sameStandaloneIdentity(left, right) {
	const normalizedLeft = normalizeStandaloneIdentityPart(left);
	const normalizedRight = normalizeStandaloneIdentityPart(right);
	return !!normalizedLeft && !!normalizedRight && normalizedLeft === normalizedRight;
}

function isStandaloneOrgTokenDuplicate(left, right) {
	const leftOrganizationId = normalizeStandaloneIdentityPart(left?.organizationId);
	const rightOrganizationId = normalizeStandaloneIdentityPart(right?.organizationId);
	if (leftOrganizationId && rightOrganizationId && leftOrganizationId !== rightOrganizationId) return false;
	const leftOrgLike = !!leftOrganizationId || left?.accountIdSource === "org";
	const rightOrgLike = !!rightOrganizationId || right?.accountIdSource === "org";
	const leftTokenLike = !leftOrganizationId && left?.accountIdSource === "token";
	const rightTokenLike = !rightOrganizationId && right?.accountIdSource === "token";
	if (!((leftOrgLike && rightTokenLike) || (rightOrgLike && leftTokenLike))) return false;
	return sameStandaloneIdentity(left?.email, right?.email) ||
		sameStandaloneIdentity(left?.refreshToken, right?.refreshToken);
}

function mergeStandaloneAccounts(target, source) {
	const targetOrgLike = !!normalizeStandaloneIdentityPart(target?.organizationId) || target?.accountIdSource === "org";
	const sourceOrgLike = !!normalizeStandaloneIdentityPart(source?.organizationId) || source?.accountIdSource === "org";
	if (targetOrgLike || !sourceOrgLike) {
		return {
			...source,
			...target,
			organizationId: target.organizationId ?? source.organizationId,
			accountId: target.accountId ?? source.accountId,
			accountIdSource: target.accountIdSource ?? source.accountIdSource,
			accountLabel: target.accountLabel ?? source.accountLabel,
			email: target.email ?? source.email,
		};
	}
	return mergeStandaloneAccounts(source, target);
}

// Mirror of `isStaleGeneratedAccountLabel` / `dropStaleGeneratedLabel` in
// lib/auth/token-utils.ts and lib/storage/normalize.ts. The standalone CLI
// reads the pool through this normalizer and never through the compiled
// `normalizeAccountStorage`, so without the mirror `status`, `list`, `health`,
// `doctor` and `dashboard` keep printing the org-derived label the plugin
// itself now drops - next to the account id, which is the identity the label
// was misnaming. The marker must hold this account's own id suffix so a name
// set with `codex-label` survives.
const GENERATED_LABEL_PATTERN = /\s\[id:[^\]]*\]$/;

function dropStaleStandaloneLabel(account) {
	const label = typeof account?.accountLabel === "string" ? account.accountLabel.trim() : "";
	const accountId = typeof account?.accountId === "string" ? account.accountId.trim() : "";
	if (!label || !accountId) return account;
	const marker = label.match(GENERATED_LABEL_PATTERN)?.[0];
	if (!marker) return account;
	const suffix = accountId.length > 6 ? accountId.slice(-6) : accountId;
	if (marker !== ` [id:${suffix}]`) return account;
	const next = { ...account };
	delete next.accountLabel;
	return next;
}

function normalizeStandaloneStorage(storage) {
	if (!Array.isArray(storage.accounts)) return storage;
	const accounts = [...storage.accounts];
	const removed = new Set();
	for (let i = 0; i < accounts.length; i += 1) {
		if (removed.has(i)) continue;
		for (let j = i + 1; j < accounts.length; j += 1) {
			if (removed.has(j) || !isStandaloneOrgTokenDuplicate(accounts[i], accounts[j])) continue;
			const leftOrgLike = !!normalizeStandaloneIdentityPart(accounts[i]?.organizationId) ||
				accounts[i]?.accountIdSource === "org";
			const targetIndex = leftOrgLike ? i : j;
			const sourceIndex = targetIndex === i ? j : i;
			accounts[targetIndex] = mergeStandaloneAccounts(accounts[targetIndex], accounts[sourceIndex]);
			removed.add(sourceIndex);
			if (sourceIndex === i) break;
		}
	}
	const normalizedAccounts = accounts
		.filter((_, index) => !removed.has(index))
		.map(dropStaleStandaloneLabel);
	return {
		...storage,
		accounts: normalizedAccounts,
		activeIndex: Math.max(0, Math.min(storage.activeIndex ?? 0, Math.max(0, normalizedAccounts.length - 1))),
	};
}

const MASKED_VALUE = "*****";
// The head/tail mask keeps eight characters, so it conceals nothing worth
// concealing below thirteen: `me@x.io` would print in full and `me@x.io12`
// all but its middle character. `doctor` output is what users paste into
// issues, so anything shorter is replaced outright instead. Input is trimmed
// first, or `" me@x.io "` clears the cutoff on padding alone and drops back
// into the partial mask.
const MASK_MIN_LENGTH = 13;

function maskValue(value, includeSensitive) {
	if (includeSensitive || typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed) return trimmed;
	if (trimmed.length < MASK_MIN_LENGTH) return MASKED_VALUE;
	return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

// Six characters when the id is shown in full, matching what the
// in-conversation surfaces print as `id:`. Four when it is head/tail masked,
// which is the tail `maskValue` already discloses as `accountId` in the same
// payload, so the printed identity never reveals more of an id than the field
// beside it. Nothing at all when the id was too short for that mask: the
// `accountId` next to it is then `*****`, and four raw characters of a short
// id can be the whole id.
function accountIdSuffix(accountId, includeSensitive) {
	if (!accountId) return undefined;
	if (includeSensitive) {
		return accountId.length > 6 ? accountId.slice(-6) : accountId;
	}
	if (accountId.length < MASK_MIN_LENGTH) return undefined;
	return accountId.slice(-4);
}

// A member id is what tells two seats of one Business workspace apart, and no
// fixed-length tail always does it: member ids sharing a six-character tail
// were observed, and in a real nine-seat pool the ids are 67 characters with
// no shared tail at all, so growing a tail until it separates them prints most
// of the id in every row. The renderer below mirrors `resolveSeatRenderer` in
// lib/account-display.ts - a tail, else one window anchored where the ids first
// diverge, else short windows at each position where a pair first differs
// joined by `..`, else a hash prefix, each capped - and the id whole only if
// none of those separate them, which needs a 128-bit SHA-256 collision. The
// hash outcome is reachable, and it prints a value that cannot be matched
// against the id by eye.
const STANDALONE_SEAT_MAX_LENGTH = 12;
const STANDALONE_SEAT_HASH_LENGTHS = [8, 12, 16, 24, 32];
const STANDALONE_SEAT_WINDOW_SEPARATOR = "..";

function seatIsDisclosable(accountUserId, includeSensitive) {
	if (!accountUserId) return false;
	return includeSensitive || accountUserId.length >= MASK_MIN_LENGTH;
}

function seatTail(accountUserId, length) {
	return accountUserId.length > length ? accountUserId.slice(-length) : accountUserId;
}

function seatWindow(accountUserId, start, length) {
	if (accountUserId.length <= length) return accountUserId;
	const begin = Math.max(0, Math.min(start, accountUserId.length - length));
	return accountUserId.slice(begin, begin + length);
}

function seatCommonPrefixLength(values) {
	const [first] = values;
	if (first === undefined) return 0;
	let shared = first.length;
	for (const value of values) {
		let index = 0;
		while (index < shared && index < value.length && first[index] === value[index]) {
			index += 1;
		}
		shared = index;
		if (shared === 0) break;
	}
	return shared;
}

function seatFirstDivergence(left, right) {
	const limit = Math.min(left.length, right.length);
	let index = 0;
	while (index < limit && left[index] === right[index]) index += 1;
	return index;
}

// For every pair, the first index at which that pair differs - not every index
// where the ids disagree, which across a handful of random-looking ids is
// nearly all of them and localizes nothing.
function seatDivergenceAnchors(values) {
	const anchors = new Set();
	for (let left = 0; left < values.length; left += 1) {
		for (let right = left + 1; right < values.length; right += 1) {
			anchors.add(seatFirstDivergence(values[left], values[right]));
		}
	}
	return [...anchors].sort((left, right) => left - right);
}

function seatAnchorWindowStarts(anchors, width) {
	const starts = [];
	for (const anchor of anchors) {
		const last = starts[starts.length - 1];
		if (last !== undefined && anchor < last + width) continue;
		starts.push(anchor);
	}
	return starts;
}

function resolveStandaloneSeatRenderer(accountUserIds, includeSensitive) {
	// Starts at the length the mask above allows, so masked output widens only
	// when leaving it short would print a lie.
	const base = includeSensitive ? 6 : 4;
	const distinct = [];
	const seen = new Set();
	for (const accountUserId of accountUserIds) {
		if (!seatIsDisclosable(accountUserId, includeSensitive)) continue;
		if (seen.has(accountUserId)) continue;
		seen.add(accountUserId);
		distinct.push(accountUserId);
	}
	const atBase = (accountUserId) => seatTail(accountUserId, base);
	if (distinct.length <= 1) return atBase;

	const separates = (render) => new Set(distinct.map(render)).size === distinct.length;

	for (let length = base; length <= STANDALONE_SEAT_MAX_LENGTH; length += 1) {
		const render = (accountUserId) => seatTail(accountUserId, length);
		if (separates(render)) return render;
	}
	const start = seatCommonPrefixLength(distinct);
	for (let length = base; length <= STANDALONE_SEAT_MAX_LENGTH; length += 1) {
		const render = (accountUserId) => seatWindow(accountUserId, start, length);
		if (separates(render)) return render;
	}
	const anchors = seatDivergenceAnchors(distinct);
	for (let width = 2; width <= STANDALONE_SEAT_MAX_LENGTH; width += 1) {
		const starts = seatAnchorWindowStarts(anchors, width);
		const rendered =
			starts.length * width + (starts.length - 1) * STANDALONE_SEAT_WINDOW_SEPARATOR.length;
		// Skipped, not abandoned: a wider window can span two nearby anchors
		// that needed one window each, so the cost falls as the window count
		// does. Mirrors `resolveSeatRenderer` in lib/account-display.ts, where
		// the measured counter-example is written out.
		if (rendered > STANDALONE_SEAT_MAX_LENGTH) continue;
		const render = (accountUserId) =>
			starts
				.map((windowStart) => accountUserId.slice(windowStart, windowStart + width))
				.join(STANDALONE_SEAT_WINDOW_SEPARATOR);
		if (separates(render)) return render;
	}
	for (const length of STANDALONE_SEAT_HASH_LENGTHS) {
		const render = (accountUserId) => createHash("sha256").update(accountUserId).digest("hex").slice(0, length);
		if (separates(render)) return render;
	}
	return (accountUserId) => accountUserId;
}

function summarizeStandaloneAccounts(storage, includeSensitive, tag) {
	const accounts = Array.isArray(storage?.accounts) ? storage.accounts : [];
	const normalizedTag = typeof tag === "string" ? tag.trim().toLowerCase() : "";
	const entries = accounts
		.map((account, index) => ({ account, index }))
		.filter(({ account }) => !normalizedTag ||
			(Array.isArray(account?.accountTags) &&
				account.accountTags.some((entry) => String(entry).toLowerCase() === normalizedTag)));
	const renderSeat = resolveStandaloneSeatRenderer(
		entries.map(({ account }) =>
			(typeof account?.accountUserId === "string" ? account.accountUserId.trim() : "") || undefined,
		),
		includeSensitive,
	);
	return entries
		.map(({ account, index }) => {
			const trimmedId =
				typeof account?.accountId === "string" ? account.accountId.trim() : "";
			const accountId = trimmedId || undefined;
			// Members of one Business workspace share `accountId`, so the seat is
			// what tells them apart. It is carried masked next to its suffix for
			// the same reason `accountId` is: so the printed `seat:` discloses no
			// more of an id than the field beside it unless telling two seats
			// apart requires it.
			const trimmedUserId =
				typeof account?.accountUserId === "string" ? account.accountUserId.trim() : "";
			const accountUserId = trimmedUserId || undefined;
			return {
				index,
				label: account?.accountLabel ?? `Account ${index + 1}`,
				email: maskValue(account?.email, includeSensitive),
				accountId: maskValue(accountId, includeSensitive),
				idSuffix: accountIdSuffix(accountId, includeSensitive),
				accountUserId: maskValue(accountUserId, includeSensitive),
				seatSuffix: seatIsDisclosable(accountUserId, includeSensitive)
					? renderSeat(accountUserId)
					: undefined,
				accountIdSource: account?.accountIdSource,
				enabled: account?.enabled !== false,
				hasRefreshToken: typeof account?.refreshToken === "string" && account.refreshToken.length > 0,
				hasAccessToken: typeof account?.accessToken === "string" && account.accessToken.length > 0,
				expiresAt: account?.expiresAt,
				expired: typeof account?.expiresAt === "number" ? account.expiresAt <= Date.now() : undefined,
				tags: Array.isArray(account?.accountTags) ? account.accountTags : [],
				note: account?.accountNote,
				rateLimitResetTimes: account?.rateLimitResetTimes ?? {},
				quotaExhaustedUntil: account?.quotaExhaustedUntil,
			};
		});
}

function printStandaloneResult(command, payload, json) {
	if (json) {
		console.log(JSON.stringify(payload, null, 2));
		return;
	}
	console.log(`oc-codex-multi-auth ${command}`);
	if (payload.message) console.log(payload.message);
	console.log(`Storage: ${payload.storagePath}`);
	console.log(`Accounts: ${payload.totalAccounts}`);
	if (Array.isArray(payload.accounts)) {
		for (const account of payload.accounts) {
			const identity = [
				account.email,
				account.idSuffix ? `id:${account.idSuffix}` : undefined,
				account.seatSuffix ? `seat:${account.seatSuffix}` : undefined,
			]
				.filter(Boolean)
				.join(", ");
			const name = identity ? `${account.label} (${identity})` : account.label;
			console.log(`- [${account.index}] ${name} enabled=${account.enabled} refresh=${account.hasRefreshToken} access=${account.hasAccessToken}`);
		}
	}
	if (payload.error) console.log(`Error: ${payload.error}`);
	for (const fix of payload.appliedFixes ?? []) console.log(`Fixed: ${fix}`);
	for (const error of payload.fixErrors ?? []) console.log(`Repair failed: ${error}`);
	if (payload.nextAction) console.log(`Next: ${payload.nextAction}`);
}

/**
 * Import compiled modules from dist/ so the standalone CLI behaves identically
 * to the in-conversation tools. dist/ ships in the npm package (files
 * allowlist) and none of these modules import the OpenCode plugin runtime, so
 * they load cleanly in plain Node.
 */
async function loadDistModules(relativePaths, label) {
	const distRoot = join(repoRoot, "dist", "lib");
	const toUrl = (rel) => pathToFileURL(join(distRoot, rel)).href;
	try {
		return await Promise.all(relativePaths.map((rel) => import(toUrl(rel))));
	} catch (error) {
		throw new Error(
			`Could not load ${label} runtime from dist/. Build the package first (npm run build). Cause: ${formatErrorForLog(error)}`,
		);
	}
}

async function loadWarmRuntime(env) {
	const [storageMod, usageMod, warmReqMod, warmMod, shutdownMod, recoveryMod] = await loadDistModules(
		[
			"storage.js",
			"codex-usage.js",
			"accounts/warm-request.js",
			"accounts/warm.js",
			"shutdown.js",
			"accounts/warm-recovery.js",
		],
		"warm",
	);
	// Unlike the plugin, this CLI *is* the process, so it owns termination:
	// Ctrl+C must abort the warm run rather than wait for it to drain.
	// Refreshing a token here persists credentials, which registers the
	// shutdown handler via the storage lock.
	shutdownMod.setShutdownOwnsProcess(true);
	return { storageMod, usageMod, warmReqMod, warmMod, shutdownMod, recoveryMod };
}

async function loadLimitsRuntime(env) {
	const [
		storageMod,
		usageMod,
		shutdownMod,
		loggerMod,
		configMod,
		planMod,
		planTierMod,
		quotaCacheMod,
		quotaOverviewMod,
		themeMod,
	] = await loadDistModules(
		[
			"storage.js",
			"codex-usage.js",
			"shutdown.js",
			"logger.js",
			"config.js",
			"plan-allotment.js",
			"auth/plan-tier.js",
			"tui-quota-cache.js",
			"tui-quota-overview.js",
			"ui/theme.js",
		],
		"limits",
	);
	// Fetching usage can refresh (and therefore persist) a token, so the same
	// process-owns-termination rule as `warm` applies.
	shutdownMod.setShutdownOwnsProcess(true);
	return {
		storageMod,
		usageMod,
		shutdownMod,
		loggerMod,
		configMod,
		planMod,
		planTierMod,
		quotaCacheMod,
		quotaOverviewMod,
		themeMod,
	};
}

export async function runWarmCommand(parsed, options = {}) {
	const { env = process.env } = options;
	const storagePath = getStandaloneStoragePath(parsed, env);

	let runtime;
	try {
		runtime = await (options.loadWarmRuntime ?? loadWarmRuntime)(env);
	} catch (error) {
		const payload = { command: "warm", storagePath, error: formatErrorForLog(error) };
		printWarmResult(payload, parsed.json);
		return { exitCode: 1, action: "warm", storagePath };
	}

	const { storageMod, usageMod, warmReqMod, warmMod, recoveryMod } = runtime;
	// Point dist storage at the resolved accounts file so a refreshed token is
	// persisted to the SAME file the rest of the toolchain reads.
	storageMod.setStoragePathDirect(storagePath);

	let storage = null;
	try {
		storage = await storageMod.loadAccounts();
	} catch (error) {
		// Typed storage errors (e.g. UNSUPPORTED_SCHEMA_VERSION) carry the
		// upgrade hint; surface them rather than crashing the CLI.
		const hint = error && typeof error.hint === "string" ? ` ${error.hint}` : "";
		const payload = { command: "warm", storagePath, error: `${formatErrorForLog(error)}${hint}` };
		printWarmResult(payload, parsed.json);
		return { exitCode: 1, action: "warm", storagePath };
	}
	const accounts = Array.isArray(storage?.accounts) ? storage.accounts : [];
	if (accounts.length === 0) {
		// `loadAccounts` swallows parse/IO errors and returns null. Probe the
		// file so a corrupt storage fails like `status`/`doctor` do (exit 1)
		// instead of reporting a healthy empty pool. ENOENT stays a silent
		// empty pool: a missing file legitimately means no accounts yet.
		const probe = await readStandaloneStorage(storagePath);
		if (probe.error) {
			const payload = { command: "warm", storagePath, error: probe.error };
			printWarmResult(payload, parsed.json);
			return { exitCode: 1, action: "warm", storagePath };
		}
		const payload = {
			command: "warm",
			storagePath,
			totalAccounts: 0,
			warmed: 0,
			blocksCleared: 0,
			failed: 0,
			skipped: 0,
			results: [],
			message: "No accounts configured.",
			nextAction: "Run opencode auth login.",
		};
		printWarmResult(payload, parsed.json);
		return { exitCode: 0, action: "warm", storagePath };
	}

	// Same adapter as lib/tools/codex-warm.ts createWarmOne: refresh → resolve
	// account id → open the usage window; map an exhausted (quota-429) account
	// to a failure so it is not reported as warmed.
	const succeeded = [];
	const warmOne = async (account) => {
		const snapshot = { ...account, rateLimitResetTimes: { ...account.rateLimitResetTimes } };
		const { accessToken } = await usageMod.ensureCodexUsageAccessToken({ storage, account });
		const accountId = usageMod.resolveCodexUsageAccountId({ account, accessToken });
		if (!accountId) {
			return { status: "failed", detail: "could not resolve account id (re-login may be required)" };
		}
		const result = await warmReqMod.warmAccountWindow({
			accountId,
			accessToken,
			organizationId: account.organizationId,
		});
		if (result.status === "exhausted") {
			return { status: "failed", detail: result.detail ?? "quota/usage limit reached" };
		}
		if (!result.rateLimited && result.model) succeeded.push({
			account: { ...snapshot, refreshToken: account.refreshToken }, model: result.model, accessToken,
		});
		return { status: "warmed" };
	};

	const summary = await warmMod.warmAccounts(accounts, warmOne);
	let blocksCleared = 0;
	let blockClearError;
	for (const observation of succeeded) {
		let changed = false;
		try {
			const completed = await recoveryMod.recoverWarmedAccount(observation, () => { changed = true; });
			changed = completed || changed;
		} catch {
			blockClearError = "Failed to clear local blocks; warm results are unchanged.";
		}
		if (changed) blocksCleared++;
	}
	const payload = {
		command: "warm",
		blocksCleared,
		blockClearError,
		storagePath,
		totalAccounts: summary.total,
		warmed: summary.warmedCount,
		failed: summary.failedCount,
		skipped: summary.skippedCount,
		results: summary.results.map((r) => ({
			index: r.index,
			email: maskValue(accounts[r.index]?.email, parsed.includeSensitive),
			status: r.status,
			detail: r.detail,
		})),
	};
	printWarmResult(payload, parsed.json);
	return { exitCode: summary.failedCount > 0 ? 1 : 0, action: "warm", storagePath };
}

function printWarmResult(payload, json) {
	if (json) {
		console.log(JSON.stringify(payload, null, 2));
		return;
	}
	console.log(`oc-codex-multi-auth warm`);
	if (payload.message) console.log(payload.message);
	console.log(`Storage: ${payload.storagePath}`);
	if (payload.error) {
		console.log(`Error: ${payload.error}`);
		return;
	}
	console.log(`Accounts: ${payload.totalAccounts}`);
	for (const r of payload.results ?? []) {
		const label = r.email ? `[${r.index}] ${r.email}` : `[${r.index}]`;
		const detail = r.detail ? ` — ${r.detail}` : "";
		console.log(`- ${label}: ${r.status}${detail}`);
	}
	console.log(`Summary: ${payload.warmed} warmed, ${payload.failed} failed, ${payload.skipped} skipped`);
	console.log(`Blocks cleared: ${payload.blocksCleared ?? 0}`);
	if (payload.blockClearError) console.log(payload.blockClearError);
	if (payload.nextAction) console.log(`Next: ${payload.nextAction}`);
}

/**
 * `limits` — show 5-hour and weekly Codex usage per account (#209).
 *
 * Reports the plugin's own last reading of each account by default, and reads
 * an account live only when the plugin holds none for it or under
 * `--refresh`. A live read goes through the compiled `codex-usage` runtime, so
 * the CLI reports the same windows as the in-conversation `codex-limits`
 * tool. The locally persisted
 * `rateLimitResetTimes` is carried in the payload as well: it is the only
 * rate-limit state available for an account whose live fetch fails, and
 * `--json` consumers of the previous behavior still find the field.
 */
export async function runLimitsCommand(parsed, options = {}) {
	const { env = process.env } = options;
	const storagePath = getStandaloneStoragePath(parsed, env);

	let runtime;
	try {
		runtime = await (options.loadLimitsRuntime ?? loadLimitsRuntime)(env);
	} catch (error) {
		const payload = { command: "limits", storagePath, error: formatErrorForLog(error) };
		printLimitsResult(payload, parsed.json);
		return { exitCode: 1, action: "limits", storagePath };
	}

	const {
		storageMod,
		usageMod,
		loggerMod,
		configMod,
		planMod,
		planTierMod,
		quotaCacheMod,
		quotaOverviewMod,
		themeMod,
	} = runtime;
	const pluginConfig = configMod.loadPluginConfig();
	const quotaDisplay = configMod.getQuotaDisplay(pluginConfig);
	const configuredSort = configMod.getLimitsSort?.(pluginConfig) ?? { by: "account", direction: "asc" };
	const sort = {
		by: parsed.sort ?? configuredSort.by,
		direction: parsed.direction ?? configuredSort.direction,
	};
	const render = {
		usageMod,
		quotaDisplay,
		color: !parsed.json && (themeMod?.shouldUseColor?.(process.stdout, env) ?? false),
	};
	const planNameOf = (planType) =>
		planTierMod?.formatPlanType?.(planType) ?? (typeof planType === "string" ? planType : null);
	// The badge is decoration; the report is the point. A runtime that arrived
	// without the plan module drops the `(5x)` rather than failing the account
	// it was attached to - the per-account catch below would otherwise turn one
	// missing module into an "Error:" line against every account in the pool.
	const planMultiplierOf = (planType) =>
		planMod?.formatPlanMultiplier?.(planType) ?? null;
	// Point dist storage at the resolved accounts file so a refreshed token is
	// persisted to the SAME file the rest of the toolchain reads.
	storageMod.setStoragePathDirect(storagePath);

	let storage = null;
	try {
		storage = await storageMod.loadAccounts();
	} catch (error) {
		// Typed storage errors (e.g. UNSUPPORTED_SCHEMA_VERSION) carry the
		// upgrade hint; surface them rather than crashing the CLI.
		const hint = error && typeof error.hint === "string" ? ` ${error.hint}` : "";
		const payload = { command: "limits", storagePath, error: `${formatErrorForLog(error)}${hint}` };
		printLimitsResult(payload, parsed.json);
		return { exitCode: 1, action: "limits", storagePath };
	}
	const accounts = Array.isArray(storage?.accounts) ? storage.accounts : [];
	if (accounts.length === 0) {
		// Same probe contract as `warm`: a corrupt file exits 1 like
		// `status`/`doctor`; a missing file stays a silent empty pool.
		const probe = await readStandaloneStorage(storagePath);
		if (probe.error) {
			const payload = { command: "limits", storagePath, error: probe.error };
			printLimitsResult(payload, parsed.json);
			return { exitCode: 1, action: "limits", storagePath };
		}
		const payload = {
			command: "limits",
			storagePath,
			totalAccounts: 0,
			// Same shape as a populated pool: `null` when nothing is readable.
			pool: null,
			poolSummary: null,
			readings: null,
			sort,
			accounts: [],
			message: "No accounts configured.",
			nextAction: "Run opencode auth login.",
		};
		printLimitsResult(payload, parsed.json);
		return { exitCode: 0, action: "limits", storagePath };
	}

	// Same workspace dedupe the codex-limits tool applies, so two entries for one
	// workspace are not billed and printed twice.
	const indices = usageMod.deduplicateUsageAccountIndices(storage);
	// `--tag` must gate which accounts are contacted at all, not just which are
	// printed: an untagged account would otherwise be billed a usage fetch and
	// could have its refreshed credentials persisted.
	const normalizedTag =
		typeof parsed.tag === "string" ? parsed.tag.trim().toLowerCase() : "";
	const stateDir = resolveOpenCodeStateDir(env);
	const now = Date.now();
	// The plugin already polls every account's usage for the pool status line
	// and keeps the result on disk. Reading that instead of asking upstream
	// again is what makes this report instant, and it spares a large pool a
	// burst of usage requests. `--refresh` still reads every account live.
	const previous = await readPluginQuotaReadings(quotaCacheMod, quotaOverviewMod, stateDir);
	const cached = parsed.refresh ? undefined : previous;
	const results = [];
	// Only accounts that answered contribute to the pool total. An account that
	// failed to report is left out entirely rather than counted as full or as
	// empty, since either would state capacity nobody measured.
	const poolMembers = [];
	const sortKeys = new Map();
	const entryAccounts = new Map();
	const entryWorkspaceIds = new Map();
	const liveOverviewAccounts = [];
	let failedCount = 0;

	const readLive = async (account, index, entry) => {
		const { accessToken } = await usageMod.ensureCodexUsageAccessToken({ storage, account });
		const accountId = usageMod.resolveCodexUsageAccountId({ account, accessToken });
		if (!accountId) {
			throw new Error("could not resolve account id (re-login may be required)");
		}
		entryWorkspaceIds.set(entry, accountId);
		const usage = usageMod.parseCodexUsagePayload(
			await usageMod.fetchCodexUsage({
				accountId,
				accessToken,
				organizationId: account.organizationId,
			}),
			quotaDisplay,
		);
		const quotaExhaustedResetAtMs = usageMod.getUsageQuotaExhaustedResetAtMs([
			usage.primary,
			usage.secondary,
		]);
		if (quotaExhaustedResetAtMs !== undefined) {
			try {
				await usageMod.persistUsageQuotaExhaustion(account, quotaExhaustedResetAtMs);
			} catch (error) {
				loggerMod.logWarn(
					`[${PACKAGE_NAME}] Failed to persist exhausted usage quota: ${formatErrorForLog(error)}`,
				);
			}
		}
		if (usageMod.isUsageQuotaRecovered([usage.primary, usage.secondary])) {
			try {
				await usageMod.persistUsageQuotaRecovery(account);
			} catch {
				loggerMod.logWarn("Failed to persist recovered usage quota");
			}
		}
		const overviewAccount = quotaOverviewMod?.toOverviewAccount?.({
			// Taken after the fetch: a refresh above rotates the token the
			// fingerprint is derived from.
			fingerprint: usageMod.createUsageAccountFingerprint(account),
			index: index + 1,
			usage,
			email: account.email,
			label: account.accountLabel,
		});
		if (overviewAccount) liveOverviewAccounts.push({ ...overviewAccount, fetchedAt: now });
		return {
			source: "live",
			readAt: now,
			planType: usage.planType,
			windows: [usage.primary, usage.secondary],
			limits: usage.limits,
			credits: usage.credits,
			// Raw counts stay in `resetCredits` and the rendered line lives in
			// its own field: embedding the English summary inside the counts
			// object would make `--json` consumers parse presentation text to
			// reach a number that is already beside it.
			resetCredits: usage.resetCredits,
			resetCreditsSummary: usage.resetCredits
				? usageMod.formatResetCredits(usage.resetCredits)
				: null,
		};
	};

	for (const index of indices) {
		const account = accounts[index];
		if (!account) continue;
		if (
			normalizedTag &&
			!(
				Array.isArray(account.accountTags) &&
				account.accountTags.some((entry) => String(entry).toLowerCase() === normalizedTag)
			)
		) {
			continue;
		}
		const entry = {
			index,
			label: account.accountLabel ?? `Account ${index + 1}`,
			email: maskValue(account.email, parsed.includeSensitive),
			rateLimitResetTimes: account.rateLimitResetTimes ?? {},
			quotaExhaustedUntil: account.quotaExhaustedUntil,
		};
		entryAccounts.set(entry, account);
		entryWorkspaceIds.set(entry, account.accountId);
		try {
			// An account the plugin has no reading for (added since its last
			// poll, or a different pool than the one it polled) is read live
			// rather than left blank.
			const cachedAccount = cached && findPluginQuotaReading(cached, account, index, usageMod);
			const reading = cachedAccount
				? toCachedLimitsReading(cachedAccount, usageMod, quotaDisplay)
				: await readLive(account, index, entry);
			poolMembers.push({
				planType: reading.planType,
				primary: reading.windows[0] ?? {},
				secondary: reading.windows[1] ?? {},
			});
			sortKeys.set(entry, readLimitsSortKeys(usageMod, reading.windows));
			entry.source = reading.source;
			entry.readAt = reading.readAt;
			entry.planType = reading.planType;
			entry.planName = planNameOf(reading.planType);
			entry.planMultiplier = planMultiplierOf(reading.planType);
			entry.credits = reading.credits;
			entry.resetCredits = reading.resetCredits;
			entry.resetCreditsSummary = reading.resetCreditsSummary;
			entry.limits = reading.limits;
		} catch (error) {
			// `ensureCodexUsageAccessToken` can surface a raw OAuth refresh
			// response, so the message is redacted through the logger's token
			// patterns before it reaches stdout, JSON output, or CI logs.
			// Truncation alone does not protect bearer/JWT/refresh-token material.
			entry.error = loggerMod.maskString(formatErrorForLog(error)).slice(0, 160);
			failedCount += 1;
		}
		results.push(entry);
	}

	await attachWorkspaceNames({
		results,
		entryAccounts,
		entryWorkspaceIds,
		stateDir,
		refresh: parsed.refresh,
		lookup: async (account, readLive) => {
			// An account reported from the plugin's readings is not worth a
			// token refresh just to name it: only a stored token still valid
			// is used, and the name waits for a run that reads it live.
			const accessToken = readLive
				? (await usageMod.ensureCodexUsageAccessToken({ storage, account })).accessToken
				: typeof account.accessToken === "string" && account.expiresAt > Date.now()
					? account.accessToken
					: undefined;
			if (!accessToken) return undefined;
			const accountId = usageMod.resolveCodexUsageAccountId({ account, accessToken });
			if (!accountId) throw new Error("could not resolve account id");
			return usageMod.fetchCodexWorkspaceNames({
				accountId,
				accessToken,
				organizationId: account.organizationId,
				timeoutMs: WORKSPACE_NAME_LOOKUP_TIMEOUT_MS,
			});
		},
		warn: (message) => loggerMod.logWarn(`[${PACKAGE_NAME}] ${loggerMod.maskString(message)}`),
	});

	// Hand a full live read back to the plugin, so its status line and the next
	// `limits` see it too. Only a read of the whole pool qualifies: a `--tag`
	// subset would drop every other account from the snapshot.
	const allLive = results.every((entry) => entry.source !== "cache");
	if (!normalizedTag && allLive && liveOverviewAccounts.length > 0) {
		try {
			await writePluginQuotaReadings({
				quotaCacheMod,
				stateDir,
				now,
				live: liveOverviewAccounts,
				previous,
				pool: indices.map((index) => ({ index, account: accounts[index] })).filter(({ account }) => account),
				usageMod,
			});
		} catch (error) {
			loggerMod.logWarn(
				`[${PACKAGE_NAME}] Failed to cache the pool quota snapshot: ${formatErrorForLog(error)}`,
			);
		}
	}

	const cachedEntries = results.filter((entry) => entry.source === "cache");
	const readings = results.some((entry) => entry.source)
		? {
			source: cachedEntries.length === 0
				? "live"
				: cachedEntries.length === results.filter((entry) => entry.source).length
					? "cache"
					: "mixed",
			// The newest reading names the report; any account read at another
			// moment carries its own time.
			readAt: cachedEntries.length === 0
				? now
				: Math.max(...cachedEntries.map((entry) => entry.readAt)),
		}
		: null;
	const pool = usageMod.summarizeUsagePool(poolMembers);
	const payload = {
		command: "limits",
		storagePath,
		totalAccounts: accounts.length,
		shownAccounts: results.length,
		// Both percentages are stated so a consumer never has to know which way
		// `quotaDisplay` was pointing to read them.
		pool: pool
			? {
				leftPercent: pool.leftPercent,
				usedPercent: 100 - pool.leftPercent,
				allotment: pool.allotment,
				countedAccounts: pool.countedAccounts,
			}
			: null,
		poolSummary: pool
			? usageMod.formatUsagePoolSummary(pool, quotaDisplay)
			: null,
		readings,
		sort,
		accounts: sortLimitsEntries(results, sortKeys, sort),
	};
	printLimitsResult(payload, parsed.json, render);
	return { exitCode: failedCount > 0 ? 1 : 0, action: "limits", storagePath };
}

/** Where OpenCode keeps its state, and so where the plugin's quota caches live. */
function resolveOpenCodeStateDir(env) {
	const explicit = env.OPENCODE_STATE_DIR?.trim();
	if (explicit) return explicit;
	const stateHome = env.XDG_STATE_HOME?.trim() || join(resolveHomeDirectory(env), ".local", "state");
	return join(stateHome, "opencode");
}

/**
 * The plugin's last reading of the pool: the snapshot its status line polls,
 * with the request path's newer reading of the serving account folded in.
 */
async function readPluginQuotaReadings(quotaCacheMod, quotaOverviewMod, stateDir) {
	if (!quotaCacheMod?.readTuiQuotaOverviewSnapshot) return undefined;
	const raw = await quotaCacheMod.readTuiQuotaOverviewSnapshot(
		quotaCacheMod.getTuiQuotaOverviewCachePath(stateDir),
	);
	if (!raw) return undefined;
	const latest = await quotaCacheMod.readTuiQuotaSnapshot(
		quotaCacheMod.getTuiQuotaCachePath(stateDir),
	);
	const snapshot = quotaOverviewMod?.mergeOverviewWithLatestAccount?.(raw, latest) ?? raw;
	return { raw, snapshot };
}

/**
 * Pair an account with its entry in a plugin snapshot. The fingerprint covers
 * the refresh token, which rotates on every token refresh, so an account the
 * plugin read just before a refresh is still recognized by its pool position
 * and email.
 */
function findPluginQuotaEntry(snapshot, account, index, usageMod) {
	const fingerprint = usageMod.createUsageAccountFingerprint(account);
	const email = typeof account.email === "string" ? account.email.trim().toLowerCase() : "";
	return (
		snapshot.accounts.find((candidate) => candidate.fingerprint === fingerprint) ??
		(email
			? snapshot.accounts.find(
				(candidate) =>
					candidate.index === index + 1 &&
					candidate.email?.trim().toLowerCase() === email,
			)
			: undefined)
	);
}

function findPluginQuotaReading(readings, account, index, usageMod) {
	const found = findPluginQuotaEntry(readings.snapshot, account, index, usageMod);
	if (!found) return undefined;
	return { account: found, readAt: found.fetchedAt ?? readings.snapshot.fetchedAt };
}

/**
 * A window nobody has drawn from reports "now plus the window" as its reset.
 * The plugin now drops that reset, but a snapshot an older build wrote still
 * carries it, so it is recognized by lying a whole window after the reading.
 */
function isCachedWindowNotStarted(limit, readAt) {
	if (limit.usedPercent !== 0) return false;
	if (limit.resetAtMs === undefined) return true;
	const windowMs = (limit.windowMinutes ?? 0) * 60_000;
	return windowMs > 0 && limit.resetAtMs - readAt >= windowMs - 60_000;
}

function toCachedLimitsReading(reading, usageMod, quotaDisplay) {
	const windows = reading.account.limits.map((limit) => {
		const usedPercent =
			typeof limit.usedPercent === "number"
				? limit.usedPercent
				: typeof limit.leftPercent === "number"
					? 100 - limit.leftPercent
					: undefined;
		const window = { usedPercent, windowMinutes: limit.windowMinutes };
		if (isCachedWindowNotStarted({ ...limit, usedPercent }, reading.readAt)) {
			return { ...window, notStarted: true };
		}
		return { ...window, resetAtMs: limit.resetAtMs };
	});
	const count = reading.account.resetCredits;
	const applicable = reading.account.resetCreditsApplicable;
	return {
		source: "cache",
		readAt: reading.readAt,
		planType: reading.account.planType ?? null,
		windows,
		limits: windows.map((window) =>
			usageMod.toUsageLimitPayload(
				usageMod.formatUsageLimitTitle(window.windowMinutes),
				window,
				quotaDisplay,
			),
		),
		// The snapshot keeps neither the credit balance nor the banked total
		// beside the redeemable count, so only what it does keep is reported.
		credits: null,
		resetCredits: null,
		resetCreditsSummary:
			typeof count === "number" && count > 0
				? `${count} ${typeof applicable === "number" ? "applicable now" : "banked"}`
				: null,
	};
}

/**
 * Write a live read of the whole pool as the plugin's snapshot, in the shape
 * its poller writes. An account this run failed to read keeps its previous
 * entry, and the snapshot then keeps the older time, exactly as the poller
 * does. A previous snapshot that describes a different pool is left alone:
 * the file is shared by every OpenCode window on the machine.
 */
async function writePluginQuotaReadings({ quotaCacheMod, stateDir, now, live, previous, pool, usageMod }) {
	if (!quotaCacheMod?.writeTuiQuotaOverviewSnapshot) return;
	const matched = (entry) =>
		pool.some(({ index, account }) => findPluginQuotaEntry({ accounts: [entry] }, account, index, usageMod));
	if (previous && !previous.raw.accounts.every(matched)) return;
	const accounts = [...live];
	let carriedOver = false;
	for (const { index, account } of pool) {
		if (accounts.some((entry) => entry.index === index + 1)) continue;
		const kept = previous && findPluginQuotaEntry(previous.raw, account, index, usageMod);
		if (!kept) continue;
		accounts.push({ ...kept, fetchedAt: kept.fetchedAt ?? previous.raw.fetchedAt });
		carriedOver = true;
	}
	accounts.sort((left, right) => left.index - right.index);
	await quotaCacheMod.writeTuiQuotaOverviewSnapshot(
		{
			version: quotaCacheMod.TUI_QUOTA_CACHE_VERSION,
			fetchedAt: carriedOver && previous ? Math.min(previous.raw.fetchedAt, now) : now,
			accounts,
		},
		quotaCacheMod.getTuiQuotaOverviewCachePath(stateDir),
	);
}

const WORKSPACE_NAME_CACHE_FILE = "oc-codex-multi-auth-workspace-names.json";
const WORKSPACE_NAME_CACHE_VERSION = 1;
// The name is decoration, so a slow lookup gives up long before a usage fetch
// would.
const WORKSPACE_NAME_LOOKUP_TIMEOUT_MS = 5_000;

async function readWorkspaceNameCache(stateDir) {
	const names = new Map();
	try {
		const parsed = JSON.parse(await readFile(join(stateDir, WORKSPACE_NAME_CACHE_FILE), "utf-8"));
		if (parsed?.version !== WORKSPACE_NAME_CACHE_VERSION || typeof parsed.accounts !== "object") {
			return names;
		}
		for (const [id, record] of Object.entries(parsed.accounts ?? {})) {
			const name = record?.name;
			if (name === null) names.set(id, null);
			else if (typeof name === "string") {
				names.set(id, name.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim() || null);
			}
		}
	} catch {
		// A missing or unreadable cache is an empty one.
	}
	return names;
}

async function writeWorkspaceNameCache(stateDir, names, now) {
	const target = join(stateDir, WORKSPACE_NAME_CACHE_FILE);
	const accounts = Object.fromEntries(
		[...names].map(([id, name]) => [id, { name, checkedAt: now }]),
	);
	const temporary = `${target}.${process.pid}.${now}.tmp`;
	await mkdir(stateDir, { recursive: true });
	await writeFile(
		temporary,
		`${JSON.stringify({ version: WORKSPACE_NAME_CACHE_VERSION, accounts }, null, 2)}\n`,
		{ encoding: "utf-8", mode: 0o600 },
	);
	await rename(temporary, target);
}

/**
 * Name the Business workspace each account belongs to.
 *
 * Names are remembered on disk, because a workspace is renamed far more
 * rarely than `limits` is run: an account is asked about only the first time
 * it is seen, or under `--refresh`. One answer lists every workspace the login
 * is a member of, so an id another account already named is not asked about
 * again, and a personal account is remembered as having no name. The lookup
 * is decoration: a failure only drops the line.
 */
async function attachWorkspaceNames({ results, entryAccounts, entryWorkspaceIds, stateDir, refresh, lookup, warn }) {
	const known = refresh ? new Map() : await readWorkspaceNameCache(stateDir);
	let changed = false;
	for (const entry of results) {
		const workspaceId = entryWorkspaceIds.get(entry);
		if (!workspaceId || known.has(workspaceId) || entry.error) continue;
		try {
			const names = await lookup(entryAccounts.get(entry), entry.source === "live");
			if (!names) continue;
			for (const [id, name] of names) known.set(id, name);
			if (!known.has(workspaceId)) known.set(workspaceId, null);
			changed = true;
		} catch (error) {
			warn(`Failed to read workspace names: ${formatErrorForLog(error)}`);
		}
	}
	for (const entry of results) {
		const workspaceId = entryWorkspaceIds.get(entry);
		entry.workspaceName = (workspaceId && known.get(workspaceId)) ?? null;
	}
	if (!changed) return;
	try {
		await writeWorkspaceNameCache(stateDir, known, Date.now());
	} catch (error) {
		warn(`Failed to cache workspace names: ${formatErrorForLog(error)}`);
	}
}

/**
 * What `--sort usage` and `--sort reset` compare: the account's governing
 * window, the one with the least headroom, since that is the one that stops a
 * request. Ties go to the later reset, so an account with both windows spent
 * is ranked by when it actually becomes usable again. Only the two windows
 * that govern ordinary requests count, matching the pool total, and a window
 * that has not started has no renewal to rank by.
 */
function readLimitsSortKeys(usageMod, windows) {
	let governing;
	for (const window of windows) {
		if (!usageMod.hasUsageWindow(window) || !Number.isFinite(window.usedPercent)) continue;
		if (
			!governing ||
			window.usedPercent > governing.usedPercent ||
			(window.usedPercent === governing.usedPercent &&
				(window.resetAtMs ?? -Infinity) > (governing.resetAtMs ?? -Infinity))
		) {
			governing = window;
		}
	}
	return {
		usedPercent: governing?.usedPercent,
		resetAtMs: governing && !governing.notStarted && Number.isFinite(governing.resetAtMs)
			? governing.resetAtMs
			: undefined,
	};
}

/**
 * Accounts whose key is unknown (a failed fetch, a window not yet started)
 * sort last in either direction, and ties fall back to the account number so
 * the order is stable between runs.
 */
function sortLimitsEntries(entries, sortKeys, sort) {
	const keyOf = (entry) => {
		if (sort.by === "account") return entry.index;
		const keys = sortKeys.get(entry);
		return sort.by === "usage" ? keys?.usedPercent : keys?.resetAtMs;
	};
	const direction = sort.direction === "desc" ? -1 : 1;
	return [...entries].sort((left, right) => {
		const leftKey = keyOf(left);
		const rightKey = keyOf(right);
		if (leftKey === undefined && rightKey !== undefined) return 1;
		if (rightKey === undefined && leftKey !== undefined) return -1;
		if (leftKey !== undefined && leftKey !== rightKey) {
			return direction * (leftKey - rightKey);
		}
		return left.index - right.index;
	});
}

const LIMITS_USAGE_COLORS = [
	[99, "\u001b[31m"],
	[80, "\u001b[38;5;208m"],
	[60, "\u001b[33m"],
	[0, "\u001b[32m"],
];

/**
 * Colour keyed on consumption whatever `quotaDisplay` words it as. It follows
 * the rounded figure printed beside it, so `99% used` is never shown orange.
 */
function colorLimitsPercent(text, usedPercent, render) {
	if (!render?.color) return text;
	const code = LIMITS_USAGE_COLORS.find(([floor]) => usedPercent >= floor)?.[1];
	return code ? `${code}${text}\u001b[0m` : text;
}

function formatLimitsPercent(limit, render) {
	if (typeof limit.leftPercent !== "number") return "unavailable";
	const mode = render?.quotaDisplay ?? "free";
	const usedPercent = 100 - limit.leftPercent;
	const text = mode === "used" ? `${usedPercent}% used` : `${limit.leftPercent}% left`;
	return colorLimitsPercent(text, usedPercent, render);
}

function formatLimitsRenewal(limit, render, now) {
	if (limit.notStarted) return "not started (the window opens on first use)";
	const usageMod = render?.usageMod;
	if (!Number.isFinite(limit.resetAtMs) || !usageMod?.formatUsageResetTimestamp) return undefined;
	const at = usageMod.formatUsageResetTimestamp(limit.resetAtMs);
	if (!at) return undefined;
	if (limit.resetAtMs <= now) return `${at} (passed since this reading)`;
	const countdown = usageMod.formatUsageCountdown(limit.resetAtMs - now);
	return countdown ? `${at} (in ${countdown})` : at;
}

/** `2026-09-27 13:17:22 (14m ago)`. */
function formatLimitsReadTime(readAt, render, now) {
	const usageMod = render?.usageMod;
	if (!Number.isFinite(readAt) || !usageMod?.formatUsageResetTimestamp) return undefined;
	const at = usageMod.formatUsageResetTimestamp(Math.floor(readAt / 1000) * 1000);
	const age = now - readAt >= 60_000 ? `${usageMod.formatUsageCountdown(now - readAt)} ago` : "just now";
	return `${at} (${age})`;
}

function describeLimitsReadings(readings, render, now) {
	const at = readings && formatLimitsReadTime(readings.readAt, render, now);
	if (!at) return undefined;
	if (readings.source === "live") return `read live at ${at}`;
	return `the plugin's last readings, taken ${at}; --refresh reads every account live`;
}

function buildLimitsAccountRows(account, render, now, readings) {
	const rows = [];
	if (account.workspaceName) rows.push(["Business account", account.workspaceName]);
	if (account.error) {
		rows.push(["Error", account.error]);
		return rows;
	}
	for (const limit of account.limits ?? []) {
		rows.push([limit.name, formatLimitsPercent(limit, render)]);
		const renewal = formatLimitsRenewal(limit, render, now);
		if (renewal) rows.push(["Renews", renewal]);
	}
	if ((account.limits ?? []).length === 0) rows.push([null, "No usage windows reported yet."]);
	const planName = account.planName ?? account.planType;
	if (planName) {
		const allotment = account.planMultiplier ? ` (${account.planMultiplier})` : "";
		rows.push(["Plan", `${planName}${allotment}`]);
	}
	if (account.credits) rows.push(["Credits", account.credits]);
	const hasResets = account.resetCredits
		? account.resetCredits.available > 0
		: Boolean(account.resetCreditsSummary);
	if (hasResets) rows.push(["Resets", account.resetCreditsSummary]);
	// Only a reading taken at a different moment from the one the header
	// names gets its own time.
	if (readings && Number.isFinite(account.readAt) && account.readAt !== readings.readAt) {
		const at = formatLimitsReadTime(account.readAt, render, now);
		if (at) rows.push(["Read", account.source === "live" ? `${at}, live` : at]);
	}
	return rows;
}

function limitsKeyWidth(rows) {
	return Math.max(0, ...rows.filter(([key]) => key !== null).map(([key]) => key.length));
}

function printLimitsRows(rows, indent, width = limitsKeyWidth(rows)) {
	for (const [key, value] of rows) {
		console.log(key === null ? `${indent}${value}` : `${indent}${`${key}:`.padEnd(width + 1)} ${value}`);
	}
}

function printLimitsResult(payload, json, render) {
	if (json) {
		console.log(JSON.stringify(payload, null, 2));
		return;
	}
	console.log(`oc-codex-multi-auth limits`);
	if (payload.message) console.log(payload.message);
	if (payload.error) {
		printLimitsRows([["Storage", payload.storagePath], ["Error", payload.error]], "");
		return;
	}
	const now = Date.now();
	const readings = describeLimitsReadings(payload.readings, render, now);
	const header = [
		["Storage", payload.storagePath],
		["Accounts", String(payload.totalAccounts)],
		...(payload.sort ? [["Sort", `${payload.sort.by} (${payload.sort.direction})`]] : []),
		...(readings ? [["Readings", readings]] : []),
	];
	const footer = [
		...(payload.poolSummary ? [["Pool", payload.poolSummary]] : []),
		...(payload.nextAction ? [["Next", payload.nextAction]] : []),
	];
	// The header and the pool total share one column, and every account's rows
	// share another, so the report reads down straight edges rather than each
	// block lining up only with itself.
	const topWidth = limitsKeyWidth([...header, ...footer]);
	printLimitsRows(header, "", topWidth);
	const accountRows = (payload.accounts ?? []).map((account) => ({
		account,
		rows: buildLimitsAccountRows(account, render, now, payload.readings),
	}));
	const rowWidth = limitsKeyWidth(accountRows.flatMap(({ rows }) => rows));
	for (const { account, rows } of accountRows) {
		console.log("");
		const label = account.email ? `${account.label} (${account.email})` : account.label;
		console.log(`- [${account.index}] ${label}`);
		printLimitsRows(rows, "  ", rowWidth);
	}
	if (footer.length > 0) {
		console.log("");
		printLimitsRows(footer, "", topWidth);
	}
}

export async function runStandaloneCommand(command, argv = [], options = {}) {
	const parsed = parseStandaloneArgs(argv);
	if (command === "diag") {
		command = "doctor";
		parsed.deep = true;
	}
	if (parsed.help) {
		printHelp();
		return { exitCode: 0, action: "help" };
	}
	if (command === "warm") {
		return runWarmCommand(parsed, options);
	}
	if (command === "limits") {
		return runLimitsCommand(parsed, options);
	}
	const { env = process.env } = options;
	const storagePath = getStandaloneStoragePath(parsed, env);
	const repairRequested = command === "doctor" && parsed.fix;
	let storage = null;
	let error = null;
	if (parsed.configPath || !repairRequested) {
		({ storage, error } = await readStandaloneStorage(storagePath));
	}
	const appliedFixes = [];
	const fixErrors = [];
	if (repairRequested && !error) {
		const previousKeychain = process.env.CODEX_KEYCHAIN;
		try {
			const loadDoctorRuntime = options.loadDoctorRuntime ?? (() => loadDistModules(
				["storage.js", "tools/doctor-repair.js", "shutdown.js"], "doctor",
			));
			const [storageMod, repairMod, shutdownMod] = await loadDoctorRuntime();
			// A CLI file selection must not read or replace the global keychain pool.
			if (parsed.configPath) process.env.CODEX_KEYCHAIN = "0";
			storageMod.setStoragePathDirect(storagePath);
			shutdownMod.setShutdownOwnsProcess(true);
			try {
				storage = await storageMod.loadAccounts();
			} catch (loadError) {
				// Typed storage errors (UNSUPPORTED_SCHEMA_VERSION, unknown V2)
				// carry exact in-tree copy plus an upgrade/recovery hint, and the
				// load never got far enough to attempt a repair. Surface them on
				// the error channel (exit 1) instead of the generic catch below,
				// which is reserved for unknown throws so upstream failure text
				// never reaches output unredacted.
				if (loadError && typeof loadError.code === "string") {
					const hint = typeof loadError.hint === "string" ? ` ${loadError.hint}` : "";
					error = `${formatErrorForLog(loadError)}${hint}`;
				} else {
					throw loadError;
				}
			}
			if (!storage && !error) {
				// `loadAccounts` swallows JSON parse/IO errors and returns null. In
				// default-path mode the pre-read above was skipped (keychain routing
				// may own the pool), so probe the JSON file here: a corrupt file must
				// surface as a parse error (exit 1) instead of "No accounts
				// configured" (exit 0). ENOENT stays silent - a missing file with an
				// empty keychain legitimately means no accounts yet. Skipped when a
				// typed load error already set `error`; the probe would only
				// overwrite the precise schema message with its own paraphrase.
				const probe = await readStandaloneStorage(storagePath);
				if (probe.error) error = probe.error;
			}
			if (!error) {
				const repair = await repairMod.repairDoctorAccounts(storage?.accounts ?? []);
				appliedFixes.push(...repair.appliedFixes);
				fixErrors.push(...repair.fixErrors);
				storage = (await storageMod.loadAccounts()) ?? storage;
			}
		} catch {
			fixErrors.push("Doctor repair could not complete. Check the selected storage file and installed runtime.");
		} finally {
			if (parsed.configPath) {
				if (previousKeychain === undefined) delete process.env.CODEX_KEYCHAIN;
				else process.env.CODEX_KEYCHAIN = previousKeychain;
			}
		}
	}
	const accounts = summarizeStandaloneAccounts(storage, parsed.includeSensitive, parsed.tag);
	const totalAccounts = Array.isArray(storage?.accounts) ? storage.accounts.length : 0;
	const payload = {
		command,
		storagePath,
		totalAccounts,
		shownAccounts: accounts.length,
		activeIndex: typeof storage?.activeIndex === "number" ? storage.activeIndex : 0,
		activeIndexByFamily: storage?.activeIndexByFamily ?? {},
		accounts,
		error,
	};
	if (command === "dashboard") {
		payload.message = "Standalone dashboard server is not launched by this safe CLI; use status/list/limits/health or OpenCode codex-dashboard.";
		payload.nextAction = "Run oc-codex-multi-auth status or open OpenCode and call codex-dashboard.";
	} else if (command === "doctor") {
		payload.message = error ? "Storage could not be parsed." : totalAccounts > 0 ? "Local diagnostics completed." : "No accounts configured.";
		payload.deep = parsed.deep;
		payload.fixApplied = parsed.fix ? appliedFixes.length > 0 : undefined;
		if (parsed.fix) {
			payload.appliedFixes = appliedFixes;
			payload.fixErrors = fixErrors;
		}
		payload.nextAction = totalAccounts > 0 ? "Run oc-codex-multi-auth health --json for scriptable checks." : "Run opencode auth login.";
	} else if (command === "health") {
		payload.healthyCount = accounts.filter((account) => account.enabled && account.hasRefreshToken).length;
		payload.unhealthyCount = accounts.filter((account) => !account.enabled || !account.hasRefreshToken).length;
	} else if (command === "status") {
		payload.message = totalAccounts > 0 ? "Account storage loaded." : "No accounts configured.";
	}
	printStandaloneResult(command, payload, parsed.json);
	return { exitCode: error || fixErrors.length > 0 ? 1 : 0, action: command, storagePath };
}

// Top-level keys inside `provider.openai` that the installer owns absolutely.
// These are always sourced from the template (overwritten or removed) so the
// plugin's required runtime shape is authoritative. Any OTHER key the user has
// placed under `provider.openai` is preserved as-is. `models` is handled
// separately because it's a map where user-added model ids must survive while
// template-shipped ids win on collision.
const MANAGED_OPENAI_KEYS = new Set(["baseURL", "apiKey", "options"]);

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Deep-merge `provider.openai` preserving unknown user keys while letting the
// installer overwrite the managed shape it ships. This replaces the earlier
// wholesale overwrite which clobbered custom user-added keys (see audit top-20
// #6).
function mergeOpenaiProvider(existingOpenai, templateOpenai, options = {}) {
	const existingSafe = isPlainObject(existingOpenai) ? existingOpenai : {};
	const templateSafe = isPlainObject(templateOpenai) ? templateOpenai : {};
	const modelKeysToRemove = options.modelKeysToRemove instanceof Set
		? options.modelKeysToRemove
		: new Set();

	const result = {};

	// 1. Start with the user's non-managed keys (unknown-to-installer settings).
	for (const [key, value] of Object.entries(existingSafe)) {
		if (MANAGED_OPENAI_KEYS.has(key)) continue;
		if (key === "models") continue; // handled explicitly below
		result[key] = value;
	}

	// 2. Apply template-managed keys. Installer is source of truth for these.
	for (const [key, value] of Object.entries(templateSafe)) {
		if (key === "models") continue; // handled explicitly below
		result[key] = value;
	}

	// 3. Merge `models` by id: template wins on collision, user-added ids survive.
	const existingModels = isPlainObject(existingSafe.models) ? existingSafe.models : {};
	const templateModels = isPlainObject(templateSafe.models) ? templateSafe.models : {};
	const prunedExistingModels = Object.fromEntries(
		Object.entries(existingModels).filter(([key]) => !modelKeysToRemove.has(key)),
	);
	const mergedModels = { ...prunedExistingModels, ...templateModels };
	if (Object.keys(mergedModels).length > 0) {
		result.models = mergedModels;
	}

	return result;
}

// Naive line-by-line diff for displaying config changes in dry-run. Good enough
// for eyeballing; not intended to be parsed or round-tripped.
function formatConfigDiff(existingConfig, nextConfig) {
	const oldText = existingConfig === undefined ? "" : formatJson(existingConfig);
	const newText = formatJson(nextConfig);
	if (oldText === newText) {
		return "(no changes)";
	}
	const lines = [];
	lines.push("--- existing");
	lines.push("+++ proposed");
	if (existingConfig === undefined) {
		lines.push("- (no existing config)");
	} else {
		for (const line of oldText.split("\n")) {
			lines.push(`- ${line}`);
		}
	}
	for (const line of newText.split("\n")) {
		lines.push(`+ ${line}`);
	}
	return lines.join("\n");
}

function formatRedactedConfigDiff(existingConfig, nextConfig) {
	const missing = Symbol("missing");
	const changes = [];
	const visit = (existing, next, path) => {
		if (existing === missing) {
			changes.push(`+ ${path}`);
			return;
		}
		if (next === missing) {
			changes.push(`- ${path}`);
			return;
		}
		if (Object.is(existing, next)) return;

		if (Array.isArray(existing) && Array.isArray(next)) {
			const length = Math.max(existing.length, next.length);
			for (let index = 0; index < length; index += 1) {
				visit(
					index < existing.length ? existing[index] : missing,
					index < next.length ? next[index] : missing,
					`${path}[${index}]`,
				);
			}
			return;
		}

		if (isPlainObject(existing) && isPlainObject(next)) {
			const keys = new Set([...Object.keys(existing), ...Object.keys(next)]);
			for (const key of keys) {
				visit(
					Object.hasOwn(existing, key) ? existing[key] : missing,
					Object.hasOwn(next, key) ? next[key] : missing,
					`${path}.${key}`,
				);
			}
			return;
		}

		changes.push(`~ ${path}`);
	};

	visit(existingConfig === undefined ? missing : existingConfig, nextConfig, "$");
	return changes.length > 0 ? changes.join("\n") : "(no changes)";
}

function mergeFullTemplate(modernTemplate, legacyTemplate) {
	const modernModels = modernTemplate.provider?.openai?.models ?? {};
	const legacyModels = legacyTemplate.provider?.openai?.models ?? {};
	const overlappingKeys = Object.keys(modernModels).filter((key) => Object.hasOwn(legacyModels, key));

	if (overlappingKeys.length > 0) {
		throw new Error(`Full config template collision for model keys: ${overlappingKeys.join(", ")}`);
	}

	return {
		...modernTemplate,
		provider: {
			...(modernTemplate.provider ?? {}),
			openai: {
				...(modernTemplate.provider?.openai ?? {}),
				models: {
					...modernModels,
					...legacyModels,
				},
			},
		},
	};
}

function getTemplateModelKeys(template) {
	return new Set(Object.keys(template.provider?.openai?.models ?? {}));
}

async function readJson(filePath) {
	const content = await readFile(filePath, "utf-8");
	return JSON.parse(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content);
}

async function renameWithWindowsRetry(sourcePath, destinationPath) {
	let lastError = null;

	for (let attempt = 0; attempt < WINDOWS_RENAME_RETRY_ATTEMPTS; attempt += 1) {
		try {
			await rename(sourcePath, destinationPath);
			return;
		} catch (error) {
			if (isWindowsLockError(error)) {
				lastError = error;
				await delay(WINDOWS_RENAME_RETRY_BASE_DELAY_MS * 2 ** attempt);
				continue;
			}
			throw error;
		}
	}

	if (lastError) {
		throw lastError;
	}
}

async function removeWithWindowsRetry(path, options) {
	let lastError = null;

	for (let attempt = 0; attempt < WINDOWS_RENAME_RETRY_ATTEMPTS; attempt += 1) {
		try {
			await rm(path, options);
			return;
		} catch (error) {
			if (isWindowsLockError(error)) {
				lastError = error;
				await delay(WINDOWS_RENAME_RETRY_BASE_DELAY_MS * 2 ** attempt);
				continue;
			}
			throw error;
		}
	}

	if (lastError) {
		throw lastError;
	}
}

async function writeFileAtomic(filePath, content) {
	const uniqueSuffix = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
	const tempPath = `${filePath}.${uniqueSuffix}.tmp`;

	try {
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
		await renameWithWindowsRetry(tempPath, filePath);
	} catch (error) {
		await rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
}

async function loadTemplate(mode, paths) {
	if (mode === "modern") {
		return readJson(paths.modernTemplatePath);
	}
	if (mode === "legacy") {
		return readJson(paths.legacyTemplatePath);
	}

	const [modernTemplate, legacyTemplate] = await Promise.all([
		readJson(paths.modernTemplatePath),
		readJson(paths.legacyTemplatePath),
	]);

	return mergeFullTemplate(modernTemplate, legacyTemplate);
}

async function copyFileWithWindowsRetry(sourcePath, destinationPath) {
	let lastError = null;

	for (let attempt = 0; attempt < WINDOWS_RENAME_RETRY_ATTEMPTS; attempt += 1) {
		try {
			await copyFile(sourcePath, destinationPath);
			return;
		} catch (error) {
			if (isWindowsLockError(error)) {
				lastError = error;
				await delay(WINDOWS_RENAME_RETRY_BASE_DELAY_MS * 2 ** attempt);
				continue;
			}
			throw error;
		}
	}

	if (lastError) {
		throw lastError;
	}
}

async function backupConfig(sourcePath, dryRun) {
	const timestamp = new Date()
		.toISOString()
		.replace(/[:.]/g, "-")
		.replace("T", "_")
		.replace("Z", "");
	const backupPath = `${sourcePath}.bak-${timestamp}`;
	if (!dryRun) {
		await copyFileWithWindowsRetry(sourcePath, backupPath);
	}
	return backupPath;
}

async function removePluginFromCachePackage(paths, dryRun) {
	if (!existsSync(paths.cachePackageJson)) {
		return;
	}
	if (!isEvictableCachePath(paths.cachePackageJson, paths.cacheDir)) {
		log(`Warning: refusing to update ${paths.cachePackageJson}: it does not resolve inside the OpenCode cache.`);
		return;
	}

	let cacheData;
	try {
		cacheData = await readJson(paths.cachePackageJson);
	} catch (error) {
		log(`Warning: Could not parse ${paths.cachePackageJson} (${formatErrorForLog(error)}). Skipping.`);
		return;
	}

	const sections = [
		"dependencies",
		"devDependencies",
		"peerDependencies",
		"optionalDependencies",
	];

	let changed = false;
	for (const section of sections) {
		const deps = cacheData?.[section];
		if (deps && typeof deps === "object") {
			for (const name of getManagedPackageNames()) {
				if (name in deps) {
					delete deps[name];
					changed = true;
				}
			}
		}
	}

	if (!changed) {
		return;
	}

	if (dryRun) {
		log(`[dry-run] Would update ${paths.cachePackageJson} to remove ${getManagedPackageNames().join(", ")}`);
		return;
	}

	await writeFileAtomic(paths.cachePackageJson, formatJson(cacheData));
}

/**
 * Mirror of `isEvictableCachePath` in lib/auto-update-checker.ts. A recursive
 * delete must never act on a path that only spells like cache: the cache root
 * itself must not resolve through a symlink (`~/.cache/opencode -> ~` would
 * otherwise call the whole home directory "inside the cache"), and the
 * resolved target must stay inside the resolved root.
 */
function isEvictableCachePath(cachePath, cacheRoot) {
	const absolutePath = resolve(cachePath);
	const absoluteRoot = resolve(cacheRoot);
	if (!isInsideDirectory(absolutePath, absoluteRoot, process.platform)) return false;
	try {
		const realRoot = realpathSync(absoluteRoot);
		const rootIsSymlinked = process.platform === "win32"
			? realRoot.toLowerCase() !== absoluteRoot.toLowerCase()
			: realRoot !== absoluteRoot;
		if (rootIsSymlinked) return false;
		return isInsideDirectory(realpathSync(absolutePath), realRoot, process.platform);
	} catch {
		return false;
	}
}

async function clearCache(paths, dryRun, skipCacheClear) {
	if (skipCacheClear) {
		log("Skipping cache clear (--no-cache-clear).");
		await removePluginFromCachePackage(paths, dryRun);
		return;
	}

	const cacheTargets = [
		...paths.cacheNodeModulesPaths,
		...paths.cachePackagePaths,
		paths.cacheBunLock,
	];

	if (dryRun) {
		for (const cacheNodeModulesPath of paths.cacheNodeModulesPaths) {
			log(`[dry-run] Would remove ${cacheNodeModulesPath}`);
		}
		for (const cachePackagePath of paths.cachePackagePaths) {
			log(`[dry-run] Would remove ${cachePackagePath}`);
		}
		log(`[dry-run] Would remove ${paths.cacheBunLock}`);
	} else {
		for (const cacheTarget of cacheTargets) {
			if (!existsSync(cacheTarget)) continue;
			if (!isEvictableCachePath(cacheTarget, paths.cacheDir)) {
				log(`Warning: refusing to remove ${cacheTarget}: it does not resolve inside the OpenCode cache.`);
				continue;
			}
			await removeWithWindowsRetry(cacheTarget, {
				recursive: cacheTarget !== paths.cacheBunLock,
				force: true,
			});
		}
	}

	await removePluginFromCachePackage(paths, dryRun);
}

/** Route V2 installs without rewriting V1 entries or parallel JSONC config. */
export async function runInstaller(argv = process.argv.slice(2), options = {}) {
	const split = splitCommandArgv(argv);
	if (split.kind === "standalone") {
		return runStandaloneCommand(split.command, split.argv, options);
	}
	if (split.kind === "unknown") {
		printHelp();
		throw new Error(`Unknown command: ${split.command}`);
	}
	const { env = process.env } = options;
	const paths = buildPaths(resolveHomeDirectory(env));
	if (split.kind === "update") {
		const parsedUpdate = parseUpdateArgs(split.argv);
		if (parsedUpdate.wantsHelp) {
			printHelp();
			return { exitCode: 0, action: "help" };
		}
		await clearCache(paths, parsedUpdate.dryRun, false);
		log(`\n${parsedUpdate.dryRun ? "Dry run complete." : "Cache cleared."} Restart OpenCode to install the latest plugin.`);
		return {
			exitCode: 0,
			action: "update",
			dryRun: Boolean(parsedUpdate.dryRun),
		};
	}
	const parsed = parseCliArgs(split.argv);
	if (parsed.wantsHelp) {
		printHelp();
		return { exitCode: 0, action: "help" };
	}

	const { configMode, dryRun, skipCacheClear, pluginOnly } = parsed;
	if (parsed.v2) {
		if (existsSync(paths.jsoncConfigPath)) {
			throw new Error(`OpenCode config exists at ${paths.jsoncConfigPath}; edit its plugins list directly instead of writing a second config file.`);
		}
		const existing = existsSync(paths.configPath) ? await readJson(paths.configPath) : {};
		if (!isPlainObject(existing)) throw new Error("OpenCode config root must be an object");
		if (Array.isArray(existing.plugin) && existing.plugin.length > 0) {
			throw new Error("OpenCode V1 plugin entries are present. Use a separate V2 config or migrate them manually; --v2 will not remove your V1 registration.");
		}
		const next = { ...existing, plugins: normalizePluginList(existing.plugins, log, {
			baseDirectory: paths.configDir, cacheDirectory: paths.cacheDir,
		}) };
		next.$schema ??= "https://opencode.ai/config.json";
		if (dryRun) log(`[dry-run] Would register V2 plugin in ${paths.configPath}`);
		else if (formatJson(existing) !== formatJson(next)) {
			if (existsSync(paths.configPath)) await backupConfig(paths.configPath, false);
			await writeFileAtomic(paths.configPath, formatJson(next));
		}
		log(dryRun ? "V2 registration dry run complete." : "V2 plugin registered. Restart the OpenCode service to load it.");
		return { exitCode: 0, action: "install", dryRun: Boolean(dryRun), configMode: "v2" };
	}
	const effectiveConfigMode = pluginOnly ? "plugin-only" : configMode;
	const requiredTemplatePaths = pluginOnly
		? []
		: configMode === "modern"
			? [paths.modernTemplatePath]
			: configMode === "legacy"
				? [paths.legacyTemplatePath]
				: [paths.modernTemplatePath, paths.legacyTemplatePath];

	for (const templatePath of requiredTemplatePaths) {
		if (!existsSync(templatePath)) {
			throw new Error(`Config template not found at ${templatePath}`);
		}
	}

	const template = pluginOnly
		? { $schema: "https://opencode.ai/config.json", plugin: [PACKAGE_NAME] }
		: await loadTemplate(configMode, paths);
	template.plugin = [PACKAGE_NAME];
	const modelKeysToRemove = new Set(STALE_MANAGED_MODEL_KEYS);
	if (!pluginOnly && configMode === "modern") {
		for (const key of getTemplateModelKeys(await readJson(paths.legacyTemplatePath))) {
			modelKeysToRemove.add(key);
		}
	}
	if (!pluginOnly && configMode === "legacy") {
		for (const key of getTemplateModelKeys(await readJson(paths.modernTemplatePath))) {
			modelKeysToRemove.add(key);
		}
	}

	let existingConfig;
	if (existsSync(paths.configPath)) {
		try {
			const existing = await readJson(paths.configPath);
			if (!isPlainObject(existing)) {
				throw new Error("config root must be a JSON object");
			}
			existingConfig = existing;
		} catch (error) {
			if (pluginOnly) {
				throw new Error(
					`Could not parse existing config (${formatErrorForLog(error)}). Refusing to replace it in --plugin-only mode.`,
				);
			}
			log(`Warning: Could not parse existing config (${formatErrorForLog(error)}). Replacing with template.`);
			existingConfig = undefined;
		}
	} else {
		log("No existing config found. Creating new global config.");
	}

	let existingTuiConfig;
	if (existsSync(paths.tuiConfigPath)) {
		try {
			const existing = await readJson(paths.tuiConfigPath);
			if (!isPlainObject(existing)) {
				throw new Error("TUI config root must be a JSON object");
			}
			existingTuiConfig = existing;
		} catch (error) {
			if (pluginOnly) {
				throw new Error(
					`Could not parse existing TUI config (${formatErrorForLog(error)}). Refusing to replace it in --plugin-only mode.`,
				);
			}
			log(`Warning: Could not parse existing TUI config (${formatErrorForLog(error)}). Replacing with minimal TUI config.`);
			existingTuiConfig = undefined;
		}
	} else {
		log("No existing TUI config found. Creating new global TUI config.");
	}

	// A checkout of this package registered in either file already loads the
	// plugin, so the published name must not be written beside it anywhere -
	// otherwise the checkout in opencode.json and the published package in
	// tui.json both load.
	const pluginListOptions = {
		baseDirectory: paths.configDir,
		cacheDirectory: paths.cacheDir,
	};
	const checkoutRegistered = [existingConfig?.plugin, existingTuiConfig?.plugin]
		.flatMap((list) => (Array.isArray(list) ? list : []))
		.some((entry) => {
			const classification = classifyPluginEntry(entry, pluginListOptions);
			return (
				classification.kind === LOCAL_CHECKOUT_ENTRY &&
				classification.name === PACKAGE_NAME
			);
		});
	const normalizeOptions = { ...pluginListOptions, checkoutRegistered };

	let nextConfig;
	if (existingConfig !== undefined) {
		const merged = { ...existingConfig };
		merged.plugin = normalizePluginList(existingConfig.plugin, log, normalizeOptions);
		if (!pluginOnly) {
			const provider = (existingConfig.provider && typeof existingConfig.provider === "object")
				? { ...existingConfig.provider }
				: {};
			provider.openai = mergeOpenaiProvider(existingConfig.provider?.openai, template.provider?.openai, {
				modelKeysToRemove,
			});
			merged.provider = provider;
		}
		nextConfig = merged;
	} else {
		nextConfig = pluginOnly
			? { $schema: template.$schema, plugin: [PACKAGE_NAME] }
			: template;
		nextConfig.plugin = normalizePluginList(nextConfig.plugin, log, normalizeOptions);
	}

	const nextTuiConfig = mergeTuiConfig(existingTuiConfig, log, normalizeOptions);

	const unregisteredCheckout = findUnregisteredLocalCheckout(nextConfig.plugin, paths.originHistoryPath, {
		baseDirectory: paths.configDir,
		cacheDirectory: paths.cacheDir,
	});
	if (unregisteredCheckout) {
		log(
			`Note: this plugin last loaded from a checkout at ${unregisteredCheckout.root} on ${unregisteredCheckout.lastSeen}, ` +
			`which ${paths.configPath} does not register. Point the plugin entry back at that path if OpenCode should keep loading your own build.`,
		);
	}

	const configChanged = existingConfig === undefined || formatJson(existingConfig) !== formatJson(nextConfig);
	const tuiConfigChanged = existingTuiConfig === undefined || formatJson(existingTuiConfig) !== formatJson(nextTuiConfig);
	let wrote = false;
	if (dryRun) {
		log(`[dry-run] ${configChanged ? "Would write" : "Would leave unchanged"} ${paths.configPath} using ${effectiveConfigMode} config`);
		log(`[dry-run] Diff for ${paths.configPath}:`);
		log(formatRedactedConfigDiff(existingConfig, nextConfig));
		log(`[dry-run] ${tuiConfigChanged ? "Would write" : "Would leave unchanged"} ${paths.tuiConfigPath} with the TUI status plugin`);
		log(`[dry-run] Diff for ${paths.tuiConfigPath}:`);
		log(formatRedactedConfigDiff(existingTuiConfig, nextTuiConfig));
	} else {
		if (configChanged) {
			if (existsSync(paths.configPath)) {
				const backupPath = await backupConfig(paths.configPath, false);
				log(`Backup created: ${backupPath}`);
			}
			await writeFileAtomic(paths.configPath, formatJson(nextConfig));
			wrote = true;
			log(`Wrote ${paths.configPath} (${effectiveConfigMode} config)`);
		} else {
			log(`Left ${paths.configPath} unchanged`);
		}
		if (tuiConfigChanged) {
			if (existsSync(paths.tuiConfigPath)) {
				const backupPath = await backupConfig(paths.tuiConfigPath, false);
				log(`Backup created: ${backupPath}`);
			}
			await writeFileAtomic(paths.tuiConfigPath, formatJson(nextTuiConfig));
			wrote = true;
			log(`Wrote ${paths.tuiConfigPath} (TUI status plugin)`);
		} else {
			log(`Left ${paths.tuiConfigPath} unchanged`);
		}
	}

	await clearCache(paths, dryRun, skipCacheClear);

	log("\nDone. Restart OpenCode to (re)install the plugin.");
	log("Example: opencode");
	if (!pluginOnly && configMode === "modern") {
		log("Note: Modern config intentionally shows 10 base OAuth model entries; use the variant picker for reasoning presets.");
	}
	if (!pluginOnly && configMode === "legacy") {
		log("Note: Legacy config writes 53 explicit preset entries and is also safe for older OpenCode versions.");
	}
	if (!pluginOnly && configMode === "full") {
		log("Note: Full config installs both compact base models and explicit preset entries for direct selector IDs.");
	}

	return {
		exitCode: 0,
		action: "install",
		configMode: effectiveConfigMode,
		pluginOnly,
		configPath: paths.configPath,
		tuiConfigPath: paths.tuiConfigPath,
		dryRun: Boolean(dryRun),
		wrote,
	};
}

export const __test = {
	ORIGIN_HISTORY_FILE_NAME,
	buildPaths,
	backupConfig,
	classifyPluginEntry,
	copyFileWithWindowsRetry,
	findUnregisteredLocalCheckout,
	formatConfigDiff,
	formatRedactedConfigDiff,
	mergeFullTemplate,
	mergeOpenaiProvider,
	mergeTuiConfig,
	normalizePluginList,
	parseCliArgs,
	removeWithWindowsRetry,
	runStandaloneCommand,
	splitCommandArgv,
	writeFileAtomic,
	renameWithWindowsRetry,
	resolveHomeDirectory,
};
