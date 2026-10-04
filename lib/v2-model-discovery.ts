import { createHash } from "node:crypto";
import { loadAccounts } from "./storage.js";
import { extractAccountId, resolveRequestAccountId } from "./auth/token-utils.js";
import { ensureCodexUsageAccessToken } from "./codex-usage.js";
import { createCodexHeaders } from "./request/fetch-helpers.js";
import { DEFAULT_CODEX_CLIENT_VERSION, sanitizeVersionToken } from "./request/helpers/user-agent.js";
import { getStoragePath } from "./storage/state.js";
import type { Auth } from "@opencode-ai/sdk";

type RecordValue = Record<string, unknown>;
type CacheEntry = { at: number; models: RecordValue[]; pending?: Promise<RecordValue[]> };
const cache = new Map<string, CacheEntry>();
const TTL = 5 * 60_000;

function record(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positive(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Account metadata describes the subscription route, independently of API access. */
export function subscriptionModels(data: unknown, providerID: string): RecordValue[] {
	if (!record(data) || !Array.isArray(data.models)) return [];
	return data.models.flatMap((item): RecordValue[] => {
		if (!record(item) || typeof item.slug !== "string" || item.visibility === "hide") return [];
		if (!/^[a-zA-Z0-9._-]+$/.test(item.slug) || !positive(item.context_window)) return [];
		const context = item.context_window;
		const maximum = positive(item.max_context_window) ? item.max_context_window : context;
		const levels = Array.isArray(item.supported_reasoning_levels) ? item.supported_reasoning_levels : [];
		const model: RecordValue = {
			id: item.slug, modelID: item.slug, providerID,
			name: `${typeof item.display_name === "string" ? item.display_name : item.slug} (Subscription)`,
			capabilities: { tools: true, input: Array.isArray(item.input_modalities) ? item.input_modalities : ["text"], output: ["text"] },
			variants: levels.flatMap((level) => record(level) && typeof level.effort === "string"
				? [{ id: level.effort, settings: { reasoningEffort: level.effort } }] : []),
			time: { released: 0 }, cost: [], status: "active", enabled: true,
			limit: { context, input: context, output: Math.min(128_000, context) },
		};
		if (maximum <= context) return [model];
		return [model, { ...structuredClone(model), id: `${item.slug}-long`,
			name: `${String(model.name)} · Long ${Math.floor(maximum / 1_000)}k`,
			limit: { context: maximum, input: maximum, output: Math.min(128_000, maximum) },
		}];
	});
}

/** Reuse the upstream coordinated refresh; disabled pool grants cannot re-enter via host auth. */
export async function resolveV2Credential(getAuth: () => Promise<Auth>) {
	const pool = await loadAccounts();
	const active = pool?.accounts[pool.activeIndex ?? 0];
	const account = active?.enabled !== false && (active?.refreshToken || active?.accessToken) ? active
		: pool?.accounts.find((candidate) => candidate.enabled !== false && (candidate.refreshToken || candidate.accessToken));
	if (pool && account) {
		const { accessToken } = await ensureCodexUsageAccessToken({ storage: pool, account });
		return {
			auth: { type: "oauth" as const, access: accessToken, refresh: account.refreshToken, expires: account.expiresAt ?? 0 },
			accountId: resolveRequestAccountId(account.accountId, account.accountIdSource, extractAccountId(accessToken)),
		};
	}
	const auth = await getAuth();
	if (auth.type !== "oauth") throw new Error("Codex OAuth is unavailable");
	if (pool?.accounts.some((candidate) => candidate.enabled === false &&
		(candidate.refreshToken === auth.refresh || candidate.accessToken === auth.access))) {
		throw new Error("Codex OAuth account is disabled");
	}
	return { auth, accountId: extractAccountId(auth.access) };
}

export async function discoverV2Models(providerID: string, getAuth: () => Promise<Auth>): Promise<RecordValue[]> {
	try {
		const { auth, accountId } = await resolveV2Credential(getAuth);
		return accountId ? await discoverAccountModels(providerID, accountId, auth.access) : [];
	} catch { return []; }
}

/** The request path supplies its refreshed credential and selected workspace, never another account's. */
export async function discoverAccountModels(providerID: string, accountId: string, access: string): Promise<RecordValue[]> {
	const key = createHash("sha256").update(JSON.stringify([getStoragePath(), providerID, accountId, access])).digest("hex");
	const cached = cache.get(key);
	if (cached?.pending) return structuredClone(await cached.pending);
	if (cached && Date.now() < cached.at) return structuredClone(cached.models);
	const oldestKey = cache.keys().next().value;
	if (cache.size >= 20 && oldestKey !== undefined) cache.delete(oldestKey);
	const entry: CacheEntry = cached ?? { at: 0, models: [] };
	cache.set(key, entry);
	entry.pending = (async () => {
	try {
		const version = sanitizeVersionToken(process.env.CODEX_AUTH_CLIENT_VERSION ?? "") || DEFAULT_CODEX_CLIENT_VERSION;
		const response = await fetch(`https://chatgpt.com/backend-api/codex/models?client_version=${version}`, {
			headers: createCodexHeaders(undefined, accountId, access),
			signal: AbortSignal.timeout(5_000),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const models = subscriptionModels(await response.json(), providerID);
		if (models.length === 0) throw new Error("Empty subscription model catalog");
		entry.models = models;
		entry.at = Date.now() + TTL;
		return structuredClone(models);
	} catch {
		entry.at = Date.now() + 30_000;
		entry.models = [];
		return [];
	}
	})();
	try { return structuredClone(await entry.pending); } finally { entry.pending = undefined; }
}
