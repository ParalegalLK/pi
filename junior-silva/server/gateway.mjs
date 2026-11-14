import { createServer } from "node:http";
import { runInChat } from "../core/chat-scope.mjs";
import { env } from "../core/environment.mjs";
import { dispatchMcpRequest } from "../mcp/server.mjs";
import { MODEL_PROVIDERS, providerError, proxyModelCall } from "./model-proxy.mjs";
import { bearerToken, plainAddress, runForToken } from "./run-tokens.mjs";

// Pi's own door into the bridge, for its tool calls only. It's never published: LibreChat, browsers
// and downloads use the public port instead.
export const GATEWAY_PORT = Number(env("JS_GATEWAY_PORT", String(Number(env("JUNIOR_SILVA_PORT", "8126")) + 1)));
const GATEWAY_HOST = env("JS_GATEWAY_HOST", "127.0.0.1");
const MAX_CALL_BYTES = 4 * 1024 * 1024;
const MAX_CALLS_AT_ONCE = 16;
// Pi's Anthropic client calls <baseUrl>/v1/messages?beta=true, with baseUrl ending in /model/anthropic.
const ANTHROPIC_ROUTES = new Set(["/model/anthropic/v1/messages", "/model/anthropic/v1/messages?beta=true"]);
// Pi's Gemini client calls <baseUrl>/models/<model>:streamGenerateContent?alt=sse, with baseUrl ending in
// /model/google. Gemini's other methods, such as generateContent, countTokens and files, aren't routed.
const GOOGLE_ROUTE = /^\/model\/google\/models\/([A-Za-z0-9._-]{1,128}):streamGenerateContent\?alt=sse$/;
// The header each provider's client sends its key in. Pi sends its run token there.
const KEY_HEADERS = { anthropic: "x-api-key", google: "x-goog-api-key" };

// The model call a request is for, with its provider, or undefined. Which provider a run may call is decided
// by its run token (P3.18): the other provider's route is closed to it.
export function modelCallRoute(method, url) {
	if (method !== "POST") return undefined;
	if (ANTHROPIC_ROUTES.has(url)) return { provider: "anthropic" };
	const match = GOOGLE_ROUTE.exec(String(url));
	return match ? { provider: "google", pathModel: match[1] } : undefined;
}

// Pi's containers will live on 10.89.<slot>.0/24 networks (P3). The network a connection arrived on
// is decided by the bridge's own address, so the caller can't fake it.
export function arrivedOnPiNetwork(localAddress) {
	return /^10\.89\.\d{1,3}\.\d{1,3}$/.test(plainAddress(localAddress));
}

// Until P3, Pi runs inside the bridge's container, so its calls arrive locally.
export function gatewayAcceptsArrival(localAddress) {
	const address = plainAddress(localAddress);
	return arrivedOnPiNetwork(address) || address === "::1" || /^127\./.test(address);
}

function reply(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
	res.end(body);
}

// Reads the whole body even when it's too large, so the caller gets the 413 and not a reset connection.
async function readCall(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size <= MAX_CALL_BYTES) chunks.push(chunk);
	}
	if (size > MAX_CALL_BYTES) throw Object.assign(new Error("A tool call can be at most 4 MB"), { status: 413 });
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw Object.assign(new Error("A tool call must be valid JSON"), { status: 400 });
	}
}

// Each provider's real key, and where its calls go. JS_MODEL_UPSTREAM sends them all to a fake model, in tests.
function modelServicesFromSettings() {
	const upstream = env("JS_MODEL_UPSTREAM");
	return Object.fromEntries(Object.entries(MODEL_PROVIDERS).map(([provider, settings]) => [provider, { apiKey: env(settings.keySetting), upstream: upstream || settings.upstream }]));
}

// The token is checked before the body is read, so a caller with no token can't make the bridge read a body.
export function startGateway({ port = GATEWAY_PORT, host = GATEWAY_HOST, dispatch = dispatchMcpRequest, modelServices = modelServicesFromSettings() } = {}) {
	const callsRunning = new Map();
	const server = createServer(async (req, res) => {
		try {
			if (!gatewayAcceptsArrival(req.socket.localAddress)) return reply(res, 403, { error: "Not allowed" });
			const modelCall = modelCallRoute(req.method, req.url);
			if (!modelCall && (req.method !== "POST" || req.url !== "/internal/mcp")) return reply(res, 404, { error: "Not found" });
			const provider = modelCall?.provider;
			// Pi sends its run token as a bearer token to the tools, and as the API key to the model.
			const token = modelCall ? String(req.headers[KEY_HEADERS[provider]] || "") : bearerToken(req);
			const run = runForToken(token, req.socket.remoteAddress);
			if (!run) return modelCall ? providerError(provider, res, 401, "authentication_error", "A valid run token is required") : reply(res, 401, { error: "A valid run token is required" });
			// A run may call only the provider it was started with. The other provider's route is closed to it.
			if (modelCall && run.model?.provider !== provider) return providerError(provider, res, 404, "not_found_error", "Not found");
			const running = callsRunning.get(token) ?? 0;
			if (running >= MAX_CALLS_AT_ONCE) return modelCall ? providerError(provider, res, 429, "rate_limit_error", "Too many calls at once") : reply(res, 429, { error: "Too many tool calls at once" });
			callsRunning.set(token, running + 1);
			try {
				// The proxy checks the call against this run's own model.
				if (modelCall) return await proxyModelCall(req, res, { chatHash: run.chat.chatHash, ...modelServices[provider], provider, model: run.model.id, pathModel: modelCall.pathModel });
				const message = await readCall(req);
				const response = await runInChat(run.chat, () => dispatch(message));
				return response ? reply(res, 200, response) : reply(res, 202, {});
			} finally {
				const left = callsRunning.get(token) - 1;
				if (left > 0) callsRunning.set(token, left);
				else callsRunning.delete(token);
			}
		} catch (error) {
			const status = Number(error?.status) || 500;
			if (status === 500) console.error(`[junior-silva-v2] Tool gateway error: ${error?.stack || error}`);
			if (!res.headersSent) reply(res, status, { error: status === 500 ? "The tool call failed" : error.message });
		}
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			console.log(`[junior-silva-v2] tool gateway ready on ${host}:${server.address().port}`);
			resolve(server);
		});
	});
}
