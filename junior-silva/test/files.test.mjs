import assert from "node:assert/strict";
import test from "node:test";
import { markdownLinks, stripServiceFileLinks } from "../core/files.mjs";
import { translatedOutputName } from "../services/translator.mjs";

test("markdownLinks does not absorb text from preceding lines", () => {
	const response = `Translation complete.\n\n[Download as PDF](https://example.test/download?file=/app/shared/translated.pdf)\n[Download as DOCX](https://example.test/download?file=/app/shared/translated.docx)`;
	assert.deepEqual(markdownLinks(response), [
		{ label: "Download as PDF", url: "https://example.test/download?file=/app/shared/translated.pdf" },
		{ label: "Download as DOCX", url: "https://example.test/download?file=/app/shared/translated.docx" },
	]);
});

test("translatedOutputName preserves the extension from the translator file query", () => {
	assert.equal(translatedOutputName({ label: "Download as DOCX", url: "https://example.test/download?file=/app/shared/my%20translation.docx" }), "my translation.docx");
	assert.equal(translatedOutputName({ label: "View as Text", url: "https://example.test/download?file=/app/shared/my-translation.md" }), "my-translation.md");
});

test("translatedOutputName falls back to a typed stable name", () => {
	assert.equal(translatedOutputName({ label: "Download as PDF", url: "https://example.test/download" }, 2), "translated-document-3.pdf");
});

test("stripServiceFileLinks removes translator download URLs", () => {
	const response = "Done. [Download as DOCX](https://example.test/download?file=/app/shared/translated.docx)";
	assert.equal(stripServiceFileLinks(response), "Done. Download as DOCX");
});
