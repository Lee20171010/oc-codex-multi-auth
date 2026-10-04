import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ToolContext } from "@opencode-ai/plugin/tool";
type NativeToolCall = { sessionID: string; messageID: string; id: string; signal?: AbortSignal };

type Connection = { url: string; password: string };
type FormState = { status: "pending" | "answered" | "cancelled"; answer?: Record<string, unknown> };
const stateSchema = z.object({
	status: z.enum(["pending", "answered", "cancelled"]), answer: z.record(z.string(), z.unknown()).optional(),
});
const detail = z.object({ data: z.object({ state: stateSchema.optional() }) });
type FormEvents = { subscribe: (input: { signal: AbortSignal }) => AsyncIterable<unknown> };

/** Resolve only this process's host; credentials never leave loopback or enter diagnostics. */
export async function resolveNativeFormConnection(): Promise<Connection | undefined> {
	const candidates: Connection[] = [];
	try {
		const state = JSON.parse(await readFile(join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "opencode/service.json"), "utf8")) as Record<string, unknown>;
		if (state.pid === process.pid && typeof state.url === "string" && typeof state.password === "string") candidates.push({ url: state.url, password: state.password });
	} catch { /* Standalone servers may use their launch environment instead. */ }
	const password = process.env.OPENCODE_SERVER_PASSWORD;
	const portArg = process.argv.find((arg) => arg.startsWith("--port="))?.slice(7) ?? process.argv[process.argv.indexOf("--port") + 1];
	if (password && portArg && /^\d+$/.test(portArg) && Number(portArg) > 0 && Number(portArg) <= 65535) candidates.push({ url: `http://127.0.0.1:${portArg}`, password });
	for (const candidate of candidates) {
		try {
			const url = new URL(candidate.url);
			if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) continue;
			const response = await nativeRequest(candidate, "/api/session?limit=1", "GET");
			if (!response.ok) continue;
			await response.body?.cancel();
			return { ...candidate, url: url.origin };
		} catch { /* An unavailable endpoint cannot authorize an operation. */ }
	}
	return undefined;
}

function nativeRequest(connection: Connection, path: string, method: string, input?: unknown, signal?: AbortSignal): Promise<Response> {
	return fetch(`${connection.url}${path}`, {
		method, redirect: "error",
		headers: { Authorization: `Basic ${Buffer.from(`opencode:${connection.password}`).toString("base64")}`, "Content-Type": "application/json" },
		body: input === undefined ? undefined : JSON.stringify(input),
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
	});
}

/** Native forms are rendered by the host's web, desktop and terminal clients. */
export function createV2NativeForms(resolve = resolveNativeFormConnection, timeoutMs = 300_000, pollMs = 300, events?: FormEvents) {
	const pending = new Set<AbortController>();
	const forms = new Map<string, { sessionID: string; state?: FormState }>();
	const eventController = new AbortController();
	let closed = false;
	let eventsAvailable = typeof events?.subscribe === "function";
	const task = events ? (async () => {
		for await (const value of events.subscribe({ signal: eventController.signal })) {
			if (!value || typeof value !== "object") continue;
			const event = value as { type?: string; data?: { id?: string; sessionID?: string; answer?: unknown } };
			const form = event.data?.id ? forms.get(event.data.id) : undefined;
			if (!form || event.data?.sessionID !== form.sessionID) continue;
			if (event.type === "form.replied") {
				const parsed = z.record(z.string(), z.unknown()).safeParse(event.data.answer);
				if (parsed.success) form.state = { status: "answered", answer: parsed.data };
			}
			if (event.type === "form.cancelled") form.state = { status: "cancelled" };
		}
	})().catch(() => {}).finally(() => { eventsAvailable = false; }) : undefined;
	return {
		ask: async (input: Parameters<ToolContext["ask"]>[0], context: NativeToolCall): Promise<boolean> => {
			if (closed || context.signal?.aborted) throw new Error("Permission request cancelled");
			const connection = await resolve();
			if (!connection) return false;
			const controller = new AbortController();
			pending.add(controller);
			const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs), ...(context.signal ? [context.signal] : [])]);
			const base = `/api/session/${encodeURIComponent(context.sessionID)}/form`;
			const id = `frm_${randomUUID().replaceAll("-", "")}`;
			const observed: { sessionID: string; state?: FormState } = { sessionID: context.sessionID };
			forms.set(id, observed);
			let state: FormState | undefined;
			try {
				if (closed) throw new Error("Permission request cancelled");
				const response = await nativeRequest(connection, base, "POST", {
					id,
					title: `Allow ${input.permission}?`,
					fields: [{ key: "decision", type: "string", title: "Allow this operation once?", description: [`Allow ${input.permission}?`, ...input.patterns].join("\n"), required: true,
						options: [{ value: "deny", label: "Deny" }, { value: "allow", label: "Allow once" }], default: "deny" }],
					metadata: { kind: "question", tool: { messageID: context.messageID, id: context.id }, plugin: "oc-codex-multi-auth", toolCallID: context.id },
				}, signal);
				// A missing route/session is an explicit failure; never present a second prompt after an ambiguous POST.
				if (!response.ok) throw new Error(`Native confirmation could not be created (${response.status})`);
				const created = z.object({ data: z.object({ id: z.string().startsWith("frm_") }) }).parse(await response.json()).data.id;
				if (created !== id) throw new Error("Native confirmation identity mismatch");
				let eventOnly = false;
				while (!signal.aborted) {
					state = observed.state;
					if (!state && !eventOnly) {
						const response = await nativeRequest(connection, `${base}/${encodeURIComponent(id)}`, "GET", undefined, signal);
						if (!response.ok && !observed.state) throw new Error(`Native confirmation unavailable (${response.status})`);
						state = observed.state ?? detail.parse(await response.json()).data.state;
						eventOnly = state === undefined;
					}
					if (!state && eventOnly && !eventsAvailable) throw new Error("Native confirmation event stream unavailable");
					state ??= { status: "pending" };
					if (state.status === "answered") {
						if (state.answer?.decision !== "allow" || signal.aborted) throw new Error("Permission denied");
						return true;
					}
					if (state.status === "cancelled") throw new Error("Permission cancelled");
					await delay(pollMs, undefined, { signal });
				}
				throw new Error("Permission request cancelled or timed out");
			} finally {
				pending.delete(controller);
				forms.delete(id);
				if (id && state?.status !== "answered" && state?.status !== "cancelled") await nativeRequest(connection, `${base}/${encodeURIComponent(id)}`, "DELETE").catch(() => {});
			}
		},
		dispose: async () => { closed = true; eventController.abort(); for (const controller of pending) controller.abort(); pending.clear(); await task; forms.clear(); },
	};
}
