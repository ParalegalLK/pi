import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { currentChat, runInChat } from "../core/chat-scope.mjs";
import { dispatchMcpRequest } from "../mcp/server.mjs";
import { GATEWAY_PORT } from "../server/gateway.mjs";
import { chatForRunToken, createRunToken, revokeRunToken } from "../server/run-tokens.mjs";

process.env.JUNIOR_SILVA_API_KEY ||= "test-junior-silva-key";
const { agentEnvironment } = await import("../server/openai.mjs");

const serverPath = fileURLToPath(new URL("../server/openai.mjs", import.meta.url));
const launcherPath = fileURLToPath(new URL("../mcp/launcher.mjs", import.meta.url));
const NO_CHAT = "This tool can only run for a chat, and none is set.";
const CHAT_A = { userHash: "a".repeat(32), chatHash: "c".repeat(32), folders: { uploads: "/a/uploads", workspace: "/a/workspace" } };
const CHAT_B = { userHash: "b".repeat(32), chatHash: "d".repeat(32), folders: { uploads: "/b/uploads", workspace: "/b/workspace" } };
const MINUTE = 60_000;

function withEnv(t, name, value) {
	const before = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	t.after(() => {
		if (before === undefined) delete process.env[name];
		else process.env[name] = before;
	});
}

function callPublish(filePath) {
	return dispatchMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workbench_publish_artifact", arguments: { file_path: filePath } } });
}

test("a tool sees its own chat, even after waiting", async () => {
	const seen = await runInChat(CHAT_A, async () => {
		await delay(5);
		return currentChat();
	});
	assert.equal(seen, CHAT_A);
});

test("two calls running at once each see only their own chat", async () => {
	const look = (chat, wait) => runInChat(chat, async () => {
		const before = currentChat();
		await delay(wait);
		return [before, currentChat()];
	});
	const [a, b] = await Promise.all([look(CHAT_A, 20), look(CHAT_B, 5)]);
	assert.deepEqual(a, [CHAT_A, CHAT_A]);
	assert.deepEqual(b, [CHAT_B, CHAT_B]);
});

test("the chat ends when the call ends", async (t) => {
	withEnv(t, "JS_NATIVE_DEV", undefined);
	await runInChat(CHAT_A, async () => currentChat());
	assert.throws(() => currentChat(), new RegExp(NO_CHAT));
});

test("with no chat and no native setting, currentChat is an error", (t) => {
	withEnv(t, "JS_NATIVE_DEV", undefined);
	assert.throws(() => currentChat(), new RegExp(NO_CHAT));
});

test("a native setting of 0 or false doesn't count", (t) => {
	for (const value of ["0", "false", ""]) {
		withEnv(t, "JS_NATIVE_DEV", value);
		assert.throws(() => currentChat(), new RegExp(NO_CHAT), value);
	}
});

test("the native setting gives a marked native chat, and a real chat wins over it", async (t) => {
	withEnv(t, "JS_NATIVE_DEV", "1");
	assert.equal(currentChat().native, true);
	assert.equal(await runInChat(CHAT_A, async () => currentChat()), CHAT_A);
});

test("a run token gives back its own chat until it's revoked", () => {
	const tokenA = createRunToken(CHAT_A, MINUTE, "127.0.0.1");
	const tokenB = createRunToken(CHAT_B, MINUTE, "127.0.0.1");
	assert.match(tokenA, /^[a-f0-9]{64}$/);
	assert.notEqual(tokenA, tokenB);
	assert.equal(chatForRunToken(tokenA, "127.0.0.1"), CHAT_A);
	assert.equal(chatForRunToken(tokenB, "::ffff:127.0.0.1"), CHAT_B, "the same address written the IPv6 way");
	revokeRunToken(tokenA);
	assert.equal(chatForRunToken(tokenA, "127.0.0.1"), undefined);
	assert.equal(chatForRunToken(tokenB, "127.0.0.1"), CHAT_B);
	revokeRunToken(tokenB);
});

test("a run token gives no chat from another address, or when it has no address", () => {
	const token = createRunToken(CHAT_A, MINUTE, "10.89.1.3");
	assert.equal(chatForRunToken(token, "10.89.1.3"), CHAT_A);
	for (const address of ["10.89.2.3", "127.0.0.1", "", undefined]) assert.equal(chatForRunToken(token, address), undefined, String(address));
	const noAddress = createRunToken(CHAT_A, MINUTE);
	for (const address of ["", undefined, "127.0.0.1"]) assert.equal(chatForRunToken(noAddress, address), undefined, String(address));
	revokeRunToken(token);
	revokeRunToken(noAddress);
});

test("unknown, empty and expired run tokens give no chat", () => {
	for (const token of ["", undefined, "not-a-real-token", "a".repeat(64)]) assert.equal(chatForRunToken(token, "127.0.0.1"), undefined);
	assert.equal(chatForRunToken(createRunToken(CHAT_A, 0, "127.0.0.1"), "127.0.0.1"), undefined);
});

test("Pi gets the run token and the gateway's address in its environment", () => {
	const folders = { uploads: "/a/uploads", sessions: "/a/sessions" };
	const environment = agentEnvironment(folders, "/a/workspace/requests/r1", "run-token-value");
	assert.equal(environment.JS_RUN_TOKEN, "run-token-value");
	assert.equal(environment.JUNIOR_SILVA_MCP_GATEWAY_URL, `http://127.0.0.1:${GATEWAY_PORT}/internal/mcp`);
});

test("a tool call with no chat is refused", async (t) => {
	withEnv(t, "JS_NATIVE_DEV", undefined);
	const reply = await callPublish("/etc/passwd");
	assert.equal(reply.result.isError, true);
	assert.equal(reply.result.content[0].text, NO_CHAT);
});

test("a tool call with a chat reaches the tool", async () => {
	const reply = await runInChat(CHAT_A, () => callPublish("/etc/passwd"));
	assert.equal(reply.result.isError, true);
	assert.equal(reply.result.content[0].text, "File not found in this chat.");
});

test("a tool call on the native CLI reaches the tool", async (t) => {
	withEnv(t, "JS_NATIVE_DEV", "1");
	const reply = await callPublish("/etc/passwd");
	assert.equal(reply.result.content[0].text, "File not found in this chat.");
});

test("listing tools doesn't need a chat", async (t) => {
	withEnv(t, "JS_NATIVE_DEV", undefined);
	const reply = await dispatchMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
	assert.ok(reply.result.tools.length > 0);
});

async function launcherHeaders(t, runToken) {
	const seen = [];
	const gateway = createServer((req, res) => {
		seen.push(req.headers.authorization);
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
		});
	});
	await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	t.after(() => gateway.close());
	const environment = { ...process.env, JUNIOR_SILVA_MCP_GATEWAY_URL: `http://127.0.0.1:${gateway.address().port}/internal/mcp` };
	delete environment.JS_RUN_TOKEN;
	if (runToken) environment.JS_RUN_TOKEN = runToken;
	const child = spawn(process.execPath, [launcherPath], { env: environment, stdio: ["pipe", "pipe", "ignore"] });
	t.after(() => child.kill("SIGKILL"));
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("The launcher didn't reply in time")), 10_000);
		child.stdout.once("data", () => {
			clearTimeout(timer);
			resolve();
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
	});
	return seen;
}

test("the launcher sends the run token to the bridge", async (t) => {
	assert.deepEqual(await launcherHeaders(t, "launcher-test-token"), ["Bearer launcher-test-token"]);
});

test("the launcher sends no header when it has no run token", async (t) => {
	assert.deepEqual(await launcherHeaders(t, ""), [undefined]);
});

// Returns every reply the launcher gives within a short wait after its first one.
async function launcherReplies(t, gatewayUrl, messages) {
	const child = spawn(process.execPath, [launcherPath], { env: { ...process.env, JUNIOR_SILVA_MCP_GATEWAY_URL: gatewayUrl, JS_RUN_TOKEN: "launcher-test-token" }, stdio: ["pipe", "pipe", "ignore"] });
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
	for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
	const deadline = Date.now() + 10_000;
	while (!replies.length && Date.now() < deadline) await delay(20);
	await delay(300);
	return replies;
}

test("when the gateway refuses a call, the launcher's error carries the call's ID", async (t) => {
	const gateway = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.writeHead(429, { "Content-Type": "application/json" });
			res.end("{}");
		});
	});
	await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	t.after(() => gateway.close());
	const replies = await launcherReplies(t, `http://127.0.0.1:${gateway.address().port}/internal/mcp`, [
		{ jsonrpc: "2.0", method: "notifications/initialized" },
		{ jsonrpc: "2.0", id: 7, method: "tools/list" },
	]);
	assert.equal(replies.length, 1, "the notification must get no reply");
	assert.equal(replies[0].id, 7);
	assert.equal(replies[0].error.code, -32000);
});

test("when the gateway is down, the launcher's error carries the call's ID", async (t) => {
	const closed = createServer();
	await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
	const { port } = closed.address();
	await new Promise((resolve) => closed.close(resolve));
	const replies = await launcherReplies(t, `http://127.0.0.1:${port}/internal/mcp`, [{ jsonrpc: "2.0", id: "call-9", method: "tools/call", params: { name: "legal_validate_draft", arguments: {} } }]);
	assert.equal(replies.length, 1);
	assert.equal(replies[0].id, "call-9");
	assert.equal(replies[0].error.code, -32000);
});

async function startServer(t, overrides = {}) {
	const root = await mkdtemp(path.join(os.tmpdir(), "junior-silva-chat-context-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const port = 20000 + Math.floor(Math.random() * 20000);
	const child = spawn(process.execPath, [serverPath], {
		env: {
			...process.env,
			JUNIOR_SILVA_API_KEY: "test-junior-silva-key",
			JS_IDENTITY_SECRET: "test-identity-secret",
			JUNIOR_SILVA_ARTIFACT_SECRET: "test-artifact-secret",
			JS_NATIVE_DEV: "",
			JUNIOR_SILVA_BIND_HOST: "127.0.0.1",
			JUNIOR_SILVA_PORT: String(port),
			JUNIOR_SILVA_DATA_ROOT: root,
			JUNIOR_SILVA_ARTIFACT_ROOT: path.join(root, "artifacts"),
			PI_CODING_AGENT_DIR: path.join(root, "pi-agent"),
			...overrides,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(() => child.kill("SIGKILL"));
	return { child, port };
}

test("the tool route is on the gateway port, and refuses a call with no valid run token", async (t) => {
	const { child, port } = await startServer(t);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("The server did not start in time")), 15_000);
		child.stdout.on("data", (chunk) => {
			if (String(chunk).includes("listening")) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`The server exited early with code ${code}`));
		});
	});
	const post = (target, headers) => fetch(`http://127.0.0.1:${target}/internal/mcp`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
	});
	const gateway = port + 1;
	assert.equal((await post(gateway, {})).status, 401);
	assert.equal((await post(gateway, { Authorization: `Bearer ${"a".repeat(64)}` })).status, 401);
	assert.equal((await post(gateway, { Authorization: "Bearer test-junior-silva-key" })).status, 401, "the LibreChat key isn't a run token");
	assert.equal((await post(port, { Authorization: "Bearer test-junior-silva-key" })).status, 404, "the old route on the public port is gone");
});

test("the bridge refuses to start with the native setting", async (t) => {
	const { child } = await startServer(t, { JS_NATIVE_DEV: "1" });
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const code = await new Promise((resolve) => child.on("exit", resolve));
	assert.notEqual(code, 0);
	assert.match(stderr, /JS_NATIVE_DEV is only for the native CLI/);
});
