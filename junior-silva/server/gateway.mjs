import { createServer } from "node:http";
import { runInChat } from "../core/chat-scope.mjs";
import { env } from "../core/environment.mjs";
import { dispatchMcpRequest } from "../mcp/server.mjs";
import { bearerToken, chatForRunToken, plainAddress } from "./run-tokens.mjs";

// Pi's own door into the bridge, for its tool calls only. It's never published: LibreChat, browsers
// and downloads use the public port instead.
export const GATEWAY_PORT = Number(env("JS_GATEWAY_PORT", String(Number(env("JUNIOR_SILVA_PORT", "8126")) + 1)));
const GATEWAY_HOST = env("JS_GATEWAY_HOST", "127.0.0.1");
const MAX_CALL_BYTES = 4 * 1024 * 1024;
const MAX_CALLS_AT_ONCE = 16;

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

// The token is checked before the body is read, so a caller with no token can't make the bridge read 4 MB.
export function startGateway({ port = GATEWAY_PORT, host = GATEWAY_HOST, dispatch = dispatchMcpRequest } = {}) {
	const callsRunning = new Map();
	const server = createServer(async (req, res) => {
		try {
			if (!gatewayAcceptsArrival(req.socket.localAddress)) return reply(res, 403, { error: "Not allowed" });
			if (req.method !== "POST" || req.url !== "/internal/mcp") return reply(res, 404, { error: "Not found" });
			const token = bearerToken(req);
			const chat = chatForRunToken(token, req.socket.remoteAddress);
			if (!chat) return reply(res, 401, { error: "A valid run token is required" });
			const running = callsRunning.get(token) ?? 0;
			if (running >= MAX_CALLS_AT_ONCE) return reply(res, 429, { error: "Too many tool calls at once" });
			callsRunning.set(token, running + 1);
			try {
				const message = await readCall(req);
				const response = await runInChat(chat, () => dispatch(message));
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
