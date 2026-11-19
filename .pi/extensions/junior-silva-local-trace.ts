import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequestTrace } from "../../junior-silva/core/trace.mjs";

function assistantText(message: unknown) {
	if (!message || typeof message !== "object") return "";
	const candidate = message as { content?: unknown };
	if (!Array.isArray(candidate.content)) return "";
	return candidate.content.filter((part): part is { type: string; text?: string } => Boolean(part) && typeof part === "object" && "type" in part && "text" in part)
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text || "")
		.join("\n");
}

export default function juniorSilvaLocalTrace(pi: ExtensionAPI) {
	let pendingInput = "";
	let trace: ReturnType<typeof createRequestTrace> | undefined;

	pi.on("input", (event) => {
		if (event.source !== "extension") pendingInput = event.text;
		return { action: "continue" };
	});

	pi.on("agent_start", () => {
		trace = createRequestTrace({ source: "cli", model: process.env.PI_MODEL, provider: process.env.PI_PROVIDER, thinking: process.env.PI_THINKING });
		void trace.start({ original_query: pendingInput, stream: false, attachment_input_mode: "cli" });
	});

	pi.on("tool_execution_start", (event) => { void trace?.toolStart(event); });
	pi.on("tool_execution_update", (event) => { void trace?.toolUpdate(event); });
	pi.on("tool_execution_end", (event) => { void trace?.toolEnd(event); });
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") void trace?.assistantMessage(event.message);
	});

	pi.on("agent_end", (event) => {
		const assistant = [...event.messages].reverse().find((message) => message.role === "assistant");
		const delivery = trace?.delivery() || { artifacts: [], previews: [] };
		void trace?.finish({ outcome: "completed", answer: assistantText(assistant), usage: assistant?.usage, artifacts: delivery.artifacts, previews: delivery.previews });
		trace = undefined;
		pendingInput = "";
	});
}
