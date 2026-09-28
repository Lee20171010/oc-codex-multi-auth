/**
 * `codex-status` tool — detailed per-account status and rate limits.
 * Extracted from `index.ts` per RC-1 Phase 2.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import { loadAccounts } from "../storage.js";
import { AccountManager, formatCooldown, formatWaitTime } from "../accounts.js";
import { resolveSeatSuffixes } from "../account-display.js";
import { MODEL_FAMILIES } from "../prompts/codex.js";
import { recommendBeginnerNextAction } from "../ui/beginner.js";
import {
	buildTableHeader,
	buildTableRow,
	type TableOptions,
} from "../table-formatter.js";
import {
	formatUiBadge,
	formatUiHeader,
	formatUiItem,
	formatUiKeyValue,
	formatUiSection,
} from "../ui/format.js";
import { normalizeToolOutputFormat, renderJsonOutput } from "../runtime.js";
import { describePluginOrigin, getPluginOrigin } from "../plugin-origin.js";
import { formatPlanType } from "../auth/plan-tier.js";
import {
	TOOL_INCLUDE_SENSITIVE_DESCRIPTION,
	TOOL_OUTPUT_FORMAT_DESCRIPTION,
	TOOL_OUTPUT_FORMAT_VALUES,
} from "./args.js";
import {
	redactHomePaths,
	redactPluginOrigin,
	withToolErrorEnvelope,
} from "./output.js";
import type { ToolContext } from "./index.js";

export function createCodexStatusTool(ctx: ToolContext): ToolDefinition {
	const {
		resolveUiRuntime,
		resolveActiveIndex,
		formatCommandAccountLabel,
		resolveMaskEmail,
		formatRateLimitEntry,
		formatQuotaExhaustionEntry,
		getRateLimitResetTimeForFamily,
		buildJsonAccountIdentity,
		buildRoutingVisibilitySnapshot,
		appendRoutingVisibilityText,
		appendRoutingVisibilityUi,
		toBeginnerAccountSnapshots,
		getBeginnerRuntimeSnapshot,
		runtimeMetrics,
		cachedAccountManagerRef,
	} = ctx;
	const definition = tool({
		description:
			"Show detailed status of Codex accounts and rate limits.",
		args: {
			format: tool.schema
				.enum(TOOL_OUTPUT_FORMAT_VALUES)
				.optional()
				.describe(TOOL_OUTPUT_FORMAT_DESCRIPTION),
			includeSensitive: tool.schema
				.boolean()
				.optional()
				.describe(TOOL_INCLUDE_SENSITIVE_DESCRIPTION),
		},
		async execute({
			format,
			includeSensitive,
		}: {
			format?: string;
			includeSensitive?: boolean;
		} = {}) {
			const ui = resolveUiRuntime();
			const maskEmail = resolveMaskEmail();
			const outputFormat = normalizeToolOutputFormat(format);
			const includeSensitiveOutput = includeSensitive === true;
			const storage = await loadAccounts();
			if (!storage || storage.accounts.length === 0) {
				if (outputFormat === "json") {
					// Keep the schema identical to the populated branch: every key the
					// populated payload emits is present here with an empty/null value,
					// so consumers never have to detect a second shape.
					return renderJsonOutput({
						message:
							"No Codex accounts configured. Run: opencode auth login",
						totalAccounts: 0,
						pluginOrigin: redactPluginOrigin(getPluginOrigin()),
						selectionView: {
							modelFamily: "codex",
							effectiveModel: null,
							label: "codex",
						},
						accounts: [],
						activeIndexByFamily: {},
						rateLimitsByModelFamily: [],
						routingVisibility: buildRoutingVisibilitySnapshot(),
						recommendedNextAction: "Run opencode auth login",
					});
				}
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Account status"),
						"",
						formatUiItem(ui, "No accounts configured.", "warning"),
						formatUiItem(ui, "Run: opencode auth login", "accent"),
					].join("\n");
				}
				return "No Codex accounts configured. Run: opencode auth login";
			}

			const now = Date.now();
			const activeIndex = resolveActiveIndex(storage, "codex");
			const explainabilityFamily =
				runtimeMetrics.lastSelectionSnapshot?.family ?? "codex";
			const explainabilityModel =
				runtimeMetrics.lastSelectionSnapshot?.effectiveModel ??
				runtimeMetrics.lastSelectionSnapshot?.model ??
				undefined;
			const managerForExplainability =
				cachedAccountManagerRef.current ?? (await AccountManager.loadFromDisk());
			const explainability =
				managerForExplainability.getSelectionExplainability(
					explainabilityFamily,
					explainabilityModel,
					now,
				);
			const selectionQuotaKey = explainabilityModel
				? `${explainabilityFamily}:${explainabilityModel}`
				: explainabilityFamily;
			const routingVisibility = buildRoutingVisibilitySnapshot({
				modelFamily: explainabilityFamily,
				effectiveModel: explainabilityModel ?? null,
				quotaKey: selectionQuotaKey,
				selectedAccountIndex: activeIndex,
				selectionExplainability: explainability,
			});
			const explainabilityByIndex = new Map(
				explainability.map((entry) => [entry.index, entry]),
			);
			const recommendedNextAction = recommendBeginnerNextAction({
				accounts: toBeginnerAccountSnapshots(storage, activeIndex, now),
				now,
				runtime: getBeginnerRuntimeSnapshot(),
			});
			if (outputFormat === "json") {
				return renderJsonOutput({
					totalAccounts: storage.accounts.length,
					pluginOrigin: redactPluginOrigin(getPluginOrigin()),
					selectionView: {
						modelFamily: explainabilityFamily,
						effectiveModel: explainabilityModel ?? null,
						label: explainabilityModel
							? `${explainabilityFamily}:${explainabilityModel}`
							: explainabilityFamily,
					},
					accounts: storage.accounts.map((account, index) => ({
						...buildJsonAccountIdentity(index, {
							includeSensitive: includeSensitiveOutput,
							account,
							peerAccounts: storage.accounts,
						}),
						enabled: account.enabled !== false,
						isActive: index === activeIndex,
						planType: account.planType ?? null,
						plan: formatPlanType(account.planType) ?? null,
						rateLimit: formatRateLimitEntry(account, now) ?? null,
						quotaExhausted: formatQuotaExhaustionEntry(account, now) ?? null,
						cooldown: formatCooldown(account, now) ?? null,
						lastUsedAgeMs:
							typeof account.lastUsed === "number" && account.lastUsed > 0
								? Math.max(0, now - account.lastUsed)
								: null,
					})),
					activeIndexByFamily: Object.fromEntries(
						MODEL_FAMILIES.map((family) => [
							family,
							typeof storage.activeIndexByFamily?.[family] === "number"
								? (storage.activeIndexByFamily?.[family] ?? 0) + 1
								: null,
						]),
					),
					rateLimitsByModelFamily: storage.accounts.map((account, index) => ({
						...buildJsonAccountIdentity(index, {
							includeSensitive: includeSensitiveOutput,
							account,
							peerAccounts: storage.accounts,
						}),
						families: Object.fromEntries(
							MODEL_FAMILIES.map((family) => {
								const resetAt = getRateLimitResetTimeForFamily(
									account,
									now,
									family,
								);
								return [
									family,
									typeof resetAt === "number"
										? {
												resetAtMs: resetAt,
												wait: formatWaitTime(resetAt - now),
											}
										: null,
								];
							}),
						),
					})),
					routingVisibility,
					recommendedNextAction,
				});
			}
			if (ui.v2Enabled) {
				const lines: string[] = [
					...formatUiHeader(ui, "Account status"),
					formatUiKeyValue(ui, "Total", String(storage.accounts.length)),
					formatUiKeyValue(
						ui,
						"Running from",
						redactHomePaths(describePluginOrigin(getPluginOrigin())),
						"muted",
					),
					formatUiKeyValue(
						ui,
						"Selection view",
						explainabilityModel
							? `${explainabilityFamily}:${explainabilityModel}`
							: explainabilityFamily,
						"muted",
					),
					"",
					...formatUiSection(ui, "Accounts"),
				];

				storage.accounts.forEach((account, index) => {
					const label = formatCommandAccountLabel(account, index, {
						maskEmail,
						peerAccounts: storage.accounts,
					});
					const badges: string[] = [];
					if (index === activeIndex)
						badges.push(formatUiBadge(ui, "active", "accent"));
					if (account.enabled === false)
						badges.push(formatUiBadge(ui, "disabled", "danger"));
					const rateLimit = formatRateLimitEntry(account, now) ?? "none";
					const quotaExhausted = formatQuotaExhaustionEntry(account, now) ?? "none";
					const cooldown = formatCooldown(account, now) ?? "none";
					if (rateLimit !== "none")
						badges.push(formatUiBadge(ui, "rate-limited", "warning"));
					if (quotaExhausted !== "none")
						badges.push(formatUiBadge(ui, "quota-exhausted", "warning"));
					if (cooldown !== "none")
						badges.push(formatUiBadge(ui, "cooldown", "warning"));
					if (badges.length === 0)
						badges.push(formatUiBadge(ui, "ok", "success"));
					const plan = formatPlanType(account.planType);
					if (plan) badges.push(formatUiBadge(ui, plan, "muted"));

					lines.push(
						formatUiItem(
							ui,
							label,
							"normal",
							badges.length > 0 ? ` ${badges.join(" ")}` : "",
						),
					);
					lines.push(
						`  ${formatUiKeyValue(ui, "rate limit", rateLimit, rateLimit === "none" ? "muted" : "warning")}`,
					);
					lines.push(
						`  ${formatUiKeyValue(ui, "quota", quotaExhausted, quotaExhausted === "none" ? "muted" : "warning")}`,
					);
					lines.push(
						`  ${formatUiKeyValue(ui, "cooldown", cooldown, cooldown === "none" ? "muted" : "warning")}`,
					);
				});

				lines.push("");
				lines.push(...formatUiSection(ui, "Active index by model family"));
				for (const family of MODEL_FAMILIES) {
					const idx = storage.activeIndexByFamily?.[family];
					const familyIndexLabel =
						typeof idx === "number" && Number.isFinite(idx)
							? String(idx + 1)
							: "-";
					lines.push(formatUiItem(ui, `${family}: ${familyIndexLabel}`));
				}

				lines.push("");
				lines.push(
					...formatUiSection(
						ui,
						"Rate limits by model family (per account)",
					),
				);
				storage.accounts.forEach((account, index) => {
					const statuses = MODEL_FAMILIES.map((family) => {
						const resetAt = getRateLimitResetTimeForFamily(
							account,
							now,
							family,
						);
						if (typeof resetAt !== "number") return `${family}=ok`;
						return `${family}=${formatWaitTime(resetAt - now)}`;
					});
					lines.push(
						formatUiItem(
							ui,
							`Account ${index + 1}: ${statuses.join(" | ")}`,
						),
					);
				});

				lines.push("");
				appendRoutingVisibilityUi(ui, lines, routingVisibility);

				lines.push("");
				lines.push(...formatUiSection(ui, "Selection explainability"));
				for (const entry of explainability) {
					const state = entry.eligible ? "eligible" : "blocked";
					const reasons = entry.reasons.join(", ");
					lines.push(
						formatUiItem(
							ui,
							`Account ${entry.index + 1}: ${state} | health=${Math.round(entry.healthScore)} | tokens=${entry.tokensAvailable.toFixed(1)} | ${reasons}`,
						),
					);
				}

				lines.push("");
				lines.push(...formatUiSection(ui, "Recommended next step"));
				lines.push(formatUiItem(ui, recommendedNextAction, "accent"));

				return lines.join("\n");
			}

			// A column of its own, sized to what it holds, for the same reason as
			// in `codex-list`: behind an unbounded email this 42-wide Label
			// truncates, and a seat that does not reach the screen cannot tell
			// two members of one workspace apart.
			const seatSuffixes = resolveSeatSuffixes(
				storage.accounts.map((entry) => entry.accountUserId),
			);
			const seatHeader = "Seat";
			const seatWidth = seatSuffixes.reduce(
				(widest, seat) => Math.max(widest, seat?.length ?? 0),
				seatHeader.length,
			);
			const statusTableOptions: TableOptions = {
				columns: [
					{ header: "#", width: 3 },
					{ header: "Label", width: 42 },
					{ header: seatHeader, width: seatWidth },
					{ header: "Plan", width: 18 },
					{ header: "Active", width: 6 },
					{ header: "Rate Limit", width: 16 },
					{ header: "Cooldown", width: 16 },
					{ header: "Last Used", width: 16 },
				],
			};

			const lines: string[] = [
				`Account Status (${storage.accounts.length} total):`,
				`Running from: ${redactHomePaths(describePluginOrigin(getPluginOrigin()))}`,
				"",
				...buildTableHeader(statusTableOptions),
			];

			storage.accounts.forEach((account, index) => {
				const label = formatCommandAccountLabel(account, index, {
					maskEmail,
					peerAccounts: storage.accounts,
					omitSeat: true,
				});
				const active = index === activeIndex ? "Yes" : "No";
				const rateLimit = formatRateLimitEntry(account, now) ?? "None";
				const cooldown = formatCooldown(account, now) ?? "No";
				const lastUsed =
					typeof account.lastUsed === "number" && account.lastUsed > 0
						? `${formatWaitTime(now - account.lastUsed)} ago`
						: "-";

				lines.push(
					buildTableRow(
						[
							String(index + 1),
							label,
							seatSuffixes[index] ?? "-",
							formatPlanType(account.planType) ?? "unknown",
							active,
							rateLimit,
							cooldown,
							lastUsed,
						],
						statusTableOptions,
					),
				);
			});

			lines.push("");
			lines.push("Active index by model family:");
			for (const family of MODEL_FAMILIES) {
				const idx = storage.activeIndexByFamily?.[family];
				const familyIndexLabel =
					typeof idx === "number" && Number.isFinite(idx)
						? String(idx + 1)
						: "-";
				lines.push(`  ${family}: ${familyIndexLabel}`);
			}

			lines.push("");
			lines.push("Rate limits by model family (per account):");
			storage.accounts.forEach((account, index) => {
				const statuses = MODEL_FAMILIES.map((family) => {
					const resetAt = getRateLimitResetTimeForFamily(
						account,
						now,
						family,
					);
					if (typeof resetAt !== "number") return `${family}=ok`;
					return `${family}=${formatWaitTime(resetAt - now)}`;
				});
				lines.push(`  Account ${index + 1}: ${statuses.join(" | ")}`);
			});

			lines.push("");
			appendRoutingVisibilityText(lines, routingVisibility);

			lines.push("");
			lines.push(
				`Selection explainability (${
					explainabilityModel
						? `${explainabilityFamily}:${explainabilityModel}`
						: explainabilityFamily
				}):`,
			);
			for (const [index] of storage.accounts.entries()) {
				const details = explainabilityByIndex.get(index);
				if (!details) continue;
				const state = details.eligible ? "eligible" : "blocked";
				lines.push(
					`  Account ${index + 1}: ${state} | health=${Math.round(details.healthScore)} | tokens=${details.tokensAvailable.toFixed(1)} | ${details.reasons.join(", ")}`,
				);
			}

			lines.push("");
			lines.push(`Recommended next step: ${recommendedNextAction}`);

			return lines.join("\n");
		},
	});
	return withToolErrorEnvelope("codex-status", definition);
}
