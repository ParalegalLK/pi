import { env, requiredEnv } from "../core/environment.mjs";
import { describeArtifact, inputFile, operationDirectory, saveRemoteFile, stripServiceFileLinks } from "../core/files.mjs";
import { requestJson } from "../core/http.mjs";

export async function draftOrRevise(args, { onProgress = () => {} } = {}) {
	const attachments = [];
	onProgress("Preparing the drafting instructions and source documents…");
	for (const filename of args.source_files || []) {
		const file = await inputFile(filename);
		attachments.push({ name: file.name, base64: file.base64 });
	}
	const operation = await operationDirectory("draft");
	const base = env("DRAFTER_BASE_URL", "http://127.0.0.1:8033").replace(/\/$/, "");
	onProgress("Drafter Weeramantry is drafting or revising the document…");
	const response = await requestJson(`${base}/tool/draft`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${requiredEnv("DRAFTER_API_KEY")}` },
		body: JSON.stringify({ conversation_id: args.conversation_id || operation.id, message: args.instruction, attachments }),
	}, "Drafter Weeramantry", Number(env("DRAFTER_REQUEST_TIMEOUT_MS", "1200000")));
	const files = [...(response.files || [])];
	if (!files.length && response.workspace_token) {
		for (const name of new Set((response.reply || "").match(/\b[A-Za-z0-9][A-Za-z0-9._ -]*\.(?:docx|md|pdf)\b/gi) || [])) files.push({ name, url: `/files/${response.workspace_token}/${name}` });
	}
	const saved = [];
	onProgress("Collecting the completed drafting artifacts…");
	for (const [index, file] of files.entries()) {
		if (!file.url) continue;
		try { saved.push(await saveRemoteFile(operation.directory, file, base, index)); }
		catch (error) { saved.push(`Download failed for ${file.name || file.url}: ${error instanceof Error ? error.message : String(error)}`); }
	}
	const validFiles = saved.filter((item) => typeof item === "string" && !item.startsWith("Download failed"));
	return {
		operation_id: operation.id,
		response: stripServiceFileLinks(response.reply || "Drafting completed."),
		artifacts: validFiles.map((item) => describeArtifact(item, operation.id)),
		download_errors: saved.filter((item) => typeof item === "string" && item.startsWith("Download failed")),
		render_errors: response.render_errors || [],
	};
}
