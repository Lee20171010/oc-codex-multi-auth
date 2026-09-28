/**
 * `codex-diag` tool — redacted diagnostic snapshot for bug reports.
 *
 * Returns a single JSON document describing runtime state (plugin version,
 * Node, platform, account count, circuit-breaker aggregates, metrics
 * summary, log-directory presence) with aggressive redaction applied:
 *
 * - No account IDs, emails, labels, or refresh/access/id tokens leak.
 * - Home-directory paths are replaced with `<HOME>` so shared bug reports
 *   do not reveal the reporter's username.
 * - The final JSON string is passed through `maskString` as a defence in
 *   depth against any caller-accidental token substring in the payload.
 *
 * Redaction depth is asserted in `test/tools-codex-diag.test.ts`.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";

import { getCircuitBreakerSummary } from "../circuit-breaker.js";
import { LOG_DIR, maskString } from "../logger.js";
import { loadAccounts } from "../storage.js";
import {
	redactHomePaths,
	sanitizeToolErrorMessage,
	withToolErrorEnvelope,
} from "./output.js";
import type { ToolContext } from "./index.js";

interface PackageManifest {
	name: string;
	version: string;
}

function loadPluginManifest(): PackageManifest {
	// `import.meta.url` resolves to `<plugin-root>/dist/lib/tools/codex-diag.js`
	// at runtime (ESM). Walking four levels up lands on the plugin root
	// regardless of whether the caller imported the source or built output.
	try {
		const here = fileURLToPath(import.meta.url);
		const root = join(here, "..", "..", "..", "..");
		const manifestPath = join(root, "package.json");
		const raw = readFileSync(manifestPath, "utf8");
		const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
		return {
			name: typeof parsed.name === "string" ? parsed.name : "unknown",
			version:
				typeof parsed.version === "string" ? parsed.version : "unknown",
		};
	} catch {
		return { name: "unknown", version: "unknown" };
	}
}

function countLogFiles(): number {
	try {
		if (!existsSync(LOG_DIR)) return 0;
		return readdirSync(LOG_DIR).filter((f) => f.endsWith(".json")).length;
	} catch {
		return 0;
	}
}

export function createCodexDiagTool(ctx: ToolContext): ToolDefinition {
	const {
		cachedAccountManagerRef,
		runtimeMetrics,
		buildRoutingVisibilitySnapshot,
	} = ctx;

	const definition = tool({
		description:
			"Generate a redacted diagnostic snapshot for bug reports. Never includes tokens, account IDs, emails, labels, or user home paths.",
		args: {},
		async execute() {
			await Promise.resolve();
			const manifest = loadPluginManifest();
			// Fresh storage read: the cached AccountManager can be empty or stale
			// even when accounts exist on disk, and diagnostics must describe the
			// on-disk reality. On a corrupt/unreadable store the manager count is
			// the best-effort fallback and `storageError` records why.
			let storageError: string | null = null;
			let accountCount: number;
			try {
				const storage = await loadAccounts();
				accountCount = storage?.accounts.length ?? 0;
			} catch (error) {
				storageError = sanitizeToolErrorMessage(
					error instanceof Error ? error.message : String(error),
				);
				accountCount =
					cachedAccountManagerRef.current?.getAccountCount() ?? 0;
			}
			const routing = buildRoutingVisibilitySnapshot();
			const circuit = getCircuitBreakerSummary();
			const logFileCount = countLogFiles();
			const logDirExists = existsSync(LOG_DIR);

			const metricsSummary = {
				uptimeMs: Math.max(0, Date.now() - runtimeMetrics.startedAt),
				totalRequests: runtimeMetrics.totalRequests,
				successfulRequests: runtimeMetrics.successfulRequests,
				failedRequests: runtimeMetrics.failedRequests,
				rateLimitedResponses: runtimeMetrics.rateLimitedResponses,
				serverErrors: runtimeMetrics.serverErrors,
				networkErrors: runtimeMetrics.networkErrors,
				authRefreshFailures: runtimeMetrics.authRefreshFailures,
				accountRotations: runtimeMetrics.accountRotations,
				emptyResponseRetries: runtimeMetrics.emptyResponseRetries,
				retryBudgetExhaustions: runtimeMetrics.retryBudgetExhaustions,
				retryProfile: runtimeMetrics.retryProfile,
				lastErrorCategory: runtimeMetrics.lastErrorCategory,
			};

			const snapshot = {
				plugin: {
					name: manifest.name,
					version: manifest.version,
				},
				runtime: {
					node: process.version,
					platform: process.platform,
					arch: process.arch,
				},
				accounts: storageError
					? { count: accountCount, storageError }
					: { count: accountCount },
				activeFamily: routing.modelFamily,
				circuitBreaker: circuit,
				metrics: metricsSummary,
				logs: logDirExists
					? {
							directory: "<HOME>/.opencode/logs/codex-plugin",
							fileCount: logFileCount,
							note:
								"Per-request JSON files only; no aggregated log file. Contents are NOT included in this snapshot.",
						}
					: { note: "no log file" },
				redactionApplied: true,
				generatedAt: new Date().toISOString(),
			};

			const rendered = JSON.stringify(snapshot, null, 2);
			// Defence in depth: mask any stray token-shaped strings AND scrub
			// home-directory paths even if an upstream value embedded them.
			return maskString(redactHomePaths(rendered));
		},
	});
	// codex-diag is always-JSON, so failures emit the envelope too.
	return withToolErrorEnvelope("codex-diag", definition, { alwaysJson: true });
}
