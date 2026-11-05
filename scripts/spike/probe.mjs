#!/usr/bin/env node
// Probes for the gVisor spike (task/plan.md, P0.4). Uses only Node, because the
// image has no curl. Prints simple "name result" lines for js-spike.sh to read.
//
//   probe.mjs net <host:port> ...     TCP connect to each target
//   probe.mjs dns <name> ...          Name lookup
//   probe.mjs http <url>              GET, prints the status
//   probe.mjs route                   Default route and interfaces
//   probe.mjs listen <port>           Listen until killed
//   probe.mjs exchange <side> <dir>   File exchange check: side is pi or bridge
import { lookup } from "node:dns/promises";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, createConnection } from "node:net";
import os from "node:os";
import path from "node:path";

const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 3000);
const ROUNDS = 20;

function connectResult(host, port) {
	return new Promise((resolve) => {
		const socket = createConnection({ host, port: Number(port), timeout: TIMEOUT_MS });
		const finish = (result) => { socket.destroy(); resolve(result); };
		socket.once("connect", () => finish("open"));
		socket.once("timeout", () => finish("timeout"));
		socket.once("error", (error) => finish(error.code === "ECONNREFUSED" ? "refused" : `blocked:${error.code || "error"}`));
	});
}

async function net(targets) {
	for (const target of targets) {
		const split = target.lastIndexOf(":");
		const result = await connectResult(target.slice(0, split).replace(/^\[|\]$/g, ""), target.slice(split + 1));
		console.log(`${target} ${result}`);
	}
}

async function dns(names) {
	for (const name of names) {
		const timer = new Promise((resolve) => setTimeout(() => resolve("timeout"), TIMEOUT_MS));
		const answer = lookup(name).then((value) => `resolved:${value.address}`, (error) => `failed:${error.code || "error"}`);
		console.log(`${name} ${await Promise.race([answer, timer])}`);
	}
}

async function http(url) {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		console.log(`${url} ${response.status}`);
	} catch (error) {
		console.log(`${url} failed:${error.cause?.code || error.name}`);
	}
}

function route() {
	let table = "";
	try { table = readFileSync("/proc/net/route", "utf8"); } catch { table = ""; }
	const hasDefault = table.split("\n").slice(1).some((line) => line.split(/\s+/)[1] === "00000000");
	console.log(`default-route ${hasDefault ? "present" : "absent"}`);
	for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
		for (const address of addresses) console.log(`interface ${name} ${address.family} ${address.address}`);
	}
}

// Listens on IPv6 and IPv4 together where the machine allows it, so an IPv6
// probe can't fail just because nothing was listening there.
function listen(port) {
	const server = createServer((socket) => socket.end("spike\n"));
	server.once("error", () => server.listen(Number(port), "0.0.0.0", () => console.log(`listening ${port} ipv4`)));
	server.listen(Number(port), "::", () => console.log(`listening ${port} dual`));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeAtomic(file, value) {
	writeFileSync(`${file}.tmp`, value);
	renameSync(`${file}.tmp`, file);
}

async function waitFor(check, limitMs = 5000) {
	const started = Date.now();
	while (Date.now() - started < limitMs) {
		if (check()) return Date.now() - started;
		await sleep(5);
	}
	return -1;
}

// Each side writes new files, and also overwrites one shared file, so a stale
// cache on the Pi side would show up as well as a late new file.
async function exchange(side, directory) {
	const other = side === "pi" ? "bridge" : "pi";
	let worst = 0;
	let failures = 0;
	for (let round = 1; round <= ROUNDS; round += 1) {
		const value = `${side}-${round}`;
		writeAtomic(path.join(directory, `${side}-${round}.txt`), value);
		writeFileSync(path.join(directory, `${side}-shared.txt`), value);
		const expected = `${other}-${round}`;
		const newFile = path.join(directory, `${other}-${round}.txt`);
		const shared = path.join(directory, `${other}-shared.txt`);
		const waited = await waitFor(() => {
			if (!existsSync(newFile) || !existsSync(shared)) return false;
			const sharedValue = readFileSync(shared, "utf8");
			return readFileSync(newFile, "utf8") === expected && Number(sharedValue.split("-")[1]) >= round;
		});
		if (waited < 0) failures += 1;
		else worst = Math.max(worst, waited);
	}
	console.log(`exchange ${side} rounds=${ROUNDS} failures=${failures} worst_wait_ms=${worst}`);
}

const [command, ...args] = process.argv.slice(2);
if (command === "net") await net(args);
else if (command === "dns") await dns(args);
else if (command === "http") await http(args[0]);
else if (command === "route") route();
else if (command === "listen") listen(args[0]);
else if (command === "exchange") await exchange(args[0], args[1]);
else {
	console.error(`Unknown probe: ${command}`);
	process.exitCode = 2;
}
