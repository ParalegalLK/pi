import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ask, PROXY_REAL_KEY, startBridgeWithFakeModel, TEST_MODEL } from "./fake-model/bridge.mjs";
import { startFakeModel } from "./fake-model/server.mjs";

process.env.JUNIOR_SILVA_API_KEY ||= "test-junior-silva-key";
delete process.env.JS_NATIVE_DEV;
const { modelCallProblem } = await import("../server/model-proxy.mjs");
const { startGateway } = await import("../server/gateway.mjs");
const { createRunToken, revokeRunToken } = await import("../server/run-tokens.mjs");

const CHAT = { userHash: "a".repeat(32), chatHash: "b".repeat(32), folders: {} };
const BETAS = "mid-conversation-output-config-2026-07-01,thinking-binding-controls-2026-08-01,inline-tools-2026-09-15";
const LIMIT = 32 * 1024 * 1024;
const servers = [];

// Shaped like what real Pi sends for our models, including the parts that are easy to get wrong:
// a tool whose settings have a field called "source", a tool call whose arguments do too, the
// placeholder tool, a mid-chat system message adding a tool, and images in base64.
function piBody() {
	const sourceSchema = { type: "object", properties: { source: { type: "string", enum: ["case_decision", "legislation"] } } };
	return {
		model: TEST_MODEL,
		max_tokens: 128000,
		stream: true,
		system: [{ type: "text", text: "You are Junior Silva.", cache_control: { type: "ephemeral" } }],
		thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } },
		output_config: { effort: "high" },
		tools: [
			{ name: "legal_source_retrieve_details", description: "Reads legal sources.", input_schema: sourceSchema },
			{ name: "__pi_deferred_placeholder__", description: "Reserved placeholder.", input_schema: { type: "object", properties: {}, required: [] }, defer_loading: true },
		],
		messages: [
			{ role: "user", content: [{ type: "text", text: "Read this." }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] },
			{ role: "assistant", content: [{ type: "thinking", thinking: "Planning.", signature: "sig" }, { type: "tool_use", id: "toolu_1", name: "legal_source_retrieve_details", input: { source: "case_decision", operation: "find" } }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "Result." }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] }] },
			{ role: "system", content: [{ type: "text", text: "Tools changed." }, { type: "tool_addition", tool: { type: "tool_definition", definition: { name: "new_tool", description: "New.", input_schema: sourceSchema } } }, { type: "tool_removal", tool: { type: "tool_reference", name: "old_tool" } }] },
		],
	};
}

const changed = (change) => {
	const body = piBody();
	change(body);
	return body;
};

after(async () => {
	for (const server of servers) await server.close();
});

async function openGateway(fakeUrl, modelService = {}) {
	const gateway = await startGateway({ port: 0, host: "127.0.0.1", modelService: { model: TEST_MODEL, apiKey: PROXY_REAL_KEY, upstream: fakeUrl, ...modelService } });
	servers.push({ close: () => new Promise((resolve) => { gateway.closeAllConnections(); gateway.close(resolve); }) });
	return gateway.address().port;
}

async function newFake() {
	const fake = await startFakeModel();
	servers.push(fake);
	return fake;
}

// Calls the gateway's model route the way Pi's Anthropic client does, with a chosen source address.
function modelCall(port, { token, body = piBody(), headers = {}, from = "127.0.0.1", route = "/model/anthropic/v1/messages?beta=true", signal } = {}) {
	const payload = typeof body === "string" ? body : JSON.stringify(body);
	return new Promise((resolve, reject) => {
		const req = request({
			host: "127.0.0.1",
			port,
			method: "POST",
			path: route,
			localAddress: from,
			agent: false,
			signal,
			headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": BETAS, "Content-Length": Buffer.byteLength(payload), ...(token ? { "x-api-key": token } : {}), ...headers },
		}, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { text += chunk; });
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
			res.on("error", reject);
		});
		req.on("error", reject);
		req.end(payload);
	});
}

async function waitUntil(check, withinMs, label) {
	const deadline = Date.now() + withinMs;
	while (!check()) {
		assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
		await delay(20);
	}
}

test("a call shaped like real Pi's passes the checks", () => {
	assert.equal(modelCallProblem(piBody(), { "anthropic-beta": BETAS }, TEST_MODEL), undefined);
	assert.equal(modelCallProblem(piBody(), {}, TEST_MODEL), undefined, "no beta header at all");
});

test("each kind of unsafe call is caught", () => {
	const cases = [
		["a body that isn't an object", [], /isn't a JSON object/],
		["the fallbacks field", changed((body) => { body.fallbacks = [{ model: "claude-opus-9" }]; }), /"fallbacks"/],
		["the mcp_servers field", changed((body) => { body.mcp_servers = [{ type: "url", url: "https://evil.example/mcp" }]; }), /"mcp_servers"/],
		["the container field", changed((body) => { body.container = "container_1"; }), /"container"/],
		["another model", changed((body) => { body.model = "claude-opus-5-5"; }), /model isn't allowed/],
		["a server tool in tools", changed((body) => { body.tools.push({ type: "web_fetch_20250910", name: "web_fetch" }); }), /only custom tools/],
		["tools that aren't a list", changed((body) => { body.tools = { name: "x" }; }), /only custom tools/],
		["a server tool added mid-chat", changed((body) => { body.messages[3].content[1].tool.definition = { type: "web_search_20250305", name: "web_search" }; }), /only custom tools/],
		["a tool addition of another kind", changed((body) => { body.messages[3].content[1].tool = { type: "mcp_toolset", mcp_server_name: "evil" }; }), /only custom tools/],
		["a URL image", changed((body) => { body.messages[0].content[1].source = { type: "url", url: "https://evil.example/x.png?d=client-text" }; }), /only base64/],
		["a URL image deep inside a tool result", changed((body) => { body.messages[2].content[0].content[1].source = { type: "url", url: "https://evil.example/x.png" }; }), /only base64/],
		["a file source", changed((body) => { body.messages[0].content.push({ type: "document", source: { type: "file", file_id: "file_1" } }); }), /only base64/],
		["a source that's a plain string", changed((body) => { body.messages[0].content.push({ type: "document", source: "https://evil.example/doc.pdf" }); }), /only base64/],
		["a URL source in the system prompt", changed((body) => { body.system.push({ type: "image", source: { type: "url", url: "https://evil.example/x.png" } }); }), /only base64/],
	];
	for (const [label, body, expected] of cases) assert.match(String(modelCallProblem(body, { "anthropic-beta": BETAS }, TEST_MODEL)), expected, label);
	assert.match(String(modelCallProblem(piBody(), {}, undefined)), /model isn't allowed/, "no model configured");
	assert.match(String(modelCallProblem(piBody(), { "anthropic-beta": `${BETAS},files-api-2025-04-14` }, TEST_MODEL)), /"files-api-2025-04-14"/);
	assert.match(String(modelCallProblem(piBody(), { "anthropic-beta": "server-side-fallback-2026-07-01" }, TEST_MODEL)), /server-side-fallback/);
});

test("an allowed call reaches the model with the real key, and streams back unchanged", async () => {
	const fake = await newFake();
	const port = await openGateway(fake.url);
	const token = createRunToken(CHAT, 60_000, "127.0.0.1");
	fake.script([{ text: "FAKE-PROXIED-ANSWER" }]);
	const reply = await modelCall(port, { token, headers: { "user-agent": "Anthropic/JS", "x-stainless-os": "Linux", "x-extra": "not passed on" } });
	assert.equal(reply.status, 200);
	assert.match(reply.headers["content-type"], /text\/event-stream/);
	assert.match(reply.text, /"text":"FAKE-PROXIED-ANSWER"/);
	assert.match(reply.text, /event: message_stop/);
	const [arrived] = fake.requests;
	assert.equal(arrived.path, "/v1/messages?beta=true");
	assert.equal(arrived.headers["x-api-key"], PROXY_REAL_KEY);
	assert.equal(arrived.headers["anthropic-beta"], BETAS);
	assert.equal(arrived.headers["anthropic-version"], "2023-06-01");
	assert.equal(arrived.headers["x-stainless-os"], undefined);
	assert.equal(arrived.headers["x-extra"], undefined);
	assert.ok(!JSON.stringify(arrived.headers).includes(token), "the run token never reaches the model");
	assert.deepEqual(arrived.body, piBody());
	revokeRunToken(token);
});

test("a body with two model fields reaches the model with exactly one", async () => {
	const fake = await newFake();
	const port = await openGateway(fake.url);
	const token = createRunToken(CHAT, 60_000, "127.0.0.1");
	fake.script([{ text: "FAKE" }]);
	const raw = `{"model":"claude-opus-9-9","model":"${TEST_MODEL}","max_tokens":10,"stream":true,"messages":[{"role":"user","content":"hi"}]}`;
	assert.equal((await modelCall(port, { token, body: raw })).status, 200);
	assert.equal(fake.requests[0].raw.split('"model"').length - 1, 1);
	assert.equal(fake.requests[0].body.model, TEST_MODEL);
	revokeRunToken(token);
});

test("refused calls get 400 and never reach the model", async (t) => {
	t.mock.method(console, "warn", () => {});
	const fake = await newFake();
	const port = await openGateway(fake.url);
	const token = createRunToken(CHAT, 60_000, "127.0.0.1");
	fake.script([]);
	for (const body of [
		changed((body) => { body.mcp_servers = []; }),
		changed((body) => { body.model = "claude-opus-5-5"; }),
		changed((body) => { body.tools.push({ type: "web_search_20250305", name: "web_search" }); }),
		changed((body) => { body.messages[0].content[1].source = { type: "url", url: "https://evil.example/x.png" }; }),
	]) {
		const reply = await modelCall(port, { token, body });
		assert.equal(reply.status, 400);
		assert.deepEqual(JSON.parse(reply.text), { type: "error", error: { type: "invalid_request_error", message: "This model call isn't allowed" } });
	}
	assert.equal((await modelCall(port, { token, headers: { "anthropic-beta": "files-api-2025-04-14" } })).status, 400);
	assert.equal((await modelCall(port, { token, body: "{not json" })).status, 400);
	assert.equal(fake.requests.length, 0);
	revokeRunToken(token);
});

test("calls without a valid run token get 401 and never reach the model", async () => {
	const fake = await newFake();
	const port = await openGateway(fake.url);
	const token = createRunToken(CHAT, 60_000, "127.0.0.1");
	for (const [label, options] of [["no token", {}], ["a wrong token", { token: "a".repeat(64) }], ["the LibreChat key", { token: "test-junior-silva-key" }], ["the real key", { token: PROXY_REAL_KEY }], ["the right token from another address", { token, from: "127.0.0.2" }]]) {
		const reply = await modelCall(port, options);
		assert.equal(reply.status, 401, label);
		assert.equal(JSON.parse(reply.text).error.type, "authentication_error", label);
	}
	assert.equal(fake.requests.length, 0);
	revokeRunToken(token);
});

test("limits, routes and errors", async (t) => {
	t.mock.method(console, "error", () => {});
	const fake = await newFake();
	const port = await openGateway(fake.url);
	const token = createRunToken(CHAT, 60_000, "127.0.0.1");
	fake.script([{ text: "FAKE-LARGE" }]);
	const large = changed((body) => { body.messages[0].content[0].text = "x".repeat(6 * 1024 * 1024); });
	assert.equal((await modelCall(port, { token, body: large })).status, 200, "a call larger than a tool call's 4 MB is fine");
	const tooLarge = changed((body) => { body.messages[0].content[0].text = "x".repeat(LIMIT); });
	assert.equal((await modelCall(port, { token, body: tooLarge })).status, 413);
	for (const route of ["/model/anthropic/v1/complete", "/model/anthropic/v1/messages?beta=false", "/model/openai/v1/messages", "/v1/messages"]) {
		assert.equal((await modelCall(port, { token, route })).status, 404, route);
	}
	assert.equal(fake.requests.length, 1, "only the large allowed call arrived");

	fake.script([{ status: 400, error: { type: "invalid_request_error", message: `bad request for key ${PROXY_REAL_KEY}` } }]);
	const echoed = await modelCall(port, { token });
	assert.equal(echoed.status, 400);
	assert.doesNotMatch(echoed.text, new RegExp(PROXY_REAL_KEY));
	assert.match(echoed.text, /\[removed\]/);

	const noKey = await openGateway(fake.url, { apiKey: "" });
	fake.script([]);
	assert.equal((await modelCall(noKey, { token })).status, 503);
	assert.equal(fake.requests.length, 0);

	const closed = createServer();
	await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
	const deadPort = closed.address().port;
	await new Promise((resolve) => closed.close(resolve));
	const unreachable = await openGateway(`http://127.0.0.1:${deadPort}`);
	const reply = await modelCall(unreachable, { token });
	assert.equal(reply.status, 502);
	assert.deepEqual(JSON.parse(reply.text), { type: "error", error: { type: "api_error", message: "The model service could not be reached" } });
	revokeRunToken(token);
});

test("when Pi hangs up mid-answer, the call to the model is cancelled", async () => {
	const fake = await newFake();
	const port = await openGateway(fake.url);
	const token = createRunToken(CHAT, 60_000, "127.0.0.1");
	fake.script([{ hold: true }]);
	const hangUp = new AbortController();
	const call = modelCall(port, { token, signal: hangUp.signal }).catch(() => undefined);
	await waitUntil(() => fake.requests.length === 1, 5_000, "the call to reach the model");
	hangUp.abort();
	await call;
	await waitUntil(() => fake.requests[0].closedEarly, 5_000, "the model call to be cancelled");
	revokeRunToken(token);
});

test("real Pi works through the proxy, and everything it sends is allowed", async () => {
	const fake = await newFake();
	const bridge = await startBridgeWithFakeModel(fake.url, { throughProxy: true });
	servers.push(bridge);
	fake.script([{ text: "FAKE: through the proxy." }]);
	const plain = await ask(bridge, "proxy-chat-1", "What is a plaint?");
	assert.equal(plain.status, 200);
	assert.equal(plain.answer, "FAKE: through the proxy.");

	fake.script([{ tool: "legal_validate_draft", input: { file_path: "/etc/passwd" } }, { text: "FAKE: tool done through the proxy." }]);
	const withTool = await ask(bridge, "proxy-chat-2", "Check the draft at /etc/passwd.");
	assert.equal(withTool.answer, "FAKE: tool done through the proxy.");
	assert.equal(fake.requests.length, 2);
	assert.match(JSON.stringify(fake.requests[1].body.messages), /File not found in this chat\./);
	for (const arrived of fake.requests) {
		assert.equal(arrived.headers["x-api-key"], PROXY_REAL_KEY);
		assert.equal(modelCallProblem(arrived.body, arrived.headers, TEST_MODEL), undefined, "real Pi's call is on the allowed lists");
	}
	assert.doesNotMatch(bridge.log, /Refused a model call/);
});
