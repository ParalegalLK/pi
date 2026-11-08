import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ask, askStreaming, FAKE_MODEL_KEY, piProcesses, send, startBridgeWithFakeModel, TEST_MODEL } from "./fake-model/bridge.mjs";
import { startFakeModel } from "./fake-model/server.mjs";

let fake;
let bridge;
let chatNumber = 0;
const newChat = () => `fake-model-chat-${++chatNumber}`;

before(async () => {
	fake = await startFakeModel();
	bridge = await startBridgeWithFakeModel(fake.url);
});

after(async () => {
	await bridge?.close();
	await fake?.close();
});

async function streamEvents(url, body) {
	const response = await fetch(`${url}/v1/messages?beta=true`, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": "unit-test-key" }, body: JSON.stringify(body) });
	const events = [];
	for (const block of (await response.text()).split("\n\n")) {
		const event = /^event: (.+)$/m.exec(block)?.[1];
		const data = /^data: (.+)$/m.exec(block)?.[1];
		if (event) events.push({ event, data: JSON.parse(data) });
	}
	return { status: response.status, events };
}

async function waitUntil(check, withinMs, label) {
	const deadline = Date.now() + withinMs;
	while (!check()) {
		assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
		await delay(25);
	}
}

test("the fake model streams answers, tool calls and cut-offs the way Anthropic does", async () => {
	const own = await startFakeModel();
	try {
		own.script([{ text: "Hello" }, { tool: "legal_validate_draft", input: { file_path: "/x.md" } }, { text: "Long", cutOff: true }]);
		const answer = await streamEvents(own.url, { model: "test-model", messages: [] });
		assert.equal(answer.status, 200);
		assert.deepEqual(answer.events.map((item) => item.event), ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
		assert.equal(answer.events[2].data.delta.text, "Hello");
		assert.equal(answer.events[4].data.delta.stop_reason, "end_turn");

		const toolCall = await streamEvents(own.url, { model: "test-model", messages: [], tools: [{ name: "junior-silva-legal__legal_validate_draft" }] });
		assert.equal(toolCall.events[1].data.content_block.name, "junior-silva-legal__legal_validate_draft", "matched to the name Pi lists");
		assert.deepEqual(JSON.parse(toolCall.events[2].data.delta.partial_json), { file_path: "/x.md" });
		assert.equal(toolCall.events.at(-2).data.delta.stop_reason, "tool_use");

		const cutOff = await streamEvents(own.url, { model: "test-model", messages: [] });
		assert.equal(cutOff.events.at(-2).data.delta.stop_reason, "max_tokens");

		assert.equal(own.requests.length, 3);
		assert.equal(own.requests[0].path, "/v1/messages?beta=true");
		assert.equal(own.requests[0].headers["x-api-key"], "unit-test-key");
		assert.equal(own.requests[0].body.model, "test-model");
	} finally {
		await own.close();
	}
});

test("the fake model sends HTTP errors and stream errors", async () => {
	const own = await startFakeModel();
	try {
		own.script([{ status: 401, error: { type: "authentication_error", message: "invalid x-api-key" } }, { text: "Half", streamError: { type: "invalid_request_error", message: "broken" } }]);
		const rejected = await fetch(`${own.url}/v1/messages`, { method: "POST", body: "{}" });
		assert.equal(rejected.status, 401);
		assert.deepEqual(await rejected.json(), { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
		const broken = await streamEvents(own.url, { model: "test-model", messages: [] });
		assert.deepEqual(broken.events.map((item) => item.event), ["message_start", "content_block_start", "content_block_delta", "error"]);
		assert.equal(broken.events.at(-1).data.error.message, "broken");
	} finally {
		await own.close();
	}
});

test("real Pi answers through the fake model, with the fake key and the real tools listed", async () => {
	fake.script([{ text: "FAKE: A plaint starts a civil action." }]);
	const reply = await ask(bridge, newChat(), "What is a plaint?");
	assert.equal(reply.status, 200);
	assert.equal(reply.answer, "FAKE: A plaint starts a civil action.");
	assert.equal(fake.requests.length, 1);
	const [request] = fake.requests;
	assert.equal(request.path, "/v1/messages?beta=true");
	assert.equal(request.headers["x-api-key"], FAKE_MODEL_KEY);
	assert.equal(request.body.model, TEST_MODEL);
	assert.equal(request.body.stream, true);
	assert.ok(request.body.tools.some((tool) => /(^|__)legal_validate_draft$/.test(tool.name)), "the bridge's MCP tools were listed");
});

test("real Pi calls a real tool through the gateway, and gets its real result", async () => {
	fake.script([{ tool: "legal_validate_draft", input: { file_path: "/etc/passwd" } }, { text: "FAKE: the tool could not find that file." }]);
	const reply = await ask(bridge, newChat(), "Check the draft at /etc/passwd.");
	assert.equal(reply.status, 200);
	assert.equal(reply.answer, "FAKE: the tool could not find that file.");
	assert.equal(fake.requests.length, 2);
	assert.match(JSON.stringify(fake.requests[1].body.messages), /File not found in this chat\./);
});

test("with real Pi, a cut-off answer keeps its text and gets the note", async () => {
	fake.script([{ text: "FAKE-LONG-ANSWER", cutOff: true }]);
	const reply = await ask(bridge, newChat(), "Write a long memo on limitation periods.");
	assert.equal(reply.status, 200);
	assert.ok(reply.answer.startsWith("FAKE-LONG-ANSWER"), reply.answer);
	assert.match(reply.answer, /cut off/);
});

test("with real Pi, a failure partway gives the note on top, and only the log gets the reason", async () => {
	fake.script([{ text: "FAKE-HALF-ANSWER", streamError: { type: "invalid_request_error", message: "FAKE-STREAM-FAILURE" } }]);
	const reply = await askStreaming(bridge, newChat(), "What is a plaint?");
	assert.equal(reply.status, 200);
	assert.match(reply.answer, /^\*\*This answer isn't complete\.\*\*/);
	assert.ok(reply.answer.endsWith("FAKE-HALF-ANSWER"), reply.answer);
	assert.doesNotMatch(reply.answer, /FAKE-STREAM-FAILURE/);
	assert.equal(fake.requests.length, 1, "this failure isn't one Pi retries");
	await waitUntil(() => bridge.log.includes("FAKE-STREAM-FAILURE"), 2_000, "the reason in the log");
});

test("with real Pi, an overloaded model is retried and the user gets a clean answer", async () => {
	fake.script([{ status: 529, error: { type: "overloaded_error", message: "Overloaded" } }, { text: "FAKE-AFTER-RETRY" }]);
	const reply = await ask(bridge, newChat(), "What is a plaint?");
	assert.equal(reply.status, 200);
	assert.equal(reply.answer, "FAKE-AFTER-RETRY");
	assert.equal(fake.requests.length, 2);
});

test("with real Pi, a rejected key gives the fixed note after one request, with no retry", async () => {
	fake.script([{ status: 401, error: { type: "authentication_error", message: "invalid x-api-key" } }]);
	const reply = await ask(bridge, newChat(), "What is a plaint?");
	assert.equal(reply.status, 200);
	assert.match(reply.answer, /^\*\*I couldn't finish this answer\.\*\*/);
	assert.doesNotMatch(reply.answer, /x-api-key/);
	assert.equal(fake.requests.length, 1);
});

test("with real Pi, Stop while it waits for the model ends the run, and the chat goes on", async () => {
	fake.script([{ hold: true }, { text: "FAKE-NEXT-ANSWER" }]);
	const chatId = newChat();
	const controller = new AbortController();
	const reply = send(bridge, chatId, "Write a long memo on limitation periods.", { stream: true, signal: controller.signal }).catch(() => undefined);
	await waitUntil(() => fake.requests.length === 1, 20_000, "Pi to call the model");
	assert.ok(piProcesses(bridge).length > 0, "Pi should be running before the Stop");
	controller.abort();
	await reply;
	await waitUntil(() => piProcesses(bridge).length === 0, 5_000, "Pi and its launcher to stop");
	const next = await ask(bridge, chatId, "In one sentence, what is a plaint?");
	assert.equal(next.status, 200);
	assert.equal(next.answer, "FAKE-NEXT-ANSWER");
});
