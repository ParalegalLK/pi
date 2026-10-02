import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

function toolResultJson(event: ToolResultEvent): Record<string, unknown> | undefined {
	if (event.structuredContent && typeof event.structuredContent === "object" && !Array.isArray(event.structuredContent)) {
		return event.structuredContent as Record<string, unknown>;
	}
	const text = event.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function isRagTool(toolName: string) {
	return toolName === "rag_chat_research" || toolName.endsWith("/rag_chat_research");
}

export default function legalResearchCitationDelivery(pi: ExtensionAPI) {
	let directResearchAnswer: string | undefined;
	let hasOtherSpecialistResult = false;

	pi.on("agent_start", () => {
		directResearchAnswer = undefined;
		hasOtherSpecialistResult = false;
	});

	pi.on("tool_result", (event) => {
		if (event.isError) return;
		if (!isRagTool(event.toolName)) {
			hasOtherSpecialistResult = true;
			return;
		}
		const answer = toolResultJson(event)?.answer;
		if (typeof answer === "string" && answer.trim()) directResearchAnswer = answer.trim();
	});

	pi.on("message_end", (event) => {
		if (!directResearchAnswer || hasOtherSpecialistResult || event.message.role !== "assistant") return;
		if (!event.message.content.some((part) => part.type === "text")) return;
		return {
			message: {
				...event.message,
				content: [{ type: "text", text: directResearchAnswer }],
			},
		};
	});
}
