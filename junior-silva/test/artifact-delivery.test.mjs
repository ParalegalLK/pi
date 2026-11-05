import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { newestRequestedArtifact, requestedArtifactExtensions, requestedSlideCount } from "../core/artifact-delivery.mjs";
import { createChatFolders, runInChat } from "../core/chat-scope.mjs";
import { publishWorkspaceArtifact } from "../core/files.mjs";
import PptxGenJS from "pptxgenjs";

process.env.JUNIOR_SILVA_PUBLIC_URL ||= "https://example.test";
process.env.JUNIOR_SILVA_ARTIFACT_SECRET ||= "test-artifact-secret";

test("detects requested user-facing artifact types without treating source files as deliverables", () => {
	assert.deepEqual([...requestedArtifactExtensions("Make a four-slide PowerPoint and include the Markdown source")].sort(), [".md", ".pptx"]);
	assert.deepEqual([...requestedArtifactExtensions("Explain the legal position in chat")], []);
	assert.equal(requestedSlideCount("Make a 4 slide PPTX"), 4);
});

test("only discovers the newest requested deliverable inside the active request workspace", async (t) => {
	const workspace = path.join(tmpdir(), `junior-silva-delivery-${randomUUID()}`);
	t.after(() => rm(workspace, { recursive: true, force: true }));
	await mkdir(path.join(workspace, "slides"), { recursive: true });
	await writeFile(path.join(workspace, "notes.md"), "deck source");
	await writeFile(path.join(workspace, "slides", "final.pptx"), "deck");
	assert.equal(await newestRequestedArtifact(workspace, "Create a PowerPoint presentation"), path.join(workspace, "slides", "final.pptx"));
	assert.equal(await newestRequestedArtifact(workspace, "Create a PowerPoint presentation with Markdown source"), path.join(workspace, "slides", "final.pptx"));
	assert.equal(await newestRequestedArtifact(workspace, "Create an XLSX workbook"), undefined);
});

test("a validated request-local presentation publishes a protected download and trusted preview", async (t) => {
	const scope = { userHash: randomBytes(16).toString("hex"), chatHash: randomBytes(16).toString("hex") };
	const folders = await createChatFolders(scope);
	t.after(() => rm(path.resolve(folders.root, "..", ".."), { recursive: true, force: true }));
	const requestWorkspace = path.join(folders.workspace, "requests", randomUUID());
	await mkdir(requestWorkspace, { recursive: true });
	const filename = path.join(requestWorkspace, "legal-due-diligence.pptx");
	const deck = new PptxGenJS();
	for (const title of ["Scope", "Authorities", "Risks", "Recommendation"]) {
		const slide = deck.addSlide();
		slide.addText(title, { x: 0.6, y: 0.5, w: 9, h: 0.5 });
	}
	await deck.writeFile({ fileName: filename });
	const publication = await runInChat({ ...scope, folders }, () => publishWorkspaceArtifact(filename));
	assert.match(publication.artifact.download_url, /^https?:\/\//);
	assert.match(publication.artifact_markup, /slide-gallery/);
});
