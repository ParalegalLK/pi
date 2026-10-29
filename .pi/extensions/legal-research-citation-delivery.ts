import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
	authorityCandidates,
	enrichAuthorityAliases,
	linkifyCitedAuthorities,
	mergeAuthorityCandidates,
} from "../../junior-silva/core/legal-research.mjs";

function toolResultJson(event: ToolResultEvent): Record<string, unknown> | undefined {
	if (event.structuredContent && typeof event.structuredContent === "object" && !Array.isArray(event.structuredContent)) {
		const structured = event.structuredContent as Record<string, unknown>;
		if ("answer" in structured || "linked_authorities" in structured || "delivery" in structured) return structured;
	}
	const text = event.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch { return undefined; }
}

function looksLikeResearchResult(result: Record<string, unknown> | undefined) {
	return Boolean(result && typeof result.answer === "string" && (Array.isArray(result.linked_authorities) || (result.delivery && typeof result.delivery === "object")));
}

function isRagTool(toolName: string) {
	// Native MCP tool names are namespaced with double underscores, while
	// standalone/older MCP clients can use a slash. Accept all forms so the
	// delivery hook receives the RAG result in CLI, Docker and LibreChat.
	return toolName === "rag_chat_research"
		|| toolName.endsWith("/rag_chat_research")
		|| toolName.endsWith("__rag_chat_research");
}

function looksLikeSeparateWorkProduct(text: string) {
	return /(^|\n)\s*(?:subject|to|dear)\s*[: ,]/im.test(text)
		|| /(^|\n)\s*(?:yours sincerely|yours faithfully|sincerely|kind regards)\b/im.test(text)
		|| /(^|\n)\s*#{1,4}\s*(?:draft|letter|email|complaint|submission|advice note)\b/im.test(text);
}

function looksLikeIncompleteArtifactReply(text: string) {
	return /(?:needs?\s+(?:one|a)\s+more\s+(?:fix|change)|couldn['’]t\s+complete\s+one\s+document|still\s+being\s+prepared|not\s+(?:yet\s+)?finali[sz]ed)/i.test(text);
}

export default function legalResearchCitationDelivery(pi: ExtensionAPI) {
	let directResearchAnswer: string | undefined;
	let hasOtherSpecialistResult = false;
	let linkedAuthorities: ReturnType<typeof authorityCandidates> = [];

	pi.on("agent_start", () => {
		directResearchAnswer = undefined;
		hasOtherSpecialistResult = false;
		linkedAuthorities = [];
	});

	pi.on("tool_result", (event) => {
		if (event.isError) return;
		const result = toolResultJson(event);
		if (!isRagTool(event.toolName) && !looksLikeResearchResult(result)) {
			hasOtherSpecialistResult = true;
			return;
		}
		const delivery = result?.delivery && typeof result.delivery === "object" ? result.delivery as Record<string, unknown> : undefined;
		const answer = result?.answer;
		if (delivery?.mode === "direct_answer" && typeof answer === "string" && answer.trim()) directResearchAnswer = answer.trim();
		linkedAuthorities = mergeAuthorityCandidates(
			linkedAuthorities,
			enrichAuthorityAliases(result?.answer, authorityCandidates(result?.linked_authorities ?? delivery?.linked_authorities)),
		);
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const text = event.message.content.filter((part) => part.type === "text").map((part) => part.text || "").join("\n");
		if (!text.trim()) return;
		// The hosted endpoint reconciles a generated-but-undelivered file. Do not
		// make this partial reply look complete by appending a citation appendix.
		if (looksLikeIncompleteArtifactReply(text)) return;
		// The delivery mode is explicit, but the conservative guard also protects a
		// user-visible letter/email if a model mistakenly selected direct_answer.
		if (directResearchAnswer && !hasOtherSpecialistResult && !looksLikeSeparateWorkProduct(text)) return { message: { ...event.message, content: [{ type: "text", text: directResearchAnswer }] } };
		const delivered = linkifyCitedAuthorities(text, linkedAuthorities);
		if (delivered === text) return;
		return { message: { ...event.message, content: [{ type: "text", text: delivered }] } };
	});
}
