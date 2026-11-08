// Test only: starts the real bridge, which starts real Pi. Pi calls the bridge's model proxy with its run
// token, and the proxy calls a fake model instead of Anthropic, with a stand-in for the real key.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../../server/openai.mjs", import.meta.url));
// Stands in for the real Anthropic key, which only the bridge's model proxy holds.
export const PROXY_REAL_KEY = "real-key-for-tests";
export const TEST_MODEL = "claude-sonnet-5-5";
const API_KEY = "test-junior-silva-key";
const USER = "aaaaaaaaaaaaaaaaaaaaaa40";

export async function startBridgeWithFakeModel(fakeModelUrl, { environment: overrides = {} } = {}) {
	const root = await mkdtemp(path.join(os.tmpdir(), "junior-silva-fake-model-"));
	// The shared settings folder each run's own folder copies from.
	const agentDir = path.join(root, "pi-agent");
	await mkdir(agentDir, { recursive: true });
	// Cache warming would make extra model calls in the background.
	await writeFile(path.join(agentDir, "settings.json"), `${JSON.stringify({ cacheWarming: "off" })}\n`);
	const port = 20000 + Math.floor(Math.random() * 20000);
	const environment = {
		...process.env,
		JUNIOR_SILVA_API_KEY: API_KEY,
		JS_IDENTITY_SECRET: "test-identity-secret",
		JUNIOR_SILVA_ARTIFACT_SECRET: "test-artifact-secret",
		JS_NATIVE_DEV: "",
		JUNIOR_SILVA_BIND_HOST: "127.0.0.1",
		JUNIOR_SILVA_PORT: String(port),
		JUNIOR_SILVA_PUBLIC_URL: `http://127.0.0.1:${port}`,
		JUNIOR_SILVA_DATA_ROOT: root,
		JUNIOR_SILVA_ARTIFACT_ROOT: path.join(root, "artifacts"),
		PI_CODING_AGENT_DIR: agentDir,
		PI_PROVIDER: "anthropic",
		PI_MODEL: TEST_MODEL,
		ANTHROPIC_API_KEY: PROXY_REAL_KEY,
		JS_MODEL_UPSTREAM: fakeModelUrl,
		...overrides,
	};
	delete environment.PI_THINKING;
	const child = spawn(process.execPath, [serverPath], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
	const bridge = { port, root, child, log: "" };
	child.stderr.on("data", (chunk) => { bridge.log += chunk; });
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("The bridge did not start in time")), 15_000);
		child.stdout.on("data", (chunk) => {
			bridge.log += chunk;
			if (String(chunk).includes("listening")) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`The bridge exited early with code ${code}: ${bridge.log}`));
		});
	});
	bridge.close = async () => {
		child.kill("SIGKILL");
		await rm(root, { recursive: true, force: true });
	};
	return bridge;
}

export function send(bridge, chatId, text, { stream = false, signal } = {}) {
	return fetch(`http://127.0.0.1:${bridge.port}/v1/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}`, "x-librechat-user-id": USER, "x-librechat-conversation-id": chatId },
		body: JSON.stringify({ user: USER, stream, messages: [{ role: "user", content: text }] }),
		signal,
	});
}

export async function ask(bridge, chatId, text) {
	const response = await send(bridge, chatId, text);
	const body = await response.json();
	return { status: response.status, answer: body.choices?.[0]?.message?.content ?? "", error: body.error?.message };
}

export async function askStreaming(bridge, chatId, text) {
	const response = await send(bridge, chatId, text, { stream: true });
	let answer = "";
	for (const line of (await response.text()).split("\n")) {
		if (line.startsWith("data: ") && line !== "data: [DONE]") answer += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? "";
	}
	return { status: response.status, answer };
}

// Pi and its tool launcher, started by this bridge. Both carry the bridge's data folder and a run token in
// their settings. The bridge carries the same data folder but never a run token, so it isn't counted.
export function piProcesses(bridge) {
	const marker = `JUNIOR_SILVA_DATA_ROOT=${bridge.root}\0`;
	return readdirSync("/proc").filter((name) => /^\d+$/.test(name)).filter((pid) => {
		try {
			const environment = readFileSync(`/proc/${pid}/environ`, "utf8");
			const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0];
			return environment.includes(marker) && environment.includes("\0JS_RUN_TOKEN=") && state !== "Z";
		} catch {
			return false;
		}
	});
}

// One process's settings, as name/value pairs.
export function processSettings(pid) {
	return Object.fromEntries(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((entry) => {
		const split = entry.indexOf("=");
		return [entry.slice(0, split), entry.slice(split + 1)];
	}));
}
