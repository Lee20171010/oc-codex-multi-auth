import { afterEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "@opencode/plugin/tui";

const mocks = vi.hoisted(() => ({ cleanups: [] as Array<() => void> }));
vi.mock("@opentui/solid", () => ({
	createElement: () => ({}),
	spread: (element: object, props: object) => Object.defineProperties(element, Object.getOwnPropertyDescriptors(props)),
}));
vi.mock("solid-js", () => ({
	createSignal: <T>(initial: T) => {
		let value = initial;
		return [() => value, (next: T) => { value = next; }];
	},
	onCleanup: (cleanup: () => void) => mocks.cleanups.push(cleanup),
}));
import { setupV2Tui } from "../lib/opencode-v2-tui.js";

afterEach(() => {
	for (const cleanup of mocks.cleanups.splice(0)) cleanup();
	vi.useRealTimers();
});

describe("V2 accounts UI", () => {
	it("exposes accounts without a mounted prompt and cleans up polling", async () => {
		vi.useFakeTimers();
		const slots = new Map<string, { render: (props: object) => { children: string } | null }>();
		const commands: Array<{ id: string; run: () => Promise<void> }> = [];
		const status = vi.fn().mockResolvedValue({
			text: "quota ready", details: "Quota details", showFor: "codex-models",
			accountStorage: "project",
			accounts: [
				{ index: 1, label: "First", active: true, enabled: true },
				{ index: 2, label: "Second", active: false, enabled: false },
			],
		});
		const alert = vi.fn();
		const unregister = vi.fn();
		const messages: Array<{ type: string; model?: { providerID: string } }> = [];
		let configuredProvider = "anthropic";
		const context = {
			location: { directory: "/tmp/opencode/project" }, renderer: { width: 100 },
			client: { rpc: () => ({ status }) }, theme: { text: { base: "white" } },
			data: { session: { get: () => ({ model: { providerID: configuredProvider } }), message: { list: () => messages } } },
			keymap: { layer: (factory: () => { commands: typeof commands }) => commands.push(...factory().commands) },
			ui: { dialog: { alert }, slot: (claim: { append: string; render: (props: object) => { children: string } | null }) => {
				slots.set(claim.append, claim);
				return unregister;
			} },
		} as unknown as Plugin.Context;
		const dispose = setupV2Tui(context);
		slots.get("app")!.render({});
		await vi.advanceTimersByTimeAsync(0);
		const sidebar = slots.get("sidebar.content")!.render({})!;
		expect(sidebar.children).toContain("● 1. First");
		expect(sidebar.children).toContain("○ 2. Second (disabled)");
		// The raw renderer width is sent — the status formatter owns the single
		// reserve discount, so subtracting it here would double-count.
		expect(status).toHaveBeenCalledWith({ width: 100 }, expect.objectContaining({ location: context.location }));
		await commands.find((command) => command.id === "codex.accounts")!.run();
		expect(alert).toHaveBeenCalledWith(expect.objectContaining({ title: "Codex accounts", message: expect.stringContaining("opencode auth login") }));
		expect(alert.mock.calls[0]?.[0].message).toContain("this project uses its own pool");
		expect(alert.mock.calls[0]?.[0].message).toContain("global pool is used to seed it");
		expect(alert.mock.calls[0]?.[0].message).toContain('"perProjectAccounts" to true (per-project) or false (global)');
		expect(alert.mock.calls[0]?.[0].message).toContain("CODEX_AUTH_PER_PROJECT_ACCOUNTS overrides this setting");
		status.mockResolvedValueOnce({
			text: "quota ready", details: "Quota details", showFor: "codex-models",
			accountStorage: "global", accounts: [
				{ index: 1, label: "First", active: true, enabled: true },
				{ index: 2, label: "Second", active: false, enabled: false },
			],
		});
		await commands.find((command) => command.id === "codex.accounts")!.run();
		expect(alert.mock.calls[1]?.[0].message).toContain("global pool is shared across projects");
		expect(alert.mock.calls[1]?.[0].message).toContain("~/.opencode/openai-codex-auth-config.json");
		expect(alert.mock.calls[1]?.[0].message).not.toContain("from this project directory");
		// Hiding Codex quota for a different provider must not hide the account list.
		expect(slots.get("prompt.footer.status")!.render({ sessionID: "test" })!.children).toBe("");
		messages.push({ type: "assistant", model: { providerID: "openai" } }, { type: "user" });
		expect(slots.get("prompt.footer.status")!.render({ sessionID: "test" })!.children).toBe("quota ready");
		configuredProvider = "openai";
		messages.push({ type: "assistant", model: { providerID: "anthropic" } });
		expect(slots.get("prompt.footer.status")!.render({ sessionID: "test" })!.children).toBe("");
		expect(sidebar.children).toContain("First");
		status.mockRejectedValue(new Error("offline"));
		await vi.advanceTimersByTimeAsync(2000);
		expect(sidebar.children).toContain("Accounts unavailable");
		await commands.find((command) => command.id === "codex.accounts")!.run();
		expect(alert.mock.calls[2]?.[0].message).toContain("Account storage: unavailable");
		expect(alert.mock.calls[2]?.[0].message).not.toContain("the global pool is shared");
		for (const cleanup of mocks.cleanups.splice(0)) cleanup();
		const calls = status.mock.calls.length;
		await vi.advanceTimersByTimeAsync(4000);
		expect(status).toHaveBeenCalledTimes(calls);
		dispose();
		expect(unregister).toHaveBeenCalledTimes(3);
	});

	it("removes stored OpenAI OAuth connections on codex.logout, keeping the pool", async () => {
		vi.useFakeTimers();
		const slots = new Map<string, { render: (props: object) => { children: string } | null }>();
		const commands: Array<{ id: string; run: () => Promise<void> }> = [];
		const status = vi.fn().mockResolvedValue({
			text: "quota ready", details: "Quota details", showFor: "always",
			accountStorage: "project", accounts: [],
		});
		const alert = vi.fn();
		const confirm = vi.fn().mockResolvedValue(true);
		const remove = vi.fn().mockResolvedValue(undefined);
		const list = vi.fn().mockResolvedValue({
			data: [
				{ id: "openai", connections: [
					{ type: "credential", id: "cred-1", label: "ChatGPT Plus", method: "oauth" },
					{ type: "credential", id: "cred-2", label: "API key", method: "key" },
					{ type: "env", name: "OPENAI_API_KEY" },
				] },
				{ id: "anthropic", connections: [{ type: "credential", id: "cred-9", label: "Claude", method: "oauth" }] },
			],
		});
		const context = {
			location: { directory: "/tmp/opencode/project" }, renderer: { width: 100 },
			client: {
				rpc: () => ({ status }),
				integration: { list },
				credential: { remove },
			},
			theme: { text: { base: "white" } },
			data: { session: { get: () => undefined, message: { list: () => [] } }, location: { default: () => ({ directory: "/tmp/opencode/project" }) } },
			keymap: { layer: (factory: () => { commands: typeof commands }) => commands.push(...factory().commands) },
			ui: { dialog: { alert, confirm }, slot: (claim: { append: string }) => { slots.set(claim.append, claim as never); return vi.fn(); } },
		} as unknown as Plugin.Context;
		setupV2Tui(context);
		slots.get("app")!.render({});
		await vi.advanceTimersByTimeAsync(0);
		const logout = commands.find((command) => command.id === "codex.logout");
		expect(logout).toBeDefined();
		await logout!.run();
		expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Codex logout" }));
		// Only the openai integration's OAuth credential is removed — API-key
		// connections, other providers, and the plugin's own pool stay put.
		expect(remove).toHaveBeenCalledTimes(1);
		expect(remove).toHaveBeenCalledWith({ credentialID: "cred-1" });
		expect(alert).toHaveBeenCalledWith(expect.objectContaining({
			title: "Codex logout",
			message: expect.stringContaining("account pool is unchanged"),
		}));
	});

	it("sanitizes RPC text and account labels, and honours the returned glyph mode", async () => {
		vi.useFakeTimers();
		const slots = new Map<string, { render: (props: object) => { children: string } | null }>();
		const status = vi.fn().mockResolvedValue({
			// Escape sequences and bidi marks must not reach the renderer; the
			// newline in `text` is preserved (multi-line status is supported).
			text: "quota\x1b[31m ready\nline two\u202e",
			details: "details \x1bPq\x1b\\ here",
			showFor: "always",
			accountStorage: "global",
			glyphMode: "ascii",
			accounts: [
				{ index: 1, label: "Fi\trst", active: true, enabled: true },
				{ index: 2, label: "\x1b[7mSecond\x1b[0m", active: false, enabled: true },
			],
		});
		const context = {
			location: { directory: "/tmp/opencode/project" }, renderer: { width: 100 },
			client: { rpc: () => ({ status }) },
			theme: { text: { base: "white" } },
			data: { session: { get: () => undefined, message: { list: () => [] } }, location: { default: () => ({ directory: "/tmp/opencode/project" }) } },
			keymap: { layer: (factory: () => { commands: Array<{ id: string }> }) => void factory() },
			ui: { dialog: { alert: vi.fn(), confirm: vi.fn() }, slot: (claim: { append: string }) => { slots.set(claim.append, claim as never); return vi.fn(); } },
		} as unknown as Plugin.Context;
		setupV2Tui(context);
		slots.get("app")!.render({});
		await vi.advanceTimersByTimeAsync(0);
		const sidebar = slots.get("sidebar.content")!.render({})!;
		// ASCII glyph mode swaps ●/○ for */o, and every label is sanitized.
		expect(sidebar.children).toContain("* 1. Fi rst");
		expect(sidebar.children).toContain("o 2. Second");
		expect(sidebar.children).not.toContain("\x1b");
		expect(slots.get("prompt.footer.status")!.render({})!.children).toBe("quota ready\nline two");
	});

	it("falls back to an 80-column budget when the renderer reports no width", async () => {
		vi.useFakeTimers();
		const slots = new Map<string, { render: (props: object) => { children: string } | null }>();
		const status = vi.fn().mockResolvedValue({
			text: "quota ready", details: "d", showFor: "always",
			accountStorage: "global", accounts: [],
		});
		const context = {
			location: { directory: "/tmp/opencode/project" }, renderer: { width: 0 },
			client: { rpc: () => ({ status }) },
			theme: { text: { base: "white" } },
			data: { session: { get: () => undefined, message: { list: () => [] } }, location: { default: () => ({ directory: "/tmp/opencode/project" }) } },
			keymap: { layer: (factory: () => { commands: Array<{ id: string }> }) => void factory() },
			ui: { dialog: { alert: vi.fn(), confirm: vi.fn() }, slot: (claim: { append: string }) => { slots.set(claim.append, claim as never); return vi.fn(); } },
		} as unknown as Plugin.Context;
		setupV2Tui(context);
		slots.get("app")!.render({});
		await vi.advanceTimersByTimeAsync(0);
		expect(status).toHaveBeenCalledWith({ width: 80 }, expect.objectContaining({ location: context.location }));
	});

	it("aborts codex.logout when the user declines the confirmation", async () => {
		vi.useFakeTimers();
		const slots = new Map<string, { render: (props: object) => { children: string } | null }>();
		const commands: Array<{ id: string; run: () => Promise<void> }> = [];
		const status = vi.fn().mockResolvedValue({
			text: "quota ready", details: "Quota details", showFor: "always",
			accountStorage: "project", accounts: [],
		});
		const confirm = vi.fn().mockResolvedValue(false);
		const remove = vi.fn().mockResolvedValue(undefined);
		const context = {
			location: { directory: "/tmp/opencode/project" }, renderer: { width: 100 },
			client: {
				rpc: () => ({ status }),
				integration: { list: vi.fn().mockResolvedValue({ data: [{ id: "openai", connections: [{ type: "credential", id: "cred-1", label: "x", method: "oauth" }] }] }) },
				credential: { remove },
			},
			theme: { text: { base: "white" } },
			data: { session: { get: () => undefined, message: { list: () => [] } }, location: { default: () => ({ directory: "/tmp/opencode/project" }) } },
			keymap: { layer: (factory: () => { commands: typeof commands }) => commands.push(...factory().commands) },
			ui: { dialog: { alert: vi.fn(), confirm }, slot: (claim: { append: string }) => { slots.set(claim.append, claim as never); return vi.fn(); } },
		} as unknown as Plugin.Context;
		setupV2Tui(context);
		slots.get("app")!.render({});
		await vi.advanceTimersByTimeAsync(0);
		await commands.find((command) => command.id === "codex.logout")!.run();
		expect(remove).not.toHaveBeenCalled();
	});
});
