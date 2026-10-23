#!/usr/bin/env node
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { artifactsRoot, env, projectRoot, requiredEnv, uploadsRoot, workspaceRoot } from "../core/environment.mjs";
import { mimeType, resolveArtifactRequest, safeFilename } from "../core/files.mjs";
import { dispatchMcpRequest } from "../mcp/server.mjs";
import { addAssistantUsage, createUsageTotals, openAiUsage, requestsStreamUsage } from "./usage.mjs";

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
const auditRoot = path.join(path.dirname(artifactsRoot), "audit");

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

async function conversationUploadPaths(key) {
	const directory = path.join(uploadsRoot, key);
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		return entries.filter((entry) => entry.isFile()).map((entry) => path.join(directory, entry.name)).sort();
	} catch (caught) {
		if (caught && typeof caught === "object" && "code" in caught && caught.code === "ENOENT") return [];
		throw caught;
	}
}

function piPrompt(instruction, files) {
	if (!files.length) return instruction;
	return `The user supplied these local document files with this request:\n${files.map((item) => `- ${item}`).join("\n")}\n\nUser request:\n${instruction || "Examine the supplied legal documents and respond appropriately."}`;
}

const safeToolProgress = Object.freeze({
	review_prepare_document_set: "Reading the supplied documents and identifying the material clauses…",
	review_record_checkpoint_outcome: "Recording the additional information provided for this review…",
	review_finalize_document: "Validating the findings against the source clauses and preparing the annotated review…",
	legal_precedent_search: "Consulting approved drafting patterns to improve the document structure…",
	legal_precedent_read: "Checking a relevant drafting pattern for the requested legal document…",
	legal_validate_draft: "Checking the legal draft for unresolved details and basic completeness…",
	rag_chat_research: "Researching Sri Lankan legal authorities and checking the cited sources…",
	web_search_public_legal_sources: "Checking current public legal sources and recent developments…",
	translator_siriwardena_translate_document: "Translating the document while preserving its legal meaning…",
	translator_siriwardena_translate_text: "Translating the supplied text while preserving its legal meaning…",
	code_runner_data_transform: "Calculating and organising the requested legal information…",
	workbench_publish_artifact: "Preparing the completed file for secure download…",
	librechat_prepare_document_preview: "Preparing an in-chat preview of the completed document…",
});

const knownToolNames = new Set([
	...Object.keys(safeToolProgress),
	"legal_source_retrieve_details",
]);

function normalisedToolName(toolName) {
	const raw = String(toolName || "");
	return [...knownToolNames].find((name) => raw === name || raw.endsWith(`__${name}`)) || raw;
}

// This is deliberately a closed vocabulary. Pi tool arguments can contain user
// material, filesystem locations, URLs, and secrets, so thought messages may
// inspect only enumerated operation values and must never interpolate them.
function safeOperation(args) {
	const operation = typeof args?.operation === "string" ? args.operation : "";
	return ["case_catalog", "amendment_catalog", "capabilities", "facet_values", "retrieve"].includes(operation) ? operation : "";
}

export function safeProgressName(toolName, args = undefined) {
	const normalized = normalisedToolName(toolName);
	if (normalized === "legal_source_retrieve_details") {
		switch (safeOperation(args)) {
			case "case_catalog": return "Searching the Sri Lankan case records using the relevant legal filters…";
			case "amendment_catalog": return "Checking the structured legislation record for the relevant amendments…";
			case "capabilities":
			case "facet_values": return "Checking the available Sri Lankan legal records for matching entries…";
			case "retrieve": return "Reading the selected Sri Lankan legal source record for the necessary detail…";
			default: return "Retrieving the relevant Sri Lankan legal source material…";
		}
	}
	if (safeToolProgress[normalized]) return safeToolProgress[normalized];
	if (/^(bash|shell|terminal|exec|run_command)$/i.test(normalized)) return "Preparing the requested legal document and checking its structure…";
	if (/^(read|read_file|list|find|glob|grep|search_files)$/i.test(normalized)) return "Reading the supplied material and identifying the points that matter…";
	if (/^(write|edit|create_file|apply_patch)$/i.test(normalized)) return "Preparing the requested legal document and checking its structure…";
	if (/skill/i.test(normalized)) return "Applying the relevant legal work guidance to this request…";
	return "Completing the next safe step for your legal request…";
}

export function safeFailureProgress(toolName) {
	const normalized = normalisedToolName(toolName);
	if (normalized === "web_search_public_legal_sources") return "I couldn’t complete one current-source check. I’m assessing another reliable legal source before continuing…";
	if (["rag_chat_research", "legal_source_retrieve_details"].includes(normalized)) return "I couldn’t complete one legal-source check. I’m assessing the available authorities before deciding the next step…";
	if (["review_prepare_document_set", "review_record_checkpoint_outcome", "review_finalize_document"].includes(normalized)) return "I couldn’t complete one review-processing step as expected. I’m checking the source material before continuing…";
	if (["workbench_publish_artifact", "librechat_prepare_document_preview"].includes(normalized)) return "I couldn’t complete one file-preparation step as expected. I’m checking a safe alternative before continuing…";
	if (/^(bash|shell|terminal|exec|run_command|write|edit|create_file|apply_patch)$/i.test(normalized)) return "I couldn’t complete one document-preparation step as expected. I’m checking a safe alternative before continuing…";
	if (/translator/i.test(normalized)) return "I couldn’t complete the translation step as expected. I’m checking the source material before deciding the next step…";
	return "I couldn’t complete one step as expected. I’m assessing the safest next step before continuing…";
}

export function createThoughtReporter(onProgress) {
	let last = "";
	return (message) => {
		if (!message || message === last) return false;
		last = message;
		onProgress(message);
		return true;
	};
}

function thoughtPhaseForTool(toolName, args = undefined) {
	const normalized = normalisedToolName(toolName);
	if (normalized === "legal_source_retrieve_details") return `legal_source:${safeOperation(args) || "retrieve"}`;
	if (/^(bash|shell|terminal|exec|run_command|write|edit|create_file|apply_patch)$/i.test(normalized)) return "document_preparation";
	if (/^(read|read_file|list|find|glob|grep|search_files)$/i.test(normalized)) return "source_reading";
	if (/skill/i.test(normalized)) return "legal_guidance";
	return normalized || "safe_step";
}

function thoughtFailurePhase(toolName) {
	const normalized = normalisedToolName(toolName);
	if (/^(bash|shell|terminal|exec|run_command|write|edit|create_file|apply_patch)$/i.test(normalized)) return "recovery:document_preparation";
	if (/^(read|read_file|list|find|glob|grep|search_files)$/i.test(normalized)) return "recovery:source_reading";
	return `recovery:${thoughtPhaseForTool(normalized)}`;
}

function isDocumentPreparationTool(toolName) {
	return /^(bash|shell|terminal|exec|run_command|write|edit|create_file|apply_patch)$/i.test(normalisedToolName(toolName));
}

function livenessThought(phase, milestone) {
	const subject = phase.includes("document") ? "requested document" :
		phase.includes("review") ? "legal review" :
		phase.includes("translation") ? "translation" :
		phase.includes("source") || phase === "rag_chat_research" || phase === "web_search_public_legal_sources" ? "legal-source check" :
		"requested legal work";
	if (milestone === 20_000) return `The ${subject} is still being prepared…`;
	if (milestone === 60_000) return `The current ${subject} step is taking longer than usual; I’m continuing the required checks…`;
	return `Still working on the ${subject} and waiting for this preparation step to finish…`;
}

// Pi can generate several low-level events for one logical task (for example,
// read -> write -> shell conversion -> retry). LibreChat should describe the
// user-visible phase once, rather than narrate every implementation detail.
// This controller deliberately knows only a closed vocabulary of phases and
// never reads tool arguments, outputs, paths, command text, or error details.
export function createThoughtController(onProgress, { now = () => Date.now() } = {}) {
	const report = createThoughtReporter(onProgress);
	const emittedPhases = new Set();
	const livenessMilestones = [20_000, 60_000, 120_000];
	let activePhase = "planning";
	let activeSince = now();
	let emittedLiveness = new Set();
	let failedDocumentTool = "";

	function activate(phase) {
		activePhase = phase;
		activeSince = now();
		emittedLiveness = new Set();
	}

	return {
		handle(event = {}) {
			if (event.type === "agent_start") {
				activate("planning");
				if (emittedPhases.has("planning")) return false;
				emittedPhases.add("planning");
				return report("I’m reviewing your request and planning the legal work…");
			}

			const tool = event.toolName || event.tool_name;
			if (event.type === "tool_execution_start") {
				const normalized = normalisedToolName(tool);
				if (failedDocumentTool && isDocumentPreparationTool(normalized) && normalized !== failedDocumentTool) {
					failedDocumentTool = "";
					activate("document_recovery");
					if (emittedPhases.has("document_recovery")) return false;
					emittedPhases.add("document_recovery");
					return report("Trying a compatible document-generation method…");
				}
				const phase = thoughtPhaseForTool(normalized, event.args);
				activate(phase);
				if (emittedPhases.has(phase)) return false;
				emittedPhases.add(phase);
				return report(safeProgressName(tool, event.args));
			}

			if (event.type === "tool_execution_end" && event.isError) {
				const phase = thoughtFailurePhase(tool);
				if (isDocumentPreparationTool(tool)) failedDocumentTool = normalisedToolName(tool);
				activate(phase);
				if (emittedPhases.has(phase)) return false;
				emittedPhases.add(phase);
				return report(safeFailureProgress(tool));
			}
			return false;
		},
		tick() {
			const elapsed = now() - activeSince;
			const milestone = livenessMilestones.find((value) => elapsed >= value && !emittedLiveness.has(value));
			if (!milestone) return false;
			emittedLiveness.add(milestone);
			return report(livenessThought(activePhase, milestone));
		},
	};
}

export function safeThoughtForPiEvent(event = {}) {
	if (event.type === "agent_start") return "I’m reviewing your request and planning the legal work…";
	const tool = event.toolName || event.tool_name;
	if (event.type === "tool_execution_start") return safeProgressName(tool, event.args);
	if (event.type === "tool_execution_end" && event.isError) return safeFailureProgress(tool);
	return undefined;
}

function safeAuditToolName(toolName) {
	const raw = String(toolName || "unknown");
	const normalized = normalisedToolName(raw);
	return (knownToolNames.has(normalized) ? normalized : undefined) ||
		(/^(bash|shell|terminal|exec|run_command)$/i.test(raw) ? "builtin_command" :
			/^(read|read_file|list|find|glob|grep|search_files)$/i.test(raw) ? "builtin_read" :
			/^(write|edit|create_file|apply_patch)$/i.test(raw) ? "builtin_write" : "builtin_or_unrecognized");
}

function agentEnvironment() {
	const output = {
		PATH: process.env.PATH || "",
		HOME: process.env.HOME || "",
		LANG: process.env.LANG || "C.UTF-8",
		TERM: process.env.TERM || "xterm-256color",
		TZ: "Asia/Colombo",
		PI_CODING_AGENT_SESSION_DIR: SESSION_ROOT,
		PI_CODING_AGENT_DIR: AGENT_ROOT,
		PI_SKIP_VERSION_CHECK: "1",
		JUNIOR_SILVA_MCP_GATEWAY_URL: `http://127.0.0.1:${PORT}/internal/mcp`,
		JUNIOR_SILVA_DATA_ROOT: path.dirname(artifactsRoot),
		JUNIOR_SILVA_ARTIFACT_ROOT: artifactsRoot,
		JUNIOR_SILVA_UPLOAD_ROOT: uploadsRoot,
		JUNIOR_SILVA_WORKSPACE_ROOT: workspaceRoot,
	};
	const provider = env("PI_PROVIDER", "google");
	if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) output.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
	if (provider === "google" && process.env.GEMINI_API_KEY) output.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
	return output;
}

function loopback(req) {
	return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(String(req.socket.remoteAddress || ""));
}

async function audit(sessionId, event) {
	await mkdir(auditRoot, { recursive: true });
	const line = JSON.stringify({ at: new Date().toISOString(), sessionId, ...event });
	await appendFile(path.join(auditRoot, `${sessionId}.jsonl`), `${line}\n`, "utf8");
}

async function sessionFileSizes() {
	const sizes = new Map();
	try {
		const entries = await readdir(SESSION_ROOT, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			const file = path.join(SESSION_ROOT, entry.name);
			sizes.set(file, (await stat(file)).size);
		}
	} catch (caught) {
		if (caught?.code !== "ENOENT") throw caught;
	}
	return sizes;
}

async function appendedSessionUsage(sizesBefore) {
	const totals = createUsageTotals();
	let changedFiles = 0;
	try {
		const entries = await readdir(SESSION_ROOT, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			const file = path.join(SESSION_ROOT, entry.name);
			const offset = sizesBefore.get(file) || 0;
			if ((await stat(file)).size <= offset) continue;
			changedFiles += 1;
			const contents = await readFile(file);
			for (const line of contents.subarray(offset).toString("utf8").split(/\r?\n/)) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line);
					if (event.type === "message" && event.message?.role === "assistant") addAssistantUsage(totals, event.message.usage);
				} catch { }
			}
		}
	} catch (caught) {
		if (caught?.code !== "ENOENT") throw caught;
	}
	return changedFiles === 1 ? totals : undefined;
}

async function runPi(prompt, sessionId, onProgress) {
	// Hosted Pi uses administrator-owned legal MCP registration. Its normal built-in
	// tools remain subject to the legal-scope extension and deployment sandbox.
	const args = [
		PI_CLI,
		"--mode", "json", "--approve", "--session-id", sessionId,
		// Project extensions are explicit so the hosted endpoint behaves exactly
		// like the local CLI, even when Pi's discovery configuration changes.
		"--extension", path.join(projectRoot, ".pi", "extensions", "junior-silva-legal-context.ts"),
		"--extension", path.join(projectRoot, ".pi", "extensions", "junior-silva-scope-guard.ts"),
		"--extension", path.join(projectRoot, ".pi", "extensions", "legal-research-citation-delivery.ts"),
		"--extension", path.join(projectRoot, ".pi", "extensions", "librechat-preview-delivery.ts"),
	];
	if (env("PI_PROVIDER")) args.push("--provider", env("PI_PROVIDER"));
	if (env("PI_MODEL")) args.push("--model", env("PI_MODEL"));
	if (env("PI_THINKING")) args.push("--thinking", env("PI_THINKING"));
	args.push(prompt);
	await mkdir(SESSION_ROOT, { recursive: true });
	const sessionSizesBefore = await sessionFileSizes();
	const startedAt = Date.now();
	const thoughtController = createThoughtController(onProgress);
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, args, { cwd: projectRoot, env: agentEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
		// The service-level SSE keepalive is intentionally invisible. This bounded
		// timer is different: it tells the user that Pi is still alive when a
		// legitimate document or research step produces no lifecycle event.
		const thoughtLivenessTimer = setInterval(() => thoughtController.tick(), 5_000);
		let buffer = "";
		let stderr = "";
		let finalText = "";
		const usageTotals = createUsageTotals();
		const usageResponseIds = new Set();
		const recordAssistantUsage = (message) => {
			if (!message?.usage) return;
			const key = message.responseId || `${message.timestamp || ""}:${message.usage.totalTokens || ""}:${message.usage.input || ""}:${message.usage.output || ""}`;
			if (usageResponseIds.has(key)) return;
			usageResponseIds.add(key);
			addAssistantUsage(usageTotals, message.usage);
		};
		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() || "";
			for (const line of lines) {
				try {
					const event = JSON.parse(line);
					if (event.type === "message_update" && event.assistantMessageEvent?.type === "message_end") {
						recordAssistantUsage({ ...event.assistantMessageEvent.message, usage: event.usage });
					}
					if (event.type === "message_end" && event.message?.role === "custom" && event.message?.customType === "junior-silva-scope" && typeof event.message?.content === "string") finalText = event.message.content;
					thoughtController.handle(event);
					if (event.type === "tool_execution_start") {
						const tool = event.toolName || event.tool_name;
						void audit(sessionId, { type: "tool", tool: safeAuditToolName(tool), status: "started" }).catch(() => {});
					}
					// Never relay update payloads: built-in tools can include shell output,
					// files, URLs, source text, credentials, or internal service responses.
					if (event.type === "tool_execution_end") {
						const tool = event.toolName || event.tool_name;
						void audit(sessionId, { type: "tool", tool: safeAuditToolName(tool), status: event.isError ? "error" : "completed" }).catch(() => {});
					}
					if (event.type === "message" && event.message?.role === "assistant") recordAssistantUsage(event.message);
					if (event.type === "message_end" && event.message?.role === "assistant") {
						finalText = (event.message.content || []).filter((part) => part.type === "text").map((part) => part.text || "").join("\n");
						recordAssistantUsage(event.message);
					}
				} catch { }
			}
		});
		child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString()}`.slice(-12_000); });
		const timeout = setTimeout(() => { clearInterval(thoughtLivenessTimer); child.kill("SIGTERM"); reject(new Error("Pi request timed out")); }, Number(env("JUNIOR_SILVA_PI_TIMEOUT_MS", "1200000")));
		child.on("error", (error) => { clearTimeout(timeout); clearInterval(thoughtLivenessTimer); reject(error); });
		child.on("close", (code) => {
			clearTimeout(timeout);
			clearInterval(thoughtLivenessTimer);
			if (code !== 0) return reject(new Error(`Pi exited with code ${code}: ${stderr.replace(/\s+/g, " ").slice(0, 1200)}`));
			if (!finalText.trim()) return reject(new Error("Pi returned no final answer"));
			void appendedSessionUsage(sessionSizesBefore).then((persistedUsage) => {
				resolve({ answer: finalText.trim(), usage: openAiUsage(persistedUsage) || openAiUsage(usageTotals), elapsedMs: Date.now() - startedAt });
			}).catch(reject);
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

function finishStream(res, id, answer, usage) {
	for (let offset = 0; offset < answer.length; offset += 1200) streamDelta(res, id, "content", answer.slice(offset, offset + 1200));
	res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
	if (usage) res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL, choices: [], usage })}\n\n`);
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

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
await Promise.all([mkdir(artifactsRoot, { recursive: true }), mkdir(uploadsRoot, { recursive: true }), mkdir(workspaceRoot, { recursive: true }), mkdir(SESSION_ROOT, { recursive: true }), mkdir(AGENT_ROOT, { recursive: true }), mkdir(auditRoot, { recursive: true })]);
// Hosted mode uses an administrator-owned global MCP registration. It does not
// bypass Pi's project-trust prompt or approve arbitrary project-local code.
await writeFile(path.join(AGENT_ROOT, "mcp.json"), `${JSON.stringify({
	mcpServers: {
		"junior-silva-legal": {
			command: process.execPath,
			args: [path.join(projectRoot, "junior-silva", "mcp", "launcher.mjs")],
			cwd: projectRoot,
			exposure: "direct",
			timeout: 1200,
			description: "Independent Sri Lankan legal research, native source-anchored review, native drafting, and translation tools.",
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
		if (req.method === "POST" && url.pathname === "/internal/mcp") {
			if (!loopback(req)) return json(res, 403, { error: "Local gateway only" });
			const message = await requestBody(req);
			const response = await dispatchMcpRequest(message);
			if (!response) return json(res, 202, {});
			return json(res, 200, response);
		}
		if (url.pathname.startsWith("/v1/") && !authorized(req)) return json(res, 401, { error: { message: "Unauthorized", type: "authentication_error" } });
		if (req.method === "GET" && url.pathname === "/v1/models") return json(res, 200, { object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "paralegal.lk" }] });
		if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
			const body = await requestBody(req);
			const messages = Array.isArray(body.messages) ? body.messages : [];
			const uploadText = textUploads(messages);
			const candidates = fileCandidates(body);
			if (!uploadText.instruction && !uploadText.files.length && !candidates.length) return json(res, 400, { error: { message: "A user message or document is required", type: "invalid_request_error" } });
			const key = conversationKey(req, body);
			await saveUploads(key, candidates, uploadText.files);
			const files = await conversationUploadPaths(key);
			const id = `chatcmpl-${randomUUID()}`;
			const streaming = body.stream !== false;
			const includeStreamUsage = requestsStreamUsage(body);
			if (streaming) { startStream(res, id); heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000); }
			const result = await serial(key, () => runPi(piPrompt(uploadText.instruction, files), `junior-silva-v2-${key}`, (message) => { if (streaming) streamDelta(res, id, "reasoning_content", `${message}\n`); }));
			if (heartbeat) clearInterval(heartbeat);
			if (streaming) return finishStream(res, id, result.answer, includeStreamUsage ? result.usage : undefined);
			return json(res, 200, { id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: result.answer }, finish_reason: "stop" }], ...(result.usage ? { usage: result.usage } : {}) });
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
}

export { fileCandidates, messageText, splitTextEnvelope, textUploads };
