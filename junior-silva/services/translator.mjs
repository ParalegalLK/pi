import path from "node:path";
import { env, requiredEnv } from "../core/environment.mjs";
import { describeArtifact, inputFile, markdownLinks, operationDirectory, safeFilename, saveRemoteFile, stripServiceFileLinks } from "../core/files.mjs";
import { requestCompletion } from "../core/http.mjs";

const translatorBase = () => env("TRANSLATOR_BASE_URL", "https://www.devtranslate.paralegal.lk/api").replace(/\/$/, "");
const OUTPUT_EXTENSIONS = new Set([".pdf", ".docx", ".md", ".txt"]);

export function translatedOutputName(link, index = 0) {
	const parsed = new URL(link.url, translatorBase());
	const remotePath = parsed.searchParams.get("file") || parsed.searchParams.get("filename") || parsed.pathname;
	const candidate = safeFilename(path.basename(remotePath.replaceAll("\\", "/")), "");
	if (candidate && OUTPUT_EXTENSIONS.has(path.extname(candidate).toLowerCase())) return candidate;
	const label = String(link.label || "").toLowerCase();
	const extension = label.includes("docx") ? ".docx" : label.includes("pdf") ? ".pdf" : label.includes("markdown") || label.includes("text") ? ".md" : ".bin";
	return `translated-document-${index + 1}${extension}`;
}

function visibleResponse(value) {
	return String(value || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}
async function translate(content, sourcePath, onProgress = () => {}) {
	const parts = [{ type: "text", text: content }];
	if (sourcePath) {
		const file = await inputFile(sourcePath);
		parts.push({ type: "file", file: { filename: file.name, mime_type: "application/octet-stream", file_data: `data:application/octet-stream;base64,${file.base64}` } });
	}
	return requestCompletion(`${translatorBase()}/v1/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${requiredEnv("TRANSLATOR_API_KEY")}` },
		body: JSON.stringify({ model: "translate-chat", stream: true, messages: [{ role: "user", content: parts }] }),
	}, "Translator Siriwardena", 1_200_000, onProgress);
}
export async function translateText(args, { onProgress = () => {} } = {}) {
	onProgress(`Translator Siriwardena is translating the supplied text to ${args.target_language}…`);
	return { translation: await translate(`Translate the following text to ${args.target_language}.\n\n${args.text}`, undefined, onProgress) };
}
export async function translateDocument(args, { onProgress = () => {} } = {}) {
	const operation = await operationDirectory("translation");
	onProgress(`Translator Siriwardena is translating the document to ${args.target_language}…`);
	const response = visibleResponse(await translate(`${args.instructions || "Translate this document"}\nTarget language: ${args.target_language}`, args.file_path, onProgress));
	const files = [];
	onProgress("Collecting the translated document artifacts…");
	for (const [index, link] of markdownLinks(response).entries()) {
		try { files.push(await saveRemoteFile(operation.directory, { name: translatedOutputName(link, index), url: link.url }, translatorBase(), index)); }
		catch { /* Keep the translated text if an optional file download fails. */ }
	}
	return { operation_id: operation.id, response: stripServiceFileLinks(response), artifacts: files.map((item) => describeArtifact(item, operation.id)) };
}
