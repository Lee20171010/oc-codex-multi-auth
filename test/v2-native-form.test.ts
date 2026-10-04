import { afterEach, describe, expect, it, vi } from "vitest";
import { createV2NativeForms } from "../lib/v2-native-form.js";

const input = { permission: "test", patterns: ["No changes"], always: [], metadata: {} };
const context = { sessionID: "ses_test", agent: "build", messageID: "m", id: "c", progress: vi.fn() };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("native confirmation forms", () => {
	it.each(["allow", "deny", "cancelled"])("requires an explicit answer (%s)", async (answer) => {
		const fetch = vi.fn(async (_url, options) => {
			if (options.method === "POST") return Response.json({ data: { id: JSON.parse(options.body).id } });
			return Response.json({ data: { state: answer === "cancelled" ? { status: "cancelled" } : { status: "answered", answer: { decision: answer } } } });
		});
		vi.stubGlobal("fetch", fetch);
		const forms = createV2NativeForms(async () => ({ url: "http://127.0.0.1", password: "test-only" }));
		try {
			if (answer === "allow") await expect(forms.ask(input, context)).resolves.toBe(true);
			else await expect(forms.ask(input, context)).rejects.toThrow(/denied|cancelled/);
			const body = JSON.parse(fetch.mock.calls[0][1].body);
			// OpenCode 2.0.18's session request dock selects only question/websearch forms.
			expect(body.metadata).toMatchObject({ kind: "question", tool: { messageID: context.messageID, id: context.id } });
			expect(body.fields[0]).toMatchObject({ default: "deny", required: true, description: "Allow test?\nNo changes" });
			expect(fetch.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(1);
		} finally { await forms.dispose(); }
	});
	it("cancels its known form after an ambiguous POST and never falls back to a second prompt", async () => {
		const fetch = vi.fn(async (_url, options) => {
			if (options.method === "POST") throw new Error("Connection lost after request delivery");
			return new Response(null, { status: 204 });
		});
		vi.stubGlobal("fetch", fetch);
		const forms = createV2NativeForms(async () => ({ url: "http://127.0.0.1", password: "test-only" }));
		await expect(forms.ask(input, context)).rejects.toThrow("Connection lost");
		const id = JSON.parse(fetch.mock.calls[0][1].body).id;
		expect(fetch.mock.calls[1][0]).toContain(`/${id}`);
		expect(fetch.mock.calls[1][1].method).toBe("DELETE");
		await forms.dispose();
	});
	it("cancels a pending form on plugin disposal", async () => {
		const fetch = vi.fn(async (_url, options) => options.method === "POST" ? Response.json({ data: { id: JSON.parse(options.body).id } }) : options.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ data: { state: { status: "pending" } } }));
		vi.stubGlobal("fetch", fetch);
		const forms = createV2NativeForms(async () => ({ url: "http://127.0.0.1", password: "test-only" }));
		const pending = forms.ask(input, context);
		const rejected = expect(pending).rejects.toThrow();
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		await forms.dispose(); await rejected;
		expect(fetch.mock.calls.at(-1)?.[1].method).toBe("DELETE");
	});
	it.each(["tool cancellation", "timeout"])("rejects a late allow after %s", async (reason) => {
		const controller = new AbortController();
		const timeoutMs = 300_000;
		const timeout = vi.spyOn(AbortSignal, "timeout");
		if (reason === "timeout") timeout.mockImplementation((ms) => ms === timeoutMs ? controller.signal : new AbortController().signal);
		const fetch = vi.fn(async (_url, options) => {
			if (options.method === "POST") return Response.json({ data: { id: JSON.parse(options.body).id } });
			// Cancellation can race with a response already delivered by the transport.
			controller.abort();
			return Response.json({ data: { state: { status: "answered", answer: { decision: "allow" } } } });
		});
		vi.stubGlobal("fetch", fetch);
		const forms = createV2NativeForms(async () => ({ url: "http://127.0.0.1", password: "test-only" }), timeoutMs);
		try {
			await expect(forms.ask(input, { ...context, ...(reason === "tool cancellation" ? { signal: controller.signal } : {}) })).rejects.toThrow("Permission denied");
			expect(timeout).toHaveBeenCalledWith(timeoutMs);
			expect(fetch.mock.calls.map(([, options]) => options.method)).toEqual(["POST", "GET"]);
		} finally { await forms.dispose(); timeout.mockRestore(); }
	});
	it("uses the TUI fallback only when no native connection can be resolved", async () => {
		const forms = createV2NativeForms(async () => undefined);
		await expect(forms.ask(input, context)).resolves.toBe(false);
		await forms.dispose();
	});
	it("reads beta replies from the native event stream when GET has no state", async () => {
		let id = "";
		let reply!: () => void;
		const replied = new Promise<void>((resolve) => { reply = resolve; });
		vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
			if (options.method === "POST") { id = JSON.parse(options.body).id; return Response.json({ data: { id } }); }
			return Response.json({ data: { id } });
		}));
		const events = { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
			await replied;
			yield { type: "form.replied", data: { id, sessionID: context.sessionID, answer: { decision: "allow" } } };
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		} };
		const forms = createV2NativeForms(async () => ({ url: "http://127.0.0.1", password: "test-only" }), 5000, 10, events);
		try {
			const pending = forms.ask(input, context);
			await vi.waitFor(() => expect(id).toMatch(/^frm_/));
			reply();
			await expect(pending).resolves.toBe(true);
		} finally { await forms.dispose(); }
	});
});
