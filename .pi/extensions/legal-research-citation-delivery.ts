import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

type Authority = { label: string; url: string; aliases: string[] };

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

function cleanAuthorityName(value: string) {
	return value.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
}

function collectAuthorities(value: unknown): Authority[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const record = item as Record<string, unknown>;
		const label = typeof record.label === "string" ? record.label.trim() : "";
		const url = typeof record.url === "string" ? record.url.trim() : "";
		return label && /^https?:\/\//i.test(url) ? [{ label, url, aliases: [label] }] : [];
	});
}

// RAG commonly writes a readable authority name immediately before its linked
// neutral citation, e.g. "*A v B* ([27-nlr-361](...))". Preserve that name as
// an alias, so a later work product can link the cited case rather than only a
// machine-like neutral citation label.
function enrichAuthorities(answer: unknown, authorities: Authority[]) {
	const text = String(answer || "");
	return authorities.map((authority) => {
		const aliases = new Set(authority.aliases.map(cleanAuthorityName).filter(Boolean));
		const escapedUrl = escapeRegExp(authority.url);
		const linkAt = new RegExp("(.{0,180}?)\\s*(?:\\(|\\[)\\[?" + escapeRegExp(authority.label) + "\\]?\\(" + escapedUrl + "\\)\\)?", "gi");
		for (const match of text.matchAll(linkAt)) {
			const prefix = cleanAuthorityName(match[1]);
			const candidates = [
				...prefix.matchAll(/\*{1,2}([^*\n]{3,160})\*{1,2}/g),
				...prefix.matchAll(/([A-Z][^\n.]{3,150}?\s+v\.?\s+[A-Z][^\n.]{2,150})/g),
			].map((item) => cleanAuthorityName(item[1]));
			for (const candidate of candidates) if (candidate) aliases.add(candidate);
		}
		return { ...authority, aliases: [...aliases].sort((a, b) => b.length - a.length) };
	});
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Do not touch an existing Markdown link. Only link authority labels in the
// ordinary prose around them, so preservation never corrupts user-facing Markdown.
function linkifyOutsideMarkdown(text: string, label: string, url: string) {
	if (!label || text.includes(`](${url})`)) return text;
	const pieces = text.split(/(\[[^\]\r\n]+\]\(https?:\/\/[^\s)]+\))/g);
	const expression = new RegExp(`(^|[^\\w])(${escapeRegExp(label)})(?=$|[^\\w])`, "gi");
	return pieces.map((piece) => {
		if (/^\[[^\]\r\n]+\]\(https?:\/\//.test(piece)) return piece;
		return piece.replace(expression, (_whole, before, matched) => `${before}[${matched}](${url})`);
	}).join("");
}

function preserveAuthorities(text: string, authorities: Authority[]) {
	if (!text.trim() || !authorities.length) return text;
	let output = text;
	for (const authority of authorities) {
		for (const alias of authority.aliases) output = linkifyOutsideMarkdown(output, alias, authority.url);
	}
	const sources = authorities.slice(0, 12).map((authority) => `- [${authority.aliases.find((alias) => alias !== authority.label) || authority.label}](${authority.url})`).join("\n");
	const missing = authorities.filter((authority) => !output.includes(`](${authority.url})`));
	if (!missing.length) return output;
	const missingSources = missing.slice(0, 12).map((authority) => `- [${authority.aliases.find((alias) => alias !== authority.label) || authority.label}](${authority.url})`).join("\n");
	return `${output.trim()}\n\n### Linked authorities supporting this draft\n\nThe following primary sources support the legal information above:\n\n${missingSources}`;
}

function looksLikeSeparateWorkProduct(text: string) {
	return /(^|\n)\s*(?:subject|to|dear)\s*[: ,]/im.test(text)
		|| /(^|\n)\s*(?:yours sincerely|yours faithfully|sincerely|kind regards)\b/im.test(text)
		|| /(^|\n)\s*#{1,4}\s*(?:draft|letter|email|complaint|submission|advice note)\b/im.test(text);
}

export default function legalResearchCitationDelivery(pi: ExtensionAPI) {
	let directResearchAnswer: string | undefined;
	let hasOtherSpecialistResult = false;
	let linkedAuthorities: Authority[] = [];

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
		for (const authority of enrichAuthorities(result?.answer, collectAuthorities(result?.linked_authorities ?? delivery?.linked_authorities))) {
			if (!linkedAuthorities.some((known) => known.label === authority.label && known.url === authority.url)) linkedAuthorities.push(authority);
		}
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const text = event.message.content.filter((part) => part.type === "text").map((part) => part.text || "").join("\n");
		if (!text.trim()) return;
		// The delivery mode is explicit, but the conservative guard also protects a
		// user-visible letter/email if a model mistakenly selected direct_answer.
		if (directResearchAnswer && !hasOtherSpecialistResult && !looksLikeSeparateWorkProduct(text)) return { message: { ...event.message, content: [{ type: "text", text: directResearchAnswer }] } };
		const delivered = preserveAuthorities(text, linkedAuthorities);
		if (delivered === text) return;
		return { message: { ...event.message, content: [{ type: "text", text: delivered }] } };
	});
}
