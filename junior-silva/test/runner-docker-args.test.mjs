import assert from "node:assert/strict";
import test from "node:test";
import { containerName, piRunArgs, RUN_LABEL } from "../runner/docker-args.mjs";

const USER = "a".repeat(32);
const CHAT = "b".repeat(32);
const REQUEST = "chatcmpl-12345678-9abc-4def-8123-456789abcdef";
const RUN = { requestId: REQUEST, userHash: USER, chatHash: CHAT, slot: 2, model: "claude-opus-5-5" };
const SETTINGS = { hostDataRoot: "/srv/js/data", image: "junior-silva-pi:local", slots: 3, gatewayPort: 8127 };

test("the Docker settings for a Pi run are exactly the plan's", () => {
	const chat = `/data/users/${USER}/chats/${CHAT}`;
	const host = `/srv/js/data/users/${USER}/chats/${CHAT}`;
	assert.deepEqual(piRunArgs(RUN, SETTINGS), [
		"run", "--rm", "-i", "--pull", "never",
		"--name", `js-run-${REQUEST}`, "--label", "js.run=1",
		"--runtime", "runsc",
		"--network", "js-slot-2", "--ip", "10.89.2.3", "--hostname", "js-run",
		"--user", "1000:1000", "--workdir", "/app",
		"--cap-drop", "ALL", "--security-opt", "no-new-privileges",
		"--read-only",
		"--tmpfs", "/tmp:rw,size=1g,mode=1777",
		"--tmpfs", "/home/node:rw,size=256m,uid=1000,gid=1000",
		"--tmpfs", "/run/pi-agent:rw,size=32m,uid=1000,gid=1000",
		"--shm-size", "256m", "--memory", "2g", "--memory-swap", "2g", "--cpus", "2", "--pids-limit", "512",
		"--init", "--log-driver", "none", "--no-healthcheck",
		"--mount", `type=bind,src=${host}/uploads,dst=${chat}/uploads,readonly`,
		"--mount", `type=bind,src=${host}/artifacts,dst=${chat}/artifacts,readonly`,
		"--mount", `type=bind,src=${host}/workspace,dst=${chat}/workspace`,
		"--mount", `type=bind,src=${host}/sessions,dst=${chat}/sessions`,
		"-e", "JS_RUN_TOKEN",
		"-e", "JS_GATEWAY_URL=http://10.89.2.2:8127",
		"-e", `JS_CHAT_ROOT=${chat}`,
		"-e", `JS_REQUEST_ID=${REQUEST}`,
		"junior-silva-pi:local",
		"--mode", "json", "--approve", "--session-id", `junior-silva-v2-${CHAT}`,
		"--provider", "anthropic", "--model", "claude-opus-5-5",
	]);
	assert.equal(containerName(REQUEST), `js-run-${REQUEST}`);
	assert.equal(RUN_LABEL, "js.run=1");
});

test("the run token only ever comes from the environment, never as a value on the command line", () => {
	const args = piRunArgs(RUN, SETTINGS);
	assert.equal(args.filter((arg) => arg.startsWith("JS_RUN_TOKEN")).join(" "), "JS_RUN_TOKEN");
	assert.ok(!args.some((arg) => /JS_RUN_TOKEN=/.test(arg)));
});

test("a thinking level is passed on only when one is set", () => {
	assert.ok(!piRunArgs(RUN, SETTINGS).includes("--thinking"));
	assert.deepEqual(piRunArgs({ ...RUN, thinking: "high" }, SETTINGS).slice(-2), ["--thinking", "high"]);
});

test("every mount comes from this chat's own host folder, and lands at the same path", () => {
	const args = piRunArgs(RUN, { ...SETTINGS, hostDataRoot: "/srv/js/data/" });
	const mounts = args.filter((_, index) => args[index - 1] === "--mount");
	assert.equal(mounts.length, 4);
	for (const mount of mounts) {
		const [, src, dst] = /^type=bind,src=([^,]+),dst=([^,]+)(,readonly)?$/.exec(mount);
		assert.ok(src.startsWith(`/srv/js/data/users/${USER}/chats/${CHAT}/`));
		assert.equal(dst, src.replace("/srv/js/data/", "/data/"));
	}
	assert.deepEqual(mounts.filter((mount) => mount.endsWith(",readonly")).map((mount) => mount.split("/").at(-1)), ["uploads,readonly", "artifacts,readonly"]);
});

test("each bad input is refused, so nothing unchecked reaches Docker", () => {
	const refused = [
		[{ ...RUN, requestId: "../x" }, SETTINGS],
		[{ ...RUN, requestId: `${REQUEST} --privileged` }, SETTINGS],
		[{ ...RUN, userHash: "A".repeat(32) }, SETTINGS],
		[{ ...RUN, chatHash: `${CHAT}/../x` }, SETTINGS],
		[{ ...RUN, slot: 0 }, SETTINGS],
		[{ ...RUN, slot: 4 }, SETTINGS],
		[{ ...RUN, slot: 1.5 }, SETTINGS],
		[{ ...RUN, slot: "1" }, SETTINGS],
		[{ ...RUN, model: "claude --privileged" }, SETTINGS],
		[{ ...RUN, model: "" }, SETTINGS],
		[{ ...RUN, thinking: "huge" }, SETTINGS],
		[RUN, { ...SETTINGS, hostDataRoot: "relative/path" }],
		[RUN, { ...SETTINGS, hostDataRoot: "/srv/../etc" }],
		[RUN, { ...SETTINGS, hostDataRoot: "/srv/js,readonly=false" }],
		[RUN, { ...SETTINGS, image: "junior-silva-pi:local --privileged" }],
		[RUN, { ...SETTINGS, slots: 0 }],
		[RUN, { ...SETTINGS, gatewayPort: 70000 }],
	];
	for (const [run, settings] of refused) assert.throws(() => piRunArgs(run, settings), Error, JSON.stringify({ run, settings }));
});
