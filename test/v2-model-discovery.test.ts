import { afterEach, describe, expect, it, vi } from "vitest";
const { loadAccounts } = vi.hoisted(() => ({ loadAccounts: vi.fn() }));
vi.mock("../lib/storage.js", () => ({ loadAccounts }));
import { discoverV2Models, subscriptionModels, discoverAccountModels } from "../lib/v2-model-discovery.js";
import { normalizeModel } from "../lib/request/request-transformer.js";

const entry = { slug: "gpt-6-sol", display_name: "Sol", visibility: "list",
	context_window: 272000, max_context_window: 872000,
	supported_reasoning_levels: [{ effort: "high" }], supported_in_api: false };

afterEach(() => vi.unstubAllGlobals());

describe("subscription model discovery", () => {
	it("never authorizes a request using stale metadata after failed refresh", async () => {
		vi.useFakeTimers();
		try {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ models: [entry] }))).mockRejectedValue(new Error("offline")));
			expect(await discoverAccountModels("openai", "stale-seat", "stale-token")).toHaveLength(2);
			vi.advanceTimersByTime(300001);
			expect(await discoverAccountModels("openai", "stale-seat", "stale-token")).toEqual([]);
		} finally { vi.useRealTimers(); }
	});
	it("does not leak discovered names into unrelated normalization", async () => {
		const before = normalizeModel("future-isolated");
		loadAccounts.mockResolvedValue({ activeIndex: 0, accounts: [{ expiresAt: Date.now() + 3600000, accessToken: "isolated", accountId: "isolated" }] });
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ ...entry, slug: "future-isolated" }] }))));
		await discoverV2Models("openai", vi.fn());
		expect(normalizeModel("future-isolated")).toBe(before);
	});
	it("coalesces parallel discovery and backs off failures", async () => {
		loadAccounts.mockResolvedValue({ activeIndex: 0, accounts: [{ expiresAt: Date.now() + 3600000, accessToken: "singleflight", accountId: "singleflight" }] });
		const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
		vi.stubGlobal("fetch", fetcher);
		await Promise.all([discoverV2Models("openai", vi.fn()), discoverV2Models("openai", vi.fn())]);
		await discoverV2Models("openai", vi.fn());
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("refreshes the enabled pool credential through the upstream resolver before discovery", async () => {
		const refresh = await import("../lib/storage/coordinated-refresh.js");
		const spy = vi.spyOn(refresh, "coordinatePersistedRefresh").mockResolvedValue({ type: "success", adopted: false, access: "renewed", refresh: "renewed-refresh", expires: Date.now() + 3600000 });
		loadAccounts.mockResolvedValue({ activeIndex: 0, accounts: [
			{ enabled: false, expiresAt: Date.now() + 3600000, accessToken: "disabled", refreshToken: "disabled", accountId: "disabled" },
			{ accessToken: "expired", refreshToken: "refresh", expiresAt: 0, accountId: "enabled-seat" },
		] });
		const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [entry] })));
		vi.stubGlobal("fetch", fetcher);
		await discoverV2Models("openai", async () => ({ type: "api", key: "fake" }));
		expect(spy).toHaveBeenCalled();
		expect((fetcher.mock.calls[0][1].headers as Headers).get("Authorization")).toBe("Bearer renewed");
		expect((fetcher.mock.calls[0][1].headers as Headers).get("ChatGPT-Account-ID")).toBe("enabled-seat");
		spy.mockRestore();
	});
	it("uses subscription windows and preserves the wire slug for long context", () => {
		const models = subscriptionModels({ models: [entry, { ...entry, slug: "hidden", visibility: "hide" }] }, "openai");
		expect(models).toHaveLength(2);
		expect(models[0]).toMatchObject({ id: "gpt-6-sol", limit: { context: 272000 }, variants: [{ id: "high" }] });
		expect(models[1]).toMatchObject({ id: "gpt-6-sol-long", modelID: "gpt-6-sol", limit: { context: 872000 } });
	});
	it("does not invent extended context when the account has no higher ceiling", () => {
		expect(subscriptionModels({ models: [{ ...entry, max_context_window: 272000 }] }, "openai")).toHaveLength(1);
		expect(subscriptionModels({ models: [{ ...entry, context_window: -1 }] }, "openai")).toEqual([]);
	});
	it("queries with the account credential, caches by credential, and discovers newly named models", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ ...entry, slug: "future-codex" }] })));
		vi.stubGlobal("fetch", fetcher);
		loadAccounts.mockResolvedValue({ activeIndex: 0, accounts: [{ expiresAt: Date.now() + 3600000, accessToken: "catalog-token-a", accountId: "account-a" }] });
		const auth = vi.fn();
		expect(await discoverV2Models("openai", auth)).toEqual(expect.arrayContaining([expect.objectContaining({ id: "future-codex" })]));
		await discoverV2Models("openai", auth);
		expect(fetcher).toHaveBeenCalledTimes(1);
		const headers = fetcher.mock.calls[0][1].headers as Headers;
		expect(headers.get("Authorization")).toBe("Bearer catalog-token-a");
		expect(headers.get("ChatGPT-Account-ID")).toBe("account-a");
		expect(auth).not.toHaveBeenCalled();
	});
	it("does not combine a disabled pool identity with a different host credential", async () => {
		loadAccounts.mockResolvedValue({ activeIndex: 0, accounts: [{ enabled: false, accountId: "disabled-seat", expiresAt: Date.now() + 3600000, accessToken: "disabled-token" }] });
		const access = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "host-seat" } })).toString("base64url")}.signature`;
		const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [entry] })));
		vi.stubGlobal("fetch", fetcher);
		await discoverV2Models("openai", async () => ({ type: "oauth", access, refresh: "fake-refresh", expires: 0 }));
		expect((fetcher.mock.calls[0][1].headers as Headers).get("ChatGPT-Account-ID")).toBe("host-seat");
	});
	it("does not offer speculative long windows after discovery fails", async () => {
		loadAccounts.mockResolvedValue({ activeIndex: 0, accounts: [{ expiresAt: Date.now() + 3600000, accessToken: "catalog-token-b", accountId: "account-b" }] });
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		const models = await discoverV2Models("openai", vi.fn());
		expect(models).toEqual([]);
	});
});
