import path from "node:path";
import { readFile } from "node:fs/promises";
import mammoth from "mammoth";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

async function docxText(filename) {
	const result = await mammoth.extractRawText({ buffer: await readFile(filename) });
	return result.value;
}

async function pdfText(filename) {
	// Import the library entry directly: pdf-parse's package root runs its
	// bundled sample when loaded from ESM because `module.parent` is absent.
	const result = await pdfParse(await readFile(filename));
	return result.text;
}

export async function extractDocumentText(filename) {
	const extension = path.extname(filename).toLowerCase();
	if ([".txt", ".md", ".json"].includes(extension)) return readFile(filename, "utf8");
	if (extension === ".docx") return docxText(filename);
	if (extension === ".pdf") return pdfText(filename);
	throw new Error(`Multi-document review cannot extract ${extension || "this file type"}; convert it to PDF, DOCX, Markdown, or text first.`);
}

export async function buildReviewPacket(files, primaryFile) {
	const primary = primaryFile ? path.resolve(primaryFile) : path.resolve(files[0]);
	const ordered = [...files].sort((left, right) => Number(path.resolve(right) === primary) - Number(path.resolve(left) === primary));
	const sections = [];
	for (const [index, filename] of ordered.entries()) {
		const absolute = path.resolve(filename);
		const text = (await extractDocumentText(absolute)).trim();
		if (!text) throw new Error(`${path.basename(absolute)} did not contain extractable text`);
		sections.push(`# Document ${index + 1}: ${path.basename(absolute)}${absolute === primary ? " (PRIMARY AGREEMENT)" : " (RELATED DOCUMENT / ANNEXURE)"}\n\n${text}`);
	}
	return sections.join("\n\n---\n\n");
}
