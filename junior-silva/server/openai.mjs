#!/usr/bin/env node
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { artifactsRoot, env, projectRoot, requiredEnv, uploadsRoot } from "../core/environment.mjs";
import { mimeType, resolveArtifactRequest, safeFilename } from "../core/files.mjs";

const PORT = Number(env("JUNIOR_SILVA_PORT", "8126"));
const HOST = env("JUNIOR_SILVA_BIND_HOST", "127.0.0.1");
const MODEL = env("JUNIOR_SILVA_MODEL_NAME", "junior-silva-v2");
const API_KEY = requiredEnv("JUNIOR_SILVA_API_KEY");
const MAX_BODY = Number(env("JUNIOR_SILVA_MAX_BODY_BYTES", String(60 * 1024 * 1024)));
const MAX_FILE = Number(env("JUNIOR_SILVA_MAX_FILE_BYTES", String(50 * 1024 * 1024)));
const SESSION_ROOT = path.join(path.dirname(artifactsRoot), "sessions");
const AGENT_ROOT = path.resolve(env("PI_CODING_AGENT_DIR", path.join(path.dirname(artifactsRoot), "pi-agent")));
const PI_CLI = path.join(projectRoot, "packages", "coding-agent", "dist", "bundle", "cli.js");
const ATTACHMENT_ORIGINS = new Set(env("JUNIOR_SILVA_ATTACHMENT_ORIGINS").split(",").map((item) => item.trim()).filter(Boolean));

function json(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
	res.end(body);
}

function authorized(req) {
	const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
	const left = Buffer.from(supplied);
	const right = Buffer.from(API_KEY);
	return left.length === right.length && timingSafeEqual(left, right);
}

async function requestBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY) throw Object.assign(new Error("Request exceeds the configured upload limit"), { status: 413 });
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function messageText(message = {}) {
	if (typeof message.content === "string") return message.content.trim();
	if (!Array.isArray(message.content)) return "";
	return message.content.filter((item) => item?.type === "text" || item?.type === "input_text").map((item) => item.text || item.input_text || "").join("\n").trim();
}

function splitTextEnvelope(value = "") {
	const input = String(value || "");
	const opener = /^Attached document\(s\):\s*\r?\n```(?:markdown|md)?(?:\r?\n|(?=#\s+"))/i.exec(input);
	if (!opener) return { instruction: input.trim(), files: [] };
	const closing = input.lastIndexOf("\n```");
	if (closing < opener[0].length) return { instruction: input.trim(), files: [] };
	const body = input.slice(opener[0].length, closing).trim();
	const instruction = input.slice(closing + 4).trim();
	const files = body.split(/\n\n---\n\n(?=#\s+")/g).map((section) => {
		const match = section.match(/^#\s+"([^"]+)"\s*\n([\s\S]*)$/);
		return match ? { name: safeFilename(match[1], "uploaded-document.md"), text: match[2].trim() } : undefined;
	}).filter(Boolean);
	return { instruction, files };
}

function textUploads(messages = []) {
	const users = messages.filter((item) => item?.role === "user");
	const latest = messageText(users.at(-1) || {});
	const direct = splitTextEnvelope(latest);
	if (direct.files.length) return direct;
	for (let index = users.length - 2; index >= 0; index -= 1) {
		const candidate = splitTextEnvelope(messageText(users[index]));
		if (candidate.files.length) return { instruction: latest || candidate.instruction, files: candidate.files };
	}
	return { instruction: latest, files: [] };
}

function fileCandidates(body) {
	const output = [];
	const add = (item = {}) => {
		const nested = [item.image_url, item.file_url, item.document_url, item.file].find((value) => value && typeof value === "object") || {};
		const url = item.url || item.data || item.file_data || item.base64 || nested.url || nested.file_data;
		if (typeof url === "string" && url) output.push({ url, name: item.name || item.filename || nested.filename || nested.name });
	};
	for (const item of Array.isArray(body.attachments) ? body.attachments : []) add(item);
	for (const item of Array.isArray(body.files) ? body.files : []) add(item);
	for (const message of Array.isArray(body.messages) ? body.messages : []) {
		for (const item of Array.isArray(message?.attachments) ? message.attachments : []) add(item);
		for (const item of Array.isArray(message?.files) ? message.files : []) add(item);
		for (const item of Array.isArray(message?.content) ? message.content : []) if (item?.type !== "text" && item?.type !== "input_text") add(item);
	}
	return output;
}

function extensionForMime(mime = "") {
	return ({ "application/pdf": ".pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx", "application/msword": ".doc", "image/png": ".png", "image/jpeg": ".jpg" })[mime] || ".bin";
}

async function fetchFile(candidate) {
	if (candidate.url.startsWith("data:")) {
		const match = candidate.url.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
		if (!match) throw new Error("Invalid uploaded data URL");
		const bytes = candidate.url.includes(";base64,") ? Buffer.from(match[2], "base64") : Buffer.from(decodeURIComponent(match[2]));
		if (bytes.length > MAX_FILE) throw new Error("Uploaded file exceeds the configured limit");
		return { bytes, filename: safeFilename(candidate.name, `uploaded-document${extensionForMime(match[1])}`) };
	}
	const parsed = new URL(candidate.url);
	if (!ATTACHMENT_ORIGINS.has(parsed.origin)) throw new Error(`Attachment origin ${parsed.origin} is not allowlisted`);
	const response = await fetch(parsed, { redirect: "error", signal: AbortSignal.timeout(30_000) });
	if (!response.ok) throw new Error(`Could not retrieve uploaded file (${response.status})`);
	const declared = Number(response.headers.get("content-length") || 0);
	if (declared > MAX_FILE) throw new Error("Uploaded file exceeds the configured limit");
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.length > MAX_FILE) throw new Error("Uploaded file exceeds the configured limit");
	return { bytes, filename: safeFilename(candidate.name || path.basename(parsed.pathname), `uploaded-document${extensionForMime(response.headers.get("content-type"))}`) };
}

function conversationKey(req, body) {
	const conversation = req.headers["x-librechat-conversation-id"] || body.conversationId || body.conversation_id;
	const user = req.headers["x-librechat-user-id"] || "anonymous";
	const stable = conversation || createHash("sha256").update(JSON.stringify(body.messages || [])).digest("hex").slice(0, 24);
	return createHmac("sha256", API_KEY).update(`${user}:${stable}`).digest("hex").slice(0, 32);
}

async function saveUploads(key, candidates, extracted) {
	const directory = path.join(uploadsRoot, key);
	await mkdir(directory, { recursive: true });
	const paths = [];
	for (const candidate of candidates) {
		const file = await fetchFile(candidate);
		const destination = path.join(directory, `${randomUUID().slice(0, 8)}-${file.filename}`);
		await writeFile(destination, file.bytes);
		paths.push(destination);
	}
	for (const file of extracted) {
		const destination = path.join(directory, `${randomUUID().slice(0, 8)}-${safeFilename(file.name).replace(/\.[^.]+$/, "")}.md`);
		await writeFile(destination, file.text, "utf8");
		paths.push(destination);
	}
	return paths;
}

function piPrompt(instruction, files) {
	if (!files.length) return instruction;
	return `The user supplied these local document files with this request:\n${files.map((item) => `- ${item}`).join("\n")}\n\nUser request:\n${instruction || "Examine the supplied legal documents and respond appropriately."}`;
}

function progressName(toolName) {
	return ({ reviewer_perera_start_review: "Reviewer Perera is reading the supplied document set…", reviewer_perera_continue_review: "Reviewer Perera is applying the user's answers…", reviewer_perera_get_findings: "Retrieving Reviewer Perera's clause findings…", rag_chat_research: "Researching Sri Lankan legal authorities and linked citations…", drafter_weeramantry_draft_or_revise: "Drafter Weeramantry is preparing the legal document…", translator_siriwardena_translate_document: "Translator Siriwardena is translating the document…", translator_siriwardena_translate_text: "Translator Siriwardena is translating the supplied text…", librechat_prepare_document_preview: "Preparing a local document preview…" })[toolName] || `Using ${toolName || "a specialist tool"}…`;
}

async function runPi(prompt, sessionId, onProgress) {
	// The hosted surface exposes the legal MCP tools, never Pi's shell/edit tools.
	// Full Pi remains available through the Windows and Docker CLI launchers.
	const args = [
		PI_CLI,
		"--mode", "json", "--no-builtin-tools", "--session-id", sessionId,
		// Project extensions are explicit so the hosted endpoint behaves exactly
		// like the local CLI, even when Pi's discovery configuration changes.
		"--extension", path.join(projectRoot, ".pi", "extensions", "legal-research-citation-delivery.ts"),
		"--extension", path.join(projectRoot, ".pi", "extensions", "librechat-preview-delivery.ts"),
	];
	if (env("PI_PROVIDER")) args.push("--provider", env("PI_PROVIDER"));
	if (env("PI_MODEL")) args.push("--model", env("PI_MODEL"));
	if (env("PI_THINKING")) args.push("--thinking", env("PI_THINKING"));
	args.push(prompt);
	await mkdir(SESSION_ROOT, { recursive: true });
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, args, { cwd: projectRoot, env: { ...process.env, PI_CODING_AGENT_SESSION_DIR: SESSION_ROOT, PI_SKIP_VERSION_CHECK: "1" }, stdio: ["ignore", "pipe", "pipe"] });
		let buffer = "";
		let stderr = "";
		let finalText = "";
		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() || "";
			for (const line of lines) {
				try {
					const event = JSON.parse(line);
					if (event.type === "agent_start") onProgress("Pi is planning the requested work…");
					if (event.type === "tool_execution_start") onProgress(progressName(event.toolName || event.tool_name));
					if (event.type === "tool_execution_update") {
						const message = event.partialResult?.details?.progress || event.partial_result?.details?.progress || event.partialResult?.content?.find?.((part) => part.type === "text")?.text;
						if (typeof message === "string" && message.trim()) onProgress(message.trim().slice(0, 500));
					}
					if (event.type === "tool_execution_end" && event.isError) onProgress("A specialist tool reported a problem; Pi is deciding the next safe step…");
					if (event.type === "message_end" && event.message?.role === "assistant") finalText = (event.message.content || []).filter((part) => part.type === "text").map((part) => part.text || "").join("\n");
				} catch { }
			}
		});
		child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString()}`.slice(-12_000); });
		const timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Pi request timed out")); }, Number(env("JUNIOR_SILVA_PI_TIMEOUT_MS", "1200000")));
		child.on("error", (error) => { clearTimeout(timeout); reject(error); });
		child.on("close", (code) => {
			clearTimeout(timeout);
			if (code !== 0) return reject(new Error(`Pi exited with code ${code}: ${stderr.replace(/\s+/g, " ").slice(0, 1200)}`));
			if (!finalText.trim()) return reject(new Error("Pi returned no final answer"));
			resolve(finalText.trim());
		});
	});
}

const queues = new Map();
function serial(key, task) {
	const previous = queues.get(key) || Promise.resolve();
	const current = previous.catch(() => {}).then(task).finally(() => { if (queues.get(key) === current) queues.delete(key); });
	queues.set(key, current);
	return current;
}

function startStream(res, id) {
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
	res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
}

function streamDelta(res, id, field, value) {
	if (!value || res.writableEnded) return;
	res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL, choices: [{ index: 0, delta: { [field]: value }, finish_reason: null }] })}\n\n`);
}

function finishStream(res, id, answer) {
	for (let offset = 0; offset < answer.length; offset += 1200) streamDelta(res, id, "content", answer.slice(offset, offset + 1200));
	res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
	res.end("data: [DONE]\n\n");
}

async function serveArtifact(res, pathname) {
	const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
	if (parts.length !== 4 || parts[0] !== "files") return json(res, 404, { error: "Not found" });
	const target = resolveArtifactRequest(parts[1], parts[2], parts[3]);
	if (!target || !existsSync(target)) return json(res, 404, { error: "Not found" });
	const bytes = await readFile(target);
	res.writeHead(200, { "Content-Type": mimeType(target), "Content-Length": bytes.length, "Content-Disposition": `attachment; filename="${safeFilename(path.basename(target))}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
	res.end(bytes);
}

await Promise.all([mkdir(artifactsRoot, { recursive: true }), mkdir(uploadsRoot, { recursive: true }), mkdir(SESSION_ROOT, { recursive: true }), mkdir(AGENT_ROOT, { recursive: true })]);
// Hosted mode uses an administrator-owned global MCP registration. It does not
// bypass Pi's project-trust prompt or approve arbitrary project-local code.
await writeFile(path.join(AGENT_ROOT, "mcp.json"), `${JSON.stringify({
	mcpServers: {
		"junior-silva-legal": {
			command: process.execPath,
			args: [path.join(projectRoot, "junior-silva", "mcp", "server.mjs")],
			cwd: projectRoot,
			exposure: "direct",
			timeout: 1200,
			description: "Independent legal research, interactive review, drafting, and translation tools.",
		},
	},
}, null, 2)}\n`, "utf8");
const server = createServer(async (req, res) => {
	let heartbeat;
	try {
		const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
		if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { status: "ok", service: MODEL, pi: "1.0.0" });
		if (req.method === "GET" && url.pathname === "/ready") return json(res, 200, { ready: existsSync(PI_CLI), mcp: existsSync(path.join(projectRoot, ".pi", "mcp.json")) });
		if (req.method === "GET" && url.pathname.startsWith("/files/")) return serveArtifact(res, url.pathname);
		if (url.pathname.startsWith("/v1/") && !authorized(req)) return json(res, 401, { error: { message: "Unauthorized", type: "authentication_error" } });
		if (req.method === "GET" && url.pathname === "/v1/models") return json(res, 200, { object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "paralegal.lk" }] });
		if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
			const body = await requestBody(req);
			const messages = Array.isArray(body.messages) ? body.messages : [];
			const uploadText = textUploads(messages);
			const candidates = fileCandidates(body);
			if (!uploadText.instruction && !uploadText.files.length && !candidates.length) return json(res, 400, { error: { message: "A user message or document is required", type: "invalid_request_error" } });
			const key = conversationKey(req, body);
			const files = await saveUploads(key, candidates, uploadText.files);
			const id = `chatcmpl-${randomUUID()}`;
			const streaming = body.stream !== false;
			if (streaming) { startStream(res, id); heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000); }
			const answer = await serial(key, () => runPi(piPrompt(uploadText.instruction, files), `junior-silva-v2-${key}`, (message) => { if (streaming) streamDelta(res, id, "reasoning_content", `${message}\n`); }));
			if (heartbeat) clearInterval(heartbeat);
			if (streaming) return finishStream(res, id, answer);
			return json(res, 200, { id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }] });
		}
		return json(res, 404, { error: { message: "Not found", type: "invalid_request_error" } });
	} catch (error) {
		if (heartbeat) clearInterval(heartbeat);
		console.error(`[junior-silva-v2] ${error?.stack || error}`);
		const status = Number(error?.status || 500);
		const message = status < 500 ? error.message : "Junior Silva could not complete this request. Please retry or contact the administrator.";
		if (!res.headersSent) return json(res, status, { error: { message, type: "junior_silva_error" } });
		if (!res.writableEnded) { streamDelta(res, `chatcmpl-${randomUUID()}`, "content", message); res.end("data: [DONE]\n\n"); }
	}
});

server.listen(PORT, HOST, () => console.log(`[junior-silva-v2] listening on ${HOST}:${PORT}`));

export { fileCandidates, messageText, splitTextEnvelope, textUploads };
