import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Model, Provider, type Plugin } from "@opencode/plugin";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import type { AISDKHooks } from "@opencode/plugin/promise/aisdk";
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/promise/integration";
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";

const mocks = vi.hoisted(() => ({
	runtime: vi.fn(), loadAccounts: vi.fn(), refresh: vi.fn(), openBrowser: vi.fn(), interactive: vi.fn(),
	logWarn: vi.fn(),
}));
vi.mock("@ai-sdk/openai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ai-sdk/openai")>();
	return { ...actual, createOpenAI: vi.fn(actual.createOpenAI) };
});
vi.mock("../lib/auth/browser.js", () => ({ openBrowserUrl: mocks.openBrowser }));
vi.mock("../lib/storage.js", () => ({ loadAccounts: mocks.loadAccounts }));
vi.mock("../lib/storage/coordinated-refresh.js", () => ({ coordinatePersistedRefresh: mocks.refresh }));
vi.mock("../lib/opencode-v2-status.js", () => ({ readV2Status: vi.fn() }));
vi.mock("../lib/logger.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/logger.js")>()),
	logWarn: mocks.logWarn,
}));
import { createV2Fetch, missingV2SdkSurface, setupV2 } from "../lib/opencode-v2.js";
import { createStorageScope, getStoragePath, setStoragePathDirect, subscribeToStoragePathChanges } from "../lib/storage/state.js";

function host(directory = "/tmp/opencode/v2-test") {
	const methods: IntegrationOAuthMethodRegistration[] = [];
	const tools: ToolInfo[] = [];
	const hooks = new Map<string, (event: AISDKHooks["sdk"] | AISDKHooks["language"]) => Promise<void>>();
	// Every SDK registration returns a Registration; cleanup must dispose them all.
	const registrations: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
	const registered = () => {
		const registration = { dispose: vi.fn(async () => {}) };
		registrations.push(registration);
		return registration;
	};
	const model = Model.Info.default(Provider.ID.make("openai"), Model.ID.make("gpt-5.5"));
	const provider = Provider.Info.empty(Provider.ID.make("openai"));
	const editor = {
		update: (_id: string, update: (value: typeof provider) => void) => update(provider),
		get: () => ({ provider, models: new Map([[model.id, model]]) }),
		models: { set: vi.fn(), update: (_provider: string, _id: string, update: (value: typeof model) => void) => update(model) },
	};
	const context = {
		app: { version: "2.0.16" },
		location: { directory, project: { directory } },
		rpc: { register: vi.fn(async () => registered()) },
		integration: {
			connection: { active: vi.fn(), resolve: vi.fn() },
			transform: async (callback: (input: unknown) => void) => {
				callback({ method: { update: (value: IntegrationOAuthMethodRegistration) => methods.push(value) } });
				return registered();
			},
		},
		provider: { reload: vi.fn(), transform: vi.fn(async (callback: (input: unknown) => void) => { callback(editor); return registered(); }) },
		model: { transform: async (callback: (input: unknown) => void) => {
			callback({
				list: () => [model], update: (_provider: string, _id: string, update: (value: typeof model) => void) => update(model),
			});
			return registered();
		} },
		aisdk: { hook: vi.fn(async (name, callback) => { hooks.set(name, callback); return registered(); }) },
		tool: { transform: async (callback: (input: unknown) => void) => { callback({ add: (value: ToolInfo) => tools.push(value) }); return registered(); } },
		session: { hook: vi.fn(async () => registered()) },
		event: { subscribe: vi.fn(async function* () { /* empty public event stream */ }) },
	};
	return { context: context as unknown as Plugin.Context, methods, tools, hooks, model, provider, registrations, editor };
}

describe("V2 compatibility adapter", () => {
	const event = vi.fn();
	const callback = vi.fn();
	const transport = vi.fn(async () => new Response("ok"));
	const loader = vi.fn(async (getAuth: () => Promise<unknown>) => {
		await getAuth();
		return { apiKey: "placeholder", fetch: transport };
	});
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.loadAccounts.mockResolvedValue({ activeIndex: 0, accounts: [{ refreshToken: "test-refresh", accessToken: "test-access", expiresAt: Date.now() + 3600000 }] });
		callback.mockResolvedValue({ type: "success", access: "new-access", refresh: "new-refresh", expires: 456 });
		mocks.runtime.mockResolvedValue({ event, auth: { loader, methods: [
			{ type: "oauth", label: "Interactive setup", authorize: mocks.interactive },
			{ type: "oauth", label: "Codex OAuth (Open URL Manually)", authorize: async () => ({ url: "https://example.com", instructions: "Sign in", method: "auto", callback }) },
			{ type: "oauth", label: "Manual", authorize: async () => ({ url: "https://example.com", instructions: "Paste code", method: "code", callback }) },
		] }, tool: {
			"codex-test": { description: "Example", args: { value: z.number().default(2) }, execute: async (input: { value: number }) => String(input.value) },
			"codex-meta": { description: "Meta", args: {}, execute: async () => ({ output: "done", metadata: { source: "test" } }) },
		} });
	});
	afterEach(() => vi.restoreAllMocks());

	// The surface probe warn-logs once per process, so this case has to be the
	// first setupV2 call in the file — the module-level flag is consumed by it.
	it("warn-logs once when the connected SDK surface misses expected members", async () => {
		const h = host();
		const context = { ...h.context, rpc: undefined } as unknown as Plugin.Context;
		// The probe warns first; setup still fails later when the missing member is called.
		await expect(setupV2(context, mocks.runtime)).rejects.toThrow();
		expect(mocks.logWarn).toHaveBeenCalledTimes(1);
		expect(mocks.logWarn.mock.calls[0]?.[0]).toContain("@opencode/plugin");
		expect(mocks.logWarn.mock.calls[0]?.[1]).toMatchObject({ missing: "rpc.register" });
		const second = host();
		const broken = { ...second.context, tool: undefined } as unknown as Plugin.Context;
		await expect(setupV2(broken, mocks.runtime)).rejects.toThrow();
		expect(mocks.logWarn).toHaveBeenCalledTimes(1);
	});

	it("names the SDK members the adapter expects but the host lacks", () => {
		const h = host();
		expect(missingV2SdkSurface(h.context)).toEqual([]);
		const withoutTool = { ...h.context, tool: { transform: "nope" } } as unknown as Plugin.Context;
		expect(missingV2SdkSurface(withoutTool)).toEqual(["tool.transform"]);
		const withoutNested = { ...h.context, integration: { ...h.context.integration, connection: {} } } as unknown as Plugin.Context;
		expect(missingV2SdkSurface(withoutNested)).toEqual([
			"integration.connection.active",
			"integration.connection.resolve",
		]);
		const withoutConnection = { ...h.context, integration: { ...h.context.integration, connection: undefined } } as unknown as Plugin.Context;
		expect(missingV2SdkSurface(withoutConnection)).toEqual([
			"integration.connection.active",
			"integration.connection.resolve",
			"integration.connection",
		]);
		// An intermediate member that is a *callable* namespace (a function
		// carrying properties, e.g. `event` with `event.subscribe`) must still
		// be walked — it is not "missing" merely for being a function.
		const callableIntegration = {
			...h.context,
			integration: Object.assign(() => undefined, h.context.integration),
		} as unknown as Plugin.Context;
		expect(missingV2SdkSurface(callableIntegration)).toEqual([]);
		const callableEvent = {
			...h.context,
			event: Object.assign(() => undefined, h.context.event),
		} as unknown as Plugin.Context;
		expect(missingV2SdkSurface(callableEvent)).toEqual([]);
	});

	it("uses a distinct provider package so V2 cannot rewrite the transport to native OpenAI", async () => {
		const h = host();
		const cleanup = await setupV2(h.context, mocks.runtime);
		expect(h.provider.package).toMatch(/^aisdk:file:.*opencode-v2-provider\.(ts|js)$/);
		expect(h.model.package).toBe(h.provider.package);
		const sdkEvent: AISDKHooks["sdk"] = { model: h.model, package: h.provider.package, options: {} };
		await h.hooks.get("sdk")?.(sdkEvent);
		expect(sdkEvent.sdk).toBeDefined();
		expect(loader).toHaveBeenCalled();
		expect(h.context.aisdk.hook).toHaveBeenCalledWith("sdk", expect.any(Function), { providerID: "openai" });
		await cleanup();
		expect(event).toHaveBeenCalledWith(expect.objectContaining({ event: expect.objectContaining({ type: "server.instance.disposed" }) }));
	});

	it("carries native wire identity and long context into the shared transport only for that request", async () => {
		const { getV2ModelRequest } = await import("../lib/v2-request-scope.js");
		const { normalizeModel } = await import("../lib/request/request-transformer.js");
		const h = host();
		h.model.modelID = Model.ID.make("future-native");
		h.model.limit = { context: 872000, output: 128000 };
		const cleanup = await setupV2(h.context, mocks.runtime);
		const sdkEvent: AISDKHooks["sdk"] = { model: h.model, package: h.provider.package, options: {} };
		const stop = new Error("wire captured");
		transport.mockImplementationOnce(async () => {
			expect(getV2ModelRequest()).toMatchObject({ model: "future-native", context: 872000 });
			expect(normalizeModel("future-native")).toBe("future-native");
			throw stop;
		});
		await h.hooks.get("sdk")?.(sdkEvent);
		const language: AISDKHooks["language"] = { model: h.model, sdk: sdkEvent.sdk!, options: {} };
		await h.hooks.get("language")?.(language);
		await expect(language.language!.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "mock" }] }] })).rejects.toThrow("wire captured");
		expect(getV2ModelRequest()).toBeUndefined();
		await cleanup();
	});

	it("scopes each language model when the official host reuses one SDK across selections", async () => {
		const { getV2ModelRequest } = await import("../lib/v2-request-scope.js");
		const h = host();
		h.model.limit.context = 872000;
		const cleanup = await setupV2(h.context, mocks.runtime);
		const sdkEvent: AISDKHooks["sdk"] = { model: h.model, package: h.provider.package, options: {} };
		await h.hooks.get("sdk")?.(sdkEvent);
		const b = { ...h.model, id: Model.ID.make("b-selected"), modelID: Model.ID.make("future-b"), limit: { context: 128000, output: 1000 } };
		const language: AISDKHooks["language"] = { model: b, sdk: sdkEvent.sdk!, options: {} };
		await h.hooks.get("language")?.(language);
		transport.mockImplementationOnce(async () => {
			expect(getV2ModelRequest()).toMatchObject({ model: "future-b", context: 128000 });
			throw new Error("B selected");
		});
		await expect(language.language!.doGenerate({ prompt: [] })).rejects.toThrow("B selected");
		await cleanup();
	});

	it("merges new discovery IDs without losing existing explicit overrides", async () => {
		const discovery = await import("../lib/v2-model-discovery.js");
		const catalog = vi.spyOn(discovery, "discoverV2Models").mockResolvedValue([
			{ ...Model.Info.default(Provider.ID.make("openai"), Model.ID.make("future-new")), modelID: "future-new", limit: { context: 872000, output: 128000 } },
			{ ...Model.Info.default(Provider.ID.make("openai"), Model.ID.make("gpt-5.5")), limit: { context: 872000, output: 128000 } },
		]);
		const h = host();
		h.model.name = Model.ID.make("My explicit override");
		const cleanup = await setupV2(h.context, mocks.runtime);
		const merged = h.editor.models.set.mock.calls[0]![1] as typeof h.model[];
		expect(merged.find((model) => model.id === h.model.id)).toMatchObject({ name: "My explicit override", limit: h.model.limit });
		expect(merged.find((model) => model.id === "future-new")).toMatchObject({ modelID: "future-new", limit: { context: 872000 } });
		expect(merged.find((model) => model.id === "gpt-5.5-subscription")).toMatchObject({ modelID: "gpt-5.5", limit: { context: 872000 } });
		expect(catalog).toHaveBeenCalledTimes(1);
		await cleanup();
	});

	it("publishes candidate B's narrower catalog before a failed request, preserving host overrides", async () => {
		const { getV2ModelRequest } = await import("../lib/v2-request-scope.js");
		const discovery = await import("../lib/v2-model-discovery.js");
		const make = (id: string, context: number) => ({ ...Model.Info.default(Provider.ID.make("openai"), Model.ID.make(id)), limit: { context, output: 1000 } });
		vi.spyOn(discovery, "discoverV2Models").mockResolvedValue([make("a-only", 872000), make("shared", 872000)]);
		const h = host();
		h.model.name = "Custom, not subscription-confirmed";
		const cleanup = await setupV2(h.context, mocks.runtime);
		// Native State.reload re-folds transforms against the host/config baseline.
		vi.mocked(h.context.provider.reload).mockImplementation(async () => {
			await vi.mocked(h.context.provider.transform).mock.calls[0]![0](h.editor as never);
		});
		transport.mockImplementationOnce(async () => {
			await getV2ModelRequest()?.onAccountSelected?.({ index: 1, models: Promise.resolve([make("b-only", 128000), make("shared", 128000)]) });
			return new Response(JSON.stringify({ error: { message: "Candidate account #2 cannot serve original context" } }), { status: 503 });
		});
		const sdkEvent: AISDKHooks["sdk"] = { model: h.model, package: h.provider.package, options: {} };
		await h.hooks.get("sdk")?.(sdkEvent);
		const language: AISDKHooks["language"] = { model: h.model, sdk: sdkEvent.sdk!, options: {} };
		await h.hooks.get("language")?.(language);
		await expect(language.language!.doGenerate({ prompt: [] })).rejects.toThrow("Candidate account #2");
		expect(h.context.provider.reload).toHaveBeenCalledTimes(1);
		const models = h.editor.models.set.mock.calls.at(-1)![1] as typeof h.model[];
		expect(models.map((model) => model.id)).toEqual(["gpt-5.5", "b-only", "shared"]);
		expect(models.find((model) => model.id === "shared")?.limit.context).toBe(128000);
		expect(models[0]?.name).toBe("Custom, not subscription-confirmed");
		await cleanup();
	});
	it("reloads only when the candidate model catalog changes", async () => {
		const { getV2ModelRequest } = await import("../lib/v2-request-scope.js");
		const discovery = await import("../lib/v2-model-discovery.js");
		const catalog = [{ ...Model.Info.default(Provider.ID.make("openai"), Model.ID.make("FAKE_MODEL")) }];
		vi.spyOn(discovery, "discoverV2Models").mockResolvedValue(catalog);
		const h = host();
		const cleanup = await setupV2(h.context, mocks.runtime);
		try {
			let notify: NonNullable<ReturnType<typeof getV2ModelRequest>>["onAccountSelected"];
			transport.mockImplementationOnce(async () => { notify = getV2ModelRequest()?.onAccountSelected; throw new Error("capture"); });
			const sdkEvent: AISDKHooks["sdk"] = { model: h.model, package: h.provider.package, options: {} };
			await h.hooks.get("sdk")?.(sdkEvent);
			const language: AISDKHooks["language"] = { model: h.model, sdk: sdkEvent.sdk!, options: {} };
			await h.hooks.get("language")?.(language);
			await expect(language.language!.doGenerate({ prompt: [] })).rejects.toThrow("capture");
			await notify!({ index: 0, models: Promise.resolve(structuredClone(catalog)) });
			expect(h.context.provider.reload).not.toHaveBeenCalled();
			const changed = structuredClone(catalog);
			changed[0].limit.context += 1000;
			await notify!({ index: 0, models: Promise.resolve(changed) });
			await notify!({ index: 1, models: Promise.resolve(structuredClone(changed)) });
			expect(h.context.provider.reload).toHaveBeenCalledOnce();
			const retryCatalog = structuredClone(changed);
			retryCatalog[0].limit.context += 1000;
			h.context.provider.reload.mockRejectedValueOnce(new Error("reload failed"));
			await expect(notify!({ index: 1, models: Promise.resolve(retryCatalog) })).rejects.toThrow("reload failed");
			await notify!({ index: 1, models: Promise.resolve(structuredClone(retryCatalog)) });
			expect(h.context.provider.reload).toHaveBeenCalledTimes(3);
			const concurrentCatalog = structuredClone(retryCatalog);
			concurrentCatalog[0].limit.context += 1000;
			let rejectReload!: (error: Error) => void;
			h.context.provider.reload.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectReload = reject; }));
			const pending = notify!({ index: 0, models: Promise.resolve(concurrentCatalog) });
			const failed = expect(pending).rejects.toThrow("concurrent reload failed");
			await vi.waitFor(() => expect(h.context.provider.reload).toHaveBeenCalledTimes(4));
			await notify!({ index: 1, models: Promise.resolve(structuredClone(concurrentCatalog)) });
			rejectReload(new Error("concurrent reload failed"));
			await failed;
			await notify!({ index: 1, models: Promise.resolve(structuredClone(concurrentCatalog)) });
			expect(h.context.provider.reload).toHaveBeenCalledTimes(5);
		} finally { await cleanup(); }
	});

	it("isolates candidate refreshes by project and ignores late discoveries and disposed callbacks", async () => {
		const { getV2ModelRequest } = await import("../lib/v2-request-scope.js");
		const first = host();
		const second = host("/tmp/opencode/other-project");
		const cleanupFirst = await setupV2(first.context, mocks.runtime);
		const cleanupSecond = await setupV2(second.context, mocks.runtime);
		const capture = async (h: ReturnType<typeof host>) => {
			let callback: NonNullable<ReturnType<typeof getV2ModelRequest>>["onAccountSelected"];
			transport.mockImplementationOnce(async () => {
				callback = getV2ModelRequest()?.onAccountSelected;
				throw new Error("capture");
			});
			const event: AISDKHooks["sdk"] = { model: h.model, package: h.provider.package, options: {} };
			await h.hooks.get("sdk")?.(event);
			const language: AISDKHooks["language"] = { model: h.model, sdk: event.sdk!, options: {} };
			await h.hooks.get("language")?.(language);
			await expect(language.language!.doGenerate({ prompt: [] })).rejects.toThrow("capture");
			return callback!;
		};
		const notifyFirst = await capture(first);
		const notifySecond = await capture(second);
		const make = (id: string) => ({ ...Model.Info.default(Provider.ID.make("openai"), Model.ID.make(id)) });
		let finishOld!: (models: Record<string, unknown>[]) => void;
		const old = notifyFirst({ index: 0, models: new Promise((resolve) => { finishOld = resolve; }) });
		await notifyFirst({ index: 1, models: Promise.resolve([make("new-b")]) });
		await notifySecond({ index: 2, models: Promise.resolve([make("other-project")]) });
		finishOld([make("stale-a")]);
		await old;
		for (const [h, expected] of [[first, "new-b"], [second, "other-project"]] as const) {
			h.editor.models.set.mockClear();
			await vi.mocked(h.context.provider.transform).mock.calls[0]![0](h.editor as never);
			expect((h.editor.models.set.mock.calls.at(-1)![1] as typeof h.model[]).map((model) => model.id)).toEqual(["gpt-5.5", expected]);
			expect(h.context.provider.reload).toHaveBeenCalledTimes(1);
		}
		await cleanupFirst();
		await notifyFirst({ index: 2, models: Promise.resolve([make("disposed")]) });
		expect(first.context.provider.reload).toHaveBeenCalledTimes(1);
		await cleanupSecond();
	});

	it("does not let an older credential refresh disable a newer selected account", async () => {
		const { getV2ModelRequest } = await import("../lib/v2-request-scope.js");
		const h = host();
		let begin!: () => void;
		const trigger = new Promise<void>((resolve) => { begin = resolve; });
		vi.mocked(h.context.event.subscribe).mockImplementation(async function* () {
			await trigger;
			yield { type: "credential.updated" } as never;
		});
		const cleanup = await setupV2(h.context, mocks.runtime);
		const event: AISDKHooks["sdk"] = { model: h.model, package: h.provider.package, options: {} };
		await h.hooks.get("sdk")?.(event);
		const language: AISDKHooks["language"] = { model: h.model, sdk: event.sdk!, options: {} };
		await h.hooks.get("language")?.(language);
		let notify: NonNullable<ReturnType<typeof getV2ModelRequest>>["onAccountSelected"];
		transport.mockImplementationOnce(async () => { notify = getV2ModelRequest()?.onAccountSelected; throw new Error("capture"); });
		await expect(language.language!.doGenerate({ prompt: [] })).rejects.toThrow("capture");
		let finish!: (value: null) => void;
		mocks.loadAccounts.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
		begin();
		await vi.waitFor(() => expect(finish).toBeDefined());
		await notify!({ index: 1, models: Promise.resolve([{ ...h.model, id: "new-b" }]) });
		finish(null);
		await vi.waitFor(() => expect(h.context.integration.connection.active).toHaveBeenCalled());
		const next: AISDKHooks["language"] = { model: h.model, sdk: event.sdk!, options: {} };
		await h.hooks.get("language")?.(next);
		expect(next.language).toBeDefined();
		await cleanup();
	});

	it("clears generated catalog when credential lifecycle refresh fails without removing host entries", async () => {
		const discovery = await import("../lib/v2-model-discovery.js");
		const catalog = vi.spyOn(discovery, "discoverV2Models")
			.mockResolvedValueOnce([{ ...Model.Info.default(Provider.ID.make("openai"), Model.ID.make("future-retained")) }])
			.mockResolvedValue([]);
		const h = host();
		vi.mocked(h.context.event.subscribe).mockImplementation(async function* () {
			yield { type: "credential.updated" } as never;
		});
		const cleanup = await setupV2(h.context, mocks.runtime);
		await vi.waitFor(() => expect(catalog).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(h.context.provider.reload).toHaveBeenCalledTimes(1));
		h.editor.models.set.mockClear();
		const transform = vi.mocked(h.context.provider.transform).mock.calls[0]![0];
		await transform(h.editor as never);
		expect(h.editor.models.set).not.toHaveBeenCalled();
		expect([...h.editor.get().models.keys()]).toEqual(["gpt-5.5"]);
		await cleanup();
	});

	it("leaves API-key-only OpenAI routing alone", async () => {
		mocks.loadAccounts.mockResolvedValue(null);
		const h = host();
		const original = h.provider.package;
		const cleanup = await setupV2(h.context, mocks.runtime);
		expect(h.provider.package).toBe(original);
		await h.hooks.get("sdk")?.({ model: h.model, package: original, options: {} });
		expect(loader).not.toHaveBeenCalled();
		await cleanup();
	});

	it.each(["doGenerate", "doStream"] as const)("preserves multi-turn history before %s serialization", async (method) => {
		const h = host();
		const cleanup = await setupV2(h.context, mocks.runtime);
		const captured: Record<string, unknown>[] = [];
		const stop = new Error("captured request");
		const sdk = createOpenAI({
			apiKey: "test-key",
			fetch: async (_input, init) => {
				captured.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
				throw stop;
			},
		});
		const languageEvent: AISDKHooks["language"] = { model: h.model, sdk };
		await h.hooks.get("language")?.(languageEvent);
		const options: Parameters<ReturnType<typeof sdk.responses>["doGenerate"]>[0] = {
			providerOptions: { openai: { store: true, previousResponseId: "resp_old", conversation: "conv_old", parallelToolCalls: false } },
			prompt: [
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{ role: "assistant", content: [
					{ type: "text", text: "Hello!", providerOptions: { openai: { itemId: "msg_previous" } } },
					{ type: "reasoning", text: "", providerOptions: { openai: { itemId: "rs_previous", reasoningEncryptedContent: "encrypted-history" } } },
					{ type: "tool-call", toolCallId: "call_limits", toolName: "codex_limits", input: "{}" },
				] },
				{ role: "tool", content: [{ type: "tool-result", toolCallId: "call_limits", toolName: "codex_limits", output: { type: "text", value: "Quota available" } }] },
				{ role: "user", content: [{ type: "text", text: "what are my limits?" }] },
			],
		};
		try {
			await expect(languageEvent.language![method](options)).rejects.toThrow("captured request");
			expect(captured).toHaveLength(1);
			const body = captured[0]!;
			expect(body).toMatchObject({ store: false, parallel_tool_calls: false });
			expect(body).not.toHaveProperty("previous_response_id");
			expect(body).not.toHaveProperty("conversation");
			expect(body.input).toEqual(expect.arrayContaining([
				expect.objectContaining({ role: "assistant", content: [{ type: "output_text", text: "Hello!" }] }),
				expect.objectContaining({ type: "reasoning", encrypted_content: "encrypted-history" }),
				expect.objectContaining({ type: "function_call", call_id: "call_limits" }),
				expect.objectContaining({ type: "function_call_output", call_id: "call_limits", output: "Quota available" }),
			]));
			expect(body.input).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "item_reference" })]));
			expect(options.providerOptions?.openai?.store).toBe(true);
		} finally {
			await cleanup();
		}
	});

	it("adapts automatic and pasted-code OAuth without invoking terminal-interactive setup", async () => {
		const h = host();
		const cleanup = await setupV2(h.context, mocks.runtime);
		expect(h.methods.map((method) => method.method.label)).toEqual([
			"Codex OAuth (Add account — ChatGPT Plus/Pro)", "Codex OAuth (Open URL Manually)", "Manual",
		]);
		const browser = await h.methods[0]!.authorize({});
		expect(browser.mode).toBe("auto");
		expect(await browser.callback).toMatchObject({ type: "oauth", methodID: "codex-multi-0", refresh: "new-refresh" });
		expect(browser.instructions).toContain("Repeat opencode auth login");
		expect(mocks.openBrowser).toHaveBeenCalledWith("https://example.com");
		expect(mocks.interactive).not.toHaveBeenCalled();
		mocks.openBrowser.mockClear();
		const link = await h.methods[1]!.authorize({});
		await link.callback;
		expect(mocks.openBrowser).not.toHaveBeenCalled();
		const manual = await h.methods[2]!.authorize({});
		if (manual.mode !== "code") throw new Error("Expected code mode");
		await manual.callback("callback-code");
		expect(callback).toHaveBeenCalledWith("callback-code");
		callback.mockResolvedValue({ type: "failed" });
		await expect(manual.callback("invalid")).rejects.toThrow("sign-in failed");
		await cleanup();
	});

	it("pins host refresh to the original seat after the pool rotates its token", async () => {
		const h = host();
		const cleanup = await setupV2(h.context, mocks.runtime);
		const access = `header.${Buffer.from(JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "workspace", chatgpt_account_user_id: "member-b" },
		})).toString("base64url")}.signature`;
		mocks.loadAccounts.mockResolvedValue({ activeIndex: 0, accounts: [
			{ organizationId: "org", accountId: "workspace", accountUserId: "member-a", refreshToken: "rotated-a" },
			{ organizationId: "org", accountId: "workspace", accountUserId: "member-b", refreshToken: "rotated-b" },
		] });
		mocks.refresh.mockResolvedValue({ type: "success", access: "updated", refresh: "rotated-b", expires: 456 });
		const refreshed = await h.methods[0]!.refresh({ type: "oauth", methodID: "codex-multi-0", access, refresh: "old-b", expires: 0 });
		expect(mocks.refresh).toHaveBeenCalledWith({
			refreshToken: "old-b", organizationId: "org", accountId: "workspace", accountUserId: "member-b",
		});
		expect(refreshed).toMatchObject({ access: "updated", refresh: "rotated-b" });
		await cleanup();
	});

	it("chooses the access-token seat when several accounts share a refresh token", async () => {
		const h = host();
		const cleanup = await setupV2(h.context, mocks.runtime);
		const access = `header.${Buffer.from(JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "workspace", chatgpt_account_user_id: "member-b" },
		})).toString("base64url")}.signature`;
		mocks.loadAccounts.mockResolvedValue({ activeIndex: 0, accounts: [
			{ organizationId: "org", accountId: "workspace", accountUserId: "member-a", refreshToken: "shared" },
			{ organizationId: "org", accountId: "workspace", accountUserId: "member-b", refreshToken: "shared" },
		] });
		mocks.refresh.mockResolvedValue({ type: "success", access: "updated", refresh: "rotated", expires: 456 });
		const credential = { type: "oauth" as const, methodID: "codex-multi-0", access, refresh: "shared", expires: 0 };
		await h.methods[0]!.refresh(credential);
		expect(mocks.refresh).toHaveBeenCalledWith({
			refreshToken: "shared", organizationId: "org", accountId: "workspace", accountUserId: "member-b",
		});
		mocks.refresh.mockClear();
		await expect(h.methods[0]!.refresh({ ...credential, access: "unidentifiable" })).rejects.toThrow("ambiguous");
		expect(mocks.refresh).not.toHaveBeenCalled();
		await cleanup();
	});

	it("retains the provider catalog when subscription discovery is unavailable", async () => {
		const h = host();
		const cleanup = await setupV2(h.context, mocks.runtime);
		expect(h.editor.models.set).not.toHaveBeenCalled();
		await cleanup();
	});
	it("does not hand disabled pool credentials to the runtime loader", async () => {
		mocks.loadAccounts.mockResolvedValue({ activeIndex: 0, accounts: [
			{ enabled: false, refreshToken: "disabled", accessToken: "disabled" },
			{ refreshToken: "enabled", accessToken: "enabled", expiresAt: Date.now() + 3600000 },
		] });
		const h = host();
		const cleanup = await setupV2(h.context, mocks.runtime);
		await h.hooks.get("sdk")?.({ model: h.model, package: h.provider.package, options: {} });
		const getAuth = loader.mock.calls.at(-1)![0];
		expect(await getAuth()).toMatchObject({ refresh: "enabled" });
		await cleanup();
	});
	it("registers native context and bounded retry recovery", async () => {
		const h = host();
		const cleanup = await setupV2(h.context, mocks.runtime);
		expect(h.context.session.hook).toHaveBeenCalledWith("retry", expect.any(Function), { providerID: "openai" });
		expect(h.context.session.hook).toHaveBeenCalledWith("context", expect.any(Function), { providerID: "openai" });
		await cleanup();
	});
	it("requires native approval before destructive execution, even with confirm=true", async () => {
		const execute = vi.fn(async () => "removed");
		mocks.runtime.mockResolvedValue({ event, auth: { loader, methods: [] }, tool: {
			"codex-remove": { description: "Remove", args: { confirm: z.boolean(), index: z.number() }, execute },
		} });
		const h = host();
		const cleanup = await setupV2(h.context, mocks.runtime);
		try {
			const call = { sessionID: "s", messageID: "m", id: "c", signal: new AbortController().signal, progress: vi.fn() } as unknown as Parameters<ToolInfo["execute"]>[1];
			await expect(h.tools[0]!.execute({ confirm: true, index: 1 }, call)).rejects.toThrow(/confirmation|Permission/);
			expect(execute).not.toHaveBeenCalled();
		} finally { await cleanup(); }
	});

	it("registers every runtime tool and retains validation, defaults, and metadata", async () => {
		const h = host();
		const cleanup = await setupV2(h.context, mocks.runtime);
		// The registry registration is the bridge's whole contract: every
		// runtime tool lands, none silently dropped.
		expect(h.tools.map((tool) => tool.name)).toEqual(["codex-test", "codex-meta"]);
		const tool = h.tools[0]!;
		expect(tool.input).toMatchObject({ type: "object" });
		const call = { signal: new AbortController().signal, progress: vi.fn() } as unknown as Parameters<typeof tool.execute>[1];
		await expect(tool.execute({}, call)).resolves.toEqual({ content: "2" });
		// Omitted input parses as {} so optional/defaulted args still apply.
		await expect(tool.execute(undefined, call)).resolves.toEqual({ content: "2" });
		await expect(tool.execute({ value: "wrong" }, call)).rejects.toThrow();
		// Structured results forward output as content and keep metadata.
		const meta = h.tools[1]!;
		await expect(meta.execute({}, call)).resolves.toEqual({ content: "done", metadata: { source: "test" } });
		await cleanup();
	});

	it("does not let an in-flight credential-event reload outlive teardown", async () => {
		const h = host();
		// The credential event fires once, then the stream idles — the consumer
		// is then parked inside reload() while cleanup aborts the subscription.
		(h.context as { event: unknown }).event = {
			subscribe: vi.fn(async function* ({ signal }: { signal: AbortSignal }) {
				yield { type: "credential.updated", location: h.context.location };
				if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			}),
		};
		let releasePool: (value: unknown) => void = () => {};
		const poolGate = new Promise((resolve) => { releasePool = resolve; });
		mocks.loadAccounts
			// setup's own hasOAuth() probe resolves normally…
			.mockResolvedValueOnce({ activeIndex: 0, accounts: [{ refreshToken: "seed", accessToken: "seed-access", expiresAt: Date.now() + 3600000 }] })
			.mockResolvedValueOnce({ activeIndex: 0, accounts: [{ refreshToken: "seed", accessToken: "seed-access", expiresAt: Date.now() + 3600000 }] })
			// …but the credential-event reload parks inside hasOAuth() until the
			// test releases it — i.e. teardown lands mid-reload.
			.mockImplementationOnce(() => poolGate);
		const cleanup = await setupV2(h.context, mocks.runtime);
		await vi.waitFor(() =>
			expect(mocks.loadAccounts.mock.calls.length).toBeGreaterThanOrEqual(3),
		);
		const teardown = cleanup();
		releasePool({ activeIndex: 0, accounts: [{ refreshToken: "fresh" }] });
		await teardown;
		// Abort landed before provider.reload(): the in-flight handler must be
		// awaited and must not reload the provider post-teardown.
		expect(h.context.provider.reload).not.toHaveBeenCalled();
	});

	it("hands the V1 loader a real model-keyed provider record", async () => {
		const h = host();
		const cleanup = await setupV2(h.context, mocks.runtime);
		const sdkEvent: AISDKHooks["sdk"] = {
			model: h.model,
			package: h.provider.package,
			options: { reasoningEffort: "high" },
		};
		await h.hooks.get("sdk")?.(sdkEvent);
		const provider = loader.mock.calls.at(-1)?.[1] as {
			options: Record<string, unknown>;
			models: Record<string, { id: string; name: string; status: string; options: object; variants: object }>;
		};
		// models:{} used to reach the loader — per-model config and prewarm
		// silently degraded. The record now mirrors the host's model inventory.
		expect(provider.options).toEqual({ reasoningEffort: "high" });
		expect(provider.models["gpt-5.5"]).toMatchObject({
			id: "gpt-5.5",
			name: "gpt-5.5",
			status: "active",
			options: {},
			variants: {},
			api: { id: "gpt-5.5", npm: "@ai-sdk/openai" },
		});
		await cleanup();
	});

	it("forwards provider options the host resolved into the OpenAI SDK factory", async () => {
		const h = host();
		const cleanup = await setupV2(h.context, mocks.runtime);
		await h.hooks.get("sdk")?.({
			model: { ...h.model, headers: { "x-model": "yes" } },
			package: h.provider.package,
			options: {
				organization: "org-1",
				project: "proj-1",
				name: "custom-openai",
				headers: { "x-provider": "yes", "x-model": "provider-wins-not" },
				ignored: 42,
			},
		});
		expect(createOpenAI).toHaveBeenCalledWith(expect.objectContaining({
			apiKey: "placeholder",
			organization: "org-1",
			project: "proj-1",
			name: "custom-openai",
			// Model headers override provider-level headers on the same key.
			headers: { "x-provider": "yes", "x-model": "yes" },
			fetch: expect.any(Function),
		}));
		await cleanup();
	});

	it("disposes every SDK registration on unload", async () => {
		const h = host();
		const cleanup = await setupV2(h.context, mocks.runtime);
		expect(h.registrations.length).toBeGreaterThanOrEqual(7);
		await cleanup();
		for (const registration of h.registrations) {
			expect(registration.dispose).toHaveBeenCalledTimes(1);
		}
	});

	it("sends the generated user-agent on non-POST requests too", async () => {
		const fetcher = vi.fn(async (_input: Request | string | URL, _init?: RequestInit) => new Response("ok"));
		await createV2Fetch(fetcher, "2.0.16")("https://example.com/models", {
			method: "GET", headers: { "x-test": "preserved" },
		});
		const input = fetcher.mock.calls[0]![0];
		expect(input).toBeInstanceOf(Request);
		const headers = new Headers((input as Request).headers);
		expect(headers.get("user-agent")).toBe("opencode/2.0.16");
		expect(headers.get("x-test")).toBe("preserved");
	});

	it.each([
		"{broken json",
		"42",
		'["an", "array"]',
		"plain text body",
	] as const)("passes a non-object POST body through untouched (%s)", async (raw) => {
		const fetcher = vi.fn(async (_input: Request | string | URL, _init?: RequestInit) => new Response("ok"));
		await createV2Fetch(fetcher, "2.0.16")("https://example.com/responses", { method: "POST", body: raw });
		const input = fetcher.mock.calls[0]![0];
		expect(input).toBeInstanceOf(Request);
		expect(await (input as Request).text()).toBe(raw);
		expect(new Headers((input as Request).headers).get("user-agent")).toBe("opencode/2.0.16");
	});

	it("enforces stateless wire defaults and preserves headers and cancellation", async () => {
		const abort = new AbortController();
		const fetcher = vi.fn(async (_input: Request | string | URL, _init?: RequestInit) => new Response("ok"));
		await createV2Fetch(fetcher, "2.0.16")("https://example.com/responses", {
			method: "POST", headers: { "x-test": "preserved" }, signal: abort.signal,
			body: JSON.stringify({ model: "gpt-5.5", store: true, include: ["other"] }),
		});
		const init = fetcher.mock.calls[0]![1]!;
		expect(JSON.parse(String(init.body))).toMatchObject({ store: false, include: ["other", "reasoning.encrypted_content"] });
		expect(new Headers(init.headers).get("x-test")).toBe("preserved");
		expect(new Headers(init.headers).get("user-agent")).toBe("opencode/2.0.16");
		abort.abort();
		expect(init.signal?.aborted).toBe(true);
	});
});

it("isolates simultaneous V2 location storage and path listeners", async () => {
	const first = createStorageScope();
	const second = createStorageScope();
	const listener = vi.fn();
	const previous = getStoragePath();
	await Promise.all([
		first(async () => {
			setStoragePathDirect("/tmp/opencode/first.json");
			subscribeToStoragePathChanges(listener);
			await Promise.resolve();
			expect(getStoragePath()).toBe("/tmp/opencode/first.json");
		}),
		second(async () => {
			setStoragePathDirect("/tmp/opencode/second.json");
			await Promise.resolve();
			expect(getStoragePath()).toBe("/tmp/opencode/second.json");
		}),
	]);
	expect(listener).not.toHaveBeenCalled();
	expect(getStoragePath()).toBe(previous);
});
