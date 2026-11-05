import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

process.env.JUNIOR_SILVA_API_KEY ||= "test-junior-silva-key";

const { serveArtifact } = await import("../server/openai.mjs");

const serverPath = fileURLToPath(new URL("../server/openai.mjs", import.meta.url));

function fakeResponse() {
	return {
		status: 0,
		body: "",
		writeHead(status) { this.status = status; },
		end(body) { this.body = String(body); },
	};
}

test("a malformed percent-encoded artifact path returns 404 instead of throwing", async () => {
	const res = fakeResponse();
	await serveArtifact(res, "/files/%ff/a/b");
	assert.equal(res.status, 404);
});

test("an artifact path with a bad signature returns 404", async () => {
	const res = fakeResponse();
	await serveArtifact(res, "/files/not-a-signature/operation/name.docx");
	assert.equal(res.status, 404);
});

test("a malformed artifact path does not stop the running server", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "junior-silva-files-route-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const port = 20000 + Math.floor(Math.random() * 20000);
	const child = spawn(process.execPath, [serverPath], {
		env: {
			...process.env,
			JUNIOR_SILVA_API_KEY: "test-junior-silva-key",
			JS_IDENTITY_SECRET: "test-identity-secret",
			JUNIOR_SILVA_BIND_HOST: "127.0.0.1",
			JUNIOR_SILVA_PORT: String(port),
			JUNIOR_SILVA_DATA_ROOT: root,
			JUNIOR_SILVA_ARTIFACT_ROOT: path.join(root, "artifacts"),
			JUNIOR_SILVA_UPLOAD_ROOT: path.join(root, "uploads"),
			JUNIOR_SILVA_WORKSPACE_ROOT: path.join(root, "workspace"),
			PI_CODING_AGENT_DIR: path.join(root, "pi-agent"),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(() => child.kill("SIGKILL"));
	let exited = false;
	child.on("exit", () => { exited = true; });
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("The server did not start in time")), 15_000);
		child.stdout.on("data", (chunk) => {
			if (String(chunk).includes("listening")) { clearTimeout(timer); resolve(); }
		});
		child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`The server exited early with code ${code}`)); });
	});

	const bad = await fetch(`http://127.0.0.1:${port}/files/%ff/a/b`);
	assert.equal(bad.status, 404);

	const health = await fetch(`http://127.0.0.1:${port}/health`);
	assert.equal(health.status, 200);
	assert.equal(exited, false);
});
