import { describe, expect, it, vi } from "vitest";
import { Message, ToolCallPart, ToolResultPart } from "@opencode/ai";
import { recoveryKind, repairV2Context, registerV2Recovery } from "../lib/v2-recovery.js";
import type { SessionDomain, SessionContext, SessionRetry } from "@opencode/plugin/promise/session";

describe("native V2 context recovery", () => {
	it("repairs missing results before the next user and at the end without changing history", () => {
		const call = Message.assistant([ToolCallPart.make({ id: "call-1", name: "write", input: {} })]);
		const messages = [call, Message.user("Continue")];
		const snapshot = structuredClone(messages);
		const result = repairV2Context(messages);
		expect(result.repairs).toBe(1);
		expect(result.messages[1].content[0]).toMatchObject({ type: "tool-result", id: "call-1", result: { type: "error" } });
		expect(structuredClone(messages)).toEqual(snapshot);
		expect(repairV2Context([call]).messages).toHaveLength(2);
		expect(repairV2Context(result.messages).repairs).toBe(0);
	});
	it("keeps real results and provider-executed calls, removes orphan and duplicate results", () => {
		const call = Message.assistant([ToolCallPart.make({ id: "c", name: "read", input: {} }), ToolCallPart.make({ id: "server", name: "search", input: {}, providerExecuted: true })]);
		const result = new Message({ role: "tool", content: [
			ToolResultPart.make({ id: "c", name: "wrong", result: "real output" }),
			ToolResultPart.make({ id: "c", name: "read", result: "duplicate" }),
			ToolResultPart.make({ id: "orphan", name: "read", result: "orphan" }),
		] });
		const repaired = repairV2Context([call, result]);
		expect(repaired.messages[1].content).toHaveLength(1);
		expect(repaired.messages[1].content[0]).toMatchObject({ name: "read", result: { value: "real output" } });
	});
	it("repairs reasoning only in response to a matching backend failure", () => {
		const original = Message.assistant([{ type: "text", text: "Answer" }, { type: "reasoning", text: "Reasoning" }]);
		expect(repairV2Context([original]).messages[0]).toBe(original);
		expect(repairV2Context([original], "reasoning-order").messages[0].content[0].type).toBe("reasoning");
		expect(repairV2Context([original], "reasoning-disabled").messages[0].content).toEqual([{ type: "text", text: "Answer" }]);
		expect(recoveryKind("401 unauthorized")).toBeUndefined();
	});
	it("repairs once at the stable host's first retry (attempt 2) and disposes registrations", async () => {
		const callbacks = new Map<string, (event: unknown) => unknown>();
		const dispose = vi.fn();
		const session = { hook: vi.fn(async (name, fn) => { callbacks.set(name, fn); return { dispose }; }) };
		const cleanup = await registerV2Recovery(session as unknown as SessionDomain, true);
		const event = { sessionID: "s", attempt: 2, error: { message: "Expected thinking as first block but found text" }, decision: { retry: false } };
		callbacks.get("retry")?.(event as unknown as SessionRetry);
		expect(event.decision).toEqual({ retry: true, delay: 0 });
		const original = Message.assistant([{ type: "text", text: "Answer" }, { type: "reasoning", text: "Reason" }]);
		const context = { sessionID: "s", messages: [original] };
		await callbacks.get("context")?.(context as unknown as SessionContext);
		expect(context.messages[0].content[0].type).toBe("reasoning");
		expect(original.content[0].type).toBe("text");
		const repeated = { ...event, attempt: 3, decision: { retry: false } };
		callbacks.get("retry")?.(repeated);
		expect(repeated.decision.retry).toBe(false);
		await cleanup();
		expect(dispose).toHaveBeenCalledTimes(3);
	});
});
