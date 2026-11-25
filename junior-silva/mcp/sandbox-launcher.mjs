#!/usr/bin/env node
// Pi's tool launcher in the Pi sandbox image (task/plan.md, task P3.3 and section 3.9). The image puts
// it at junior-silva/mcp/launcher.mjs, where .pi/mcp.json already looks. It forwards every message from
// Pi to the bridge's gateway with this run's token, and passes the bridge's replies back. It holds no
// tool code and never runs a tool itself: if the bridge can't be reached, the call fails.
import readline from "node:readline";

// Pi's own tool timeout is 20 minutes (.pi/mcp.json). This is a little longer, so Pi decides first.
const CALL_TIMEOUT_MS = 1_220_000;
const runToken = String(process.env.JS_RUN_TOKEN || "").trim();
const gatewayUrl = (() => {
	try {
		return process.env.JS_GATEWAY_URL ? new URL("/internal/mcp", process.env.JS_GATEWAY_URL).href : undefined;
	} catch {
		return undefined;
	}
})();

if (!gatewayUrl || !runToken) console.error("pi tool launcher: JS_GATEWAY_URL or JS_RUN_TOKEN is missing, so every tool call will fail.");

function send(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

// An error Pi should see as it is, such as the bridge's own reason for refusing a call.
function toolError(message) {
	return Object.assign(new Error(message), { forPi: true });
}

async function forward(message) {
	if (!gatewayUrl || !runToken) throw toolError("The legal tools aren't set up in this sandbox.");
	const response = await fetch(gatewayUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${runToken}` },
		body: JSON.stringify(message),
		signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
	});
	if (!response.ok) {
		// The bridge's short reason, such as "A tool call can be at most 4 MB", helps Pi recover.
		const reason = (await response.json().catch(() => undefined))?.error;
		throw toolError(typeof reason === "string" && reason.length <= 200 ? reason : `The legal tools refused this call (status ${response.status}).`);
	}
	if (response.status === 202) return undefined;
	return response.json();
}

readline.createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
	if (!line.trim()) return;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid MCP request." } });
	}
	// Every request gets a reply carrying its own ID, so Pi never waits out its 20-minute tool timeout.
	// A notification gets no reply, even when it fails.
	const id = message?.id;
	const fail = (text) => send({ jsonrpc: "2.0", id, error: { code: -32000, message: text } });
	void forward(message).then(
		(reply) => {
			if (id === undefined) return;
			if (reply === undefined) fail("The legal tools gave no reply.");
			else send(reply);
		},
		(error) => {
			if (id === undefined) return;
			if (error?.forPi) fail(error.message);
			else fail(error?.name === "TimeoutError" ? "The legal tool took too long." : "The legal tools can't be reached right now.");
		},
	);
});
