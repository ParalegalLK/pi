import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// Pi calls the model through here with its run token. The proxy checks the call, swaps the token for the
// real key, and streams the answer back, so Pi never needs the key. Only the provider in PI_PROVIDER is
// open (task/plan.md 3.8).
const MAX_MODEL_BYTES = 32 * 1024 * 1024;

// For each provider Pi can use: the setting that holds the real key, and where its calls go by default.
export const MODEL_PROVIDERS = {
	anthropic: { keySetting: "ANTHROPIC_API_KEY", upstream: "https://api.anthropic.com" },
	google: { keySetting: "GEMINI_API_KEY", upstream: "https://generativelanguage.googleapis.com/v1beta" },
};

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

// Every field Pi's Gemini code sends (packages/ai/src/api/google-generative-ai.ts, buildParams, through
// Google's SDK), checked against Pi's real calls in P3.17. So cachedContent, which could point at content
// stored for another chat, and safetySettings are refused.
const GOOGLE_BODY_FIELDS = new Set(["contents", "systemInstruction", "tools", "toolConfig", "generationConfig"]);
const GOOGLE_GENERATION_FIELDS = new Set(["temperature", "maxOutputTokens", "thinkingConfig"]);
const GOOGLE_CONTENT_FIELDS = new Set(["role", "parts"]);
// What a part can hold: text, thinking, an inline (base64) image, or a tool call or reply. Not fileData, a URL
// or stored file that Google would fetch, nor executableCode and codeExecutionResult from Google's own code
// execution.
const GOOGLE_PART_FIELDS = new Set(["text", "thought", "thoughtSignature", "inlineData", "functionCall", "functionResponse"]);

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function googlePartsProblem(parts) {
	if (!Array.isArray(parts)) return "parts must be a list";
	for (const part of parts) {
		if (!isObject(part)) return "a part must be an object";
		const extra = Object.keys(part).find((field) => !GOOGLE_PART_FIELDS.has(field));
		if (extra !== undefined) return `the part field "${extra}" isn't allowed`;
		// A tool call's arguments and a tool's reply are data for our tools and aren't searched. Images added
		// to a reply must be inline, like any other image.
		const added = part.functionResponse?.parts;
		if (added !== undefined && !(Array.isArray(added) && added.every((item) => isObject(item) && Object.keys(item).every((field) => field === "inlineData")))) return "a tool reply can only add inline images";
	}
	return undefined;
}

// Returns why a Gemini call isn't allowed, or undefined when it is. Gemini names the model in the path.
export function googleCallProblem(body, pathModel, allowedModel) {
	if (!isObject(body)) return "the body isn't a JSON object";
	const extra = Object.keys(body).find((field) => !GOOGLE_BODY_FIELDS.has(field));
	if (extra !== undefined) return `the field "${extra}" isn't allowed`;
	if (!allowedModel || pathModel !== allowedModel) return "that model isn't allowed";
	if (body.generationConfig !== undefined) {
		if (!isObject(body.generationConfig)) return "generationConfig must be an object";
		const setting = Object.keys(body.generationConfig).find((field) => !GOOGLE_GENERATION_FIELDS.has(field));
		if (setting !== undefined) return `the generationConfig field "${setting}" isn't allowed`;
	}
	// Only Pi's own tools. Google's server tools, such as googleSearch, urlContext and codeExecution, would
	// reach the internet or stored data for Pi.
	if (body.tools !== undefined && !(Array.isArray(body.tools) && body.tools.every((tool) => isObject(tool) && Object.keys(tool).length === 1 && Array.isArray(tool.functionDeclarations)))) return "only function declarations are allowed as tools";
	if (body.toolConfig !== undefined && !(isObject(body.toolConfig) && Object.keys(body.toolConfig).every((field) => field === "functionCallingConfig"))) return "only functionCallingConfig is allowed in toolConfig";
	if (!Array.isArray(body.contents)) return "contents must be a list";
	for (const content of body.contents) {
		if (!isObject(content) || Object.keys(content).some((field) => !GOOGLE_CONTENT_FIELDS.has(field))) return "each content can have only a role and parts";
		const problem = googlePartsProblem(content.parts);
		if (problem) return problem;
	}
	if (body.systemInstruction === undefined) return undefined;
	if (!isObject(body.systemInstruction) || Object.keys(body.systemInstruction).some((field) => !GOOGLE_CONTENT_FIELDS.has(field))) return "systemInstruction can have only a role and parts";
	return googlePartsProblem(body.systemInstruction.parts);
}

// Anthropic's own error shape, so Pi handles the reply as it would one from Anthropic.
export function modelError(res, status, type, message) {
	const body = JSON.stringify({ type: "error", error: { type, message } });
	res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
	res.end(body);
}

const GOOGLE_STATUS = { 400: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 404: "NOT_FOUND", 413: "INVALID_ARGUMENT", 429: "RESOURCE_EXHAUSTED", 502: "UNAVAILABLE", 503: "UNAVAILABLE" };

// The proxy's own refusals, in the shape of the provider Pi is calling, so Pi handles them as it would one
// of that provider's errors.
export function providerError(provider, res, status, type, message) {
	if (provider !== "google") return modelError(res, status, type, message);
	const body = JSON.stringify({ error: { code: status, message, status: GOOGLE_STATUS[status] ?? "UNKNOWN" } });
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

// How each provider's checked call goes upstream: its address, and only the headers it needs, with the real key.
const UPSTREAM_CALLS = {
	anthropic: {
		problem: (body, req, settings) => modelCallProblem(body, req.headers, settings.model),
		url: (upstream) => `${upstream}/v1/messages?beta=true`,
		headers(incoming, apiKey) {
			const headers = { "x-api-key": apiKey, "content-type": "application/json", "anthropic-version": String(incoming["anthropic-version"] || "2023-06-01") };
			if (incoming.accept) headers.accept = String(incoming.accept);
			if (incoming["anthropic-beta"]) headers["anthropic-beta"] = String(incoming["anthropic-beta"]);
			return headers;
		},
	},
	google: {
		problem: (body, req, settings) => googleCallProblem(body, settings.pathModel, settings.model),
		// The model was checked against PI_MODEL, and only PI_MODEL goes upstream.
		url: (upstream, model) => `${upstream}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
		headers(incoming, apiKey) {
			const headers = { "x-goog-api-key": apiKey, "content-type": "application/json" };
			if (incoming.accept) headers.accept = String(incoming.accept);
			return headers;
		},
	},
};

// settings: { provider, chatHash, model, pathModel, apiKey, upstream }. pathModel is the model a Gemini call
// names in its path.
export async function proxyModelCall(req, res, { provider = "anthropic", chatHash, model, pathModel, apiKey, upstream }) {
	const call = UPSTREAM_CALLS[provider];
	if (!call) return providerError(provider, res, 404, "not_found_error", "Not found");
	const { body, status } = await readModelCall(req);
	if (status === 413) return providerError(provider, res, 413, "request_too_large", "A model call can be at most 32 MB");
	if (status === 400) return providerError(provider, res, 400, "invalid_request_error", "A model call must be valid JSON");
	const problem = call.problem(body, req, { model, pathModel });
	if (problem) {
		console.warn(`[junior-silva-v2] Refused a model call for chat ${chatHash}: ${problem}`);
		return providerError(provider, res, 400, "invalid_request_error", "This model call isn't allowed");
	}
	if (!apiKey) return providerError(provider, res, 503, "api_error", "The model service isn't set up");
	const cancel = new AbortController();
	// Pi stopped or went away, so nobody is waiting for the answer.
	res.once("close", () => cancel.abort());
	let answer;
	try {
		// The body that was checked is the body that's sent. Forwarding the raw bytes would let a body with
		// two "model" fields pass the check with one value and reach Anthropic with the other.
		answer = await fetch(call.url(upstream.replace(/\/+$/, ""), model), { method: "POST", headers: call.headers(req.headers, apiKey), body: JSON.stringify(body), signal: cancel.signal });
	} catch (error) {
		if (cancel.signal.aborted) return;
		console.error(`[junior-silva-v2] The model service could not be reached for chat ${chatHash}: ${error?.cause?.code || error?.name || "unknown error"}`);
		return providerError(provider, res, 502, "api_error", "The model service could not be reached");
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
