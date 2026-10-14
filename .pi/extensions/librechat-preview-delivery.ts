import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

type Artifact = { download_url?: unknown };

function structured(event: ToolResultEvent): Record<string, unknown> | undefined {
	if (event.isError) return undefined;
	return event.structuredContent && typeof event.structuredContent === "object" && !Array.isArray(event.structuredContent)
		? event.structuredContent as Record<string, unknown>
		: undefined;
}

function previewResults(event: ToolResultEvent): string[] {
	const value = structured(event);
	if (!value) return [];
	const values = [value.artifact_markup, ...(Array.isArray(value.artifact_markups) ? value.artifact_markups : [])];
	return values.filter((markup): markup is string => typeof markup === "string" && markup.startsWith(":::artifact{"));
}

function artifactRows(event: ToolResultEvent): Array<{ label: string; url: string }> {
	const value = structured(event);
	if (!value) return [];
	const candidates: Array<{ label: string; artifact: Artifact }> = [];
	if (value.artifact && typeof value.artifact === "object") candidates.push({ label: "Download completed file", artifact: value.artifact as Artifact });
	if (value.reviewed_docx && typeof value.reviewed_docx === "object") candidates.push({ label: "Download reviewed DOCX", artifact: value.reviewed_docx as Artifact });
	if (value.review_markdown && typeof value.review_markdown === "object") candidates.push({ label: "Download legal review", artifact: value.review_markdown as Artifact });
	for (const review of Array.isArray(value.reviews) ? value.reviews : []) {
		if (!review || typeof review !== "object") continue;
		const item = review as Record<string, unknown>;
		const source = typeof item.source_filename === "string" ? item.source_filename : "document";
		if (item.reviewed_docx && typeof item.reviewed_docx === "object") candidates.push({ label: `Download reviewed DOCX — ${source}`, artifact: item.reviewed_docx as Artifact });
		if (item.review_markdown && typeof item.review_markdown === "object") candidates.push({ label: `Download legal review — ${source}`, artifact: item.review_markdown as Artifact });
	}
	const seen = new Set<string>();
	return candidates.flatMap(({ label, artifact }) => {
		const url = typeof artifact.download_url === "string" ? artifact.download_url : "";
		if (!/^https?:\/\//i.test(url) || seen.has(url)) return [];
		seen.add(url);
		return [{ label, url }];
	});
}

function isPreviewTool(name: string) {
	return ["librechat_prepare_document_preview", "workbench_publish_artifact", "review_finalize_document"]
		.some((tool) => name === tool || name.endsWith(`/${tool}`));
}

function removeUntrustedHtmlPreview(text: string) {
	// Only renderer-produced :::artifact markup is allowed to create the browser
	// preview. It also removes model-copied internal artifact metadata.
	return text.replace(/<!doctype\s+html[\s\S]*?<\/html>/gi, "").split("\n")
		.filter((line) => !/(?:local_path|file_uri|\/data\/(?:artifacts|uploads|workspace)|\/app\/)/i.test(line))
		.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Pi decides whether a preview is useful by deciding whether to call the MCP
// tool. Once it has made that choice, this extension makes the resulting
// artifact deterministic instead of relying on the model to copy a large HTML
// block from the tool result into its final answer.
export default function libreChatPreviewDelivery(pi: ExtensionAPI) {
	let pending: string[] = [];
	let downloads: Array<{ label: string; url: string }> = [];
	pi.on("agent_start", () => { pending = []; downloads = []; });
	pi.on("tool_result", (event) => {
		if (!isPreviewTool(event.toolName)) return;
		for (const markup of previewResults(event)) if (!pending.includes(markup)) pending.push(markup);
		for (const row of artifactRows(event)) if (!downloads.some((item) => item.url === row.url)) downloads.push(row);
	});
	pi.on("message_end", (event) => {
		if ((!pending.length && !downloads.length) || event.message.role !== "assistant") return;
		const text = removeUntrustedHtmlPreview(event.message.content.filter((part) => part.type === "text").map((part) => part.text || "").join("\n"));
		const links = downloads.filter((item) => !text.includes(item.url)).map((item) => `- [${item.label}](${item.url})`);
		const delivery = links.length ? `## Files\n\n${links.join("\n")}` : "";
		const previews = pending.filter((markup) => !text.includes(markup)).join("\n\n");
		return { message: { ...event.message, content: [{ type: "text", text: [text, delivery, previews].filter(Boolean).join("\n\n").trim() }] } };
	});
}
