import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chatFolders, currentChat, readChatFile } from "./chat-scope.mjs";
import { artifactsRoot, env, requiredEnv } from "./environment.mjs";
import { download } from "./http.mjs";
import { preparePreview } from "./previews.mjs";

const INPUT_EXTENSIONS = new Set([".pdf", ".docx", ".doc", ".odt", ".pptx", ".xlsx", ".txt", ".md", ".json", ".png", ".jpg", ".jpeg"]);
const MIME = new Map([
	[".pdf", "application/pdf"],
	[".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
	[".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
	[".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
	[".doc", "application/msword"],
	[".odt", "application/vnd.oasis.opendocument.text"],
	[".md", "text/markdown; charset=utf-8"],
	[".txt", "text/plain; charset=utf-8"],
	[".json", "application/json; charset=utf-8"],
	[".html", "text/html; charset=utf-8"],
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
]);

const DEFAULT_LINK_HOURS = 168;
const CHAT_HASH = /^[a-f0-9]{32}$/;

// Covers every part of a download link, so changing any of them breaks the link.
function linkSignature({ userHash, chatHash, operationId, filename, expiresAt }) {
	const message = ["download", userHash, chatHash, operationId, filename, expiresAt].join("\0");
	return createHmac("sha256", requiredEnv("JUNIOR_SILVA_ARTIFACT_SECRET")).update(message).digest("hex");
}

function linkExpiry() {
	const hours = Number(env("JS_LINK_TTL_HOURS", String(DEFAULT_LINK_HOURS)));
	const lifetime = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_LINK_HOURS;
	return Math.floor(Date.now() / 1000 + lifetime * 3600);
}

function downloadUrl(publicBase, { userHash, chatHash }, operationId, filename) {
	const expiresAt = linkExpiry();
	const signature = linkSignature({ userHash, chatHash, operationId, filename, expiresAt });
	return `${publicBase}/files/${signature}/${userHash}/${chatHash}/${encodeURIComponent(operationId)}/${encodeURIComponent(filename)}?exp=${expiresAt}`;
}

function equalText(left, right) {
	const a = Buffer.from(String(left));
	const b = Buffer.from(String(right));
	return a.length === b.length && timingSafeEqual(a, b);
}

export async function inputFile(filename) {
	const file = await readChatFile(filename);
	if (!INPUT_EXTENSIONS.has(path.extname(file.name).toLowerCase())) throw new Error(`${file.name} has an unsupported file type`);
	return { ...file, base64: file.bytes.toString("base64") };
}
export async function operationDirectory(prefix) {
	const id = `${prefix}-${randomUUID()}`;
	const directory = path.join(currentChat().folders.artifacts, id);
	await mkdir(directory, { recursive: true });
	return { id, directory };
}

export async function publishWorkspaceArtifact(filename, title) {
	const source = await readChatFile(filename, { only: ["workspace", "artifacts"] });
	const extension = path.extname(source.name).toLowerCase();
	if (!new Set([".pptx", ".xlsx", ".docx", ".pdf", ".md", ".txt", ".json"]).has(extension)) throw new Error("Only PPTX, XLSX, DOCX, PDF, Markdown, text, and JSON files can be published.");
	const operation = await operationDirectory("artifact");
	const name = safeFilename(title ? `${title}${extension}` : source.name, `legal-artifact${extension}`);
	const destination = path.join(operation.directory, name);
	await writeFile(destination, source.bytes);
	// A published document is a completed user-facing deliverable.  Generate its
	// preview here, rather than trusting the agent to invent HTML in its reply.
	const preview = await preparePreview(destination, title);
	return {
		operation_id: operation.id,
		artifact: describeArtifact(destination, operation.id),
		preview_kind: preview.kind,
		preview_title: preview.title,
		artifact_markup: preview.markup,
	};
}
export async function saveJson(directory, filename, value) {
	const destination = path.join(directory, filename);
	await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	return destination;
}
function safeFilename(value, fallback) {
	const name = path.basename(decodeURIComponent(value || "")).replace(/[^A-Za-z0-9._ -]/g, "_");
	return name || fallback;
}
export function markdownLinks(text) {
	return [...String(text || "").matchAll(/\[([^\]\r\n]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]+)\)/g)].map((match) => ({ label: match[1], url: match[2] }));
}
export function serviceUrl(raw, serviceBase, pathPrefixes = ["/files", "/download"]) {
	const base = new URL(serviceBase);
	const candidate = new URL(raw, base);
	if (candidate.origin === base.origin) return candidate.toString();
	if (candidate.pathname.startsWith("/drafter-files/files/")) return new URL(`${candidate.pathname.slice("/drafter-files".length)}${candidate.search}`, base).toString();
	if (pathPrefixes.some((prefix) => candidate.pathname.startsWith(prefix))) return new URL(`${candidate.pathname}${candidate.search}`, base).toString();
	throw new Error(`Refused an output URL outside ${base.origin}`);
}
export async function saveRemoteFile(directory, item, serviceBase, index = 0) {
	const url = serviceUrl(item.url, serviceBase);
	const parsed = new URL(url);
	const filename = safeFilename(item.name || parsed.searchParams.get("file") || path.basename(parsed.pathname), `output-${index + 1}.bin`);
	const bytes = await download(url, `Output ${filename}`);
	const extension = path.extname(filename).toLowerCase();
	if (extension === ".pdf" && Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-") throw new Error(`Output ${filename} is not a valid PDF`);
	if (extension === ".docx" && (bytes[0] !== 0x50 || bytes[1] !== 0x4b)) throw new Error(`Output ${filename} is not a valid DOCX`);
	const destination = path.join(directory, filename);
	await writeFile(destination, bytes);
	return destination;
}

export function stripServiceFileLinks(text) {
	return String(text || "")
		.replace(/\[([^\]\r\n]+)\]\((?:https?:\/\/[^\s)]+)?\/[^\s)]*(?:files\/|download(?:\?|\/))[^\s)]*\)/gi, "$1")
		.replace(/https?:\/\/[^\s)]+\/[^\s)]*(?:files\/|download(?:\?|\/))[^\s)]*/gi, "")
		.replace(/`?\/(?:[^\s`)]*\/)?files\/[^\s`)]*`?/gi, "")
		.trim();
}

export function mimeType(filename) {
	return MIME.get(path.extname(filename).toLowerCase()) || "application/octet-stream";
}

export function describeArtifact(filename, operationId) {
	const chat = currentChat();
	const absolute = path.resolve(filename);
	const root = path.resolve(chat.folders.artifacts, operationId);
	if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error("Artifact is outside its operation directory");
	const name = path.basename(absolute);
	const publicBase = env("JUNIOR_SILVA_PUBLIC_URL").replace(/\/$/, "");
	return {
		name,
		media_type: mimeType(name),
		local_path: absolute,
		file_uri: pathToFileURL(absolute).href,
		// The native CLI has no chat for the bridge to find the file in, so it only gets the local path.
		...(publicBase && !chat.native ? { download_url: downloadUrl(publicBase, chat, operationId, name) } : {}),
	};
}

// Returns { target } for a good link, { expired: true } for an expired one, and {} for anything
// else. Expiry is only checked after the signature, so nobody can use it to test made-up links.
export function resolveArtifactRequest({ signature, userHash, chatHash, operationId, filename, expiresAt }) {
	if (!CHAT_HASH.test(userHash) || !CHAT_HASH.test(chatHash) || !/^[-A-Za-z0-9]+$/.test(operationId) || path.basename(filename) !== filename || !/^\d+$/.test(String(expiresAt))) return {};
	if (!equalText(signature, linkSignature({ userHash, chatHash, operationId, filename, expiresAt }))) return {};
	if (Number(expiresAt) * 1000 <= Date.now()) return { expired: true };
	const root = path.resolve(chatFolders({ userHash, chatHash }).artifacts, operationId);
	const target = path.resolve(root, filename);
	return target.startsWith(`${root}${path.sep}`) ? { target } : {};
}

export { artifactsRoot, safeFilename };
