import { afterEach, describe, expect, it, vi } from "vitest";
import type { TuiPluginApi, TuiPluginMeta, TuiSlotPlugin } from "@opencode-ai/plugin/tui";

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
import tuiModule from "../tui.js";

type RegisteredSlotPlugin = TuiSlotPlugin & {
	slots: Record<string, (ctx: unknown, props: { session_id: string }) => unknown>;
};

/**
 * `api.slots.register` hands back the registry id and `TuiSlots` offers no
 * `unregister`; teardown reaches a slot plugin through its `dispose` hook.
 * These cases pin that contract: once `dispose` or plugin teardown runs, the
 * renderer stops producing nodes instead of polling a dead api.
 */
function harness() {
	const disposers: Array<() => void> = [];
	const commandDispose = vi.fn();
	let plugin: RegisteredSlotPlugin | undefined;
	const api = {
		renderer: { width: 100 },
		slots: {
			register: (value: RegisteredSlotPlugin): string => {
				plugin = value;
				return "slot-1";
			},
		},
		command: { register: () => commandDispose },
		lifecycle: {
			signal: new AbortController().signal,
			onDispose: (fn: () => void) => {
				disposers.push(fn);
				return () => {};
			},
		},
		event: { on: () => () => {} },
	};
	return {
		api: api as unknown as TuiPluginApi,
		plugin: () => plugin,
		disposers,
		commandDispose,
	};
}

afterEach(() => {
	for (const cleanup of mocks.cleanups.splice(0)) cleanup();
	vi.useRealTimers();
});

describe("TUI status slot lifecycle", () => {
	it("stops the slot renderer once the registry calls the plugin's dispose hook", async () => {
		vi.useFakeTimers();
		const h = harness();
		await tuiModule.tui(h.api, undefined, {} as TuiPluginMeta);
		const plugin = h.plugin();
		expect(plugin).toBeDefined();
		expect(typeof plugin!.dispose).toBe("function");
		const render = plugin!.slots["session_prompt_right"]!;
		expect(render({}, { session_id: "s" })).not.toBeNull();
		plugin!.dispose!();
		expect(render({}, { session_id: "s" })).toBeNull();
	});

	it("unregisters the command and stops the slot on plugin teardown", async () => {
		vi.useFakeTimers();
		const h = harness();
		await tuiModule.tui(h.api, undefined, {} as TuiPluginMeta);
		for (const dispose of h.disposers) dispose();
		expect(h.commandDispose).toHaveBeenCalledTimes(1);
		expect(h.plugin()!.slots["session_prompt_right"]!({}, { session_id: "s" })).toBeNull();
	});
});
