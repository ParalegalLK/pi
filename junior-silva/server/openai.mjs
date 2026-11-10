#!/usr/bin/env node
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { constants, existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createChatFolders, resolveChatScope, runInChat } from "../core/chat-scope.mjs";
import { artifactsRoot, env, projectRoot, requiredEnv } from "../core/environment.mjs";
import { mimeType, publishWorkspaceArtifact, resolveArtifactRequest, safeFilename } from "../core/files.mjs";
import { newestRequestedArtifact, requestedSlideCount } from "../core/artifact-delivery.mjs";
import { arrivedOnPiNetwork, GATEWAY_PORT, startGateway } from "./gateway.mjs";
import { createSlotPool, piAddress, startContainerPi, startLocalPi } from "./pi-executor.mjs";
import { bearerToken, createRunToken, revokeRunToken } from "./run-tokens.mjs";
import { addAssistantUsage, createUsageTotals, openAiUsage, requestsStreamUsage } from "./usage.mjs";

const PORT = Number(env("JUNIOR_SILVA_PORT", "8126"));
const HOST = env("JUNIOR_SILVA_BIND_HOST", "127.0.0.1");
const MODEL = env("JUNIOR_SILVA_MODEL_NAME", "junior-silva-v2");
const API_KEY = requiredEnv("JUNIOR_SILVA_API_KEY");
const MAX_BODY = Number(env("JUNIOR_SILVA_MAX_BODY_BYTES", String(60 * 1024 * 1024)));
const MAX_FILE = Number(env("JUNIOR_SILVA_MAX_FILE_BYTES", String(50 * 1024 * 1024)));
const AGENT_ROOT = path.resolve(env("PI_CODING_AGENT_DIR", path.join(path.dirname(artifactsRoot), "pi-agent")));
const PI_CLI = path.join(projectRoot, "packages", "coding-agent", "dist", "bundle", "cli.js");
const ATTACHMENT_ORIGINS = new Set(env("JUNIOR_SILVA_ATTACHMENT_ORIGINS").split(",").map((item) => item.trim()).filter(Boolean));
const auditRoot = path.join(path.dirname(artifactsRoot), "audit");
// How Pi starts for each message (pi-executor.mjs): "container", in its own gVisor container through
// the runner, or "local", inside this container, for development only. The start checks are below.
const PI_EXECUTOR = env("JS_PI_EXECUTOR", "container");
const RUNNER_URL = env("JS_RUNNER_URL");
const RUNNER_SECRET = env("JS_RUNNER_SECRET");
// The same number of slots as the runner has.
const SLOT_COUNT = Number(env("JS_SLOTS", "3"));
// How long a message waits for a free slot before it gets the busy answer.
const SLOT_WAIT_MS = Number(env("JS_SLOT_WAIT_MS", "300000"));
// Made once the settings above are checked.
let slotPool;
// In the local way, Pi runs inside this container.
const LOCAL_PI_ADDRESS = "127.0.0.1";
// Each run gets its own settings folder in here, removed when the run ends.
const RUNS_ROOT = path.join(path.dirname(artifactsRoot), "pi-runs");
// Pi's model calls go through the bridge's model proxy, which has an Anthropic route only.
const PI_MODEL = env("PI_MODEL");
// Pi fills in $JS_RUN_TOKEN from its own settings when it calls the model, so the token is never
// written to disk. The proxy swaps it for the real key.
const PI_MODELS_SETTINGS = `${JSON.stringify({ providers: { anthropic: { baseUrl: `http://${LOCAL_PI_ADDRESS}:${GATEWAY_PORT}/model/anthropic`, apiKey: "$JS_RUN_TOKEN" } } }, null, 2)}\n`;

function json(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
	res.end(body);
}

function authorized(req) {
	const left = Buffer.from(bearerToken(req));
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

function latestUserMessage(messages = []) {
	return [...messages].reverse().find((item) => item?.role === "user") || {};
}

function textUploads(messages = []) {
	// LibreChat's standard chat-completions payload includes prior messages. An
	// older "Upload as Text" envelope is already available in Pi's session and
	// must not be treated as a newly uploaded document on a later turn.
	const latest = messageText(latestUserMessage(messages));
	return splitTextEnvelope(latest);
}

function fileCandidates(body) {
	const output = [];
	const add = (item = {}) => {
		const nested = [item.image_url, item.file_url, item.document_url, item.file].find((value) => value && typeof value === "object") || {};
		const url = item.url || item.data || item.file_data || item.base64 || nested.url || nested.file_data;
		const sourceId = item.file_id || item.id || nested.file_id || nested.id;
		if (typeof url === "string" && url) output.push({ url, name: item.name || item.filename || nested.filename || nested.name, sourceId: typeof sourceId === "string" ? sourceId : "" });
	};
	for (const item of Array.isArray(body.attachments) ? body.attachments : []) add(item);
	for (const item of Array.isArray(body.files) ? body.files : []) add(item);
	const latest = latestUserMessage(Array.isArray(body.messages) ? body.messages : []);
	for (const item of Array.isArray(latest?.attachments) ? latest.attachments : []) add(item);
	for (const item of Array.isArray(latest?.files) ? latest.files : []) add(item);
	for (const item of Array.isArray(latest?.content) ? latest.content : []) if (item?.type !== "text" && item?.type !== "input_text") add(item);

	const seen = new Set();
	return output.filter((candidate) => {
		const identity = candidate.sourceId ? `id:${candidate.sourceId}` : candidate.url;
		if (seen.has(identity)) return false;
		seen.add(identity);
		return true;
	});
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

function uploadManifestPath(directory) {
	return path.join(directory, ".manifest.json");
}

async function loadUploadManifest(directory) {
	try {
		const parsed = JSON.parse(await readFile(uploadManifestPath(directory), "utf8"));
		if (parsed?.version === 1 && parsed?.files && typeof parsed.files === "object" && parsed?.sourceIds && typeof parsed.sourceIds === "object") return parsed;
	} catch (caught) {
		if (!(caught && typeof caught === "object" && "code" in caught && caught.code === "ENOENT")) console.warn("[junior-silva-v2] Ignoring an invalid upload manifest");
	}
	return { version: 1, files: {}, sourceIds: {} };
}

function manifestFilePath(directory, entry) {
	if (!entry || typeof entry.filename !== "string") return undefined;
	const target = path.resolve(directory, entry.filename);
	return target.startsWith(`${path.resolve(directory)}${path.sep}`) ? target : undefined;
}

async function existingSourcePath(directory, manifest, sourceId) {
	if (!sourceId) return undefined;
	const digest = manifest.sourceIds[`file:${sourceId}`];
	const target = manifestFilePath(directory, manifest.files[digest]);
	return target && existsSync(target) ? target : undefined;
}

async function retainUpload(directory, manifest, { bytes, filename, sourceId = "" }) {
	const digest = createHash("sha256").update(bytes).digest("hex");
	let target = manifestFilePath(directory, manifest.files[digest]);
	let isNew = false;
	if (!target || !existsSync(target)) {
		const extension = path.extname(filename);
		target = path.join(directory, `${digest}${extension}`);
		await writeFile(target, bytes);
		manifest.files[digest] = { filename: path.basename(target), originalName: safeFilename(filename) };
		isNew = true;
	}
	if (sourceId) manifest.sourceIds[`file:${sourceId}`] = digest;
	return { path: target, isNew };
}

async function saveUploads(directory, candidates, extracted) {
	await mkdir(directory, { recursive: true });
	const manifest = await loadUploadManifest(directory);
	const paths = [];
	for (const candidate of candidates) {
		const retained = await existingSourcePath(directory, manifest, candidate.sourceId);
		if (retained) continue;
		const file = await fetchFile(candidate);
		const saved = await retainUpload(directory, manifest, { ...file, sourceId: candidate.sourceId });
		if (saved.isNew) paths.push(saved.path);
	}
	for (const file of extracted) {
		const saved = await retainUpload(directory, manifest, {
			bytes: Buffer.from(file.text, "utf8"),
			filename: `${safeFilename(file.name).replace(/\.[^.]+$/, "")}.md`,
		});
		if (saved.isNew) paths.push(saved.path);
	}
	await writeFile(uploadManifestPath(directory), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	return paths;
}

async function conversationUploadPaths(directory) {
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		return entries.filter((entry) => entry.isFile() && !entry.name.startsWith(".")).map((entry) => path.join(directory, entry.name)).sort();
	} catch (caught) {
		if (caught && typeof caught === "object" && "code" in caught && caught.code === "ENOENT") return [];
		throw caught;
	}
}

function piPrompt(instruction, files, requestWorkspace) {
	const workspace = `Use this request-only workspace for every file you create: ${requestWorkspace}. Do not read, write, or publish files from any other workspace directory.`;
	if (!files.length) return `${workspace}\n\nDocuments supplied in earlier turns remain available in this Pi session. Re-read one only when it is necessary for the user's current request.\n\nUser request:\n${instruction}`;
	return `${workspace}\n\nThe user supplied these local document files with this request:\n${files.map((item) => `- ${item}`).join("\n")}\n\nUser request:\n${instruction || "Examine the supplied legal documents and respond appropriately."}`;
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

// Pi's settings hold no model key: its model calls go through the bridge's model proxy with the run token.
function agentEnvironment(folders, requestWorkspace, runToken, settingsFolder) {
	return {
		// Pi downloaded rg and fd into the shared folder's bin once. It looks there and on PATH.
		PATH: [process.env.PATH, path.join(AGENT_ROOT, "bin")].filter(Boolean).join(path.delimiter),
		HOME: process.env.HOME || "",
		LANG: process.env.LANG || "C.UTF-8",
		TERM: process.env.TERM || "xterm-256color",
		TZ: "Asia/Colombo",
		PI_CODING_AGENT_SESSION_DIR: folders.sessions,
		PI_CODING_AGENT_DIR: settingsFolder,
		PI_SKIP_VERSION_CHECK: "1",
		// No catalog refreshes or downloads. Model calls and tools aren't affected.
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		JUNIOR_SILVA_MCP_GATEWAY_URL: `http://${LOCAL_PI_ADDRESS}:${GATEWAY_PORT}/internal/mcp`,
		JS_RUN_TOKEN: runToken,
		JUNIOR_SILVA_DATA_ROOT: path.dirname(artifactsRoot),
		JUNIOR_SILVA_ARTIFACT_ROOT: folders.artifacts,
		JUNIOR_SILVA_UPLOAD_ROOT: folders.uploads,
		JUNIOR_SILVA_WORKSPACE_ROOT: requestWorkspace,
	};
}

// A fresh settings folder for each run, so a run can't leave changed settings behind for the next one,
// which may be another user's. It has no auth.json, so no stored key can outrank the run token. It has
// no mcp.json either: Pi takes its tools from the project's .pi/mcp.json, which would win anyway.
async function createPiSettings() {
	const folder = await mkdtemp(path.join(RUNS_ROOT, "run-"));
	await Promise.all([
		writeFile(path.join(folder, "models.json"), PI_MODELS_SETTINGS, { mode: 0o600 }),
		...["settings.json", "models-store.json"].map((name) => copyFile(path.join(AGENT_ROOT, name), path.join(folder, name)).catch(() => {})),
	]);
	return folder;
}

async function audit(sessionId, event) {
	await mkdir(auditRoot, { recursive: true });
	const line = JSON.stringify({ at: new Date().toISOString(), sessionId, ...event });
	await appendFile(path.join(auditRoot, `${sessionId}.jsonl`), `${line}\n`, "utf8");
}

async function sessionFileSizes(directory) {
	const sizes = new Map();
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			const file = path.join(directory, entry.name);
			sizes.set(file, (await stat(file)).size);
		}
	} catch (caught) {
		if (caught?.code !== "ENOENT") throw caught;
	}
	return sizes;
}

async function appendedSessionUsage(directory, sizesBefore) {
	const totals = createUsageTotals();
	let changedFiles = 0;
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			const file = path.join(directory, entry.name);
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

const NOT_COMPLETE_NOTE = "**This answer isn't complete.** The AI service stopped before it finished, so please don't rely on the text below. Send your message again to retry, and contact the administrator if this keeps happening.";
const CUT_OFF_NOTE = "**This answer was cut off** because it reached the length limit, so it's incomplete. You can ask me to continue.";
const NO_ANSWER_NOTE = "**I couldn't finish this answer.** The AI service stopped before it wrote anything. Send your message again to retry, and contact the administrator if this keeps happening.";

// Pi exits as a success even when a model call fails, so only its last message says how the
// run ended. Only "stop" means finished. No stop reason means an extension answered without
// a model call. The notes are fixed text, because LibreChat shows error text word for word.
function finishedAnswer(text, stopReason) {
	const answer = text.trim();
	if (stopReason === undefined || stopReason === "stop") return answer;
	if (!answer) return NO_ANSWER_NOTE;
	if (stopReason === "length") return `${answer}\n\n---\n\n${CUT_OFF_NOTE}`;
	return `${NOT_COMPLETE_NOTE}\n\n---\n\n${answer}`;
}

function localPiArgs(sessionId) {
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
	args.push("--provider", "anthropic", "--model", PI_MODEL);
	if (env("PI_THINKING")) args.push("--thinking", env("PI_THINKING"));
	return args;
}

// Starts Pi for one run: through the runner on a free slot (the container way, the default), or as a
// process here (the local way, development only). The run token is tied to the address Pi calls from.
// Whatever has to be undone when the run ends is added to cleanUps.
async function startPi({ requestId, requestWorkspace, sessionId, chat, prompt, timeoutMs, signal, cleanUps }) {
	if (PI_EXECUTOR === "local") {
		// In the container way, Pi's start-up script makes this folder. Here the bridge does, as before P3.
		await mkdir(requestWorkspace, { recursive: true });
		const settingsFolder = await createPiSettings();
		cleanUps.push(() => rm(settingsFolder, { recursive: true, force: true }));
		const runToken = createRunToken(chat, timeoutMs, LOCAL_PI_ADDRESS);
		cleanUps.push(() => revokeRunToken(runToken));
		signal.throwIfAborted();
		const environment = agentEnvironment(chat.folders, requestWorkspace, runToken, settingsFolder);
		return { runToken, pi: startLocalPi({ command: process.execPath, args: localPiArgs(sessionId), cwd: projectRoot, environment, prompt }) };
	}
	const slot = await slotPool.take(signal);
	cleanUps.push(() => slotPool.release(slot));
	// The token only works from this slot's Pi container, so a stolen one is useless anywhere else.
	const runToken = createRunToken(chat, timeoutMs, piAddress(slot));
	cleanUps.push(() => revokeRunToken(runToken));
	signal.throwIfAborted();
	const thinking = env("PI_THINKING");
	const run = { requestId, userHash: chat.userHash, chatHash: chat.chatHash, slot, runToken, model: PI_MODEL, ...(thinking ? { thinking } : {}) };
	return { runToken, pi: startContainerPi({ runnerUrl: RUNNER_URL, runnerSecret: RUNNER_SECRET, run, prompt }) };
}

// One run of Pi. makePrompt(requestWorkspace) builds the prompt for this run's own message folder.
async function runPiOnce({ requestId, makePrompt, sessionId, onProgress, chat, signal }) {
	const requestWorkspace = path.join(chat.folders.workspace, "requests", requestId);
	const sessionSizesBefore = await sessionFileSizes(chat.folders.sessions);
	const startedAt = Date.now();
	const thoughtController = createThoughtController(onProgress);
	const timeoutMs = Number(env("JUNIOR_SILVA_PI_TIMEOUT_MS", "1200000"));
	const cleanUps = [];
	try {
		// A message whose connection closed while it waited in the queue never starts Pi.
		signal.throwIfAborted();
		const { runToken, pi } = await startPi({ requestId, requestWorkspace, sessionId, chat, prompt: makePrompt(requestWorkspace), timeoutMs, signal, cleanUps });
		return await new Promise((resolve, reject) => {
			// The service-level SSE keepalive is intentionally invisible. This bounded
			// timer is different: it tells the user that Pi is still alive when a
			// legitimate document or research step produces no lifecycle event.
			const thoughtLivenessTimer = setInterval(() => thoughtController.tick(), 5_000);
			let buffer = "";
			let finalText = "";
			let stopReason;
			let failure;
			let stopError;
			let artifactPublished = false;
			const usageTotals = createUsageTotals();
			const usageResponseIds = new Set();
			const recordAssistantUsage = (message) => {
				if (!message?.usage) return;
				const key = message.responseId || `${message.timestamp || ""}:${message.usage.totalTokens || ""}:${message.usage.input || ""}:${message.usage.output || ""}`;
				if (usageResponseIds.has(key)) return;
				usageResponseIds.add(key);
				addAssistantUsage(usageTotals, message.usage);
			};
			pi.stdout.on("data", (chunk) => {
				buffer += chunk.toString();
				const lines = buffer.split(/\r?\n/);
				buffer = lines.pop() || "";
				for (const line of lines) {
					try {
						const event = JSON.parse(line);
						if (event.type === "message_update" && event.assistantMessageEvent?.type === "message_end") {
							recordAssistantUsage({ ...event.assistantMessageEvent.message, usage: event.usage });
						}
						if (event.type === "message_end" && event.message?.role === "custom" && event.message?.customType === "junior-silva-scope" && typeof event.message?.content === "string") {
							finalText = event.message.content;
							stopReason = undefined;
						}
						thoughtController.handle(event);
						if (event.type === "tool_execution_start") {
							const tool = event.toolName || event.tool_name;
							void audit(sessionId, { type: "tool", tool: safeAuditToolName(tool), status: "started" }).catch(() => {});
						}
						// Never relay update payloads: built-in tools can include shell output,
						// files, URLs, source text, credentials, or internal service responses.
						if (event.type === "tool_execution_end") {
							const tool = event.toolName || event.tool_name;
							if (!event.isError && /(?:^|__|\/)workbench_publish_artifact$/.test(String(tool || ""))) artifactPublished = true;
							void audit(sessionId, { type: "tool", tool: safeAuditToolName(tool), status: event.isError ? "error" : "completed" }).catch(() => {});
						}
						if (event.type === "message" && event.message?.role === "assistant") recordAssistantUsage(event.message);
						if (event.type === "message_end" && event.message?.role === "assistant") {
							finalText = (event.message.content || []).filter((part) => part.type === "text").map((part) => part.text || "").join("\n");
							stopReason = event.message.stopReason;
							failure = event.message.errorMessage;
							recordAssistantUsage(event.message);
						}
					} catch { }
				}
			});
			const stopPi = (error) => {
				if (stopError) return;
				stopError = error;
				revokeRunToken(runToken);
				pi.stop();
			};
			const onStop = () => {
				console.log(`[junior-silva-v2] Stopping the run for chat ${chat.chatHash}, because its connection closed.`);
				stopPi(new Error("The run was stopped"));
			};
			const timeout = setTimeout(() => stopPi(new Error("Pi request timed out")), timeoutMs);
			const cleanUp = () => {
				clearTimeout(timeout);
				clearInterval(thoughtLivenessTimer);
				signal.removeEventListener("abort", onStop);
			};
			signal.addEventListener("abort", onStop, { once: true });
			if (signal.aborted) onStop();
			// Settling only here means the next message in this chat can't start while this Pi is still running.
			void pi.done.then((ending) => {
				cleanUp();
				if (stopError) return reject(stopError);
				if (ending.reason === "no-start") return resolve({ noStart: true });
				if (ending.exitCode !== 0) return reject(new Error(`Pi exited with code ${ending.exitCode ?? "unknown"} (${ending.reason})${ending.detail ? `: ${ending.detail}` : ""}`));
				const answer = finishedAnswer(finalText, stopReason);
				if (!answer) return reject(new Error("Pi returned no final answer"));
				if (stopReason !== undefined && stopReason !== "stop") console.error(`[junior-silva-v2] Pi's run for chat ${chat.chatHash} ended early: ${`${stopReason}: ${failure || "no details"}`.replace(/\s+/g, " ").slice(0, 320)}`);
				void appendedSessionUsage(chat.folders.sessions, sessionSizesBefore).then((persistedUsage) => {
					resolve({ answer, usage: openAiUsage(persistedUsage) || openAiUsage(usageTotals), elapsedMs: Date.now() - startedAt, artifactPublished, requestWorkspace });
				}).catch(reject);
			});
		});
	} finally {
		for (const cleanUp of cleanUps.reverse()) await cleanUp();
	}
}

// Runs Pi for a message. In the container way, a Pi that printed nothing in time gets one more try,
// with a new message folder, because the first try may already have made its folder (P3.2 refuses
// to reuse one).
async function runPi(options) {
	const first = await runPiOnce(options);
	if (!first.noStart) return first;
	console.error(`[junior-silva-v2] Pi didn't start in time for chat ${options.chat.chatHash}, so it gets one more try.`);
	const second = await runPiOnce({ ...options, requestId: `chatcmpl-${randomUUID()}` });
	if (second.noStart) throw new Error("Pi didn't start in time, twice");
	return second;
}

function artifactDeliveryText(publication) {
	const url = publication?.artifact?.download_url;
	if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error("Published artifact did not provide a download URL");
	const markup = typeof publication.artifact_markup === "string" && publication.artifact_markup.startsWith(":::artifact{") ? publication.artifact_markup : "";
	return ["The requested legal work product is ready.", `## Files\n\n- [Download completed file](${url})`, markup].filter(Boolean).join("\n\n");
}

// Publishes a file Pi made but didn't deliver. Publishing goes through the file guard
// and makes its own preview. Any problem returns nothing, so the user still gets Pi's
// own answer instead of an error.
async function publishRecoveredArtifact(candidate, instruction) {
	const publication = await publishWorkspaceArtifact(candidate).catch(() => undefined);
	if (!publication) return undefined;
	const slides = requestedSlideCount(instruction);
	if (slides && path.extname(candidate).toLowerCase() === ".pptx" && !new RegExp(`>${slides} slides?\\.`).test(publication.artifact_markup)) {
		await rm(path.dirname(publication.artifact.local_path), { recursive: true, force: true });
		return undefined;
	}
	return publication;
}

async function recoverUndeliveredArtifact({ instruction, chat, sessionId, initial, onProgress, signal }) {
	if (initial.artifactPublished) return initial;
	// The folder of the run that answered, which a retry may have changed.
	const { requestWorkspace } = initial;
	let candidate = await newestRequestedArtifact(requestWorkspace, instruction);
	if (!candidate) return initial;

	// Give Pi one bounded opportunity to finish its own validation/repair and call
	// the normal publishing tool. It does not repeat research simply because
	// delivery was omitted. The repair run has its own message ID and folder, since
	// Pi's start-up script never reuses one, so the file is corrected where it is.
	onProgress("Checking the generated file before delivery…");
	const repair = await runPi({
		requestId: `chatcmpl-${randomUUID()}`,
		makePrompt: () => `A requested deliverable from your previous answer has not been delivered. Inspect only ${candidate}. If it needs correction, correct and validate it in place. Then call workbench_publish_artifact for the final file and finish with a concise delivery confirmation. Do not repeat legal research or return an internal progress note.`,
		sessionId,
		onProgress,
		chat,
		signal,
	}).catch(() => undefined);
	if (repair?.artifactPublished) return repair;
	if (signal.aborted) return initial;

	// Pi created a valid file but omitted the final tool call. Publish only a file
	// from this request's private workspace; never guess from a shared workspace.
	candidate = await newestRequestedArtifact(requestWorkspace, instruction);
	if (!candidate) return initial;
	onProgress("Preparing the completed file for secure download…");
	const publication = await publishRecoveredArtifact(candidate, instruction);
	if (!publication?.artifact?.download_url) return initial;
	return { ...initial, answer: artifactDeliveryText(publication), artifactPublished: true, recoveredArtifact: true };
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

// This route is public, so a planted shortcut or FIFO must not be served through it.
async function readPublishedFile(target) {
	const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
	if (!handle) return undefined;
	try {
		return (await handle.stat()).isFile() ? await handle.readFile() : undefined;
	} finally {
		await handle.close();
	}
}

async function serveArtifact(res, pathname, expiresAt) {
	let parts;
	try { parts = pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part)); }
	catch { return json(res, 404, { error: "Not found" }); }
	if (parts.length !== 6 || parts[0] !== "files") return json(res, 404, { error: "Not found" });
	const [, signature, userHash, chatHash, operationId, filename] = parts;
	const { target, expired } = resolveArtifactRequest({ signature, userHash, chatHash, operationId, filename, expiresAt });
	if (expired) return json(res, 410, { error: "This download link has expired. Ask for the file again." });
	const bytes = target && await readPublishedFile(target);
	if (!bytes) return json(res, 404, { error: "Not found" });
	res.writeHead(200, { "Content-Type": mimeType(target), "Content-Length": bytes.length, "Content-Disposition": `attachment; filename="${safeFilename(path.basename(target))}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
	res.end(bytes);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
// Chat folder names and download links are built from these secrets, so never start without them.
requiredEnv("JS_IDENTITY_SECRET");
requiredEnv("JUNIOR_SILVA_ARTIFACT_SECRET");
if (env("JS_NATIVE_DEV")) throw new Error("JS_NATIVE_DEV is only for the native CLI. Remove it from the bridge's settings.");
// Pi's model calls go through the model proxy, which has an Anthropic route only (task/plan.md 3.8).
if (env("PI_PROVIDER", "anthropic") !== "anthropic") throw new Error("PI_PROVIDER must be anthropic. Pi's model calls go through the bridge's model proxy, which has no route for other providers yet.");
requiredEnv("PI_MODEL");
requiredEnv("ANTHROPIC_API_KEY");
if (PI_EXECUTOR !== "container" && PI_EXECUTOR !== "local") throw new Error("JS_PI_EXECUTOR must be container or local.");
if (PI_EXECUTOR === "local" && env("JS_ALLOW_LOCAL_PI") !== "1") throw new Error("JS_PI_EXECUTOR=local runs Pi inside the bridge, next to its keys and every chat's files, so it's for development only. Set JS_ALLOW_LOCAL_PI=1 to use it anyway.");
if (PI_EXECUTOR === "container") {
	if (!/^http:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/?$/.test(RUNNER_URL)) throw new Error("JS_RUNNER_URL must be the runner's http address, such as http://junior-silva-runner:8128.");
	if (RUNNER_SECRET.length < 32) throw new Error("JS_RUNNER_SECRET must be set, with at least 32 characters.");
	if (!Number.isInteger(SLOT_COUNT) || SLOT_COUNT < 1 || SLOT_COUNT > 254) throw new Error("JS_SLOTS must be a whole number from 1 to 254, the same as the runner's.");
	if (!Number.isInteger(SLOT_WAIT_MS) || SLOT_WAIT_MS < 0) throw new Error("JS_SLOT_WAIT_MS must be a whole number of milliseconds.");
	slotPool = createSlotPool(SLOT_COUNT, SLOT_WAIT_MS);
}
// One user's failed request must not end the process serving every other user.
process.on("unhandledRejection", (reason) => console.error(`[junior-silva-v2] Unhandled rejection: ${reason?.stack || reason}`));
await Promise.all([mkdir(AGENT_ROOT, { recursive: true }), mkdir(auditRoot, { recursive: true })]);
// Settings folders left behind by a crash aren't in use any more.
await rm(RUNS_ROOT, { recursive: true, force: true });
await mkdir(RUNS_ROOT, { recursive: true, mode: 0o700 });
const server = createServer(async (req, res) => {
	let heartbeat;
	// LibreChat's Stop button closes this connection, and nobody can receive an answer after that.
	const stop = new AbortController();
	res.once("close", () => {
		clearInterval(heartbeat);
		stop.abort();
	});
	try {
		// In P3 Pi shares a network with the bridge, so it could reach this port. Its door is the gateway.
		if (arrivedOnPiNetwork(req.socket.localAddress)) return json(res, 403, { error: "Not allowed" });
		const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
		if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { status: "ok", service: MODEL, pi: "1.0.0" });
		if (req.method === "GET" && url.pathname === "/ready") return json(res, 200, { ready: existsSync(PI_CLI), mcp: existsSync(path.join(projectRoot, ".pi", "mcp.json")) });
		if (req.method === "GET" && url.pathname.startsWith("/files/")) return await serveArtifact(res, url.pathname, url.searchParams.get("exp"));
		if (url.pathname.startsWith("/v1/") && !authorized(req)) return json(res, 401, { error: { message: "Unauthorized", type: "authentication_error" } });
		if (req.method === "GET" && url.pathname === "/v1/models") return json(res, 200, { object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "paralegal.lk" }] });
		if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
			const body = await requestBody(req);
			const scope = resolveChatScope(req.headers, body);
			const key = scope.chatHash;
			const messages = Array.isArray(body.messages) ? body.messages : [];
			const uploadText = textUploads(messages);
			const candidates = fileCandidates(body);
			if (!uploadText.instruction && !uploadText.files.length && !candidates.length) return json(res, 400, { error: { message: "A user message or document is required", type: "invalid_request_error" } });
			const chat = { ...scope, folders: await createChatFolders(scope) };
			const files = await saveUploads(chat.folders.uploads, candidates, uploadText.files);
			const id = `chatcmpl-${randomUUID()}`;
			const streaming = body.stream !== false;
			const includeStreamUsage = requestsStreamUsage(body);
			if (streaming) { startStream(res, id); heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000); }
			const onProgress = (message) => { if (streaming) streamDelta(res, id, "reasoning_content", `${message}\n`); };
			const sessionId = `junior-silva-v2-${key}`;
			const result = await serial(key, () => runInChat(chat, async () => {
				const initial = await runPi({ requestId: id, makePrompt: (requestWorkspace) => piPrompt(uploadText.instruction, files, requestWorkspace), sessionId, onProgress, chat, signal: stop.signal });
				return recoverUndeliveredArtifact({ instruction: uploadText.instruction, chat, sessionId, initial, onProgress, signal: stop.signal });
			}));
			if (heartbeat) clearInterval(heartbeat);
			if (streaming) return finishStream(res, id, result.answer, includeStreamUsage ? result.usage : undefined);
			return json(res, 200, { id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: result.answer }, finish_reason: "stop" }], ...(result.usage ? { usage: result.usage } : {}) });
		}
		return json(res, 404, { error: { message: "Not found", type: "invalid_request_error" } });
	} catch (error) {
		if (heartbeat) clearInterval(heartbeat);
		// Nobody is waiting for an answer, and a stop isn't a failure.
		if (stop.signal.aborted) return;
		// Not a failure either, but a sign that more slots are needed.
		if (error?.busy) console.warn(`[junior-silva-v2] A message got the busy answer: no slot was free within ${SLOT_WAIT_MS} ms.`);
		else console.error(`[junior-silva-v2] ${error?.stack || error}`);
		const status = Number(error?.status || 500);
		const message = status < 500 ? error.message : "Junior Silva could not complete this request. Please retry or contact the administrator.";
		if (!res.headersSent) return json(res, status, { error: { message, type: "junior_silva_error" } });
		if (!res.writableEnded) { streamDelta(res, `chatcmpl-${randomUUID()}`, "content", message); res.end("data: [DONE]\n\n"); }
	}
});

// The gateway starts first, so "listening" means Pi's tool calls can be served too.
await startGateway();
server.listen(PORT, HOST, () => console.log(`[junior-silva-v2] listening on ${HOST}:${PORT}`));
}

export { agentEnvironment, conversationUploadPaths, fileCandidates, finishedAnswer, messageText, piPrompt, publishRecoveredArtifact, saveUploads, serveArtifact, splitTextEnvelope, textUploads };
