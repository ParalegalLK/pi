import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { piRunArgs } from "../runner/docker-args.mjs";
import { createSlotArgs } from "../runner/slots.mjs";

const runnerPath = fileURLToPath(new URL("../runner/server.mjs", import.meta.url));
const fakeDocker = fileURLToPath(new URL("./fixtures/fake-docker.mjs", import.meta.url));
const SECRET = "runner-test-secret-0123456789abcdef0123";
const HOST_DATA = "/srv/js-test/data";
const USER_A = "a".repeat(32);
const USER_B = "b".repeat(32);
const TOKEN = "f".repeat(64);

function runBody(changes = {}) {
	return { requestId: `chatcmpl-${randomUUID()}`, userHash: USER_A, chatHash: "c".repeat(32), slot: 1, runToken: TOKEN, model: "claude-opus-5-5", prompt: "ok: hello", ...changes };
}

async function until(check, ms = 5_000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await check()) return true;
		await delay(25);
	}
	return false;
}

function exitCode(child, ms = 10_000) {
	if (child.exitCode !== null) return Promise.resolve(child.exitCode);
	return Promise.race([new Promise((resolve) => child.once("close", resolve)), delay(ms).then(() => "still running")]);
}

// Starts the runner with the fake docker command, a test secret and quick timings. prepare(folder)
// can set up the fake's state first, such as a network someone else made.
async function startRunner(t, settings = {}, { plant = [], prepare } = {}) {
	const folder = await mkdtemp(path.join(os.tmpdir(), "junior-silva-runner-"));
	await mkdir(path.join(folder, "leftovers"), { recursive: true });
	for (const name of plant) await writeFile(path.join(folder, "leftovers", name), "");
	if (prepare) await prepare(folder);
	const child = spawn(process.execPath, [runnerPath], {
		env: {
			PATH: process.env.PATH,
			JS_RUNNER_SECRET: SECRET,
			JS_HOST_DATA_ROOT: HOST_DATA,
			JS_RUNNER_HOST: "127.0.0.1",
			JS_RUNNER_PORT: "0",
			JS_DOCKER_BIN: fakeDocker,
			DOCKER_HOST: `unix://${folder}/docker.sock`,
			JS_START_GAP_MS: "0",
			JS_START_TIMEOUT_MS: "5000",
			JS_RUN_TIMEOUT_MS: "20000",
			JS_SWEEP_INTERVAL_MS: "60000",
			...settings,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(async () => {
		child.kill("SIGKILL");
		const running = path.join(folder, "running");
		for (const name of await readdir(running).catch(() => [])) {
			try {
				process.kill(Number(await readFile(path.join(running, name), "utf8")), "SIGKILL");
			} catch {}
		}
		await rm(folder, { recursive: true, force: true });
	});
	let output = "";
	child.stdout.on("data", (chunk) => { output += chunk; });
	child.stderr.on("data", (chunk) => { output += chunk; });
	let port;
	await until(() => (port = /listening on 127\.0\.0\.1:(\d+)/.exec(output)?.[1]) || child.exitCode !== null, 10_000);
	assert.ok(port, `the runner didn't start: ${output}`);
	return { url: `http://127.0.0.1:${port}`, folder, child, output: () => output };
}

async function calls(runner, command) {
	const text = await readFile(path.join(runner.folder, "calls.jsonl"), "utf8").catch(() => "");
	return text.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((call) => !command || call.command === command);
}

// Sends one request and resolves with the status, the raw body and the trailers.
function send(runner, method, route, { body, secret = SECRET, hangUpAfterFirstData = false } = {}) {
	return new Promise((resolve) => {
		const payload = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
		const headers = {};
		if (secret) headers.authorization = `Bearer ${secret}`;
		if (payload) Object.assign(headers, { "content-type": "application/json", "content-length": payload.length });
		const req = http.request(`${runner.url}${route}`, { method, headers }, (res) => {
			const chunks = [];
			res.on("data", (chunk) => {
				chunks.push(chunk);
				if (hangUpAfterFirstData) req.destroy();
			});
			const done = () => {
				const all = Buffer.concat(chunks);
				resolve({ status: res.statusCode, trailers: res.trailers, body: all, json: () => JSON.parse(all.toString("utf8")) });
			};
			res.on("end", done);
			res.on("close", done);
		});
		req.on("error", () => resolve({ status: 0, trailers: {}, body: Buffer.alloc(0) }));
		if (payload) req.write(payload);
		req.end();
	});
}

test("the runner refuses to start without a long enough secret, or without a plain data folder", async () => {
	const cases = [
		[{ JS_RUNNER_SECRET: "short" }, /JS_RUNNER_SECRET/],
		[{ JS_RUNNER_SECRET: "" }, /JS_RUNNER_SECRET/],
		[{ JS_HOST_DATA_ROOT: "" }, /JS_HOST_DATA_ROOT/],
		[{ JS_HOST_DATA_ROOT: "relative/path" }, /host data folder/],
	];
	for (const [settings, reason] of cases) {
		const child = spawn(process.execPath, [runnerPath], {
			env: { PATH: process.env.PATH, JS_RUNNER_SECRET: SECRET, JS_HOST_DATA_ROOT: HOST_DATA, JS_RUNNER_PORT: "0", JS_DOCKER_BIN: "/no/docker/here", ...settings },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk) => { output += chunk; });
		child.stderr.on("data", (chunk) => { output += chunk; });
		const code = await exitCode(child);
		if (code === "still running") child.kill("SIGKILL");
		assert.equal(code, 1, `${JSON.stringify(settings)}: ${output}`);
		assert.match(output, reason);
	}
});

test("every route needs the runner's secret", async (t) => {
	const runner = await startRunner(t);
	for (const secret of [null, "a-wrong-secret-that-is-long-enough-0123456789"]) {
		assert.equal((await send(runner, "GET", "/health", { secret })).status, 401);
		assert.equal((await send(runner, "POST", "/runs", { secret, body: runBody() })).status, 401);
		assert.equal((await send(runner, "GET", "/anything", { secret })).status, 401);
	}
	assert.deepEqual(await calls(runner, "run"), []);
	assert.equal((await send(runner, "GET", "/anything")).status, 404);
});

test("health reports gVisor and the Pi image, and fails when either is missing", async (t) => {
	const runner = await startRunner(t);
	const healthy = await send(runner, "GET", "/health");
	assert.equal(healthy.status, 200);
	assert.deepEqual(healthy.json(), { runsc: true, image: true, slots: 3, slotsReady: 3, slotsInUse: 0, problems: [] });
	await writeFile(path.join(runner.folder, "no-runsc"), "");
	assert.equal((await send(runner, "GET", "/health")).status, 503);
	await rm(path.join(runner.folder, "no-runsc"));
	await writeFile(path.join(runner.folder, "no-image"), "");
	const noImage = await send(runner, "GET", "/health");
	assert.equal(noImage.status, 503);
	assert.equal(noImage.json().image, false);
});

test("a bad field is refused before Docker is touched", async (t) => {
	const runner = await startRunner(t);
	const changes = [
		{ requestId: "../x" },
		{ userHash: "not-a-hash" },
		{ chatHash: "C".repeat(32) },
		{ slot: 0 },
		{ slot: 4 },
		{ slot: "1" },
		{ runToken: "short" },
		{ runToken: undefined },
		{ model: "a b" },
		{ thinking: "huge" },
		{ prompt: "" },
		{ prompt: 42 },
	];
	for (const change of changes) assert.equal((await send(runner, "POST", "/runs", { body: runBody(change) })).status, 400, JSON.stringify(change));
	assert.equal((await send(runner, "POST", "/runs", { body: "{not json" })).status, 400);
	assert.deepEqual(await calls(runner, "run"), []);
});

test("a run gets exactly the fixed Docker settings, the token only in its environment, and the prompt on stdin", async (t) => {
	const runner = await startRunner(t);
	const body = runBody({ slot: 2, thinking: "high", prompt: "ok: the client's question" });
	assert.equal((await send(runner, "POST", "/runs", { body })).status, 200);
	const [run] = await calls(runner, "run");
	assert.deepEqual([run.command, ...run.args], piRunArgs(body, { hostDataRoot: HOST_DATA, image: "junior-silva-pi:local", slots: 3, gatewayPort: 8127 }));
	assert.equal(run.tokenFromEnvironment, TOKEN);
	assert.ok(!run.args.some((arg) => arg.includes(TOKEN)), "the token must not be on the command line");
	assert.equal(run.prompt, "ok: the client's question");
});

test("Pi's output comes back byte for byte, then its exit code and the reason as trailers", async (t) => {
	const runner = await startRunner(t);
	const result = await send(runner, "POST", "/runs", { body: runBody() });
	assert.equal(result.status, 200);
	assert.deepEqual(result.body, Buffer.concat([Buffer.from('{"type":"first"}\n'), Buffer.from([0x00, 0xff, 0x80, 0x0a]), Buffer.from('{"type":"second"}\n')]));
	assert.deepEqual(result.trailers, { "x-run-exit": "0", "x-run-reason": "done" });
	assert.match(runner.output(), /run chatcmpl-[0-9a-f-]+ ended: exit 0, done/);
	assert.doesNotMatch(runner.output(), /"type":"first"/, "Pi's output must never be logged");
});

test("a failed run passes its exit code on", async (t) => {
	const runner = await startRunner(t);
	const result = await send(runner, "POST", "/runs", { body: runBody({ prompt: "fail: x" }) });
	assert.equal(result.body.toString(), "partial\n");
	assert.deepEqual(result.trailers, { "x-run-exit": "2", "x-run-reason": "done" });
});

test("when the bridge hangs up, the runner kills the container and frees the slot", async (t) => {
	const runner = await startRunner(t);
	const body = runBody({ prompt: "slow: x" });
	await send(runner, "POST", "/runs", { body, hangUpAfterFirstData: true });
	assert.ok(await until(async () => (await calls(runner, "kill")).some((call) => call.args[0] === `js-run-${body.requestId}`)), "docker kill wasn't called");
	assert.ok(await until(() => /ended: exit 137, stopped/.test(runner.output())), runner.output());
	assert.equal((await send(runner, "POST", "/runs", { body: runBody() })).status, 200, "the slot must be free again");
});

test("a run that prints nothing in time is killed, with the reason no-start", async (t) => {
	const runner = await startRunner(t, { JS_START_TIMEOUT_MS: "800" });
	const result = await send(runner, "POST", "/runs", { body: runBody({ prompt: "silent: x" }) });
	assert.deepEqual(result.trailers, { "x-run-exit": "137", "x-run-reason": "no-start" });
	assert.equal((await calls(runner, "kill")).length, 1);
});

test("a run past its time limit is killed, with the reason timeout", async (t) => {
	const runner = await startRunner(t, { JS_RUN_TIMEOUT_MS: "1200" });
	const result = await send(runner, "POST", "/runs", { body: runBody({ prompt: "slow: x" }) });
	assert.equal(result.body.toString(), "started\n");
	assert.deepEqual(result.trailers, { "x-run-exit": "137", "x-run-reason": "timeout" });
});

test("a busy slot, the same request twice, and too many runs for one user are refused", async (t) => {
	const runner = await startRunner(t, { JS_MAX_RUNS_PER_USER: "2" });
	const first = runBody({ prompt: "slow: x", slot: 1 });
	void send(runner, "POST", "/runs", { body: first });
	assert.ok(await until(async () => (await calls(runner, "run")).length === 1));
	assert.equal((await send(runner, "POST", "/runs", { body: runBody({ slot: 1, userHash: USER_B }) })).status, 409, "a busy slot");
	assert.equal((await send(runner, "POST", "/runs", { body: { ...first, slot: 2 } })).status, 409, "the same request twice");
	void send(runner, "POST", "/runs", { body: runBody({ prompt: "slow: x", slot: 2 }) });
	assert.ok(await until(async () => (await calls(runner, "run")).length === 2));
	assert.equal((await send(runner, "POST", "/runs", { body: runBody({ slot: 3 }) })).status, 429, "a third run for one user");
	assert.equal((await send(runner, "POST", "/runs", { body: runBody({ slot: 3, userHash: USER_B }) })).status, 200, "another user can still run");
});

test("leftover Pi containers are removed at start, and lost ones on each sweep, but never a running one", async (t) => {
	const runner = await startRunner(t, { JS_SWEEP_INTERVAL_MS: "300" }, { plant: ["js-run-leftover-1", "js-run-leftover-2"] });
	const [atStart] = await calls(runner, "rm");
	assert.deepEqual(atStart?.args.slice(1).sort(), ["js-run-leftover-1", "js-run-leftover-2"]);
	assert.match(runner.output(), /removed 2 leftover Pi containers/);
	const body = runBody({ prompt: "slow: x" });
	void send(runner, "POST", "/runs", { body });
	assert.ok(await until(async () => (await calls(runner, "run")).length === 1));
	await writeFile(path.join(runner.folder, "leftovers", "js-run-lost"), "");
	assert.ok(await until(async () => (await calls(runner, "rm")).some((call) => call.args.includes("js-run-lost"))), "a lost container must be swept");
	assert.ok(!(await calls(runner, "rm")).some((call) => call.args.includes(`js-run-${body.requestId}`)), "a running one must never be swept");
});

test("runs started together are spaced apart", async (t) => {
	const runner = await startRunner(t, { JS_START_GAP_MS: "400" });
	await Promise.all([send(runner, "POST", "/runs", { body: runBody({ slot: 1 }) }), send(runner, "POST", "/runs", { body: runBody({ slot: 2, userHash: USER_B }) })]);
	const [first, second] = (await calls(runner, "run")).map((call) => call.at).sort((a, b) => a - b);
	assert.ok(second - first >= 350, `only ${second - first} ms apart`);
});

test("Pi's error output isn't logged, but Docker's own start error is", async (t) => {
	const runner = await startRunner(t);
	assert.equal((await send(runner, "POST", "/runs", { body: runBody({ prompt: "stderr: x" }) })).body.toString(), "done\n");
	const failed = await send(runner, "POST", "/runs", { body: runBody({ prompt: "cannot-start: x" }) });
	assert.deepEqual(failed.trailers, { "x-run-exit": "125", "x-run-reason": "done" });
	assert.ok(await until(() => /couldn't start: docker: Error response from daemon: network js-slot-9 not found/.test(runner.output())), runner.output());
	assert.doesNotMatch(runner.output(), /PRIVATE CLIENT TEXT/);
});

test("a run request over 32 MB is refused", async (t) => {
	const runner = await startRunner(t);
	const result = await send(runner, "POST", "/runs", { body: runBody({ prompt: "x".repeat(33 * 1024 * 1024) }) });
	assert.equal(result.status, 413);
	assert.deepEqual(await calls(runner, "run"), []);
});

test("on a stop signal, the runner kills its runs and exits", async (t) => {
	const runner = await startRunner(t);
	const body = runBody({ prompt: "slow: x" });
	void send(runner, "POST", "/runs", { body });
	assert.ok(await until(async () => (await calls(runner, "run")).length === 1));
	runner.child.kill("SIGTERM");
	assert.equal(await exitCode(runner.child), 0);
	assert.ok((await calls(runner, "kill")).some((call) => call.args[0] === `js-run-${body.requestId}`));
});

const networkCalls = async (runner, action, slotName) =>
	(await calls(runner, "network")).filter((call) => call.args[0] === action && (!slotName || call.args.includes(slotName)));

test("at start, the runner creates the slot networks with the plan's settings, and connects the bridge at .2 on each", async (t) => {
	const runner = await startRunner(t);
	assert.deepEqual((await networkCalls(runner, "create")).map((call) => [call.command, ...call.args]), [1, 2, 3].map((slot) => createSlotArgs(slot)));
	assert.deepEqual((await networkCalls(runner, "connect")).map((call) => call.args), [1, 2, 3].map((slot) => ["connect", "--ip", `10.89.${slot}.2`, `js-slot-${slot}`, "junior-silva-v2"]));
	assert.match(runner.output(), /created js-slot-1/);
	assert.match(runner.output(), /connected the bridge to js-slot-3 at 10\.89\.3\.2/);
	assert.equal((await send(runner, "GET", "/health")).status, 200);
});

test("a slot network with a wrong setting is refused, never used or deleted, and the other slots still work", async (t) => {
	const runner = await startRunner(t, {}, {
		prepare: async (folder) => {
			const wrong = { Name: "js-slot-2", Driver: "bridge", Internal: true, EnableIPv6: false, Options: {}, IPAM: { Config: [{ Subnet: "10.89.2.0/24" }] }, Labels: { "js.slot": "1" } };
			await mkdir(path.join(folder, "networks"), { recursive: true });
			await writeFile(path.join(folder, "networks", "js-slot-2.json"), JSON.stringify(wrong));
		},
	});
	const health = await send(runner, "GET", "/health");
	assert.equal(health.status, 503);
	assert.equal(health.json().slotsReady, 2);
	assert.deepEqual(health.json().problems, ["js-slot-2 can't be used: its gateway mode isn't isolated, so Pi could reach the server"]);
	const refused = await send(runner, "POST", "/runs", { body: runBody({ slot: 2 }) });
	assert.equal(refused.status, 503);
	assert.match(refused.json().error, /js-slot-2 can't be used/);
	assert.equal((await send(runner, "POST", "/runs", { body: runBody({ slot: 1 }) })).status, 200);
	assert.equal((await calls(runner, "run")).length, 1, "only slot 1's run started");
	assert.deepEqual(await networkCalls(runner, "rm"), [], "a wrong network must never be deleted");
	assert.deepEqual(await networkCalls(runner, "connect", "js-slot-2"), [], "the bridge must not join a wrong network");
});

test("a bridge that dropped off a slot is reconnected before the next run on it", async (t) => {
	const runner = await startRunner(t);
	await rm(path.join(runner.folder, "attached", "js-slot-1"));
	assert.equal((await send(runner, "POST", "/runs", { body: runBody({ slot: 1 }) })).status, 200);
	const connects = await networkCalls(runner, "connect", "js-slot-1");
	const [run] = await calls(runner, "run");
	assert.equal(connects.length, 2, "connected at start, and again before the run");
	assert.ok(connects[1].at <= run.at, "reconnected before Pi started");
});

test("a bridge that dropped off a slot is reconnected on the next sweep", async (t) => {
	const runner = await startRunner(t, { JS_SWEEP_INTERVAL_MS: "300" });
	await rm(path.join(runner.folder, "attached", "js-slot-2"));
	assert.ok(await until(async () => (await networkCalls(runner, "connect", "js-slot-2")).length === 2), "the sweep must reconnect it");
});

test("a bridge on a slot at the wrong address is moved to .2", async (t) => {
	const runner = await startRunner(t, {}, {
		prepare: async (folder) => {
			await mkdir(path.join(folder, "attached"), { recursive: true });
			await writeFile(path.join(folder, "attached", "js-slot-1"), "10.89.1.9");
		},
	});
	const moves = (await calls(runner, "network")).filter((call) => call.args.includes("js-slot-1") && ["disconnect", "connect"].includes(call.args[0]));
	assert.deepEqual(moves.map((call) => call.args[0]), ["disconnect", "connect"]);
	assert.equal(await readFile(path.join(runner.folder, "attached", "js-slot-1"), "utf8"), "10.89.1.2");
});

test("with no bridge container, the slots aren't ready and runs are refused", async (t) => {
	const runner = await startRunner(t, {}, { prepare: (folder) => writeFile(path.join(folder, "no-bridge"), "") });
	const health = await send(runner, "GET", "/health");
	assert.equal(health.status, 503);
	assert.equal(health.json().slotsReady, 0);
	assert.deepEqual([...new Set(health.json().problems)], ["the bridge container junior-silva-v2 isn't there"]);
	assert.equal((await send(runner, "POST", "/runs", { body: runBody() })).status, 503);
	assert.deepEqual(await calls(runner, "run"), []);
});
