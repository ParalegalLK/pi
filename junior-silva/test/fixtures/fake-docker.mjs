#!/usr/bin/env node
// Test only: stands in for the docker command in the runner's tests, which have no Docker. The tests
// point the runner at it with JS_DOCKER_BIN. It gets its folder from DOCKER_HOST
// (unix://<folder>/docker.sock), the one setting the runner passes on to docker. It records every call
// in <folder>/calls.jsonl, and acts out a run chosen by the start of the prompt:
//   ok            writes two lines and some raw bytes, then exits 0
//   fail          writes a line, then exits 2, as when gVisor ends a sandbox
//   stderr        writes client text to stderr, then exits 0
//   cannot-start  writes Docker's own error to stderr, then exits 125
//   slow          writes a line, then waits until killed
//   silent        writes nothing, and waits until killed
// It also keeps networks in <folder>/networks/<name>.json, as `docker network inspect` prints them, and
// the bridge's slot addresses in <folder>/attached/<network>.
// Files a test can create: <folder>/no-runsc, <folder>/no-image, <folder>/no-bridge,
// <folder>/leftovers/<name>, and <folder>/networks/<name>.json for a network made by someone else.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const folder = path.dirname(new URL(process.env.DOCKER_HOST).pathname);
const running = path.join(folder, "running");
const leftovers = path.join(folder, "leftovers");
const networks = path.join(folder, "networks");
const attached = path.join(folder, "attached");
for (const made of [running, leftovers, networks, attached]) mkdirSync(made, { recursive: true });
const [command, ...args] = process.argv.slice(2);

function record(entry = {}) {
	appendFileSync(path.join(folder, "calls.jsonl"), `${JSON.stringify({ at: Date.now(), command, args, ...entry })}\n`);
}

function stopRunning(name) {
	const file = path.join(running, name);
	if (!existsSync(file)) return false;
	try {
		process.kill(Number(readFileSync(file, "utf8")), "SIGTERM");
	} catch {}
	return true;
}

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8");
}

async function fakeRun() {
	const name = args[args.indexOf("--name") + 1];
	const prompt = await readStdin();
	record({ name, prompt, tokenFromEnvironment: process.env.JS_RUN_TOKEN ?? null });
	const marker = path.join(running, name);
	writeFileSync(marker, String(process.pid));
	const done = (code) => {
		rmSync(marker, { force: true });
		process.exitCode = code;
	};
	process.on("SIGTERM", () => {
		rmSync(marker, { force: true });
		process.exit(137);
	});
	const scenario = prompt.split(":")[0];
	if (scenario === "ok") {
		process.stdout.write('{"type":"first"}\n');
		process.stdout.write(Buffer.from([0x00, 0xff, 0x80, 0x0a]));
		process.stdout.write('{"type":"second"}\n');
		return done(0);
	}
	if (scenario === "fail") {
		process.stdout.write("partial\n");
		return done(2);
	}
	if (scenario === "stderr") {
		process.stderr.write("PRIVATE CLIENT TEXT\n");
		process.stdout.write("done\n");
		return done(0);
	}
	if (scenario === "cannot-start") {
		process.stderr.write("docker: Error response from daemon: network js-slot-9 not found.\n");
		return done(125);
	}
	if (scenario === "slow") process.stdout.write("started\n");
	setInterval(() => {}, 1000);
}

function fakeNetwork() {
	const [action, ...rest] = args;
	const flag = (name) => rest[rest.indexOf(name) + 1];
	if (action === "inspect") {
		const file = path.join(networks, `${rest.at(-1)}.json`);
		if (existsSync(file)) process.stdout.write(readFileSync(file));
		else {
			process.stderr.write(`Error response from daemon: network ${rest.at(-1)} not found\n`);
			process.exitCode = 1;
		}
	} else if (action === "create") {
		const pairs = (name) => rest.flatMap((arg, index) => (rest[index - 1] === name ? [arg.split("=")] : []));
		const network = {
			Name: rest.at(-1),
			Driver: flag("--driver"),
			Internal: rest.includes("--internal"),
			EnableIPv6: false,
			Options: Object.fromEntries(pairs("--opt")),
			IPAM: { Config: [{ Subnet: flag("--subnet") }] },
			Labels: Object.fromEntries(pairs("--label")),
		};
		writeFileSync(path.join(networks, `${network.Name}.json`), JSON.stringify(network));
	} else if (action === "connect") {
		if (existsSync(path.join(folder, "no-bridge"))) {
			process.stderr.write("Error response from daemon: No such container\n");
			process.exitCode = 1;
		} else writeFileSync(path.join(attached, rest.at(-2)), flag("--ip"));
	} else if (action === "disconnect") {
		rmSync(path.join(attached, rest.at(-2)), { force: true });
	} else process.exitCode = 1;
}

// `docker inspect --format {{json .NetworkSettings.Networks}} <bridge>`: the bridge's slot addresses.
function inspectContainer() {
	if (existsSync(path.join(folder, "no-bridge"))) {
		process.stderr.write("Error: No such object\n");
		process.exitCode = 1;
		return;
	}
	const joined = Object.fromEntries(readdirSync(attached).map((name) => {
		const address = readFileSync(path.join(attached, name), "utf8");
		return [name, { IPAMConfig: { IPv4Address: address }, IPAddress: address }];
	}));
	console.log(JSON.stringify(joined));
}

switch (command) {
	case "info":
		record();
		console.log(existsSync(path.join(folder, "no-runsc")) ? '{"runc":{}}' : '{"runc":{},"runsc":{}}');
		break;
	case "image":
		record();
		process.exitCode = existsSync(path.join(folder, "no-image")) ? 1 : 0;
		break;
	case "ps":
		record();
		for (const name of [...readdirSync(running), ...readdirSync(leftovers)]) console.log(name);
		break;
	case "rm":
		record();
		for (const name of args.filter((arg) => arg !== "-f")) {
			rmSync(path.join(leftovers, name), { force: true });
			stopRunning(name);
		}
		break;
	case "kill":
		record();
		process.exitCode = stopRunning(args[0]) ? 0 : 1;
		break;
	case "run":
		await fakeRun();
		break;
	case "network":
		record();
		fakeNetwork();
		break;
	case "inspect":
		record();
		inspectContainer();
		break;
	default:
		record({ unknown: true });
		process.exitCode = 1;
}
