// The real bridge in the container way (task P3.7), with a stand-in for the runner and Pi. The real
// runner, Pi's container and gVisor are tested end to end on a machine with Docker.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BUSY_TEXT } from "../server/pi-executor.mjs";

const serverPath = fileURLToPath(new URL("../server/openai.mjs", import.meta.url));
const KEY = "test-junior-silva-key";
const RUNNER_SECRET = "runner-test-secret-0123456789abcdef0123";
const USER_A = "a1".repeat(12);
const FAILED = "Junior Silva could not complete this request. Please retry or contact the administrator.";

async function until(check, ms = 5_000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await check()) return true;
		await delay(20);
	}
	return false;
}

// A stand-in for the runner and Pi. Each run goes to the next handler the test queued, or answers
// "ok". Stop works like the real runner's: 202, then the run ends a little later, as after docker kill.
async function standInRunner(t) {
	const runner = { runs: [], stops: [], queue: [] };
	const server = http.createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		if (req.method === "POST" && req.url === "/runs") {
			const run = { body: JSON.parse(Buffer.concat(chunks).toString("utf8")), authorization: req.headers.authorization, startedAt: Date.now(), res };
			res.on("close", () => { run.hungUp = !res.writableFinished; });
			Object.assign(run, {
				start: () => res.writeHead(200, { "Content-Type": "application/octet-stream", Trailer: "X-Run-Exit, X-Run-Reason" }),
				event: (event) => res.write(`${JSON.stringify(event)}\n`),
				say: (text) => run.event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } }),
				end: (exit, reason) => {
					if (res.writableEnded) return;
					run.endedAt = Date.now();
					res.addTrailers({ "X-Run-Exit": String(exit), "X-Run-Reason": reason });
					res.end();
				},
				answer: (text) => {
					run.start();
					run.say(text);
					run.end(0, "done");
				},
				hold: () => {
					run.start();
					run.event({ type: "agent_start" });
				},
			});
			runner.runs.push(run);
			const handler = runner.queue.shift() ?? ((queued) => queued.answer("ok"));
			return void Promise.resolve(handler(run)).catch((error) => {
				console.error(error);
				res.destroy();
			});
		}
		const stopping = /^\/runs\/(chatcmpl-[0-9a-f-]{36})\/stop$/.exec(req.url);
		runner.stops.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
		const run = stopping && runner.runs.find((candidate) => candidate.body.requestId === stopping[1] && !candidate.res.writableEnded);
		if (req.method !== "POST" || !run) {
			res.writeHead(404);
			return res.end();
		}
		res.writeHead(202, { "Content-Type": "application/json" });
		res.end("{}");
		setTimeout(() => run.end(137, "stopped"), 200);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => {
		server.closeAllConnections();
		server.close(resolve);
	}));
	runner.url = `http://127.0.0.1:${server.address().port}`;
	return runner;
}

function bridgeEnvironment(root, port, runner, overrides) {
	const environment = {
		...process.env,
		JUNIOR_SILVA_API_KEY: KEY,
		JS_IDENTITY_SECRET: "test-identity-secret",
		JUNIOR_SILVA_ARTIFACT_SECRET: "test-artifact-secret",
		JS_NATIVE_DEV: "",
		JUNIOR_SILVA_BIND_HOST: "127.0.0.1",
		JUNIOR_SILVA_PORT: String(port),
		JUNIOR_SILVA_PUBLIC_URL: `http://127.0.0.1:${port}`,
		PI_PROVIDER: "anthropic",
		PI_MODEL: "claude-sonnet-5-5",
		ANTHROPIC_API_KEY: "test-anthropic-key",
		JUNIOR_SILVA_DATA_ROOT: root,
		JUNIOR_SILVA_ARTIFACT_ROOT: path.join(root, "artifacts"),
		PI_CODING_AGENT_DIR: path.join(root, "pi-agent"),
		// Empty, so the container way is used because it's the default.
		JS_PI_EXECUTOR: "",
		JS_ALLOW_LOCAL_PI: "",
		JS_RUNNER_URL: runner?.url ?? "http://127.0.0.1:1",
		JS_RUNNER_SECRET: RUNNER_SECRET,
		JS_SLOTS: "1",
		JS_SLOT_WAIT_MS: "60000",
		...overrides,
	};
	delete environment.PI_THINKING;
	return environment;
}

async function startBridge(t, runner, overrides = {}) {
	const root = await mkdtemp(path.join(os.tmpdir(), "junior-silva-container-runs-"));
	const port = 20000 + Math.floor(Math.random() * 20000);
	const child = spawn(process.execPath, [serverPath], { env: bridgeEnvironment(root, port, runner, overrides), stdio: ["ignore", "pipe", "pipe"] });
	t.after(async () => {
		child.kill("SIGKILL");
		await rm(root, { recursive: true, force: true });
	});
	const bridge = { port, root, child, log: "" };
	child.stdout.on("data", (chunk) => { bridge.log += chunk; });
	child.stderr.on("data", (chunk) => { bridge.log += chunk; });
	await until(() => /listening on/.test(bridge.log) || child.exitCode !== null, 15_000);
	assert.match(bridge.log, /listening on/, bridge.log);
	return bridge;
}

function chatHeaders(chat) {
	return { authorization: `Bearer ${KEY}`, "content-type": "application/json", "x-librechat-user-id": USER_A, "x-librechat-conversation-id": chat };
}

async function send(bridge, chat, text) {
	const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/chat/completions`, {
		method: "POST",
		headers: chatHeaders(chat),
		body: JSON.stringify({ model: "junior-silva-v2", messages: [{ role: "user", content: text }], stream: false }),
	});
	return { status: response.status, body: await response.json() };
}

const answerOf = (reply) => reply.body.choices?.[0]?.message?.content;
const chatRoot = (bridge, run) => path.join(bridge.root, "users", run.body.userHash, "chats", run.body.chatHash);
const requestFolder = (bridge, run) => path.join(chatRoot(bridge, run), "workspace", "requests", run.body.requestId);

test("a chat is answered through the runner on a free slot, and the bridge doesn't make the message folder", async (t) => {
	const runner = await standInRunner(t);
	const bridge = await startBridge(t, runner);
	runner.queue.push((run) => run.answer("The answer from Pi's container."));
	const reply = await send(bridge, "chat-plain-0001", "What is the limitation period?");
	assert.equal(reply.status, 200, JSON.stringify(reply.body));
	assert.equal(answerOf(reply), "The answer from Pi's container.");
	const [run] = runner.runs;
	assert.equal(run.authorization, `Bearer ${RUNNER_SECRET}`);
	assert.deepEqual(Object.keys(run.body).sort(), ["chatHash", "model", "prompt", "requestId", "runToken", "slot", "userHash"]);
	assert.equal(run.body.requestId, reply.body.id, "the run uses the message's own ID");
	assert.match(run.body.userHash, /^[0-9a-f]{32}$/);
	assert.match(run.body.chatHash, /^[0-9a-f]{32}$/);
	assert.equal(run.body.slot, 1);
	assert.match(run.body.runToken, /^[0-9a-f]{64}$/);
	assert.equal(run.body.model, "claude-sonnet-5-5");
	assert.ok(run.body.prompt.includes(`Use this request-only workspace for every file you create: ${requestFolder(bridge, run)}.`), run.body.prompt);
	assert.ok(run.body.prompt.endsWith("User request:\nWhat is the limitation period?"));
	for (const folder of ["uploads", "artifacts", "workspace", "sessions"]) assert.ok((await stat(path.join(chatRoot(bridge, run), folder))).isDirectory(), `the runner mounts ${folder}, so it must exist`);
	assert.equal(existsSync(requestFolder(bridge, run)), false, "Pi's start-up script makes the message folder, not the bridge");
});

test("the run token only works from the slot's Pi address, not from the bridge's own machine", async (t) => {
	const runner = await standInRunner(t);
	const bridge = await startBridge(t, runner);
	const gateway = `http://127.0.0.1:${bridge.port + 1}`;
	let statuses;
	runner.queue.push(async (run) => {
		const tools = await fetch(`${gateway}/internal/mcp`, { method: "POST", headers: { authorization: `Bearer ${run.body.runToken}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
		const model = await fetch(`${gateway}/model/anthropic/v1/messages`, { method: "POST", headers: { "x-api-key": run.body.runToken, "content-type": "application/json" }, body: "{}" });
		statuses = { tools: tools.status, model: model.status };
		run.answer("ok");
	});
	assert.equal((await send(bridge, "chat-token-0001", "hello")).status, 200);
	assert.deepEqual(statuses, { tools: 401, model: 401 });
});

test("Stop asks the runner to end the run, waits for it to end, and frees the slot", async (t) => {
	const runner = await standInRunner(t);
	const bridge = await startBridge(t, runner);
	runner.queue.push((run) => run.hold());
	const client = http.request(`http://127.0.0.1:${bridge.port}/v1/chat/completions`, { method: "POST", headers: chatHeaders("chat-stop-0001") }, (res) => res.resume());
	client.on("error", () => {});
	client.end(JSON.stringify({ model: "junior-silva-v2", messages: [{ role: "user", content: "a long task" }], stream: true }));
	assert.ok(await until(() => runner.runs.length === 1));
	const [held] = runner.runs;
	client.destroy();
	assert.ok(await until(() => held.endedAt), "the run never ended");
	assert.deepEqual(runner.stops, [{ method: "POST", url: `/runs/${held.body.requestId}/stop`, authorization: `Bearer ${RUNNER_SECRET}` }]);
	assert.ok(await until(() => held.hungUp !== undefined));
	assert.equal(held.hungUp, false, "the bridge waited for the run's own end instead of hanging up");
	assert.match(bridge.log, /Stopping the run for chat [0-9a-f]{32}, because its connection closed/);
	runner.queue.push((run) => run.answer("after the stop"));
	const next = await send(bridge, "chat-stop-0002", "next");
	assert.equal(answerOf(next), "after the stop");
	assert.equal(runner.runs[1].body.slot, 1);
	assert.ok(runner.runs[1].startedAt >= held.endedAt, "the slot was freed only after the stopped run ended");
});

test("a Pi that prints nothing in time gets one more try with a new message ID, but not a third", async (t) => {
	const runner = await standInRunner(t);
	const bridge = await startBridge(t, runner);
	const noStart = (run) => {
		run.start();
		run.end(137, "no-start");
	};
	runner.queue.push(noStart, (run) => run.answer("the second try"));
	const reply = await send(bridge, "chat-retry-0001", "hello");
	assert.equal(answerOf(reply), "the second try");
	const [first, second] = runner.runs;
	assert.equal(reply.body.id, first.body.requestId, "the answer keeps the message's own ID");
	assert.match(second.body.requestId, /^chatcmpl-[0-9a-f-]{36}$/);
	assert.notEqual(second.body.requestId, first.body.requestId);
	assert.ok(second.body.prompt.includes(`Use this request-only workspace for every file you create: ${requestFolder(bridge, second)}.`), "the retry gets its own folder");
	assert.notEqual(second.body.runToken, first.body.runToken, "each try gets its own token");
	assert.match(bridge.log, /Pi didn't start in time for chat [0-9a-f]{32}, so it gets one more try/);
	runner.queue.push(noStart, noStart);
	const failed = await send(bridge, "chat-retry-0002", "hello");
	assert.equal(failed.status, 500);
	assert.equal(failed.body.error.message, FAILED);
	assert.equal(runner.runs.length, 4, "no third try");
});

test("a failed run or a refused one gives the usual error, and the slot is free again", async (t) => {
	const runner = await standInRunner(t);
	const bridge = await startBridge(t, runner);
	runner.queue.push(
		(run) => {
			run.start();
			run.res.write("partial\n");
			run.end(2, "done");
		},
		(run) => {
			run.res.writeHead(503, { "Content-Type": "application/json" });
			run.res.end(JSON.stringify({ error: "js-slot-1 can't be used: the bridge container junior-silva-v2 isn't there" }));
		},
		(run) => run.answer("fine again"),
	);
	for (const chat of ["chat-failed-0001", "chat-failed-0002"]) {
		const failed = await send(bridge, chat, "hello");
		assert.equal(failed.status, 500);
		assert.equal(failed.body.error.message, FAILED, "the runner's words never reach the user");
	}
	assert.match(bridge.log, /Pi exited with code 2 \(done\)/);
	assert.match(bridge.log, /the runner refused the run \(503\): js-slot-1 can't be used/);
	assert.equal(answerOf(await send(bridge, "chat-failed-0003", "hello")), "fine again");
});

test("with one slot, a second message waits its turn, and one that waits too long gets the busy answer", async (t) => {
	const runner = await standInRunner(t);
	const bridge = await startBridge(t, runner, { JS_SLOT_WAIT_MS: "3000" });
	let first;
	runner.queue.push((run) => {
		first = run;
		run.hold();
	}, (run) => run.answer("the second answer"));
	const firstReply = send(bridge, "chat-line-0001", "first");
	assert.ok(await until(() => first));
	const secondReply = send(bridge, "chat-line-0002", "second");
	await delay(700);
	assert.equal(runner.runs.length, 1, "the second message waits for the only slot");
	first.say("the first answer");
	first.end(0, "done");
	assert.equal(answerOf(await firstReply), "the first answer");
	assert.equal(answerOf(await secondReply), "the second answer");
	assert.equal(runner.runs[1].body.slot, 1);
	assert.ok(runner.runs[1].startedAt >= first.endedAt, "it started only after the first run ended");

	let holder;
	runner.queue.push((run) => {
		holder = run;
		run.hold();
	});
	const thirdReply = send(bridge, "chat-line-0003", "third");
	assert.ok(await until(() => holder));
	const started = Date.now();
	const busy = await send(bridge, "chat-line-0004", "fourth");
	assert.ok(Date.now() - started >= 2_900, "it waited first");
	assert.equal(busy.status, 429);
	assert.equal(busy.body.error.message, BUSY_TEXT);
	assert.equal(runner.runs.length, 3, "the busy message never ran");
	assert.match(bridge.log, /A message got the busy answer: no slot was free within 3000 ms\./);
	assert.doesNotMatch(bridge.log, /Error: Junior Silva is busy/, "being busy isn't logged as a failure");
	holder.say("the third answer");
	holder.end(0, "done");
	assert.equal(answerOf(await thirdReply), "the third answer");
});

test("a file Pi made but didn't deliver gets a repair run with its own message ID, then is delivered", async (t) => {
	const runner = await standInRunner(t);
	const bridge = await startBridge(t, runner);
	let note;
	runner.queue.push(async (run) => {
		// What Pi's start-up script and Pi would do in the container.
		const folder = requestFolder(bridge, run);
		await mkdir(path.dirname(folder), { recursive: true });
		await mkdir(folder, { mode: 0o700 });
		note = path.join(folder, "limitation-note.md");
		await writeFile(note, "# Limitation period\n\nA short note.\n");
		run.answer("I prepared the note.");
	}, (run) => run.answer("Delivered."));
	const reply = await send(bridge, "chat-repair-0001", "Prepare a short note on the limitation period as a Markdown (.md) file.");
	assert.equal(reply.status, 200, JSON.stringify(reply.body));
	assert.equal(runner.runs.length, 2);
	const [first, repair] = runner.runs;
	assert.notEqual(repair.body.requestId, first.body.requestId, "the repair run gets its own message ID");
	assert.ok(repair.body.prompt.startsWith(`A requested deliverable from your previous answer has not been delivered. Inspect only ${note}.`), repair.body.prompt);
	assert.match(answerOf(reply), /The requested legal work product is ready\.[\s\S]*\[Download completed file\]\(http:\/\/127\.0\.0\.1:\d+\/files\//);
});

test("the bridge refuses to start with a wrong Pi setting, and says which", async () => {
	const cases = [
		[{ JS_PI_EXECUTOR: "sideways" }, /JS_PI_EXECUTOR must be container or local/],
		[{ JS_PI_EXECUTOR: "local" }, /JS_PI_EXECUTOR=local runs Pi inside the bridge.*for development only/],
		[{ JS_PI_EXECUTOR: "local", JS_ALLOW_LOCAL_PI: "yes" }, /for development only/],
		[{ JS_RUNNER_URL: "" }, /JS_RUNNER_URL must be the runner's http address/],
		[{ JS_RUNNER_URL: "https://junior-silva-runner:8128" }, /JS_RUNNER_URL must be/],
		[{ JS_RUNNER_URL: "http://junior-silva-runner:8128/runs" }, /JS_RUNNER_URL must be/],
		[{ JS_RUNNER_SECRET: "" }, /JS_RUNNER_SECRET must be set, with at least 32 characters/],
		[{ JS_RUNNER_SECRET: "short" }, /JS_RUNNER_SECRET must be set/],
		[{ JS_SLOTS: "0" }, /JS_SLOTS must be a whole number from 1 to 254/],
		[{ JS_SLOTS: "255" }, /JS_SLOTS must be/],
		[{ JS_SLOTS: "1.5" }, /JS_SLOTS must be/],
		[{ JS_SLOTS: "two" }, /JS_SLOTS must be/],
		[{ JS_SLOT_WAIT_MS: "-1" }, /JS_SLOT_WAIT_MS must be a whole number/],
		[{ JS_SLOT_WAIT_MS: "soon" }, /JS_SLOT_WAIT_MS must be/],
	];
	const root = await mkdtemp(path.join(os.tmpdir(), "junior-silva-container-checks-"));
	try {
		await Promise.all(cases.map(async ([settings, reason], index) => {
			const port = 20000 + Math.floor(Math.random() * 20000);
			const child = spawn(process.execPath, [serverPath], { env: bridgeEnvironment(path.join(root, String(index)), port, undefined, settings), stdio: ["ignore", "pipe", "pipe"] });
			let output = "";
			child.stdout.on("data", (chunk) => { output += chunk; });
			child.stderr.on("data", (chunk) => { output += chunk; });
			const code = await Promise.race([new Promise((resolve) => child.on("exit", resolve)), delay(15_000).then(() => "still running")]);
			if (code === "still running") child.kill("SIGKILL");
			assert.equal(code, 1, `${JSON.stringify(settings)}: ${output}`);
			assert.match(output, reason, JSON.stringify(settings));
			assert.doesNotMatch(output, /listening on/);
		}));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
