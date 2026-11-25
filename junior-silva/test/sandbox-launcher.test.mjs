import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const launcherPath = fileURLToPath(new URL("../mcp/sandbox-launcher.mjs", import.meta.url));
const TOKEN = "sandbox-launcher-test-token";

// A stand-in for the bridge's gateway. It records each call and answers with reply(call).
async function startGateway(t, reply) {
	const calls = [];
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", async () => {
			const call = { method: req.method, url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") };
			calls.push(call);
			const { status = 200, body } = await reply(call);
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(body === undefined ? "" : JSON.stringify(body));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	return { url: `http://127.0.0.1:${server.address().port}`, calls };
}

async function closedAddress() {
	const server = createServer();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	await new Promise((resolve) => server.close(resolve));
	return `http://127.0.0.1:${port}`;
}

// Starts the launcher with only the settings given, sends the lines, waits until done() or 10 s, then
// a little longer to catch any extra reply, and returns every reply.
async function launcherReplies(t, settings, lines, done) {
	const child = spawn(process.execPath, [launcherPath], { env: { PATH: process.env.PATH, ...settings }, stdio: ["pipe", "pipe", "ignore"] });
	t.after(() => child.kill("SIGKILL"));
	const replies = [];
	let buffer = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
			replies.push(JSON.parse(buffer.slice(0, end)));
			buffer = buffer.slice(end + 1);
		}
	});
	for (const line of lines) child.stdin.write(`${typeof line === "string" ? line : JSON.stringify(line)}\n`);
	const deadline = Date.now() + 10_000;
	while (!done(replies) && Date.now() < deadline) await delay(20);
	await delay(300);
	return replies;
}

test("the sandbox launcher forwards a request with the run token, and passes the bridge's reply back", async (t) => {
	const tools = { jsonrpc: "2.0", id: 3, result: { tools: [{ name: "rag_chat_research" }] } };
	const gateway = await startGateway(t, () => ({ body: tools }));
	const request = { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} };
	const replies = await launcherReplies(t, { JS_GATEWAY_URL: gateway.url, JS_RUN_TOKEN: TOKEN }, [request], (seen) => seen.length >= 1);
	assert.deepEqual(replies, [tools]);
	assert.equal(gateway.calls.length, 1);
	assert.deepEqual(gateway.calls[0], { method: "POST", url: "/internal/mcp", authorization: `Bearer ${TOKEN}`, body: request });
});

test("the sandbox launcher forwards a notification, and never replies to it", async (t) => {
	const gateway = await startGateway(t, () => ({ status: 202, body: {} }));
	const notification = { jsonrpc: "2.0", method: "notifications/initialized" };
	const replies = await launcherReplies(t, { JS_GATEWAY_URL: gateway.url, JS_RUN_TOKEN: TOKEN }, [notification], () => gateway.calls.length >= 1);
	assert.deepEqual(replies, []);
	assert.deepEqual(gateway.calls.map((call) => call.body), [notification]);
});

test("when the bridge refuses a call, the error carries the call's ID and the bridge's reason", async (t) => {
	const gateway = await startGateway(t, (call) =>
		call.body.id === "big" ? { status: 413, body: { error: "A tool call can be at most 4 MB" } } : { status: 500, body: {} },
	);
	const replies = await launcherReplies(
		t,
		{ JS_GATEWAY_URL: gateway.url, JS_RUN_TOKEN: TOKEN },
		[
			{ jsonrpc: "2.0", id: "big", method: "tools/call", params: { name: "legal_validate_draft", arguments: {} } },
			{ jsonrpc: "2.0", id: "broken", method: "tools/call", params: { name: "legal_validate_draft", arguments: {} } },
		],
		(seen) => seen.length >= 2,
	);
	const byId = Object.fromEntries(replies.map((reply) => [reply.id, reply.error]));
	assert.deepEqual(byId.big, { code: -32000, message: "A tool call can be at most 4 MB" });
	assert.deepEqual(byId.broken, { code: -32000, message: "The legal tools refused this call (status 500)." });
});

test("when the bridge can't be reached, the call fails quickly with its ID", async (t) => {
	const started = Date.now();
	const replies = await launcherReplies(
		t,
		{ JS_GATEWAY_URL: await closedAddress(), JS_RUN_TOKEN: TOKEN },
		[{ jsonrpc: "2.0", id: "call-9", method: "tools/call", params: { name: "rag_chat_research", arguments: {} } }],
		(seen) => seen.length >= 1,
	);
	assert.deepEqual(replies, [{ jsonrpc: "2.0", id: "call-9", error: { code: -32000, message: "The legal tools can't be reached right now." } }]);
	assert.ok(Date.now() - started < 5_000, "the error must come at once, not after a timeout");
});

// Today's launcher would run the tools itself here and list all 13. This one must never fall back.
test("with no gateway address, the sandbox launcher runs nothing itself and every request fails with its ID", async (t) => {
	const replies = await launcherReplies(
		t,
		{ JS_RUN_TOKEN: TOKEN },
		[
			{ jsonrpc: "2.0", id: 1, method: "tools/list" },
			{ jsonrpc: "2.0", method: "notifications/initialized" },
		],
		(seen) => seen.length >= 1,
	);
	assert.deepEqual(replies, [{ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "The legal tools aren't set up in this sandbox." } }]);
});

test("with no run token, the sandbox launcher forwards nothing", async (t) => {
	const gateway = await startGateway(t, () => ({ body: { jsonrpc: "2.0", id: 1, result: {} } }));
	const replies = await launcherReplies(t, { JS_GATEWAY_URL: gateway.url }, [{ jsonrpc: "2.0", id: 1, method: "tools/list" }], (seen) => seen.length >= 1);
	assert.equal(replies[0].error.code, -32000);
	assert.equal(gateway.calls.length, 0);
});

test("two calls at once each get their own reply, the quick one first", async (t) => {
	const gateway = await startGateway(t, async (call) => {
		if (call.body.id === "slow") await delay(500);
		return { body: { jsonrpc: "2.0", id: call.body.id, result: { content: [{ type: "text", text: `answer for ${call.body.id}` }] } } };
	});
	const replies = await launcherReplies(
		t,
		{ JS_GATEWAY_URL: gateway.url, JS_RUN_TOKEN: TOKEN },
		[
			{ jsonrpc: "2.0", id: "slow", method: "tools/call", params: { name: "rag_chat_research", arguments: {} } },
			{ jsonrpc: "2.0", id: "quick", method: "tools/call", params: { name: "legal_validate_draft", arguments: {} } },
		],
		(seen) => seen.length >= 2,
	);
	assert.deepEqual(replies.map((reply) => reply.id), ["quick", "slow"]);
	for (const reply of replies) assert.equal(reply.result.content[0].text, `answer for ${reply.id}`);
});

test("a request the bridge answers with no body still gets a reply with its ID", async (t) => {
	const gateway = await startGateway(t, () => ({ status: 202 }));
	const replies = await launcherReplies(t, { JS_GATEWAY_URL: gateway.url, JS_RUN_TOKEN: TOKEN }, [{ jsonrpc: "2.0", id: 4, method: "ping" }], (seen) => seen.length >= 1);
	assert.deepEqual(replies, [{ jsonrpc: "2.0", id: 4, error: { code: -32000, message: "The legal tools gave no reply." } }]);
});

test("a line that isn't JSON gets the standard parse error, and isn't forwarded", async (t) => {
	const gateway = await startGateway(t, () => ({ body: {} }));
	const replies = await launcherReplies(t, { JS_GATEWAY_URL: gateway.url, JS_RUN_TOKEN: TOKEN }, ["{not json"], (seen) => seen.length >= 1);
	assert.deepEqual(replies, [{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid MCP request." } }]);
	assert.equal(gateway.calls.length, 0);
});

test("the sandbox launcher loads nothing but Node's own modules, so it can't run a tool itself", async () => {
	const source = await readFile(launcherPath, "utf8");
	const loaded = [...source.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm)].map((match) => match.slice(1).find(Boolean));
	assert.ok(loaded.length > 0, "the check found no imports at all");
	assert.deepEqual(loaded.filter((name) => !name.startsWith("node:")), []);
});
