import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { artifactsRoot, env } from "./environment.mjs";
import { download } from "./http.mjs";

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const INPUT_EXTENSIONS = new Set([".pdf", ".docx", ".doc", ".odt", ".txt", ".md", ".json", ".png", ".jpg", ".jpeg"]);
const MIME = new Map([
	[".pdf", "application/pdf"],
	[".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
	[".doc", "application/msword"],
	[".odt", "application/vnd.oasis.opendocument.text"],
	[".md", "text/markdown; charset=utf-8"],
	[".txt", "text/plain; charset=utf-8"],
	[".json", "application/json; charset=utf-8"],
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
]);

function artifactSecret() {
	return env("JUNIOR_SILVA_ARTIFACT_SECRET", env("JUNIOR_SILVA_API_KEY", "junior-silva-local-artifacts"));
}

function capability(operationId, filename) {
	return createHmac("sha256", artifactSecret()).update(`${operationId}\0${filename}`).digest("hex");
}

function equalText(left, right) {
	const a = Buffer.from(String(left));
	const b = Buffer.from(String(right));
	return a.length === b.length && timingSafeEqual(a, b);
}

export async function inputFile(filename) {
	const absolute = path.resolve(filename);
	const info = await stat(absolute);
	if (!info.isFile()) throw new Error(`${absolute} is not a regular file`);
	const extension = path.extname(absolute).toLowerCase();
	if (!INPUT_EXTENSIONS.has(extension)) throw new Error(`${path.basename(absolute)} has an unsupported file type`);
	const bytes = await readFile(absolute);
	if (bytes.byteLength > MAX_INPUT_BYTES) throw new Error(`${path.basename(absolute)} exceeds the 50 MB input limit`);
	return { absolute, name: path.basename(absolute), bytes, base64: Buffer.from(bytes).toString("base64") };
}
export async function operationDirectory(prefix) {
	const id = `${prefix}-${randomUUID()}`;
	const directory = path.join(artifactsRoot, id);
	await mkdir(directory, { recursive: true });
	return { id, directory };
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
	const absolute = path.resolve(filename);
	const root = path.resolve(artifactsRoot, operationId);
	if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error("Artifact is outside its operation directory");
	const name = path.basename(absolute);
	const publicBase = env("JUNIOR_SILVA_PUBLIC_URL").replace(/\/$/, "");
	return {
		name,
		media_type: mimeType(name),
		local_path: absolute,
		file_uri: pathToFileURL(absolute).href,
		...(publicBase ? { download_url: `${publicBase}/files/${capability(operationId, name)}/${encodeURIComponent(operationId)}/${encodeURIComponent(name)}` } : {}),
	};
}

export function resolveArtifactRequest(token, operationId, filename) {
	if (!/^[-A-Za-z0-9]+$/.test(operationId) || path.basename(filename) !== filename) return undefined;
	if (!equalText(token, capability(operationId, filename))) return undefined;
	const root = path.resolve(artifactsRoot, operationId);
	const target = path.resolve(root, filename);
	if (!target.startsWith(`${root}${path.sep}`)) return undefined;
	return target;
}

export { artifactsRoot, safeFilename };
