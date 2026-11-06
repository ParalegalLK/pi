import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

process.env.JUNIOR_SILVA_API_KEY ||= "test-junior-silva-key";
const { finishedAnswer } = await import("../server/openai.mjs");

const serverPath = fileURLToPath(new URL("../server/openai.mjs", import.meta.url));
const useFakePi = new URL("./fixtures/use-fake-pi.mjs", import.meta.url).href;
const USER = "aaaaaaaaaaaaaaaaaaaaaa20";
const KEY = "test-junior-silva-key";
const GENERIC_ERROR = "Junior Silva could not complete this request. Please retry or contact the administrator.";
const SECOND = 1_000;
const GRACE = 5 * SECOND;
const bridges = [];
let bridge;
let tagNumber = 0;

async function startBridge(overrides = {}) {
	const root = await mkdtemp(path.join(os.tmpdir(), "junior-silva-stop-"));
	const port = 20000 + Math.floor(Math.random() * 20000);
	const child = spawn(process.execPath, ["--import", useFakePi, serverPath], {
		env: {
			...process.env,
			JUNIOR_SILVA_API_KEY: KEY,
			JS_IDENTITY_SECRET: "test-identity-secret",
			JUNIOR_SILVA_ARTIFACT_SECRET: "test-artifact-secret",
			JS_NATIVE_DEV: "",
			JUNIOR_SILVA_BIND_HOST: "127.0.0.1",
			JUNIOR_SILVA_PORT: String(port),
			JUNIOR_SILVA_PUBLIC_URL: `http://127.0.0.1:${port}`,
			JUNIOR_SILVA_DATA_ROOT: root,
			JUNIOR_SILVA_ARTIFACT_ROOT: path.join(root, "artifacts"),
			PI_CODING_AGENT_DIR: path.join(root, "pi-agent"),
			...overrides,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const running = { child, port, root, log: "" };
	bridges.push(running);
	child.stderr.on("data", (chunk) => { running.log += chunk; });
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("The bridge did not start in time")), 15 * SECOND);
		child.stdout.on("data", (chunk) => {
			running.log += chunk;
			if (String(chunk).includes("listening")) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`The bridge exited early with code ${code}: ${running.log}`));
		});
	});
	return running;
}

before(async () => { bridge = await startBridge(); });

after(async () => {
	for (const { child, root } of bridges) {
		child.kill("SIGKILL");
		await rm(root, { recursive: true, force: true });
	}
});

function send(target, chatId, text, { stream = false, signal } = {}) {
	return fetch(`http://127.0.0.1:${target.port}/v1/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}`, "x-librechat-user-id": USER, "x-librechat-conversation-id": chatId },
		body: JSON.stringify({ user: USER, stream, messages: [{ role: "user", content: text }] }),
		signal,
	});
}

async function ask(target, chatId, text) {
	const response = await send(target, chatId, text);
	const body = await response.json();
	return { status: response.status, answer: body.choices?.[0]?.message?.content ?? "", error: body.error?.message };
}

async function askStreaming(target, chatId, text) {
	const response = await send(target, chatId, text, { stream: true });
	let answer = "";
	for (const line of (await response.text()).split("\n")) {
		if (line.startsWith("data: ") && line !== "data: [DONE]") answer += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? "";
	}
	return { status: response.status, answer };
}

function scenario(name, chatId = undefined, prefix = "") {
	tagNumber += 1;
	const tag = `t${tagNumber}`;
	return { tag, chatId: chatId ?? `stop-handling-${tag}`, text: `${prefix}Scenario SCENARIO-${name} TAG-${tag}` };
}

async function piNotes(target, tag) {
	const file = path.join(target.root, "fake-pi.jsonl");
	if (!existsSync(file)) return [];
	return (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((note) => note.tag === tag);
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(check, withinMs, label) {
	const deadline = Date.now() + withinMs;
	for (;;) {
		const value = await check();
		if (value) return value;
		assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
		await delay(20);
	}
}

const noteFor = (target, tag, event, withinMs = 10 * SECOND, wanted = () => true) => waitUntil(async () => (await piNotes(target, tag)).find((note) => note.event === event && wanted(note)), withinMs, `${event} from ${tag}`);

// Sends a message, and returns once its Pi has started. The caller stops it with `stop()`.
async function startRun(target, name, { stream = false, chatId, prefix, event = "started", wanted } = {}) {
	const run = scenario(name, chatId, prefix);
	const controller = new AbortController();
	const reply = send(target, run.chatId, run.text, { stream, signal: controller.signal }).catch(() => undefined);
	const note = await noteFor(target, run.tag, event, 10 * SECOND, wanted);
	return { ...run, pid: note.pid, note, stop: () => controller.abort(), reply };
}

test("only a finished answer goes back unchanged", () => {
	assert.equal(finishedAnswer(" an answer \n", "stop"), "an answer");
	assert.equal(finishedAnswer("the guard's message", undefined), "the guard's message");
	assert.equal(finishedAnswer("", "stop"), "");
});

test("an answer cut off by the length limit says so at the end", () => {
	const answer = finishedAnswer("a long answer", "length");
	assert.ok(answer.startsWith("a long answer"));
	assert.match(answer, /cut off.*$/);
});

test("anything else that isn't finished says so on top", () => {
	for (const stopReason of ["error", "aborted", "toolUse", "pending", "deferred", "something-new"]) {
		const answer = finishedAnswer("half an answer", stopReason);
		assert.match(answer, /^\*\*This answer isn't complete\.\*\*/, stopReason);
		assert.ok(answer.endsWith("half an answer"), stopReason);
	}
});

test("an unfinished run with no text says it couldn't finish", () => {
	for (const stopReason of ["error", "aborted", "length", "toolUse", "something-new"]) {
		assert.match(finishedAnswer("  ", stopReason), /^\*\*I couldn't finish this answer\.\*\*/, stopReason);
	}
});

for (const stream of [true, false]) {
	test(`Stop ends a ${stream ? "streaming" : "non-streaming"} run, and the next message starts right away`, async () => {
		const run = await startRun(bridge, "HANG", { stream });
		assert.ok(alive(run.pid), "Pi should be running before the Stop");
		run.stop();
		await waitUntil(() => !alive(run.pid), GRACE - SECOND, "Pi to stop");

		const next = scenario("OK", run.chatId);
		const sentAt = Date.now();
		const reply = await ask(bridge, next.chatId, next.text);
		assert.equal(reply.status, 200);
		assert.equal(reply.answer, "FAKE-ANSWER");
		assert.ok(Date.now() - sentAt < GRACE - SECOND, "the next message had to wait");
	});
}

test("a Pi that ignores the request to stop is forced, and the next message waits for that", async () => {
	const run = await startRun(bridge, "STUCK", { event: "ready" });
	assert.equal(run.note.toolRouteStatus, 200, "the run token should work before the Stop");
	const stoppedAt = Date.now();
	run.stop();
	const next = scenario("OK", run.chatId);
	const reply = ask(bridge, next.chatId, next.text);

	const afterStop = await noteFor(bridge, run.tag, "after-stop", 3 * SECOND);
	assert.equal(afterStop.toolRouteStatus, 401, "the run token should be cancelled by the Stop");
	assert.ok(alive(run.pid), "Pi should still be running during the grace time");

	const { answer } = await reply;
	assert.equal(answer, "FAKE-ANSWER");
	assert.equal(alive(run.pid), false);
	const [nextStart] = await piNotes(bridge, next.tag);
	assert.ok(nextStart.at - stoppedAt >= GRACE - 500, "the next message started while the old Pi was still running");
	assert.ok(nextStart.at - stoppedAt < GRACE + 5 * SECOND, "the old Pi wasn't forced in time");
});

test("a process left behind holding Pi's pipes doesn't block the chat", async (t) => {
	const run = await startRun(bridge, "LEFTOVER", { event: "ready" });
	t.after(() => {
		try { process.kill(run.note.leftover, "SIGKILL"); } catch { }
	});
	run.stop();
	await waitUntil(() => !alive(run.pid), GRACE - SECOND, "Pi to stop");
	assert.ok(alive(run.note.leftover), "the leftover process should still be there");

	const next = scenario("OK", run.chatId);
	const response = await send(bridge, next.chatId, next.text, { signal: AbortSignal.timeout(GRACE + 5 * SECOND) });
	assert.equal(response.status, 200);
	assert.equal((await response.json()).choices[0].message.content, "FAKE-ANSWER");
});

test("a queued message whose connection closed never starts Pi", async () => {
	const first = await startRun(bridge, "HANG");
	const queued = scenario("OK", first.chatId);
	const queuedStop = new AbortController();
	const queuedReply = send(bridge, queued.chatId, queued.text, { signal: queuedStop.signal }).catch(() => undefined);
	await delay(200);
	queuedStop.abort();
	await queuedReply;
	await delay(200);

	first.stop();
	const last = scenario("OK", first.chatId);
	assert.equal((await ask(bridge, last.chatId, last.text)).answer, "FAKE-ANSWER");
	assert.deepEqual(await piNotes(bridge, queued.tag), []);
});

test("a queued message from a live connection still runs after a Stop", async () => {
	const first = await startRun(bridge, "HANG");
	const queued = scenario("OK", first.chatId);
	const reply = ask(bridge, queued.chatId, queued.text);
	await delay(200);
	assert.deepEqual(await piNotes(bridge, queued.tag), [], "it should wait for the running message");
	first.stop();
	assert.equal((await reply).answer, "FAKE-ANSWER");
});

test("a forgotten file still gets rescued when nobody pressed Stop", async () => {
	const run = scenario("RESCUE", undefined, "Write a markdown note. ");
	const { status, answer } = await ask(bridge, run.chatId, run.text);
	assert.equal(status, 200);
	const link = /\((https?:\/\/[^)\s]+\/files\/[^)\s]+)\)/.exec(answer)?.[1];
	assert.ok(link, `no download link in: ${answer}`);
	const download = await fetch(link);
	assert.equal(download.status, 200);
	assert.match(await download.text(), /Rescued note/);
	assert.equal((await piNotes(bridge, run.tag)).length, 2, "the first run and one repair run");
});

test("a Stop during the repair run publishes nothing and starts nothing more", async () => {
	const run = await startRun(bridge, "STOP_IN_REPAIR", { prefix: "Write a markdown note. ", wanted: (note) => note.isRepair });
	run.stop();
	await waitUntil(() => !alive(run.pid), GRACE - SECOND, "the repair run to stop");
	await delay(500);
	assert.equal((await piNotes(bridge, run.tag)).length, 2, "the first run and one repair run");
	const artifacts = path.resolve(run.note.workspace, "..", "..", "..", "artifacts");
	assert.deepEqual((await readdir(artifacts)).filter((name) => name.startsWith("artifact-")), []);
});

test("a timed-out run is really gone before the user gets the error", async () => {
	const short = await startBridge({ JUNIOR_SILVA_PI_TIMEOUT_MS: "500" });
	const run = scenario("STUCK");
	const sentAt = Date.now();
	const { status, error } = await ask(short, run.chatId, run.text);
	assert.equal(status, 500);
	assert.equal(error, GENERIC_ERROR);
	const [pi] = await piNotes(short, run.tag);
	assert.equal(alive(pi.pid), false);
	assert.ok(Date.now() - sentAt < GRACE + 5 * SECOND, "the timed-out Pi wasn't forced in time");
});

for (const [label, askWith] of [["non-streaming", ask], ["streaming", askStreaming]]) {
	test(`a model failure partway gives the note and the text, and only the log gets the reason (${label})`, async () => {
		const run = scenario("FAIL_PARTIAL");
		const { status, answer } = await askWith(bridge, run.chatId, run.text);
		assert.equal(status, 200);
		assert.match(answer, /^\*\*This answer isn't complete\.\*\*/);
		assert.ok(answer.endsWith("HALF-AN-ANSWER"));
		assert.doesNotMatch(answer, /SECRET-UPSTREAM-TEXT/);
		await waitUntil(() => /ended early: error: SECRET-UPSTREAM-TEXT second line/.test(bridge.log), SECOND, "the reason in the log");
	});
}

test("a model failure with no text gives the fixed note", async () => {
	const run = scenario("FAIL_EMPTY");
	const { status, answer } = await ask(bridge, run.chatId, run.text);
	assert.equal(status, 200);
	assert.match(answer, /^\*\*I couldn't finish this answer\.\*\*/);
	assert.doesNotMatch(answer, /SECRET-UPSTREAM-TEXT/);
});

test("a cut-off answer keeps its text and gets the note", async () => {
	const run = scenario("CUT_OFF");
	const { status, answer } = await ask(bridge, run.chatId, run.text);
	assert.equal(status, 200);
	assert.ok(answer.startsWith("A-LONG-ANSWER"));
	assert.match(answer, /cut off/);
});

test("a failure followed by a successful retry gives a clean answer", async () => {
	const run = scenario("RETRIED");
	const { status, answer } = await ask(bridge, run.chatId, run.text);
	assert.equal(status, 200);
	assert.equal(answer, "FAKE-ANSWER");
});

test("the guard's message goes back unchanged", async () => {
	const run = scenario("GUARD");
	const { status, answer } = await ask(bridge, run.chatId, run.text);
	assert.equal(status, 200);
	assert.equal(answer, "GUARD-MESSAGE");
});

test("a finished run with no text still gets the generic error", async () => {
	const run = scenario("NO_TEXT");
	const { status, error } = await ask(bridge, run.chatId, run.text);
	assert.equal(status, 500);
	assert.equal(error, GENERIC_ERROR);
});

test("the bridge is still up, and a Stop wasn't logged as an error", async () => {
	assert.equal((await fetch(`http://127.0.0.1:${bridge.port}/health`)).status, 200);
	assert.equal(bridge.child.exitCode, null);
	assert.match(bridge.log, /Stopping the run for chat [a-f0-9]{32}, because its connection closed\./);
	assert.doesNotMatch(bridge.log, /The run was stopped/);
});
