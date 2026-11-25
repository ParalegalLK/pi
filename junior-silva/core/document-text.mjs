import path from "node:path";
import { execFile } from "node:child_process";
import mammoth from "mammoth";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { readChatFile } from "./chat-scope.mjs";

async function docxText(bytes) {
	const result = await mammoth.extractRawText({ buffer: bytes });
	return result.value;
}

async function pdfText(bytes) {
	// Import the library entry directly: pdf-parse's package root runs its
	// bundled sample when loaded from ESM because `module.parent` is absent.
	const result = await pdfParse(bytes);
	return result.text;
}

function run(command, args, input) {
	return new Promise((resolve, reject) => {
		const child = execFile(command, args, { windowsHide: true, maxBuffer: 12 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) return reject(new Error(String(stderr || error.message).trim()));
			resolve(String(stdout || ""));
		});
		child.stdin.on("error", () => {}); // If the command stops early, it reports that itself.
		child.stdin.end(input);
	});
}

async function imageText(filename, bytes) {
	// Image attachments are evidence too.  The container supplies Tesseract and
	// this deliberately returns only OCR text; the original image stays intact.
	// The bytes go through stdin, so Tesseract never opens a path Pi could swap.
	try {
		return await run("tesseract", ["stdin", "stdout", "-l", "eng"], bytes);
	} catch (error) {
		throw new Error(`Could not OCR ${path.basename(filename)}. Upload a readable PDF/DOCX or a clearer image. ${error.message}`);
	}
}

export async function extractDocumentText(filename) {
	const { bytes } = await readChatFile(filename);
	const extension = path.extname(filename).toLowerCase();
	if ([".txt", ".md", ".json"].includes(extension)) return bytes.toString("utf8");
	if (extension === ".docx") return docxText(bytes);
	if (extension === ".pdf") return pdfText(bytes);
	if ([".png", ".jpg", ".jpeg"].includes(extension)) return imageText(filename, bytes);
	throw new Error(`Multi-document review cannot extract ${extension || "this file type"}; convert it to PDF, DOCX, Markdown, text, or a supported image first.`);
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
