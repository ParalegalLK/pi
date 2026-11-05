import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveChatScope } from "../core/chat-scope.mjs";

const SECRET = "test-identity-secret";
const API_KEY = "test-junior-silva-key";
const USER_A = "6aeb1539c0d293be53e05d50";
const USER_B = "6aeb1539c0d293be53e05d57";
const CHAT = "3671c914-1d3b-5cf0-aecf-90f095522854";
const OTHER_CHAT = "f9c088a4-0000-5000-8000-000000000000";

const NO_USER = "This request has no valid user ID.";
const NO_CHAT = "This request has no valid chat ID.";
const WRONG_USER = "The user in this request doesn't match its user ID.";

const serverPath = fileURLToPath(new URL("../server/openai.mjs", import.meta.url));

process.env.JS_IDENTITY_SECRET = SECRET;

function ids(user, chat) {
	const headers = {};
	if (user !== undefined) headers["x-librechat-user-id"] = user;
	if (chat !== undefined) headers["x-librechat-conversation-id"] = chat;
	return headers;
}

function assertRefused(headers, body, message) {
	assert.throws(() => resolveChatScope(headers, body), (error) => {
		assert.equal(error.status, 400);
		assert.equal(error.message, message);
		return true;
	});
}

function withEnv(t, name, value) {
	const before = process.env[name];
	process.env[name] = value;
	t.after(() => {
		if (before === undefined) delete process.env[name];
		else process.env[name] = before;
	});
}

async function startServer(t, overrides = {}) {
	const root = await mkdtemp(path.join(os.tmpdir(), "junior-silva-chat-scope-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const port = 20000 + Math.floor(Math.random() * 20000);
	const child = spawn(process.execPath, [serverPath], {
		env: {
			...process.env,
			JUNIOR_SILVA_API_KEY: API_KEY,
			JS_IDENTITY_SECRET: SECRET,
			JUNIOR_SILVA_BIND_HOST: "127.0.0.1",
			JUNIOR_SILVA_PORT: String(port),
			JUNIOR_SILVA_DATA_ROOT: root,
			JUNIOR_SILVA_ARTIFACT_ROOT: path.join(root, "artifacts"),
			JUNIOR_SILVA_UPLOAD_ROOT: path.join(root, "uploads"),
			JUNIOR_SILVA_WORKSPACE_ROOT: path.join(root, "workspace"),
			PI_CODING_AGENT_DIR: path.join(root, "pi-agent"),
			...overrides,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(() => child.kill("SIGKILL"));
	return { child, port, root };
}

function waitUntilListening(child) {
	return new Promise((resolve, reject) => {
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
}

test("real LibreChat IDs are accepted and give 32-character hex hashes", () => {
	const { userHash, chatHash } = resolveChatScope(ids(USER_A, CHAT), { user: USER_A });
	assert.match(userHash, /^[a-f0-9]{32}$/);
	assert.match(chatHash, /^[a-f0-9]{32}$/);
});

test("nanoid-style chat IDs and both length limits are accepted", () => {
	for (const chat of ["V1StGXR8_Z5jdHi6B-myT", "a".repeat(8), "a".repeat(128)]) {
		assert.match(resolveChatScope(ids(USER_A, chat), {}).chatHash, /^[a-f0-9]{32}$/);
	}
});

test("body.user may match the header or be absent", () => {
	for (const body of [{ user: USER_A }, {}, { user: null }]) {
		assert.match(resolveChatScope(ids(USER_A, CHAT), body).userHash, /^[a-f0-9]{32}$/);
	}
});

test("invalid user IDs are refused with a 400", () => {
	const invalid = [undefined, "", "abc", "a".repeat(23), "a".repeat(25), USER_A.toUpperCase(), "z".repeat(24), "anonymous", `${USER_A}, ${USER_B}`];
	for (const user of invalid) assertRefused(ids(user, CHAT), {}, NO_USER);
});

test("invalid and placeholder chat IDs are refused with a 400", () => {
	const invalid = [undefined, "", "new", "null", "undefined", "PENDING", "a".repeat(7), "a".repeat(129), "../../other", "has space inside", `${CHAT}, ${CHAT}`, "{{LIBRECHAT_BODY_CONVERSATIONID}}"];
	for (const chat of invalid) assertRefused(ids(USER_A, chat), {}, NO_CHAT);
});

test("a body.user that differs from the header is refused with a 400", () => {
	for (const user of [USER_B, "", 12345]) assertRefused(ids(USER_A, CHAT), { user }, WRONG_USER);
});

test("IDs in the body don't replace missing headers", () => {
	assertRefused(ids(USER_A, undefined), { conversationId: CHAT, conversation_id: CHAT }, NO_CHAT);
	assertRefused(ids(undefined, CHAT), { user: USER_A }, NO_USER);
});

test("the same input always gives the same hashes", () => {
	assert.deepEqual(resolveChatScope(ids(USER_A, CHAT), {}), resolveChatScope(ids(USER_A, CHAT), {}));
});

test("the same chat ID under two users gives two chat folders", () => {
	const first = resolveChatScope(ids(USER_A, CHAT), {});
	const second = resolveChatScope(ids(USER_B, CHAT), {});
	assert.notEqual(first.chatHash, second.chatHash);
	assert.notEqual(first.userHash, second.userHash);
});

test("two chats under one user give two chat hashes and one user hash", () => {
	const first = resolveChatScope(ids(USER_A, CHAT), {});
	const second = resolveChatScope(ids(USER_A, OTHER_CHAT), {});
	assert.notEqual(first.chatHash, second.chatHash);
	assert.equal(first.userHash, second.userHash);
});

test("the hashes match a separately calculated HMAC", () => {
	const hmac = (text) => createHmac("sha256", SECRET).update(text).digest("hex").slice(0, 32);
	const { userHash, chatHash } = resolveChatScope(ids(USER_A, CHAT), {});
	assert.equal(userHash, hmac(`user\0${USER_A}`));
	assert.equal(chatHash, hmac(`chat\0${USER_A}\0${CHAT}`));
});

test("changing the API key doesn't change the hashes", (t) => {
	withEnv(t, "JUNIOR_SILVA_API_KEY", "first-api-key");
	const before = resolveChatScope(ids(USER_A, CHAT), {});
	process.env.JUNIOR_SILVA_API_KEY = "second-api-key";
	assert.deepEqual(resolveChatScope(ids(USER_A, CHAT), {}), before);
});

test("changing the identity secret changes both hashes", (t) => {
	const before = resolveChatScope(ids(USER_A, CHAT), {});
	withEnv(t, "JS_IDENTITY_SECRET", "a-different-secret");
	const after = resolveChatScope(ids(USER_A, CHAT), {});
	assert.notEqual(after.userHash, before.userHash);
	assert.notEqual(after.chatHash, before.chatHash);
});

test("valid IDs without the identity secret are an error, not a weak hash", (t) => {
	withEnv(t, "JS_IDENTITY_SECRET", "");
	assert.throws(() => resolveChatScope(ids(USER_A, CHAT), {}), /JS_IDENTITY_SECRET is not configured/);
});

test("error messages never include what the sender sent", () => {
	const sent = "CLIENT-TEXT-MARKER";
	const attempts = [[ids(sent, CHAT), {}], [ids(USER_A, `${sent}!`), {}], [ids(USER_A, CHAT), { user: sent }]];
	for (const [headers, body] of attempts) {
		assert.throws(() => resolveChatScope(headers, body), (error) => !error.message.includes(sent));
	}
});

test("the running server enforces the checks before doing any work", async (t) => {
	const { child, port, root } = await startServer(t);
	await waitUntilListening(child);
	const base = `http://127.0.0.1:${port}`;
	const authorization = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
	const post = (headers, body) => fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
	const upload = { messages: [{ role: "user", content: "hello" }], files: [{ url: "data:text/plain;base64,aGVsbG8=", filename: "a.txt" }] };

	const noIds = await post(authorization, upload);
	assert.equal(noIds.status, 400);
	assert.equal((await noIds.json()).error.message, NO_USER);

	const badChat = await post({ ...authorization, ...ids(USER_A, "undefined") }, upload);
	assert.equal(badChat.status, 400);
	assert.equal((await badChat.json()).error.message, NO_CHAT);

	const wrongUser = await post({ ...authorization, ...ids(USER_A, CHAT) }, { ...upload, user: USER_B });
	assert.equal(wrongUser.status, 400);
	assert.equal((await wrongUser.json()).error.message, WRONG_USER);

	assert.deepEqual(await readdir(path.join(root, "uploads")), [], "a refused request must not save anything");

	const noKey = await post({ "Content-Type": "application/json" }, upload);
	assert.equal(noKey.status, 401);

	const models = await fetch(`${base}/v1/models`, { headers: authorization });
	assert.equal(models.status, 200);

	// An empty message stops before Pi starts, so reaching this error proves the IDs passed.
	const valid = await post({ ...authorization, ...ids(USER_A, CHAT) }, { user: USER_A, messages: [] });
	assert.equal(valid.status, 400);
	assert.equal((await valid.json()).error.message, "A user message or document is required");

	assert.equal((await fetch(`${base}/health`)).status, 200);
});

test("the server refuses to start without the identity secret", async (t) => {
	const { child } = await startServer(t, { JS_IDENTITY_SECRET: "" });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const code = await new Promise((resolve) => child.on("exit", resolve));
	assert.notEqual(code, 0);
	assert.match(stderr, /JS_IDENTITY_SECRET is not configured/);
	assert.doesNotMatch(stdout, /listening/);
});
