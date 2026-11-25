import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { newestRequestedArtifact, requestedArtifactExtensions, requestedSlideCount } from "../core/artifact-delivery.mjs";
import { createChatFolders, runInChat } from "../core/chat-scope.mjs";
import { publishWorkspaceArtifact } from "../core/files.mjs";
import PptxGenJS from "pptxgenjs";

const run = promisify(execFile);

process.env.JUNIOR_SILVA_PUBLIC_URL ||= "https://example.test";
process.env.JUNIOR_SILVA_ARTIFACT_SECRET ||= "test-artifact-secret";
process.env.JUNIOR_SILVA_API_KEY ||= "test-junior-silva-key";
const { publishRecoveredArtifact } = await import("../server/openai.mjs");

const DOCX_REQUEST = "Create the document as a Word document";

async function newChat(t) {
	const scope = { userHash: randomBytes(16).toString("hex"), chatHash: randomBytes(16).toString("hex") };
	const folders = await createChatFolders(scope);
	t.after(() => rm(path.resolve(folders.root, "..", ".."), { recursive: true, force: true }));
	const requestWorkspace = path.join(folders.workspace, "requests", randomUUID());
	await mkdir(requestWorkspace, { recursive: true });
	return { chat: { ...scope, folders }, folders, requestWorkspace };
}

const scanIn = ({ chat, requestWorkspace }, instruction = DOCX_REQUEST, folder = requestWorkspace) => runInChat(chat, () => newestRequestedArtifact(folder, instruction));

async function makeDeck(filename, slides) {
	const deck = new PptxGenJS();
	for (let index = 1; index <= slides; index += 1) deck.addSlide().addText(`Slide ${index}`, { x: 0.6, y: 0.5, w: 9, h: 0.5 });
	await deck.writeFile({ fileName: filename });
}

test("detects requested user-facing artifact types without treating source files as deliverables", () => {
	assert.deepEqual([...requestedArtifactExtensions("Make a four-slide PowerPoint and include the Markdown source")].sort(), [".md", ".pptx"]);
	assert.deepEqual([...requestedArtifactExtensions("Explain the legal position in chat")], []);
	assert.equal(requestedSlideCount("Make a 4 slide PPTX"), 4);
});

test("only discovers the newest requested deliverable inside the active request workspace", async (t) => {
	const made = await newChat(t);
	const { requestWorkspace: workspace } = made;
	await mkdir(path.join(workspace, "slides"), { recursive: true });
	await writeFile(path.join(workspace, "notes.md"), "deck source");
	await writeFile(path.join(workspace, "slides", "final.pptx"), "deck");
	assert.equal(await scanIn(made, "Create a PowerPoint presentation"), path.join(workspace, "slides", "final.pptx"));
	assert.equal(await scanIn(made, "Create a PowerPoint presentation with Markdown source"), path.join(workspace, "slides", "final.pptx"));
	assert.equal(await scanIn(made, "Create an XLSX workbook"), undefined);
});

test("a request folder that's a shortcut out of the chat finds nothing", async (t) => {
	const victim = await newChat(t);
	const secretFolder = path.join(victim.folders.artifacts, "review-final-1");
	await mkdir(secretFolder, { recursive: true });
	await writeFile(path.join(secretFolder, "Reviewed_secret.docx"), "client text");

	const attacker = await newChat(t);
	await rm(attacker.requestWorkspace, { recursive: true });
	await symlink(secretFolder, attacker.requestWorkspace);
	assert.equal(await scanIn(attacker), undefined);

	await rm(attacker.requestWorkspace);
	await symlink("/etc", attacker.requestWorkspace);
	assert.equal(await scanIn(attacker, "Create a plain text .md file"), undefined);
});

test("a request folder in another chat's workspace finds nothing", async (t) => {
	const victim = await newChat(t);
	await writeFile(path.join(victim.requestWorkspace, "secret.docx"), "client text");
	const attacker = await newChat(t);
	assert.equal(await scanIn(attacker, DOCX_REQUEST, victim.requestWorkspace), undefined);
	assert.equal(await scanIn(attacker, DOCX_REQUEST, `${attacker.requestWorkspace}/../../../../../${path.basename(path.dirname(path.dirname(victim.folders.root)))}/chats/${path.basename(victim.folders.root)}/uploads`), undefined);
});

test("a missing request folder finds nothing", async (t) => {
	const made = await newChat(t);
	assert.equal(await scanIn(made, DOCX_REQUEST, path.join(made.requestWorkspace, "no-such-folder")), undefined);
});

test("shortcuts and FIFOs named like a deliverable are ignored", async (t) => {
	const victim = await newChat(t);
	const secret = path.join(victim.folders.uploads, "secret.docx");
	await writeFile(secret, "client text");
	const made = await newChat(t);
	await symlink(secret, path.join(made.requestWorkspace, "shortcut.docx"));
	await symlink(victim.folders.uploads, path.join(made.requestWorkspace, "folder-shortcut"));
	await run("mkfifo", [path.join(made.requestWorkspace, "never-ending.docx")]);
	const started = Date.now();
	assert.equal(await scanIn(made), undefined);
	assert.ok(Date.now() - started < 3000, "the scan waited on the FIFO");

	const real = path.join(made.requestWorkspace, "real.docx");
	await writeFile(real, "my draft");
	assert.equal(await scanIn(made), real, "a real file beside them is still found");
});

test("an empty file isn't a deliverable", async (t) => {
	const made = await newChat(t);
	await writeFile(path.join(made.requestWorkspace, "empty.docx"), "");
	assert.equal(await scanIn(made), undefined);
});

test("the scan stops at 5,000 entries and finds nothing", async (t) => {
	const made = await newChat(t);
	const best = path.join(made.requestWorkspace, "final.docx");
	await writeFile(best, "my draft");
	for (let start = 0; start < 4999; start += 500) {
		await Promise.all(Array.from({ length: Math.min(500, 4999 - start) }, (_, offset) => writeFile(path.join(made.requestWorkspace, `filler-${start + offset}.tmp`), "")));
	}
	assert.equal(await scanIn(made), best, "exactly 5,000 entries still works");
	await writeFile(path.join(made.requestWorkspace, "one-too-many.tmp"), "");
	assert.equal(await scanIn(made), undefined);
});

test("the scan stops at 12 levels and finds nothing", async (t) => {
	const made = await newChat(t);
	const levels = (count) => path.join(made.requestWorkspace, ...Array.from({ length: count }, () => "level"));
	await mkdir(levels(12), { recursive: true });
	const deepest = path.join(levels(12), "final.docx");
	await writeFile(deepest, "my draft");
	assert.equal(await scanIn(made), deepest, "12 levels still works");
	await mkdir(levels(13));
	assert.equal(await scanIn(made), undefined);
});

test("with no chat, the scan is an error", async () => {
	await assert.rejects(newestRequestedArtifact("/tmp", DOCX_REQUEST), /can only run for a chat/);
});

test("a validated request-local presentation publishes a protected download and trusted preview", async (t) => {
	const { chat, requestWorkspace } = await newChat(t);
	const filename = path.join(requestWorkspace, "legal-due-diligence.pptx");
	await makeDeck(filename, 4);
	const publication = await runInChat(chat, () => publishWorkspaceArtifact(filename));
	assert.match(publication.artifact.download_url, /^https?:\/\//);
	assert.match(publication.artifact_markup, /slide-gallery/);
});

test("recovery publishes a good file with its link and preview", async (t) => {
	const { chat, folders, requestWorkspace } = await newChat(t);
	const filename = path.join(requestWorkspace, "deck.pptx");
	await makeDeck(filename, 4);
	const publication = await runInChat(chat, () => publishRecoveredArtifact(filename, "Make a 4 slide PPTX"));
	assert.match(publication.artifact.download_url, /^https?:\/\//);
	assert.ok(publication.artifact.local_path.startsWith(`${folders.artifacts}${path.sep}`));
	assert.match(publication.artifact_markup, /slide-gallery/);
});

test("recovery refuses a deck with the wrong slide count and leaves no copy", async (t) => {
	const { chat, folders, requestWorkspace } = await newChat(t);
	const filename = path.join(requestWorkspace, "deck.pptx");
	await makeDeck(filename, 4);
	assert.equal(await runInChat(chat, () => publishRecoveredArtifact(filename, "Make a 3 slide PPTX")), undefined);
	assert.deepEqual(await readdir(folders.artifacts), []);
});

test("recovery returns nothing instead of failing the request", async (t) => {
	t.mock.method(console, "warn", () => {});
	const victim = await newChat(t);
	const secret = path.join(victim.folders.uploads, "secret.md");
	await writeFile(secret, "client text");
	const { chat, folders, requestWorkspace } = await newChat(t);
	const shortcut = path.join(requestWorkspace, "shortcut.md");
	await symlink(secret, shortcut);
	const upload = path.join(folders.uploads, "upload.md");
	await writeFile(upload, "# Upload\n");
	const unsupported = path.join(requestWorkspace, "script.sh");
	await writeFile(unsupported, "echo hi\n");
	for (const file of [shortcut, upload, secret, unsupported, path.join(requestWorkspace, "missing.md")]) {
		assert.equal(await runInChat(chat, () => publishRecoveredArtifact(file, "Write a markdown note")), undefined, file);
	}
	assert.deepEqual(await readdir(folders.artifacts).then((names) => names.filter((name) => name.startsWith("artifact-"))), [], "nothing was published");
	assert.equal(await readFile(secret, "utf8"), "client text");
});
