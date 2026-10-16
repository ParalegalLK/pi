import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import PptxGenJS from "pptxgenjs";
import { preparePreview } from "../core/previews.mjs";

test("PPTX preview uses the trusted slide gallery rather than a model-authored HTML summary", async (t) => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "junior-silva-preview-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const filename = path.join(directory, "due-diligence.pptx");
	const deck = new PptxGenJS();
	for (const title of ["Sri Lankan legal due diligence", "Key legal risks"]) {
		const slide = deck.addSlide();
		slide.addText(title, { x: 0.6, y: 0.5, w: 9, h: 0.5 });
		slide.addText("Verify authority, current status, and source documents.", { x: 0.6, y: 1.3, w: 9, h: 0.4 });
	}
	await deck.writeFile({ fileName: filename });
	const preview = await preparePreview(filename);
	assert.equal(preview.kind, "pptx");
	assert.match(preview.markup, /slide-gallery/);
	assert.match(preview.markup, /Sri Lankan legal due diligence/);
	assert.doesNotMatch(preview.markup, /Download the native PowerPoint for the full design/);
});
