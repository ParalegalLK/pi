// The exact `docker run` arguments for one Pi run (task/plan.md, sections 3.5 and 3.10; task P3.5).
// Everything comes from fixed settings or checked inputs, so nothing free-form from the bridge or Pi
// reaches Docker. The run token is never on the command line: `-e JS_RUN_TOKEN` takes its value from
// the docker command's own environment.

export const RUN_LABEL = "js.run=1";

const HASH = /^[0-9a-f]{32}$/;
const REQUEST_ID = /^chatcmpl-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODEL = /^[a-z0-9][a-z0-9.-]{0,63}$/;
// Pi's own list (packages/coding-agent/src/cli/args.ts, VALID_THINKING_LEVELS).
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
// An absolute path of plain characters. No commas, because Docker's --mount syntax splits on them.
const HOST_FOLDER = /^\/[A-Za-z0-9._/-]*$/;
const IMAGE = /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?(@sha256:[0-9a-f]{64})?$/;

function check(ok, message) {
	if (!ok) throw new Error(message);
}

export function containerName(requestId) {
	return `js-run-${requestId}`;
}

// run: { requestId, userHash, chatHash, slot, model, thinking? }
// settings: { hostDataRoot, image, slots, gatewayPort }
export function piRunArgs(run, settings) {
	const { requestId, userHash, chatHash, slot, model, thinking } = run;
	const { hostDataRoot, image, slots, gatewayPort } = settings;
	check(Number.isInteger(slots) && slots >= 1 && slots <= 254, "The slot count must be a whole number from 1 to 254");
	check(Number.isInteger(gatewayPort) && gatewayPort >= 1 && gatewayPort <= 65535, "The gateway port must be from 1 to 65535");
	check(typeof hostDataRoot === "string" && HOST_FOLDER.test(hostDataRoot) && !hostDataRoot.split("/").includes(".."), "The host data folder must be an absolute path of plain characters");
	check(typeof image === "string" && IMAGE.test(image), "The Pi image must be a plain image name");
	check(typeof requestId === "string" && REQUEST_ID.test(requestId), "requestId must be chatcmpl-<uuid>");
	check(typeof userHash === "string" && HASH.test(userHash), "userHash must be 32 hex characters");
	check(typeof chatHash === "string" && HASH.test(chatHash), "chatHash must be 32 hex characters");
	check(Number.isInteger(slot) && slot >= 1 && slot <= slots, `slot must be a whole number from 1 to ${slots}`);
	check(typeof model === "string" && MODEL.test(model), "model must be a plain model name");
	check(thinking === undefined || THINKING_LEVELS.has(thinking), "thinking must be one of Pi's thinking levels");

	// The same path inside the container as on the host, so paths Pi passes to tools need no translating.
	const chatRoot = `/data/users/${userHash}/chats/${chatHash}`;
	const hostChat = `${hostDataRoot.replace(/\/+$/, "")}/users/${userHash}/chats/${chatHash}`;
	const mount = (folder, readonly) => ["--mount", `type=bind,src=${hostChat}/${folder},dst=${chatRoot}/${folder}${readonly ? ",readonly" : ""}`];
	const args = [
		"run", "--rm", "-i", "--pull", "never",
		"--name", containerName(requestId), "--label", RUN_LABEL,
		"--runtime", "runsc",
		"--network", `js-slot-${slot}`, "--ip", `10.89.${slot}.3`, "--hostname", "js-run",
		"--user", "1000:1000", "--workdir", "/app",
		"--cap-drop", "ALL", "--security-opt", "no-new-privileges",
		"--read-only",
		"--tmpfs", "/tmp:rw,size=1g,mode=1777",
		"--tmpfs", "/home/node:rw,size=256m,uid=1000,gid=1000",
		"--tmpfs", "/run/pi-agent:rw,size=32m,uid=1000,gid=1000",
		"--shm-size", "256m", "--memory", "2g", "--memory-swap", "2g", "--cpus", "2", "--pids-limit", "512",
		"--init", "--log-driver", "none", "--no-healthcheck",
		...mount("uploads", true),
		...mount("artifacts", true),
		...mount("workspace", false),
		...mount("sessions", false),
		"-e", "JS_RUN_TOKEN",
		"-e", `JS_GATEWAY_URL=http://10.89.${slot}.2:${gatewayPort}`,
		"-e", `JS_CHAT_ROOT=${chatRoot}`,
		"-e", `JS_REQUEST_ID=${requestId}`,
		image,
		"--mode", "json", "--approve", "--session-id", `junior-silva-v2-${chatHash}`,
		"--provider", "anthropic", "--model", model,
	];
	if (thinking !== undefined) args.push("--thinking", thinking);
	return args;
}
