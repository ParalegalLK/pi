import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

function previewResult(event: ToolResultEvent): string | undefined {
	if (event.isError) return undefined;
	const value = event.structuredContent && typeof event.structuredContent === "object" && !Array.isArray(event.structuredContent)
		? event.structuredContent as Record<string, unknown>
		: undefined;
	const markup = value?.artifact_markup;
	return typeof markup === "string" && markup.startsWith(":::artifact{") ? markup : undefined;
}

function isPreviewTool(name: string) {
	return name === "librechat_prepare_document_preview" || name.endsWith("/librechat_prepare_document_preview");
}

// Pi decides whether a preview is useful by deciding whether to call the MCP
// tool. Once it has made that choice, this extension makes the resulting
// artifact deterministic instead of relying on the model to copy a large HTML
// block from the tool result into its final answer.
export default function libreChatPreviewDelivery(pi: ExtensionAPI) {
	let pending: string | undefined;
	pi.on("agent_start", () => { pending = undefined; });
	pi.on("tool_result", (event) => {
		if (!isPreviewTool(event.toolName)) return;
		const markup = previewResult(event);
		if (markup) pending = markup;
	});
	pi.on("message_end", (event) => {
		if (!pending || event.message.role !== "assistant") return;
		const text = event.message.content.filter((part) => part.type === "text").map((part) => part.text || "").join("\n");
		if (text.includes(pending)) return;
		return { message: { ...event.message, content: [{ type: "text", text: `${text.trim()}\n\n${pending}`.trim() }] } };
	});
}
