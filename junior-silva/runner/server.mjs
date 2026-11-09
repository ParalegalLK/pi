#!/usr/bin/env node
// The runner (task/plan.md, section 3.10; task P3.4). The only part with Docker access: it starts and
// stops Pi containers for the bridge, and nothing else. It holds no keys except its own secret, takes
// only checked inputs, and uses fixed Docker settings (docker-args.mjs). It never reads anything Pi
// writes: Pi's output goes back as raw bytes, with the exit code and the reason as trailers.
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { containerName, piRunArgs, RUN_LABEL } from "./docker-args.mjs";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const RUN_TOKEN = /^[0-9a-f]{64}$/;

function setting(name, fallback) {
	const value = process.env[name];
	return value === undefined || value === "" ? fallback : value;
}

function wholeNumber(name, fallback) {
	const value = Number(setting(name, String(fallback)));
	if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number`);
	return value;
}

function log(message) {
	console.log(`[junior-silva-runner] ${message}`);
}

function refuseToStart(message) {
	console.error(`[junior-silva-runner] ${message}. The runner did not start.`);
	process.exit(1);
}

let config;
try {
	config = {
		secret: setting("JS_RUNNER_SECRET", ""),
		host: setting("JS_RUNNER_HOST", "0.0.0.0"),
		port: wholeNumber("JS_RUNNER_PORT", 8128),
		maxRunsPerUser: wholeNumber("JS_MAX_RUNS_PER_USER", 2),
		runTimeoutMs: wholeNumber("JS_RUN_TIMEOUT_MS", 1_200_000),
		startTimeoutMs: wholeNumber("JS_START_TIMEOUT_MS", 60_000),
		startGapMs: wholeNumber("JS_START_GAP_MS", 250),
		sweepIntervalMs: wholeNumber("JS_SWEEP_INTERVAL_MS", 60_000),
		docker: setting("JS_DOCKER_BIN", "docker"),
		// Pi's error output can hold client text, so it's only shown with this, on the laptop.
		debug: setting("JS_RUNNER_DEBUG", "") === "1",
		piSettings: {
			hostDataRoot: setting("JS_HOST_DATA_ROOT", ""),
			image: setting("JS_PI_IMAGE", "junior-silva-pi:local"),
			slots: wholeNumber("JS_SLOTS", 3),
			gatewayPort: wholeNumber("JS_GATEWAY_PORT", 8127),
		},
	};
} catch (error) {
	refuseToStart(error.message);
}
if (config.secret.length < 32) refuseToStart("JS_RUNNER_SECRET must be set, with at least 32 characters");
if (!config.piSettings.hostDataRoot) refuseToStart("JS_HOST_DATA_ROOT must be set");
try {
	piRunArgs({ requestId: `chatcmpl-${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`, userHash: "0".repeat(32), chatHash: "0".repeat(32), slot: 1, model: "check" }, config.piSettings);
} catch (error) {
	refuseToStart(error.message);
}
const secretDigest = createHash("sha256").update(config.secret).digest();

// Only what the docker command needs. The run token is added for `docker run` alone.
function dockerEnvironment() {
	return {
		PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
		HOME: "/tmp",
		DOCKER_CONFIG: "/tmp/.docker",
		...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
	};
}

// A short docker command, such as info, kill or rm.
function docker(args, timeoutMs = 30_000) {
	return new Promise((resolve) => {
		const child = spawn(config.docker, args, { env: dockerEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		let settled = false;
		const settle = (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		};
		child.on("error", () => settle(-1));
		child.on("close", (code) => settle(code));
	});
}

function reply(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
	res.end(body);
}

// The secret is compared as fixed-length digests, so the time taken says nothing about it.
function authorized(req) {
	const given = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
	return timingSafeEqual(createHash("sha256").update(given).digest(), secretDigest);
}

// Reads the whole body even when it's too large, so the caller gets the 413 and not a reset connection.
async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size <= MAX_BODY_BYTES) chunks.push(chunk);
	}
	if (size > MAX_BODY_BYTES) return { status: 413, error: "A run request can be at most 32 MB" };
	try {
		return { body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
	} catch {
		return { status: 400, error: "A run request must be JSON" };
	}
}

// requestId -> { slot, userHash, name }
const runs = new Map();

// Starts are spaced apart, because gVisor sandboxes have been reported to hang when many start at once.
let nextStartAt = 0;
async function waitForStartTurn() {
	const now = Date.now();
	const at = Math.max(now, nextStartAt);
	nextStartAt = at + config.startGapMs;
	if (at > now) await delay(at - now);
}

async function health(res) {
	const [info, image] = await Promise.all([
		docker(["info", "--format", "{{json .Runtimes}}"]),
		docker(["image", "inspect", "--format", "{{.Id}}", config.piSettings.image]),
	]);
	const runsc = info.code === 0 && /"runsc"\s*:/.test(info.stdout);
	const imagePresent = image.code === 0;
	reply(res, runsc && imagePresent ? 200 : 503, { runsc, image: imagePresent, slots: config.piSettings.slots, slotsInUse: runs.size });
}

async function startRun(req, res) {
	const request = await readJson(req);
	if (request.error) return reply(res, request.status, { error: request.error });
	const { requestId, userHash, chatHash, slot, runToken, model, thinking, prompt } = request.body ?? {};
	if (typeof runToken !== "string" || !RUN_TOKEN.test(runToken)) return reply(res, 400, { error: "runToken must be 64 hex characters" });
	if (typeof prompt !== "string" || !prompt) return reply(res, 400, { error: "prompt is required" });
	let args;
	try {
		args = piRunArgs({ requestId, userHash, chatHash, slot, model, thinking }, config.piSettings);
	} catch (error) {
		return reply(res, 400, { error: error.message });
	}
	const active = [...runs.values()];
	if (runs.has(requestId)) return reply(res, 409, { error: "This request is already running" });
	if (active.some((run) => run.slot === slot)) return reply(res, 409, { error: "This slot is busy" });
	if (active.filter((run) => run.userHash === userHash).length >= config.maxRunsPerUser) return reply(res, 429, { error: "This user already has the most runs allowed at once" });
	const run = { slot, userHash, name: containerName(requestId) };
	runs.set(requestId, run);

	let bridgeLeft = false;
	res.once("close", () => { bridgeLeft = true; });
	await waitForStartTurn();
	if (bridgeLeft) {
		runs.delete(requestId);
		return;
	}

	const started = Date.now();
	log(`run ${requestId} started on slot ${slot}`);
	res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", Trailer: "X-Run-Exit, X-Run-Reason" });
	const child = spawn(config.docker, args, { env: { ...dockerEnvironment(), JS_RUN_TOKEN: runToken }, stdio: ["pipe", "pipe", "pipe"] });
	child.stdin.on("error", () => {});
	child.stdin.end(prompt);

	let reason;
	let sawOutput = false;
	let finished = false;
	let stderrTail = "";
	let forceTimer;
	const stop = (why) => {
		if (reason || finished) return;
		reason = why;
		// Killing the docker command alone would leave the container running.
		void docker(["kill", run.name]);
		forceTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
	};
	const startTimer = setTimeout(() => { if (!sawOutput) stop("no-start"); }, config.startTimeoutMs);
	const runTimer = setTimeout(() => stop("timeout"), config.runTimeoutMs);
	res.on("error", () => {});
	res.once("close", () => {
		if (finished) return;
		// Keep reading the docker command's output, so it can't block before the kill lands.
		child.stdout.unpipe(res);
		child.stdout.resume();
		stop("stopped");
	});

	child.stdout.once("data", () => {
		sawOutput = true;
		clearTimeout(startTimer);
	});
	child.stdout.pipe(res, { end: false });
	child.stderr.on("data", (chunk) => {
		if (config.debug) process.stderr.write(`[junior-silva-runner] run ${requestId} stderr: ${chunk}`);
		stderrTail = `${stderrTail}${chunk}`.slice(-2000);
	});

	const finish = (exit) => {
		if (finished) return;
		finished = true;
		clearTimeout(startTimer);
		clearTimeout(runTimer);
		clearTimeout(forceTimer);
		runs.delete(requestId);
		// Exit 125 with no output means Docker itself couldn't start the container, so Pi never ran
		// and this error holds no client text.
		// Docker puts the reason on its first line, and a general help hint after it.
		if (exit === 125 && !sawOutput) log(`run ${requestId} couldn't start: ${stderrTail.split("\n").find((line) => line.trim())?.trim().slice(0, 300) || "no reason given"}`);
		log(`run ${requestId} ended: exit ${exit}, ${reason ?? "done"}, after ${Date.now() - started} ms`);
		if (!res.destroyed && !res.writableEnded) {
			res.addTrailers({ "X-Run-Exit": String(exit), "X-Run-Reason": reason ?? "done" });
			res.end();
		}
	};
	child.on("error", () => finish(127));
	child.on("close", (code, signal) => finish(code ?? (signal === "SIGKILL" ? 137 : 143)));
}

// Removes Pi containers this runner isn't running: at start all of them, since no run survives a
// runner restart, and later any it lost track of.
async function sweep({ all }) {
	const listed = await docker(["ps", "-a", "--filter", `label=${RUN_LABEL}`, "--format", "{{.Names}}"]);
	if (listed.code !== 0) return;
	const ours = new Set([...runs.values()].map((run) => run.name));
	const names = listed.stdout.split("\n").map((name) => name.trim()).filter((name) => name.startsWith("js-run-") && (all || !ours.has(name)));
	if (!names.length) return;
	await docker(["rm", "-f", ...names]);
	log(`removed ${names.length} leftover Pi container${names.length === 1 ? "" : "s"}`);
}

const server = createServer(async (req, res) => {
	try {
		if (!authorized(req)) return reply(res, 401, { error: "The runner secret is missing or wrong" });
		const route = new URL(req.url || "/", "http://runner.invalid").pathname;
		if (req.method === "GET" && route === "/health") return await health(res);
		if (req.method === "POST" && route === "/runs") return await startRun(req, res);
		return reply(res, 404, { error: "Not found" });
	} catch (error) {
		console.error(`[junior-silva-runner] ${error?.stack || error}`);
		if (!res.headersSent) reply(res, 500, { error: "The runner failed" });
		else res.destroy();
	}
});

async function shutdown() {
	server.close();
	await Promise.all([...runs.values()].map((run) => docker(["kill", run.name])));
	process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

await sweep({ all: true });
setInterval(() => void sweep({ all: false }), config.sweepIntervalMs).unref();
server.listen(config.port, config.host, () => log(`listening on ${config.host}:${server.address().port}`));
