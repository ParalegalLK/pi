import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "junior-silva-gateway-"));
process.env.JUNIOR_SILVA_DATA_ROOT = dataRoot;
process.env.JUNIOR_SILVA_ARTIFACT_ROOT = path.join(dataRoot, "artifacts");
delete process.env.JS_NATIVE_DEV;

const { createChatFolders } = await import("../core/chat-scope.mjs");
const { arrivedOnPiNetwork, gatewayAcceptsArrival, GATEWAY_PORT, startGateway } = await import("../server/gateway.mjs");
const { createRunToken, revokeRunToken } = await import("../server/run-tokens.mjs");

const MINUTE = 60_000;
const LIMIT = 4 * 1024 * 1024;
const NOT_FOUND = "File not found in this chat.";
const PING = { jsonrpc: "2.0", id: 1, method: "ping" };
const gateways = [];

after(async () => {
	for (const gateway of gateways) {
		gateway.closeAllConnections();
		gateway.close();
	}
	await rm(dataRoot, { recursive: true, force: true });
});

async function newChat(letter) {
	const scope = { userHash: letter.repeat(32), chatHash: `${letter}c`.repeat(16) };
	return { ...scope, folders: await createChatFolders(scope) };
}

const chatA = await newChat("a");
const chatB = await newChat("b");
const draftA = path.join(chatA.folders.workspace, "draft.md");
const draftB = path.join(chatB.folders.workspace, "draft.md");
await writeFile(draftA, "# Draft\nDate: [FILL]\n");
await writeFile(draftB, "# Other chat's draft\n");

async function openGateway(options = {}) {
	const gateway = await startGateway({ port: 0, host: "127.0.0.1", ...options });
	gateways.push(gateway);
	return gateway.address().port;
}

// Uses node:http so a test can choose the address the call comes from.
function call(port, { token, body = PING, from = "127.0.0.1", method = "POST", route = "/internal/mcp" } = {}) {
	const payload = typeof body === "string" ? body : JSON.stringify(body);
	return new Promise((resolve, reject) => {
		const req = request({
			host: "127.0.0.1",
			port,
			method,
			path: route,
			localAddress: from,
			agent: false,
			headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		}, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { text += chunk; });
			res.on("end", () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : undefined }));
		});
		req.on("error", reject);
		req.end(payload);
	});
}

const validate = (filePath) => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "legal_validate_draft", arguments: { file_path: filePath } } });

function padded(size) {
	const base = Buffer.byteLength(JSON.stringify({ ...PING, params: { pad: "" } }));
	return JSON.stringify({ ...PING, params: { pad: "x".repeat(size - base) } });
}

async function waitUntil(check, withinMs, label) {
	const deadline = Date.now() + withinMs;
	while (!check()) {
		assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
		await delay(10);
	}
}

test("the gateway is on the port after the public one, unless set", () => {
	if (process.env.JS_GATEWAY_PORT) return;
	assert.equal(GATEWAY_PORT, Number(process.env.JUNIOR_SILVA_PORT || 8126) + 1);
});

test("a valid token works, and every other token gets the same 401", async () => {
	const port = await openGateway();
	const token = createRunToken(chatA, MINUTE, "127.0.0.1");
	assert.equal((await call(port, { token })).status, 200);
	const revoked = createRunToken(chatA, MINUTE, "127.0.0.1");
	revokeRunToken(revoked);
	const expired = createRunToken(chatA, 0, "127.0.0.1");
	for (const [label, bad] of [["no token", undefined], ["a wrong token", "a".repeat(64)], ["the LibreChat key", "test-junior-silva-key"], ["a revoked token", revoked], ["an expired token", expired]]) {
		const reply = await call(port, { token: bad });
		assert.equal(reply.status, 401, label);
		assert.deepEqual(reply.body, { error: "A valid run token is required" }, label);
	}
	revokeRunToken(token);
});

test("a token only works from its own run's address", async () => {
	const port = await openGateway();
	const local = createRunToken(chatA, MINUTE, "127.0.0.1");
	const elsewhere = createRunToken(chatA, MINUTE, "127.0.0.2");
	assert.equal((await call(port, { token: local, from: "127.0.0.2" })).status, 401, "a stolen token used from another address");
	assert.equal((await call(port, { token: elsewhere, from: "127.0.0.2" })).status, 200, "a token used from its own address");
	assert.equal((await call(port, { token: elsewhere, from: "127.0.0.1" })).status, 401);
	revokeRunToken(local);
	revokeRunToken(elsewhere);
});

test("a tool call runs in its token's chat", async () => {
	const port = await openGateway();
	const token = createRunToken(chatA, MINUTE, "127.0.0.1");
	const own = await call(port, { token, body: validate(draftA) });
	assert.equal(own.status, 200);
	assert.equal(own.body.result.isError, undefined);
	assert.match(own.body.result.content[0].text, /\[FILL\]/);
	const other = await call(port, { token, body: validate(draftB) });
	assert.equal(other.body.result.isError, true);
	assert.equal(other.body.result.content[0].text, NOT_FOUND);
	revokeRunToken(token);
});

test("a call of up to 4 MB is read, anything larger gets 413, and bad JSON gets 400", async () => {
	const port = await openGateway();
	const token = createRunToken(chatA, MINUTE, "127.0.0.1");
	assert.equal((await call(port, { token, body: padded(LIMIT) })).status, 200);
	assert.equal((await call(port, { token, body: padded(LIMIT + 1) })).status, 413);
	assert.equal((await call(port, { token, body: "{not json" })).status, 400);
	assert.equal((await call(port, { token, body: { jsonrpc: "2.0", method: "notifications/initialized" } })).status, 202);
	revokeRunToken(token);
});

test("each run can have 16 calls at once, without blocking another run", async () => {
	let started = 0;
	let release;
	const held = new Promise((resolve) => { release = resolve; });
	const port = await openGateway({ dispatch: async (message) => {
		started += 1;
		await held;
		return { jsonrpc: "2.0", id: message.id, result: {} };
	} });
	const token = createRunToken(chatA, MINUTE, "127.0.0.1");
	const otherRun = createRunToken(chatB, MINUTE, "127.0.0.1");
	const sixteen = Array.from({ length: 16 }, () => call(port, { token }));
	await waitUntil(() => started === 16, 5_000, "16 calls to start");
	// Without the limit this call would wait with the others, so it gets a deadline instead of hanging the test.
	const seventeenth = await Promise.race([call(port, { token }), delay(3_000).then(() => ({ status: "no reply within 3 seconds" }))]);
	assert.equal(seventeenth.status, 429);
	assert.deepEqual(seventeenth.body, { error: "Too many tool calls at once" });
	const otherCall = call(port, { token: otherRun });
	await waitUntil(() => started === 17, 5_000, "the other run's call to start");
	release();
	for (const reply of await Promise.all(sixteen)) assert.equal(reply.status, 200);
	assert.equal((await otherCall).status, 200);
	assert.equal((await call(port, { token })).status, 200, "the count went back down");
	revokeRunToken(token);
	revokeRunToken(otherRun);
});

test("calls that fail still give back their place", async (t) => {
	t.mock.method(console, "error", () => {});
	const port = await openGateway({ dispatch: async () => { throw new Error("the tool broke"); } });
	const token = createRunToken(chatA, MINUTE, "127.0.0.1");
	for (let index = 0; index < 20; index += 1) assert.equal((await call(port, { token })).status, 500);
	for (let index = 0; index < 20; index += 1) assert.equal((await call(port, { token, body: "{not json" })).status, 400);
	for (let index = 0; index < 20; index += 1) assert.equal((await call(port, { token, body: padded(LIMIT + 1) })).status, 413);
	revokeRunToken(token);
});

test("only POST /internal/mcp is served", async () => {
	const port = await openGateway();
	const token = createRunToken(chatA, MINUTE, "127.0.0.1");
	assert.equal((await call(port, { token, method: "GET" })).status, 404);
	assert.equal((await call(port, { token, route: "/v1/chat/completions" })).status, 404);
	assert.equal((await call(port, { token, route: "/internal/mcp?x=1" })).status, 404);
	revokeRunToken(token);
});

test("Pi's network is 10.89.*, and the gateway accepts only that and local calls", () => {
	for (const address of ["10.89.1.2", "10.89.255.3", "::ffff:10.89.7.2"]) {
		assert.equal(arrivedOnPiNetwork(address), true, address);
		assert.equal(gatewayAcceptsArrival(address), true, address);
	}
	for (const address of ["127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1"]) {
		assert.equal(arrivedOnPiNetwork(address), false, address);
		assert.equal(gatewayAcceptsArrival(address), true, address);
	}
	for (const address of ["172.18.0.5", "192.168.1.10", "10.8.9.1", "10.890.1.2", "", undefined]) {
		assert.equal(arrivedOnPiNetwork(address), false, String(address));
		assert.equal(gatewayAcceptsArrival(address), false, String(address));
	}
});
