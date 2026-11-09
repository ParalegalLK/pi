// How the bridge starts Pi for one message (task/plan.md, task P3.7). Two ways with the same shape:
//   container  the default: the runner starts Pi in its own gVisor container on a slot (P3.4 to P3.6)
//   local      development only: Pi runs as a process inside the bridge, as it did before P3
// Each returns Pi's output as a stream, stop(), and done: a promise of { exitCode, reason, detail }.
import { spawn } from "node:child_process";
import http from "node:http";
import { PassThrough } from "node:stream";

// In the local way, Stop asks Pi to end, then forces it after this.
const STOP_GRACE_MS = 5_000;
// In the container way, Stop asks the runner to end the run. If it hasn't ended by then, hang up,
// which makes the runner kill the container anyway.
const STOP_FALLBACK_MS = 15_000;
export const BUSY_TEXT = "Junior Silva is busy with other requests right now. Please try again in a few minutes.";

// The address Pi's container has on its slot. The runner gives it with --ip (runner/docker-args.mjs),
// and the run token is tied to it, so the token only works from that slot's Pi.
export function piAddress(slot) {
	return `10.89.${slot}.3`;
}

// The slots a run takes one of, from 1 to count. When all are busy, a run waits in line, first come
// first served, until a slot is freed, its message is stopped, or waitMs passes.
export function createSlotPool(count, waitMs) {
	const free = new Set(Array.from({ length: count }, (_, index) => index + 1));
	const waiting = [];
	return {
		async take(signal) {
			signal?.throwIfAborted();
			if (free.size) {
				const slot = Math.min(...free);
				free.delete(slot);
				return slot;
			}
			return new Promise((resolve, reject) => {
				const entry = {};
				const leave = (error) => {
					const index = waiting.indexOf(entry);
					if (index >= 0) waiting.splice(index, 1);
					clearTimeout(entry.timer);
					signal?.removeEventListener("abort", entry.onAbort);
					reject(error);
				};
				entry.timer = setTimeout(() => leave(Object.assign(new Error(BUSY_TEXT), { status: 429, busy: true })), waitMs);
				entry.onAbort = () => leave(signal.reason ?? new Error("The run was stopped"));
				entry.grant = (slot) => {
					clearTimeout(entry.timer);
					signal?.removeEventListener("abort", entry.onAbort);
					resolve(slot);
				};
				signal?.addEventListener("abort", entry.onAbort, { once: true });
				waiting.push(entry);
			});
		},
		release(slot) {
			const next = waiting.shift();
			if (next) next.grant(slot);
			else free.add(slot);
		},
	};
}

// Development only: Pi runs next to the bridge, so its shell can reach the bridge's settings.
export function startLocalPi({ command, args, cwd, environment, prompt }) {
	const child = spawn(command, args, { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] });
	// The prompt goes in on stdin, not on the command line: every process can read a command line,
	// and Linux limits one command-line argument to 128 KB, too small for a long pasted contract.
	child.stdin.on("error", () => {});
	child.stdin.end(prompt);
	let errorOutput = "";
	child.stderr.on("data", (chunk) => { errorOutput = `${errorOutput}${chunk}`.slice(-12_000); });
	let forceTimer;
	const done = new Promise((resolve) => {
		child.on("error", (error) => {
			clearTimeout(forceTimer);
			resolve({ exitCode: null, reason: "error", detail: String(error?.message || error) });
		});
		child.on("close", (code) => {
			clearTimeout(forceTimer);
			resolve({ exitCode: code, reason: "done", detail: errorOutput.replace(/\s+/g, " ").slice(0, 1200) });
		});
	});
	return {
		stdout: child.stdout,
		// Asks Pi to stop, which also stops the commands it started, then forces it. A process Pi left
		// behind can hold its pipes open, so they're closed too, or "close" might never fire.
		stop() {
			if (forceTimer) return;
			child.kill("SIGTERM");
			forceTimer = setTimeout(() => {
				child.kill("SIGKILL");
				child.stdout.destroy();
				child.stderr.destroy();
			}, STOP_GRACE_MS);
		},
		done,
	};
}

function readJson(response) {
	return new Promise((resolve) => {
		const chunks = [];
		response.on("data", (chunk) => chunks.push(chunk));
		response.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				resolve({});
			}
		});
		response.on("error", () => resolve({}));
	});
}

// The default: the runner starts Pi in its own gVisor container. Pi's output comes back as raw bytes,
// with the exit code and the reason as trailers (task/plan.md, decision D9).
// run: { requestId, userHash, chatHash, slot, runToken, model, thinking? }
export function startContainerPi({ runnerUrl, runnerSecret, run, prompt, stopFallbackMs = STOP_FALLBACK_MS }) {
	const headers = { authorization: `Bearer ${runnerSecret}` };
	const payload = Buffer.from(JSON.stringify({ ...run, prompt }));
	const stdout = new PassThrough();
	let request;
	let stopping = false;
	let fallbackTimer;
	const done = new Promise((resolve) => {
		let settled = false;
		const settle = (ending) => {
			if (settled) return;
			settled = true;
			clearTimeout(fallbackTimer);
			if (!stdout.writableEnded) stdout.end();
			resolve(ending);
		};
		request = http.request(new URL("/runs", runnerUrl), { method: "POST", headers: { ...headers, "content-type": "application/json", "content-length": payload.length } }, (response) => {
			if (response.statusCode !== 200) {
				void readJson(response).then((body) => settle({ exitCode: null, reason: "refused", detail: `the runner refused the run (${response.statusCode}): ${String(body.error || "no reason given").slice(0, 300)}` }));
				return;
			}
			response.pipe(stdout, { end: false });
			response.on("end", () => {
				const exit = response.trailers["x-run-exit"];
				if (exit === undefined) settle({ exitCode: null, reason: "lost", detail: "the runner's answer ended without an exit code" });
				else settle({ exitCode: Number(exit), reason: response.trailers["x-run-reason"] || "done", detail: "" });
			});
			response.on("close", () => settle({ exitCode: null, reason: "lost", detail: "the connection to the runner closed early" }));
		});
		request.on("error", (error) => settle({ exitCode: null, reason: "unreachable", detail: `the runner couldn't be reached: ${error?.code || error?.message || error}` }));
		request.end(payload);
	});
	return {
		stdout,
		// Asks the runner to end the run and keeps reading until it has, so the next message in this chat
		// can't start while this Pi still runs. A run the runner doesn't know yet, or one that doesn't end
		// in time, is ended by hanging up, which the runner treats as Stop too.
		stop() {
			if (stopping) return;
			stopping = true;
			fallbackTimer = setTimeout(() => request.destroy(), stopFallbackMs);
			const ask = http.request(new URL(`/runs/${run.requestId}/stop`, runnerUrl), { method: "POST", headers }, (response) => {
				response.resume();
				if (response.statusCode !== 202) request.destroy();
			});
			ask.on("error", () => request.destroy());
			ask.end();
		},
		done,
	};
}
