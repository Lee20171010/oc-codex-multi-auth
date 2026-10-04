import { Message, ToolResultPart, type ToolCallPart } from "@opencode/ai";
import type { SessionDomain } from "@opencode/plugin/promise/session";

type Repair = "tools" | "reasoning-order" | "reasoning-disabled";
export function recoveryKind(message: string): Repair | undefined {
	const text = message.toLowerCase();
	if ((text.includes("tool_use") && text.includes("tool_result")) ||
		/no tool (output|result)|tool.*result.*missing|function_call_output.*(missing|not found)|no tool call found/.test(text)) return "tools";
	if (text.includes("thinking is disabled") && text.includes("cannot contain")) return "reasoning-disabled";
	if (text.includes("thinking") && /first block|must start with|preceding|preceeding|expected.*found/.test(text)) return "reasoning-order";
	return undefined;
}

/** Repair only the outgoing context. Stored messages and executed operations are untouched. */
export function repairV2Context(messages: readonly Message[], mode?: Repair): { messages: Message[]; repairs: number } {
	const result: Message[] = [];
	const pending = new Map<string, ToolCallPart>();
	let repairs = 0;
	const flush = () => {
		if (!pending.size) return;
		result.push(new Message({ role: "tool", content: [...pending.values()].map((call) => ToolResultPart.make({
			id: call.id, name: call.name, namespace: call.namespace,
			result: "Tool execution ended without a result. The operation may have run; check its state before retrying.", resultType: "error",
		})) }));
		repairs += pending.size;
		pending.clear();
	};
	for (const message of messages) {
		if (message.role === "user" || message.role === "assistant") flush();
		let content = message.content;
		if (message.role === "tool") {
			content = content.flatMap((part) => {
				if (part.type !== "tool-result" || part.providerExecuted) return [part];
				const call = pending.get(part.id);
				if (!call) { repairs++; return []; }
				pending.delete(part.id);
				if (part.name === call.name && part.namespace === call.namespace) return [part];
				repairs++;
				return [{ ...part, name: call.name, namespace: call.namespace }];
			});
		}
		if (message.role === "assistant" && mode?.startsWith("reasoning")) {
			const reasoning = content.filter((part) => part.type === "reasoning");
			const rest = content.filter((part) => part.type !== "reasoning");
			const next = mode === "reasoning-disabled" ? rest : [...reasoning, ...rest];
			if (next.length !== content.length || next.some((part, index) => part !== content[index])) { content = next; repairs++; }
		}
		if (!content.length) { if (message.content.length === 0) repairs++; continue; }
		const changed = content.length !== message.content.length || content.some((part, i) => part !== message.content[i]);
		result.push(changed ? new Message({ ...message, content, native: undefined }) : message);
		if (message.role === "assistant") for (const part of content) {
			if (part.type === "tool-call" && !part.providerExecuted) pending.set(part.id, part);
		}
	}
	flush();
	return { messages: result, repairs };
}

/** Official stable counts the upcoming request: first retry is attempt 2. */
export async function registerV2Recovery(session: SessionDomain, autoResume: boolean) {
 const modes = new Map<string, Repair>();
 const registrations = [
  await session.hook("context", (event) => {
   const mode = modes.get(event.sessionID);
   modes.delete(event.sessionID);
   const repaired = repairV2Context(event.messages, mode);
   if (repaired.repairs) event.messages = repaired.messages;
  }, { providerID: "openai" }),
  await session.hook("retry", (event) => {
   const mode = recoveryKind(event.error.message);
   if (!autoResume || !mode || event.attempt !== 2) return;
   modes.set(event.sessionID, mode);
   event.decision = { retry: true, delay: 0 };
  }, { providerID: "openai" }),
  await session.hook("prompt", (event) => { modes.delete(event.sessionID); }),
 ];
 return async () => { modes.clear(); for (const registration of registrations) await registration?.dispose(); };
}
