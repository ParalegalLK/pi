import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { piRunArgs } from "../runner/docker-args.mjs";
import { BUSY_TEXT, createSlotPool, piAddress, startContainerPi, startLocalPi } from "../server/pi-executor.mjs";

const SECRET = "runner-test-secret-0123456789abcdef0123";
const RUN = { requestId: `chatcmpl-${randomUUID()}`, userHash: "a".repeat(32), chatHash: "c".repeat(32), slot: 2, runToken: "f".repeat(64), model: "claude-sonnet-5-5" };

async function until(check, ms = 5_000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await check()) return true;
		await delay(20);
	}
	return false;
}

function collect(stream) {
	const chunks = [];
	stream.on("data", (chunk) => chunks.push(chunk));
	return new Promise((resolve) => stream.on("end", () => resolve(Buffer.concat(chunks))));
}

test("a run takes the lowest free slot, and a freed slot goes to the first in line", async () => {
	const pool = createSlotPool(3, 60_000);
	assert.deepEqual([await pool.take(), await pool.take(), await pool.take()], [1, 2, 3]);
	const order = [];
	const fourth = pool.take().then((slot) => order.push(["fourth", slot]));
	const fifth = pool.take().then((slot) => order.push(["fifth", slot]));
	pool.release(2);
	pool.release(3);
	await Promise.all([fourth, fifth]);
	assert.deepEqual(order, [["fourth", 2], ["fifth", 3]]);
	pool.release(3);
	pool.release(1);
	assert.equal(await pool.take(), 1, "the lowest free slot first");
});

test("a message stopped while it waits leaves the line, and the slot goes to the next one", async () => {
	const pool = createSlotPool(1, 60_000);
	assert.equal(await pool.take(), 1);
	const stopped = new AbortController();
	const leaving = pool.take(stopped.signal);
	const next = pool.take();
	stopped.abort(new Error("The run was stopped"));
	await assert.rejects(leaving, /The run was stopped/);
	pool.release(1);
	assert.equal(await next, 1);
});

test("a message already stopped never takes a slot", async () => {
	const pool = createSlotPool(1, 60_000);
	const stopped = new AbortController();
	stopped.abort(new Error("The run was stopped"));
	await assert.rejects(pool.take(stopped.signal), /The run was stopped/);
	assert.equal(await pool.take(), 1, "the slot is still free");
});

test("a message that waits too long gets the busy answer, as status 429, and keeps no slot", async () => {
	const pool = createSlotPool(1, 200);
	await pool.take();
	const started = Date.now();
	await assert.rejects(pool.take(), (error) => {
		assert.equal(error.message, BUSY_TEXT);
		assert.equal(error.status, 429);
		return true;
	});
	assert.ok(Date.now() - started >= 180, "it waited first");
	pool.release(1);
	assert.equal(await pool.take(), 1, "a message that gave up must not be handed the slot");
});

test("the run token's address is the address the runner gives Pi on each slot", () => {
	for (const slot of [1, 2, 254]) {
		const args = piRunArgs({ ...RUN, slot }, { hostDataRoot: "/srv/data", image: "junior-silva-pi:local", slots: 254, gatewayPort: 8127 });
		assert.equal(args[args.indexOf("--ip") + 1], piAddress(slot));
	}
});

// A stand-in for the runner. onRun and onStop get { req, res, url, authorization, body }.
async function standInRunner(t, { onRun, onStop = ({ res }) => { res.writeHead(404); res.end(); } }) {
	const seen = [];
	const server = http.createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const text = Buffer.concat(chunks).toString("utf8");
		const call = { req, res, url: req.url, method: req.method, authorization: req.headers.authorization, body: text ? JSON.parse(text) : undefined };
		seen.push(call);
		if (req.url === "/runs") onRun(call);
		else onStop(call);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => {
		server.closeAllConnections();
		server.close(resolve);
	}));
	return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

function startStream(res) {
	res.writeHead(200, { "Content-Type": "application/octet-stream", Trailer: "X-Run-Exit, X-Run-Reason" });
}

function endRun(res, exit, reason) {
	res.addTrailers({ "X-Run-Exit": String(exit), "X-Run-Reason": reason });
	res.end();
}

test("the container way sends the run with the secret, and gives back Pi's output byte for byte and how it ended", async (t) => {
	const runner = await standInRunner(t, {
		onRun: ({ res }) => {
			startStream(res);
			res.write('{"type":"first"}\n');
			res.write(Buffer.from([0x00, 0xff, 0x80]));
			endRun(res, 0, "done");
		},
	});
	const pi = startContainerPi({ runnerUrl: runner.url, runnerSecret: SECRET, run: RUN, prompt: "the client's question" });
	const output = collect(pi.stdout);
	assert.deepEqual(await pi.done, { exitCode: 0, reason: "done", detail: "" });
	assert.deepEqual(await output, Buffer.concat([Buffer.from('{"type":"first"}\n'), Buffer.from([0x00, 0xff, 0x80])]));
	const [call] = runner.seen;
	assert.equal(call.method, "POST");
	assert.equal(call.url, "/runs");
	assert.equal(call.authorization, `Bearer ${SECRET}`);
	assert.deepEqual(call.body, { ...RUN, prompt: "the client's question" });
});

test("a failed run passes on its exit code and reason", async (t) => {
	const runner = await standInRunner(t, { onRun: ({ res }) => { startStream(res); endRun(res, 137, "no-start"); } });
	const pi = startContainerPi({ runnerUrl: runner.url, runnerSecret: SECRET, run: RUN, prompt: "x" });
	pi.stdout.resume();
	assert.deepEqual(await pi.done, { exitCode: 137, reason: "no-start", detail: "" });
});

test("a run the runner refuses ends with the runner's reason, and the output ends too", async (t) => {
	const runner = await standInRunner(t, {
		onRun: ({ res }) => {
			res.writeHead(503, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "js-slot-2 can't be used: its gateway mode isn't isolated, so Pi could reach the server" }));
		},
	});
	const pi = startContainerPi({ runnerUrl: runner.url, runnerSecret: SECRET, run: RUN, prompt: "x" });
	const output = collect(pi.stdout);
	assert.deepEqual(await pi.done, { exitCode: null, reason: "refused", detail: "the runner refused the run (503): js-slot-2 can't be used: its gateway mode isn't isolated, so Pi could reach the server" });
	assert.equal((await output).length, 0);
});

test("an answer without the exit code, a dropped connection, or a runner that can't be reached is a failed run", async (t) => {
	const runner = await standInRunner(t, {
		onRun: ({ res, body }) => {
			startStream(res);
			// Once the output is on its way, so the bridge has seen the start of the run.
			res.write("partial\n", () => {
				if (body.prompt === "no trailers") res.end();
				else setTimeout(() => res.socket.destroy(), 50);
			});
		},
	});
	for (const prompt of ["no trailers", "dropped"]) {
		const pi = startContainerPi({ runnerUrl: runner.url, runnerSecret: SECRET, run: RUN, prompt });
		pi.stdout.resume();
		const ending = await pi.done;
		assert.equal(ending.exitCode, null, prompt);
		assert.equal(ending.reason, "lost", prompt);
	}
	const pi = startContainerPi({ runnerUrl: "http://127.0.0.1:1", runnerSecret: SECRET, run: RUN, prompt: "x" });
	pi.stdout.resume();
	const ending = await pi.done;
	assert.equal(ending.exitCode, null);
	assert.equal(ending.reason, "unreachable");
});

test("Stop asks the runner to end the run, then waits for the run's own end", async (t) => {
	let running;
	const runner = await standInRunner(t, {
		onRun: ({ res }) => {
			startStream(res);
			res.write("started\n");
			running = res;
		},
		onStop: ({ res }) => {
			res.writeHead(202, { "Content-Type": "application/json" });
			res.end("{}");
			// Like docker kill, the run ends a little later.
			setTimeout(() => endRun(running, 137, "stopped"), 300);
		},
	});
	const pi = startContainerPi({ runnerUrl: runner.url, runnerSecret: SECRET, run: RUN, prompt: "x" });
	pi.stdout.resume();
	assert.ok(await until(() => running));
	pi.stop();
	pi.stop();
	assert.deepEqual(await pi.done, { exitCode: 137, reason: "stopped", detail: "" }, "the run's own end, not a hang-up");
	const stops = runner.seen.filter((call) => call.url !== "/runs");
	assert.equal(stops.length, 1, "a second Stop doesn't ask again");
	assert.equal(stops[0].method, "POST");
	assert.equal(stops[0].url, `/runs/${RUN.requestId}/stop`);
	assert.equal(stops[0].authorization, `Bearer ${SECRET}`);
});

test("a Stop the runner doesn't know, or one that doesn't end the run in time, hangs up instead", async (t) => {
	const SECOND = { ...RUN, requestId: `chatcmpl-${randomUUID()}` };
	const closed = [];
	const runner = await standInRunner(t, {
		onRun: ({ res, body }) => {
			startStream(res);
			res.write("started\n");
			res.on("close", () => closed.push(body.prompt));
		},
		onStop: ({ res, req }) => {
			// The second run is "known", but its Stop never ends it.
			res.writeHead(req.url.includes(SECOND.requestId) ? 202 : 404);
			res.end();
		},
	});
	const unknown = startContainerPi({ runnerUrl: runner.url, runnerSecret: SECRET, run: RUN, prompt: "unknown" });
	const slow = startContainerPi({ runnerUrl: runner.url, runnerSecret: SECRET, run: SECOND, prompt: "slow", stopFallbackMs: 400 });
	unknown.stdout.resume();
	slow.stdout.resume();
	assert.ok(await until(() => runner.seen.filter((call) => call.url === "/runs").length === 2));
	const stoppedAt = Date.now();
	unknown.stop();
	slow.stop();
	assert.equal((await unknown.done).reason, "lost");
	assert.equal((await slow.done).reason, "lost");
	assert.ok(Date.now() - stoppedAt >= 350, "the slow one waited for the run to end first");
	assert.ok(await until(() => closed.length === 2), "both runs were hung up on");
});

test("the local way gives Pi the prompt on stdin, and gives back its output, exit code and error output", async () => {
	const script = "let input = ''; process.stdin.on('data', (chunk) => { input += chunk; }); process.stdin.on('end', () => { process.stdout.write(input.toUpperCase()); process.stderr.write('a  note\\n'); process.exitCode = 3; });";
	const pi = startLocalPi({ command: process.execPath, args: ["-e", script], cwd: process.cwd(), environment: { PATH: process.env.PATH }, prompt: "the prompt" });
	const output = collect(pi.stdout);
	assert.deepEqual(await pi.done, { exitCode: 3, reason: "done", detail: "a note " });
	assert.equal((await output).toString(), "THE PROMPT");
});

test("Stop ends a local Pi", async () => {
	const pi = startLocalPi({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: process.cwd(), environment: { PATH: process.env.PATH }, prompt: "" });
	pi.stdout.resume();
	await delay(200);
	pi.stop();
	const ending = await Promise.race([pi.done, delay(4_000).then(() => "still running")]);
	assert.notEqual(ending, "still running");
	assert.equal(ending.exitCode, null, "ended by its signal");
});
