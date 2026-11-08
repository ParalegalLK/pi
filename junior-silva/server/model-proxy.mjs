import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// Pi calls the model through here with its run token. The proxy checks the call, swaps the token for the
// real key, and streams the answer back, so Pi never needs the key.
const MAX_MODEL_BYTES = 32 * 1024 * 1024;

// Every field Pi's Anthropic code can send (packages/ai/src/api/anthropic-messages.ts, buildParams), except
// `fallbacks`, which lets a call switch to other models. Our models never send it.
const BODY_FIELDS = new Set(["model", "messages", "max_tokens", "stream", "system", "temperature", "tools", "thinking", "output_config", "metadata", "tool_choice"]);

// The beta values Pi can ask for with an API key (same file, getBetaFeatures). The server-side fallback
// beta is left out, because it only goes with `fallbacks`.
const BETA_VALUES = new Set([
	"fine-grained-tool-streaming-2025-05-14",
	"interleaved-thinking-2025-05-14",
	"mid-conversation-output-config-2026-07-01",
	"thinking-binding-controls-2026-08-01",
	"inline-tools-2026-09-15",
]);

const RETURNED_HEADERS = ["content-type", "request-id", "retry-after", "retry-after-ms"];

// A server tool, such as web_fetch or web_search, always has a type. Pi's own tools never do.
function customTool(tool) {
	return Boolean(tool) && typeof tool === "object" && !Array.isArray(tool) && (tool.type === undefined || tool.type === "custom");
}

// Walks the messages without recursion, because a chat's history can be large and deep.
function contentProblem(roots) {
	const pending = [...roots];
	while (pending.length) {
		const value = pending.pop();
		if (!value || typeof value !== "object") continue;
		if (Array.isArray(value)) {
			for (const item of value) pending.push(item);
			continue;
		}
		if (Object.hasOwn(value, "source") && !(value.source && typeof value.source === "object" && value.source.type === "base64")) return "only base64 content is allowed";
		if (value.type === "tool_addition") {
			if (!(value.tool?.type === "tool_definition" && customTool(value.tool.definition))) return "only custom tools are allowed";
			// A tool's settings can have a field called "source", which isn't content.
			continue;
		}
		for (const [key, item] of Object.entries(value)) {
			// A tool call's arguments are data for our tools, and can also have a field called "source".
			if (key === "input" && value.type === "tool_use") continue;
			pending.push(item);
		}
	}
	return undefined;
}

// Returns why a model call isn't allowed, or undefined when it is.
export function modelCallProblem(body, headers, allowedModel) {
	if (!body || typeof body !== "object" || Array.isArray(body)) return "the body isn't a JSON object";
	const extra = Object.keys(body).find((field) => !BODY_FIELDS.has(field));
	if (extra !== undefined) return `the field "${extra}" isn't allowed`;
	if (!allowedModel || body.model !== allowedModel) return "that model isn't allowed";
	const beta = String(headers?.["anthropic-beta"] ?? "").split(",").map((value) => value.trim()).filter(Boolean).find((value) => !BETA_VALUES.has(value));
	if (beta !== undefined) return `the beta value "${beta}" isn't allowed`;
	if (body.tools !== undefined && !(Array.isArray(body.tools) && body.tools.every(customTool))) return "only custom tools are allowed";
	return contentProblem([body.messages, body.system]);
}

// Anthropic's own error shape, so Pi handles the reply as it would one from Anthropic.
export function modelError(res, status, type, message) {
	const body = JSON.stringify({ type: "error", error: { type, message } });
	res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
	res.end(body);
}

// Reads the whole body even when it's too large, so the caller gets the 413 and not a reset connection.
async function readModelCall(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size <= MAX_MODEL_BYTES) chunks.push(chunk);
	}
	if (size > MAX_MODEL_BYTES) return { status: 413 };
	try {
		return { body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
	} catch {
		return { status: 400 };
	}
}

function upstreamHeaders(incoming, apiKey) {
	const headers = { "x-api-key": apiKey, "content-type": "application/json", "anthropic-version": String(incoming["anthropic-version"] || "2023-06-01") };
	if (incoming.accept) headers.accept = String(incoming.accept);
	if (incoming["anthropic-beta"]) headers["anthropic-beta"] = String(incoming["anthropic-beta"]);
	return headers;
}

export async function proxyModelCall(req, res, { chatHash, model, apiKey, upstream }) {
	const { body, status } = await readModelCall(req);
	if (status === 413) return modelError(res, 413, "request_too_large", "A model call can be at most 32 MB");
	if (status === 400) return modelError(res, 400, "invalid_request_error", "A model call must be valid JSON");
	const problem = modelCallProblem(body, req.headers, model);
	if (problem) {
		console.warn(`[junior-silva-v2] Refused a model call for chat ${chatHash}: ${problem}`);
		return modelError(res, 400, "invalid_request_error", "This model call isn't allowed");
	}
	if (!apiKey) return modelError(res, 503, "api_error", "The model service isn't set up");
	const cancel = new AbortController();
	// Pi stopped or went away, so nobody is waiting for the answer.
	res.once("close", () => cancel.abort());
	let answer;
	try {
		// The body that was checked is the body that's sent. Forwarding the raw bytes would let a body with
		// two "model" fields pass the check with one value and reach Anthropic with the other.
		answer = await fetch(`${upstream.replace(/\/+$/, "")}/v1/messages?beta=true`, { method: "POST", headers: upstreamHeaders(req.headers, apiKey), body: JSON.stringify(body), signal: cancel.signal });
	} catch (error) {
		if (cancel.signal.aborted) return;
		console.error(`[junior-silva-v2] The model service could not be reached for chat ${chatHash}: ${error?.cause?.code || error?.name || "unknown error"}`);
		return modelError(res, 502, "api_error", "The model service could not be reached");
	}
	const headers = {};
	for (const name of RETURNED_HEADERS) {
		const value = answer.headers.get(name);
		if (value) headers[name] = value;
	}
	if (!answer.ok) {
		const text = (await answer.text().catch(() => "")).replaceAll(apiKey, "[removed]");
		res.writeHead(answer.status, { ...headers, "Content-Length": Buffer.byteLength(text) });
		return res.end(text);
	}
	res.writeHead(answer.status, headers);
	if (!answer.body) return res.end();
	await pipeline(Readable.fromWeb(answer.body), res).catch(() => {});
}
