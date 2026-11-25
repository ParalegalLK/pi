import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const dataRoot = await mkdtemp(path.join(os.tmpdir(), "junior-silva-file-guard-"));
const artifactsRoot = path.join(dataRoot, "artifacts");
process.env.JUNIOR_SILVA_DATA_ROOT = dataRoot;
process.env.JUNIOR_SILVA_ARTIFACT_ROOT = artifactsRoot;
process.env.JUNIOR_SILVA_PUBLIC_URL = "https://example.test";
process.env.JUNIOR_SILVA_ARTIFACT_SECRET = "test-artifact-secret";
delete process.env.JS_NATIVE_DEV;

const { createChatFolders, readChatFile, readChatText, runInChat, updateChatFile } = await import("../core/chat-scope.mjs");
const { extractDocumentText } = await import("../core/document-text.mjs");
const { dispatchMcpRequest } = await import("../mcp/server.mjs");

test.after(() => rm(dataRoot, { recursive: true, force: true }));

const NOT_FOUND = "File not found in this chat.";
const SECRET = "CLIENT-A-SECRET the agreement reference number is 4711";
const scopeA = { userHash: "a".repeat(32), chatHash: "c".repeat(32) };
const scopeB = { userHash: "b".repeat(32), chatHash: "d".repeat(32) };
const chatA = { ...scopeA, folders: await createChatFolders(scopeA) };
const chatB = { ...scopeB, folders: await createChatFolders(scopeB) };
const secretFile = path.join(chatA.folders.uploads, "contract.md");
const secretJson = path.join(chatA.folders.uploads, "secret.json");
const secretReviewFolder = path.join(chatA.folders.artifacts, "review-preparation-1");
const secretContext = path.join(secretReviewFolder, "review-context.json");
const secretReviewText = path.join(secretReviewFolder, "review-target-1-source.md");
await mkdir(secretReviewFolder, { recursive: true });
await writeFile(secretFile, SECRET);
await writeFile(secretJson, JSON.stringify({ secret: SECRET }));
await writeFile(secretReviewText, SECRET);
await writeFile(secretContext, JSON.stringify({ checkpoint: { required: false }, targets: [{ id: "a", filename: "a.md", file: secretFile, source_text_file: secretReviewText, clauses: [] }], secret: SECRET }));

const asB = (task) => runInChat(chatB, task);
const inWorkspace = (name) => path.join(chatB.folders.workspace, name);
const refusedByGuard = (task) => assert.rejects(asB(task), { message: NOT_FOUND });
const quiet = (t) => t.mock.method(console, "warn", () => {});

async function callTool(name, args) {
	const reply = await asB(() => dispatchMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }));
	return reply.result;
}

async function assertToolRefused(name, args) {
	const result = await callTool(name, args);
	assert.equal(result.isError, true, name);
	assert.equal(result.content[0].text, NOT_FOUND, name);
}

async function toolOutput(name, args) {
	const result = await callTool(name, args);
	assert.ok(!result.isError, `${name}: ${result.content?.[0]?.text}`);
	return result.structuredContent;
}

test("a chat reads its own uploads, workspace and artifacts", async () => {
	const upload = path.join(chatB.folders.uploads, "mine.md");
	const work = inWorkspace("mine.md");
	const artifact = path.join(chatB.folders.artifacts, "mine.md");
	await Promise.all([writeFile(upload, "upload"), writeFile(work, "work"), writeFile(artifact, "artifact")]);
	await asB(async () => {
		assert.equal(await readChatText(upload), "upload");
		assert.equal(await readChatText(work), "work");
		assert.equal(await readChatText(artifact), "artifact");
		const file = await readChatFile(upload);
		assert.equal(file.name, "mine.md");
		assert.equal(file.absolute, upload);
		assert.ok(Buffer.isBuffer(file.bytes));
	});
});

test("a shortcut inside the chat works, and an empty file reads as empty", async () => {
	const target = inWorkspace("target.md");
	const shortcut = inWorkspace("shortcut.md");
	const empty = inWorkspace("empty.md");
	await writeFile(target, "own text");
	await symlink(target, shortcut);
	await writeFile(empty, "");
	await asB(async () => {
		assert.equal(await readChatText(shortcut), "own text");
		assert.equal(await readChatText(empty), "");
	});
});

test("the other chat's file, a missing file and sessions all give the same message", async (t) => {
	quiet(t);
	const session = path.join(chatB.folders.sessions, "session.jsonl");
	await writeFile(session, "history");
	for (const file of [secretFile, inWorkspace("no-such-file.md"), path.join(chatA.folders.uploads, "no-such-file.md"), session, "/etc/passwd", "", undefined]) {
		await refusedByGuard(() => readChatFile(file));
	}
});

test("a path using .. can't leave the chat", async (t) => {
	quiet(t);
	const escape = `${chatB.folders.workspace}/../../../../${scopeA.userHash}/chats/${scopeA.chatHash}/uploads/contract.md`;
	await refusedByGuard(() => readChatFile(escape));
	await refusedByGuard(() => readChatFile(`${chatB.folders.workspace}/../sessions/session.jsonl`));
});

test("shortcuts leading out of the chat are refused", async (t) => {
	quiet(t);
	const toFile = inWorkspace("to-secret.md");
	const toSystem = inWorkspace("to-system.md");
	const toFolder = inWorkspace("to-folder");
	await symlink(secretFile, toFile);
	await symlink("/etc/passwd", toSystem);
	await symlink(chatA.folders.uploads, toFolder);
	await refusedByGuard(() => readChatFile(toFile));
	await refusedByGuard(() => readChatFile(toSystem));
	await refusedByGuard(() => readChatFile(path.join(toFolder, "contract.md")));
});

test("a folder is refused", async (t) => {
	quiet(t);
	await refusedByGuard(() => readChatFile(chatB.folders.workspace));
});

test("a FIFO is refused quickly instead of hanging", async (t) => {
	quiet(t);
	const fifo = inWorkspace("never-ending.md");
	await run("mkfifo", [fifo]);
	const started = Date.now();
	await refusedByGuard(() => readChatFile(fifo));
	await asB(() => assert.rejects(updateChatFile(fifo, (text) => text, { only: ["workspace"] }), { message: NOT_FOUND }));
	assert.ok(Date.now() - started < 3000, "the guard waited on the FIFO");
});

test("with no chat, reading is an error", async () => {
	await assert.rejects(readChatFile(inWorkspace("target.md")), /can only run for a chat/);
});

test("a huge file gets a size message in this chat, and not found in another chat", async (t) => {
	quiet(t);
	const own = inWorkspace("huge.md");
	const other = path.join(chatA.folders.uploads, "huge.md");
	for (const file of [own, other]) {
		await writeFile(file, "");
		await truncate(file, 51 * 1024 * 1024);
	}
	await asB(() => assert.rejects(readChatFile(own), /huge\.md exceeds the 50 MB input limit/));
	await refusedByGuard(() => readChatFile(other));
});

test("swapping a file for a shortcut never reveals the target", async (t) => {
	quiet(t);
	const target = inWorkspace("swapping.md");
	const nextFile = inWorkspace("swap-file.tmp");
	const nextLink = inWorkspace("swap-link.tmp");
	await writeFile(target, "harmless");
	let swapping = true;
	const swapper = (async () => {
		while (swapping) {
			await symlink(secretFile, nextLink);
			await rename(nextLink, target);
			await writeFile(nextFile, "harmless");
			await rename(nextFile, target);
		}
	})();
	let reads = 0;
	let refusals = 0;
	await asB(async () => {
		for (let round = 0; round < 400; round += 1) {
			try {
				assert.equal(await readChatText(target), "harmless");
				reads += 1;
			} catch (caught) {
				assert.equal(caught.message, NOT_FOUND);
				refusals += 1;
			}
		}
	});
	swapping = false;
	await swapper;
	assert.equal(reads + refusals, 400);
});

test("a refusal is logged with the chat and reason, but never the path", async (t) => {
	const warn = t.mock.method(console, "warn", () => {});
	await refusedByGuard(() => readChatFile(secretFile));
	const line = warn.mock.calls.at(-1).arguments[0];
	assert.match(line, new RegExp(scopeB.chatHash));
	assert.match(line, /outside its folders/);
	assert.doesNotMatch(line, /contract|uploads/);
});

test("an update rewrites this chat's file through the guard", async (t) => {
	quiet(t);
	const artifact = path.join(chatB.folders.artifacts, "context.json");
	await writeFile(artifact, JSON.stringify({ text: "a long original value that is much longer than the update" }));
	await asB(() => updateChatFile(artifact, () => "{}", { only: ["artifacts"] }));
	assert.equal(await readFile(artifact, "utf8"), "{}");

	const upload = path.join(chatB.folders.uploads, "uploaded.json");
	await writeFile(upload, "{}");
	const shortcut = inWorkspace("update-shortcut.json");
	await symlink(secretJson, shortcut);
	const before = await readFile(secretJson, "utf8");
	await asB(async () => {
		await assert.rejects(updateChatFile(upload, () => "changed", { only: ["artifacts"] }), { message: NOT_FOUND });
		await assert.rejects(updateChatFile(secretJson, () => "changed"), { message: NOT_FOUND });
		await assert.rejects(updateChatFile(shortcut, () => "changed"), { message: NOT_FOUND });
	});
	assert.equal(await readFile(upload, "utf8"), "{}");
	assert.equal(await readFile(secretJson, "utf8"), before);
});

test("no tool gives User B a file from User A's chat", async (t) => {
	quiet(t);
	const before = await readFile(secretJson, "utf8");
	await assertToolRefused("legal_validate_draft", { file_path: secretFile });
	await assertToolRefused("rag_chat_research", { question: "What is the reference?", delivery_mode: "direct_answer", context_files: [secretFile] });
	await assertToolRefused("translator_siriwardena_translate_document", { file_path: secretFile, target_language: "Sinhala" });
	await assertToolRefused("librechat_prepare_document_preview", { file_path: secretFile });
	await assertToolRefused("review_prepare_document_set", { file_path: secretFile });
	await assertToolRefused("review_record_checkpoint_outcome", { review_context_file: secretJson, outcome: "skip" });
	await assertToolRefused("review_finalize_document", { review_context_file: secretJson, findings: [{ anchor_text: "agreement reference number" }] });
	await assertToolRefused("workbench_publish_artifact", { file_path: secretFile });
	assert.equal(await readFile(secretJson, "utf8"), before);
});

test("User B can't reach User A's artifacts or review files", async (t) => {
	quiet(t);
	const before = await readFile(secretContext, "utf8");
	await refusedByGuard(() => readChatFile(secretContext));
	await refusedByGuard(() => readChatFile(secretReviewText));
	await asB(() => assert.rejects(updateChatFile(secretContext, () => "changed", { only: ["artifacts"] }), { message: NOT_FOUND }));
	const findings = [{ clause_number: "1", anchor_text: "the agreement reference number is 4711", category: "commercial", title: "Test" }];
	await assertToolRefused("review_finalize_document", { findings, review_context_file: secretContext });
	await assertToolRefused("review_record_checkpoint_outcome", { review_context_file: secretContext, outcome: "skip" });
	await assertToolRefused("legal_validate_draft", { file_path: secretReviewText });
	await assertToolRefused("librechat_prepare_document_preview", { file_path: secretReviewText });
	await assertToolRefused("workbench_publish_artifact", { file_path: secretReviewText });
	assert.equal(await readFile(secretContext, "utf8"), before);
	await runInChat(chatA, async () => assert.equal(await readChatText(secretReviewText), SECRET));
});

test("the old shared artifacts folder is no longer readable", async (t) => {
	quiet(t);
	await mkdir(artifactsRoot, { recursive: true });
	const oldFile = path.join(artifactsRoot, "old-file.md");
	await writeFile(oldFile, "old shared file");
	await refusedByGuard(() => readChatFile(oldFile));
});

test("a forged review context can't reach another chat's files", async (t) => {
	quiet(t);
	const findings = [{ clause_number: "1", anchor_text: "The Supplier assigns all existing tools to the Client.", category: "commercial", title: "Tools" }];
	const ownText = inWorkspace("forged-source.txt");
	await writeFile(ownText, "1 The Supplier assigns all existing tools to the Client.\n");
	const forge = async (name, target) => {
		const file = path.join(chatB.folders.artifacts, name);
		await writeFile(file, JSON.stringify({ checkpoint: { required: false }, targets: [{ id: "../../escape", filename: "forged.txt", clauses: [], ...target }] }));
		return file;
	};
	await assertToolRefused("review_finalize_document", { findings, review_context_file: await forge("forged-text.json", { file: ownText, source_text_file: secretFile }) });
	await assertToolRefused("review_finalize_document", { findings, review_context_file: await forge("forged-file.json", { file: secretFile, source_text_file: ownText }) });

	const inPiFolder = inWorkspace("forged-context.json");
	await writeFile(inPiFolder, JSON.stringify({ checkpoint: { required: false }, targets: [] }));
	await assertToolRefused("review_finalize_document", { findings, review_context_file: inPiFolder });
	await assertToolRefused("review_record_checkpoint_outcome", { review_context_file: inPiFolder, outcome: "skip" });
});

test("tools still work on this chat's own files", async () => {
	const draft = inWorkspace("draft.md");
	await writeFile(draft, "# Notice\nDate: [FILL]\n");
	const checked = await toolOutput("legal_validate_draft", { file_path: draft });
	assert.deepEqual(checked.flags, [{ type: "placeholder", marker: "[FILL]", count: 1 }]);

	const preview = await toolOutput("librechat_prepare_document_preview", { file_path: draft });
	assert.match(preview.artifact_markup, /^:::artifact/);
	assert.deepEqual(await readdir(path.join(chatB.folders.artifacts, preview.operation_id)), ["preview-manifest.json"], "the preview copy must be removed");

	const published = await toolOutput("workbench_publish_artifact", { file_path: draft });
	assert.ok(published.artifact.download_url.startsWith(`https://example.test/files/`));
	assert.ok(published.artifact.download_url.includes(`/${scopeB.userHash}/${scopeB.chatHash}/`), "the link names this chat");
	assert.ok(published.artifact.local_path.startsWith(`${chatB.folders.artifacts}${path.sep}`), "the file is in this chat's artifacts");
	assert.equal(await readFile(published.artifact.local_path, "utf8"), await readFile(draft, "utf8"));
});

test("publishing refuses this chat's uploads", async (t) => {
	quiet(t);
	const upload = path.join(chatB.folders.uploads, "uploaded.md");
	await writeFile(upload, "# Uploaded\n");
	await assertToolRefused("workbench_publish_artifact", { file_path: upload });
});

test("a full review works on this chat's own upload, and leaves no copies behind", async () => {
	const agreement = path.join(chatB.folders.uploads, "agreement.txt");
	await writeFile(agreement, "6.1 Ownership\nThe Supplier assigns all existing tools to the Client.\n");
	const prepared = await toolOutput("review_prepare_document_set", { file_path: agreement, user_context: "Protect the Supplier." });
	const checkpoint = await toolOutput("review_record_checkpoint_outcome", { review_context_file: prepared.review_context_file, outcome: "skip", user_response: "skip" });
	assert.equal(checkpoint.checkpoint.status, "completed");
	const result = await toolOutput("review_finalize_document", {
		review_context_file: prepared.review_context_file,
		perspective: "Supplier",
		findings: [{ clause_number: "6.1", anchor_text: "The Supplier assigns all existing tools to the Client.", category: "commercial", title: "Background IP", explanation: "It captures existing tools.", recommendation: "Carve them out." }],
	});
	assert.equal(result.completion, "review-artifacts-ready");
	assert.ok((await readFile(result.reviewed_docx.local_path)).subarray(0, 2).equals(Buffer.from("PK")));
	assert.ok(result.reviewed_docx.download_url.includes(`/${scopeB.userHash}/${scopeB.chatHash}/`));
	assert.ok(prepared.review_context_file.startsWith(`${chatB.folders.artifacts}${path.sep}`), "review files stay in this chat's artifacts");
	const left = await readdir(path.join(chatB.folders.artifacts, result.operation_id));
	assert.deepEqual(left.filter((name) => name.startsWith("source-")), [], "the renderer's copies must be removed");
});

test("text can be read from an image through standard input", async (t) => {
	const tools = await Promise.all(["tesseract", "pandoc", "soffice", "pdftoppm"].map((tool) => run("sh", ["-c", `command -v ${tool}`]).then(() => true, () => false)));
	if (tools.includes(false)) return t.skip("the OCR tools aren't installed here");
	const directory = await mkdtemp(path.join(os.tmpdir(), "junior-silva-ocr-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const markdown = path.join(directory, "page.md");
	await writeFile(markdown, "# Test\n\nHello world paragraph.\n");
	await run("pandoc", [markdown, "-o", path.join(directory, "page.docx")]);
	await run("soffice", ["--headless", "--convert-to", "pdf", "--outdir", directory, path.join(directory, "page.docx")], { env: { ...process.env, HOME: directory } });
	await run("pdftoppm", ["-png", "-r", "80", "-singlefile", path.join(directory, "page.pdf"), path.join(directory, "page")]);
	const image = inWorkspace("page.png");
	await writeFile(image, await readFile(path.join(directory, "page.png")));
	const text = await asB(() => extractDocumentText(image));
	assert.match(text, /Hello world paragraph/);
});

test("the native CLI can read any path, but publishing stays limited", async (t) => {
	quiet(t);
	process.env.JS_NATIVE_DEV = "1";
	t.after(() => { delete process.env.JS_NATIVE_DEV; });
	assert.equal(await readChatText(secretFile), SECRET);
	await assert.rejects(readChatFile(chatB.folders.workspace), { message: NOT_FOUND });
	const { publishWorkspaceArtifact } = await import("../core/files.mjs");
	await assert.rejects(publishWorkspaceArtifact(secretFile), { message: NOT_FOUND });
});
