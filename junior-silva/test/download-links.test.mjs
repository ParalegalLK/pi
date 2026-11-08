import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const dataRoot = await mkdtemp(path.join(os.tmpdir(), "junior-silva-download-links-"));
const SECRET = "test-artifact-secret";
process.env.JUNIOR_SILVA_DATA_ROOT = dataRoot;
process.env.JUNIOR_SILVA_ARTIFACT_ROOT = path.join(dataRoot, "artifacts");
process.env.JUNIOR_SILVA_PUBLIC_URL = "https://example.test";
process.env.JUNIOR_SILVA_ARTIFACT_SECRET = SECRET;
process.env.JUNIOR_SILVA_API_KEY ||= "test-junior-silva-key";
delete process.env.JS_LINK_TTL_HOURS;
delete process.env.JS_NATIVE_DEV;

const { createChatFolders, runInChat } = await import("../core/chat-scope.mjs");
const { describeArtifact, operationDirectory } = await import("../core/files.mjs");
const { serveArtifact } = await import("../server/openai.mjs");

test.after(() => rm(dataRoot, { recursive: true, force: true }));

const serverPath = fileURLToPath(new URL("../server/openai.mjs", import.meta.url));
const scopeA = { userHash: "a".repeat(32), chatHash: "c".repeat(32) };
const scopeB = { userHash: "b".repeat(32), chatHash: "d".repeat(32) };
const chatA = { ...scopeA, folders: await createChatFolders(scopeA) };
const chatB = { ...scopeB, folders: await createChatFolders(scopeB) };
const HOUR = 3600;

function withEnv(t, name, value) {
	const before = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	t.after(() => {
		if (before === undefined) delete process.env[name];
		else process.env[name] = before;
	});
}

async function publish(chat, name = "note.md", content = "# Test note\n") {
	return runInChat(chat, async () => {
		const operation = await operationDirectory("artifact");
		const file = path.join(operation.directory, name);
		await writeFile(file, content);
		return { file, operation, artifact: describeArtifact(file, operation.id) };
	});
}

// Follows a link through the real route function.
async function follow(link) {
	const url = new URL(link);
	const res = {
		status: 0,
		headers: {},
		body: "",
		writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
		end(body) { this.body = String(body ?? ""); },
	};
	await serveArtifact(res, url.pathname, url.searchParams.get("exp"));
	return res;
}

// Parts of a link path: ["files", signature, userHash, chatHash, operation, name].
function changePart(link, index, value) {
	const url = new URL(link);
	const parts = url.pathname.split("/").filter(Boolean);
	parts[index] = value;
	url.pathname = `/${parts.join("/")}`;
	return url.href;
}

function withExpiry(link, value) {
	const url = new URL(link);
	if (value === undefined) url.searchParams.delete("exp");
	else url.searchParams.set("exp", value);
	return url.href;
}

const expiryOf = (link) => Number(new URL(link).searchParams.get("exp"));
const flip = (text) => `${text.slice(0, -1)}${text.endsWith("0") ? "1" : "0"}`;

test("a good link returns the file with safe headers", async () => {
	const { artifact } = await publish(chatA, "note.md", "# The note\n");
	assert.match(artifact.download_url, new RegExp(`^https://example\\.test/files/[a-f0-9]{64}/${scopeA.userHash}/${scopeA.chatHash}/artifact-[-a-f0-9]+/note\\.md\\?exp=\\d+$`));
	const res = await follow(artifact.download_url);
	assert.equal(res.status, 200);
	assert.equal(res.body, "# The note\n");
	assert.equal(res.headers["Cache-Control"], "private, no-store");
	assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
	assert.match(res.headers["Content-Disposition"], /^attachment; filename="note\.md"$/);
});

test("changing any part of a link breaks it", async () => {
	const first = await publish(chatA, "note.md");
	const other = await publish(chatA, "other.md");
	const link = first.artifact.download_url;
	const signature = new URL(link).pathname.split("/")[2];
	const changed = {
		signature: changePart(link, 1, flip(signature)),
		"short signature": changePart(link, 1, signature.slice(0, 20)),
		"user hash": changePart(link, 2, scopeB.userHash),
		"chat hash": changePart(link, 3, scopeB.chatHash),
		operation: changePart(link, 4, other.operation.id),
		name: changePart(link, 5, "other.md"),
		"later expiry": withExpiry(link, String(expiryOf(link) + HOUR)),
		"earlier expiry": withExpiry(link, String(expiryOf(link) - HOUR)),
	};
	for (const [what, tampered] of Object.entries(changed)) assert.equal((await follow(tampered)).status, 404, what);
	assert.equal((await follow(link)).status, 200, "the real link still works");
});

test("a link from one chat can't open another chat's file", async () => {
	const inB = await publish(chatB, "note.md", "B's note");
	const fromA = await publish(chatA, "note.md", "A's note");
	const swapped = changePart(changePart(changePart(fromA.artifact.download_url, 2, scopeB.userHash), 3, scopeB.chatHash), 4, inB.operation.id);
	assert.equal((await follow(swapped)).status, 404);
});

test("a link can't move to another chat, even with the same operation and file name", async () => {
	const { operation, artifact } = await publish(chatA, "same-name.md", "A's note");
	const sameInB = path.join(chatB.folders.artifacts, operation.id);
	await mkdir(sameInB, { recursive: true });
	await writeFile(path.join(sameInB, "same-name.md"), "B's note");
	const link = artifact.download_url;
	assert.equal((await follow(changePart(changePart(link, 2, scopeB.userHash), 3, scopeB.chatHash))).status, 404);
	const sameUserOtherChat = await createChatFolders({ userHash: scopeA.userHash, chatHash: scopeB.chatHash });
	await mkdir(path.join(sameUserOtherChat.artifacts, operation.id), { recursive: true });
	await writeFile(path.join(sameUserOtherChat.artifacts, operation.id, "same-name.md"), "A's other chat");
	assert.equal((await follow(changePart(link, 3, scopeB.chatHash))).status, 404);
	const res = await follow(link);
	assert.equal(res.status, 200);
	assert.equal(res.body, "A's note");
});

test("the old link format no longer works", async () => {
	const { operation } = await publish(chatA);
	assert.equal((await follow(`https://example.test/files/${"a".repeat(64)}/${operation.id}/note.md`)).status, 404);
});

test("bad input gets a 404", async () => {
	const { artifact } = await publish(chatA);
	const link = artifact.download_url;
	for (const expiry of [undefined, "", "abc", "1e12", "-5", "12.5", `${expiryOf(link)} `]) {
		assert.equal((await follow(withExpiry(link, expiry))).status, 404, `expiry ${expiry}`);
	}
	for (const [index, value] of [[2, "abc"], [3, "abc"], [2, "A".repeat(32)], [4, "not_valid!"], [5, "%2e%2e"], [5, "..%2F..%2Fsecret.md"], [1, "%ff"], [5, "%ff"]]) {
		const url = new URL(link);
		const parts = url.pathname.split("/").filter(Boolean);
		parts[index] = value;
		const res = await follow(`https://example.test/${parts.join("/")}${url.search}`);
		assert.equal(res.status, 404, `part ${index}: ${value}`);
	}
});

test("an expired link gets a 410, and only with a valid signature", async (t) => {
	withEnv(t, "JS_LINK_TTL_HOURS", "0.0001");
	const { artifact } = await publish(chatA);
	const link = artifact.download_url;
	await delay(1200);
	const res = await follow(link);
	assert.equal(res.status, 410);
	assert.match(res.body, /expired/);
	assert.equal((await follow(changePart(link, 1, flip(new URL(link).pathname.split("/")[2])))).status, 404, "a made-up link learns nothing");
	assert.equal((await follow(withExpiry(link, String(expiryOf(link) + 10 * HOUR)))).status, 404, "an expired link can't be extended");
});

test("a shortcut, FIFO or folder planted in the artifacts isn't served", async () => {
	const secret = path.join(chatA.folders.uploads, "contract.md");
	await writeFile(secret, "CLIENT-SECRET");
	const { file, artifact } = await publish(chatB, "planted.md");
	assert.equal((await follow(artifact.download_url)).status, 200);

	await unlink(file);
	await symlink(secret, file);
	const shortcut = await follow(artifact.download_url);
	assert.equal(shortcut.status, 404);
	assert.doesNotMatch(shortcut.body, /CLIENT-SECRET/);

	await unlink(file);
	await run("mkfifo", [file]);
	const started = Date.now();
	assert.equal((await follow(artifact.download_url)).status, 404);
	assert.ok(Date.now() - started < 3000, "the route waited on the FIFO");

	await unlink(file);
	await mkdir(file);
	assert.equal((await follow(artifact.download_url)).status, 404);
});

test("a missing file gets a 404", async () => {
	const { file, artifact } = await publish(chatA, "removed.md");
	await unlink(file);
	assert.equal((await follow(artifact.download_url)).status, 404);
});

test("links last 7 days by default, and the setting changes that", async (t) => {
	const near = (link, hours) => assert.ok(Math.abs(expiryOf(link) - (Date.now() / 1000 + hours * HOUR)) < 5, `${hours} hours`);
	near((await publish(chatA)).artifact.download_url, 168);
	withEnv(t, "JS_LINK_TTL_HOURS", "24");
	near((await publish(chatA)).artifact.download_url, 24);
	for (const invalid of ["abc", "0", "-5", "Infinity"]) {
		process.env.JS_LINK_TTL_HOURS = invalid;
		near((await publish(chatA)).artifact.download_url, 168);
	}
});

test("signing needs the artifact secret, and the API key is never used instead", async (t) => {
	const { artifact, file, operation } = await publish(chatA);
	withEnv(t, "JUNIOR_SILVA_ARTIFACT_SECRET", "");
	withEnv(t, "JUNIOR_SILVA_API_KEY", "an-api-key");
	assert.throws(() => runInChat(chatA, () => describeArtifact(file, operation.id)), /JUNIOR_SILVA_ARTIFACT_SECRET is not configured/);
	process.env.JUNIOR_SILVA_ARTIFACT_SECRET = "an-api-key";
	assert.equal((await follow(artifact.download_url)).status, 404, "a link signed with another secret fails");
});

test("with no public address there's no link and no signing", async (t) => {
	withEnv(t, "JUNIOR_SILVA_PUBLIC_URL", undefined);
	withEnv(t, "JUNIOR_SILVA_ARTIFACT_SECRET", "");
	const { artifact, file } = await publish(chatA);
	assert.equal(artifact.download_url, undefined);
	assert.equal(artifact.local_path, file);
});

test("the native CLI gets a local path and no link", async (t) => {
	withEnv(t, "JS_NATIVE_DEV", "1");
	const operation = await operationDirectory("artifact");
	assert.ok(operation.directory.startsWith(path.join(dataRoot, "artifacts")), "native output stays in the shared folder");
	const file = path.join(operation.directory, "note.md");
	await writeFile(file, "# Note\n");
	const artifact = describeArtifact(file, operation.id);
	assert.equal(artifact.local_path, file);
	assert.equal(artifact.download_url, undefined);
});

test("tools can't create output with no chat", async () => {
	await assert.rejects(operationDirectory("artifact"), /can only run for a chat/);
});

test("a file outside its operation folder is refused", async () => {
	const { operation } = await publish(chatA);
	assert.throws(() => runInChat(chatA, () => describeArtifact(path.join(chatA.folders.uploads, "contract.md"), operation.id)), /outside its operation directory/);
});

async function startServer(t, overrides = {}) {
	const port = 20000 + Math.floor(Math.random() * 20000);
	const child = spawn(process.execPath, [serverPath], {
		env: {
			...process.env,
			JUNIOR_SILVA_API_KEY: "test-junior-silva-key",
			JS_IDENTITY_SECRET: "test-identity-secret",
			JUNIOR_SILVA_ARTIFACT_SECRET: SECRET,
			JUNIOR_SILVA_BIND_HOST: "127.0.0.1",
			JUNIOR_SILVA_PORT: String(port),
			PI_PROVIDER: "anthropic",
			PI_MODEL: "claude-sonnet-5-5",
			ANTHROPIC_API_KEY: "test-anthropic-key",
			JUNIOR_SILVA_DATA_ROOT: dataRoot,
			JUNIOR_SILVA_ARTIFACT_ROOT: path.join(dataRoot, "artifacts"),
			PI_CODING_AGENT_DIR: path.join(dataRoot, "pi-agent"),
			...overrides,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(() => child.kill("SIGKILL"));
	return { child, port };
}

test("the running server follows the same rules", async (t) => {
	const { child, port } = await startServer(t);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("The server did not start in time")), 15_000);
		child.stdout.on("data", (chunk) => {
			if (String(chunk).includes("listening")) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`The server exited early with code ${code}`));
		});
	});
	const { artifact } = await publish(chatA, "served.md", "# Served\n");
	const local = (link) => link.replace("https://example.test", `http://127.0.0.1:${port}`);
	const good = await fetch(local(artifact.download_url));
	assert.equal(good.status, 200);
	assert.equal(await good.text(), "# Served\n");
	assert.equal((await fetch(local(changePart(artifact.download_url, 3, scopeB.chatHash)))).status, 404);
	assert.equal((await fetch(local(withExpiry(artifact.download_url, undefined)))).status, 404);
	assert.equal((await fetch(`http://127.0.0.1:${port}/files/%ff/a/b`)).status, 404);
	assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
});

test("the bridge refuses to start without the artifact secret", async (t) => {
	const { child } = await startServer(t, { JUNIOR_SILVA_ARTIFACT_SECRET: "" });
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const code = await new Promise((resolve) => child.on("exit", resolve));
	assert.notEqual(code, 0);
	assert.match(stderr, /JUNIOR_SILVA_ARTIFACT_SECRET is not configured/);
});
