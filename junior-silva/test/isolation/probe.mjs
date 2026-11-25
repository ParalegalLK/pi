// Isolation check (task/plan.md, section 7; task P3.15): the direct probe. It runs inside a real Pi
// container, started with the runner's own Docker settings (probe-args.mjs), but with no Pi: Pi's
// guard would block things like `env` and /proc first, and a wall test would pass without proving
// anything. It reads its settings from its first argument, tries to get past each wall, and prints
// PASS, FAIL or INFO lines for js-isolation-check.sh. It prints names, counts and error codes, never a
// setting's value or another user's file. Node's own modules only, so it runs in the Pi image as is.
//
//   docker run <probe-args> < probe.mjs     (the script comes in on stdin: node - '<json>')
import { execFileSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import os from "node:os";

const input = JSON.parse(process.argv[2]);
const TIMEOUT_MS = input.timeoutMs ?? 2500;
const lines = [];
const report = (ok, row, text) => lines.push(`${ok ? "PASS" : "FAIL"} ${row} ${text}`);
const info = (row, text) => lines.push(`INFO ${row} ${text}`);
const codeOf = (action) => {
	try {
		action();
		return "ok";
	} catch (error) {
		return error.code || error.name;
	}
};

function connect(target) {
	const split = target.lastIndexOf(":");
	const host = target.slice(0, split).replace(/^\[|\]$/g, "");
	return new Promise((resolve) => {
		const socket = createConnection({ host, port: Number(target.slice(split + 1)), timeout: TIMEOUT_MS });
		const finish = (result) => {
			socket.destroy();
			resolve(result);
		};
		socket.once("connect", () => finish("open"));
		socket.once("timeout", () => finish("timeout"));
		socket.once("error", (error) => finish(error.code === "ECONNREFUSED" ? "refused" : `blocked:${error.code || "error"}`));
	});
}

// A refused connection means the target answered, so it counts as reached, like an open one.
const reached = (result) => result === "open" || result === "refused";

async function status(url, options = {}) {
	try {
		return (await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) })).status;
	} catch (error) {
		return `failed:${error.cause?.code || error.name}`;
	}
}

// Processes first, before this probe starts any of its own. By program name, because a process's own
// name can be its main thread's, such as Node's "MainThread".
const pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
const commands = pids.map((pid) => {
	try {
		return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0].split("/").pop() || "?";
	} catch {
		return "?";
	}
});

// --- ls /data/users -----------------------------------------------------------
let users = [];
const usersRead = codeOf(() => { users = readdirSync("/data/users"); });
report(usersRead === "ok" && users.length === 1 && users[0] === input.ownUser, "sandbox-users", `/data/users holds ${users.length} folder(s)${users.length === 1 && users[0] === input.ownUser ? ", only this user's own" : ", not only this user's own"} (read: ${usersRead})`);

// --- Read A's path ------------------------------------------------------------
const ownRead = codeOf(() => {
	if (readFileSync(input.ownCanary, "utf8").trim() !== input.ownCanaryText) throw Object.assign(new Error("wrong content"), { code: "WRONG_CONTENT" });
});
const otherFile = codeOf(() => readFileSync(input.otherCanary));
const otherFolder = codeOf(() => readdirSync(input.otherUserFolder));
report(ownRead === "ok", "sandbox-other", `control: its own test file can be read (${ownRead})`);
report(otherFile === "ENOENT" && otherFolder === "ENOENT", "sandbox-other", `the other user's test file: ${otherFile}, their folder: ${otherFolder}`);

// --- env and /proc/1/environ ---------------------------------------------------
const keyLike = (name) => /key|secret|password|passwd|credential|auth|private/i.test(name);
const ownNames = Object.keys(process.env);
let initNames = [];
const initRead = codeOf(() => { initNames = readFileSync("/proc/1/environ", "utf8").split("\0").filter(Boolean).map((entry) => entry.split("=")[0]); });
const expected = new Set(input.expectedEnv);
const unexpected = [...new Set([...ownNames, ...initNames])].filter((name) => !expected.has(name)).sort();
report(initRead === "ok" && ownNames.filter(keyLike).length === 0 && initNames.filter(keyLike).length === 0, "sandbox-env", `key-like setting names: ${ownNames.filter(keyLike).length} in its own settings, ${initNames.filter(keyLike).length} in /proc/1/environ (read: ${initRead})`);
report(unexpected.length === 0, "sandbox-env", `settings beyond the image's own and the run's 4: ${unexpected.length ? unexpected.join(" ") : "none"}`);
report(ownNames.includes("JS_RUN_TOKEN") && initNames.includes("JS_RUN_TOKEN"), "sandbox-env", "control: the run's token setting is there");

// --- ps, mounts, dmesg ---------------------------------------------------------
const strangers = commands.filter((name) => !["docker-init", "tini", "node", "?"].includes(name));
report(strangers.length === 0, "sandbox-view", `processes: ${pids.length} (${[...new Set(commands)].join(", ")}), none from the server or another run`);
let mounts = [];
const mountsRead = codeOf(() => {
	mounts = readFileSync("/proc/self/mountinfo", "utf8").trim().split("\n").map((line) => {
		const fields = line.split(" ");
		return { point: fields[4], options: fields[5].split(",") };
	});
});
const ownFolders = ["uploads", "artifacts", "workspace", "sessions"].map((folder) => `${input.ownChatRoot}/${folder}`);
const dataMounts = mounts.filter((mount) => mount.point === "/data" || mount.point.startsWith("/data/"));
const onlyOwn = dataMounts.length === 4 && ownFolders.every((folder) => dataMounts.some((mount) => mount.point === folder));
report(mountsRead === "ok" && onlyOwn, "sandbox-view", `mounts under /data: ${dataMounts.length}, exactly this chat's 4 folders: ${onlyOwn} (read: ${mountsRead})`);
const readOnly = (point) => Boolean(mounts.find((mount) => mount.point === point)?.options.includes("ro"));
report(readOnly("/") && readOnly(ownFolders[0]) && readOnly(ownFolders[1]) && !readOnly(ownFolders[2]) && !readOnly(ownFolders[3]), "sandbox-view", "/, uploads and artifacts are mounted read-only; workspace and sessions read-write");
const version = codeOf(() => {
	if (!/gvisor/i.test(readFileSync("/proc/version", "utf8"))) throw Object.assign(new Error("not gVisor"), { code: "NOT_GVISOR" });
});
report(version === "ok", "sandbox-view", `gVisor shows: the kernel version is gVisor's own, not the server's (${version})`);
let dmesg = "";
try {
	dmesg = execFileSync("dmesg", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (error) {
	dmesg = `error:${error.code || error.status}`;
}
info("sandbox-view", `dmesg: ${/Starting gVisor/.test(dmesg) ? "gVisor's own start-up messages, not the server's" : dmesg.slice(0, 60).replace(/\s+/g, " ")}`);

// --- Writes ---------------------------------------------------------------------
const write = (file) => codeOf(() => {
	writeFileSync(file, "isolation check\n");
	rmSync(file, { force: true });
});
const writes = {
	uploads: write(`${ownFolders[0]}/iso-write-test`),
	artifacts: write(`${ownFolders[1]}/iso-write-test`),
	app: write("/app/iso-write-test"),
	root: write("/iso-write-test"),
	workspace: write(`${ownFolders[2]}/iso-write-test`),
	tmp: write("/tmp/iso-write-test"),
};
const refused = (code) => ["EROFS", "EACCES", "EPERM"].includes(code);
report(refused(writes.uploads) && refused(writes.artifacts) && refused(writes.app) && refused(writes.root), "sandbox-writes", `refused: uploads ${writes.uploads}, artifacts ${writes.artifacts}, /app ${writes.app}, / ${writes.root}`);
report(writes.workspace === "ok" && writes.tmp === "ok", "sandbox-writes", `control: workspace ${writes.workspace}, /tmp ${writes.tmp}`);

// --- docker.sock, capabilities ---------------------------------------------------
let statusText = "";
const statusRead = codeOf(() => { statusText = readFileSync("/proc/self/status", "utf8"); });
const field = (name) => (statusText.match(new RegExp(`^${name}:\\s*(\\S+)`, "m")) || [])[1];
const capabilities = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"];
report(statusRead === "ok" && capabilities.every((name) => /^0+$/.test(field(name) ?? "x")), "sandbox-powers", `capabilities: ${capabilities.map((name) => `${name} ${field(name)}`).join(", ")}`);
report(field("NoNewPrivs") === "1", "sandbox-powers", `no-new-privileges: ${field("NoNewPrivs")}`);
const sockets = ["/var/run/docker.sock", "/run/docker.sock"].filter((file) => existsSync(file));
report(sockets.length === 0, "sandbox-powers", `docker.sock: ${sockets.length ? sockets.join(" ") : "absent"}`);
let raw;
try {
	raw = execFileSync("python3", ["-c", "import socket; socket.socket(socket.AF_PACKET, socket.SOCK_RAW); print('allowed')"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
} catch {
	raw = "refused";
}
report(raw === "refused", "sandbox-powers", `raw sockets: ${raw}`);

// --- Network ---------------------------------------------------------------------
const gateway = await status(`http://${input.bridge}:${input.gatewayPort}/internal/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
report(gateway === 401, "network-n", `control: the bridge's tool port answers on this slot (${gateway} without a token)`);
const publicPort = await Promise.all(["/health", "/v1/models", "/files/a/b/c/d/e"].map((route) => status(`http://${input.bridge}:${input.publicPort}${route}`)));
report(publicPort.every((code) => code === 403), "network-8126", `the bridge's ${input.publicPort} refuses /health, /v1/models and /files: ${publicPort.join(", ")}`);
let table = "";
codeOf(() => { table = readFileSync("/proc/net/route", "utf8"); });
const defaultRoute = table.split("\n").slice(1).some((line) => line.split(/\s+/)[1] === "00000000");
report(!defaultRoute, "network-n", `default route: ${defaultRoute ? "present" : "absent"}`);
// Each group reports under its own row: network-n, or network-host for the host's own ports (P7.8).
const groups = new Map();
for (const { group, target, row = "network-n" } of input.blocked) {
	if (!groups.has(group)) groups.set(group, { row, targets: [] });
	groups.get(group).targets.push(target);
}
for (const [group, { row, targets }] of groups) {
	const results = await Promise.all(targets.map(async (target) => ({ target, result: await connect(target) })));
	const through = results.filter(({ result }) => reached(result));
	report(through.length === 0, row, `${group}: ${targets.length} target(s), none reached${through.length ? `; REACHED ${through.map(({ target, result }) => `${target} ${result}`).join(" ")}` : ` (${[...new Set(results.map(({ result }) => result))].join(", ")})`}`);
}
const internet = await Promise.all(input.internet.map(async (target) => `${target} ${await connect(target)}`));
report(!internet.some((line) => / (open|refused)$/.test(line)), "network-n", `internet: ${internet.join(", ")}`);
const name = await Promise.race([lookup(input.dnsName).then(() => "resolved", (error) => `failed:${error.code}`), new Promise((resolve) => setTimeout(() => resolve("timeout"), TIMEOUT_MS))]);
report(name !== "resolved", "network-n", `DNS for ${input.dnsName}: ${name}`);
const runner = await connect(input.runner);
report(!reached(runner), "runner", `the runner's address: ${runner}`);
info("network-n", `interfaces: ${Object.entries(os.networkInterfaces()).flatMap(([interfaceName, addresses]) => addresses.map((address) => `${interfaceName} ${address.address}`)).join(", ")}`);

console.log(lines.join("\n"));
