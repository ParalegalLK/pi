import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const DELIVERABLE_TYPES = new Set([".pptx", ".xlsx", ".docx", ".pdf", ".md", ".txt", ".json"]);
const PRIMARY_ARTIFACT_ORDER = [".pptx", ".xlsx", ".docx", ".pdf", ".md", ".txt", ".json"];

export function requestedArtifactExtensions(instruction = "") {
	const text = String(instruction).toLowerCase();
	const types = new Set();
	if (/\b(?:pptx|powerpoint|slide\s*deck|presentation|slides?)\b/.test(text)) types.add(".pptx");
	if (/\b(?:xlsx|spreadsheet|workbook)\b/.test(text)) types.add(".xlsx");
	if (/\b(?:docx|word\s+document)\b/.test(text)) types.add(".docx");
	if (/\bpdf\b/.test(text)) types.add(".pdf");
	if (/\b(?:markdown|\.md)\b/.test(text)) types.add(".md");
	return types;
}

export function requestedSlideCount(instruction = "") {
	const match = String(instruction).match(/\b(\d{1,2})\s*(?:-| )?(?:slide|slides)\b/i);
	return match ? Number(match[1]) : undefined;
}

async function walk(directory, entries = []) {
	let children;
	try { children = await readdir(directory, { withFileTypes: true }); }
	catch (error) { if (error?.code === "ENOENT") return entries; throw error; }
	for (const child of children) {
		const filename = path.join(directory, child.name);
		if (child.isDirectory()) await walk(filename, entries);
		else if (child.isFile()) entries.push(filename);
	}
	return entries;
}

// Only scan the directory allocated to the active request. This deliberately
// never considers files created by another request or a previous conversation.
export async function newestRequestedArtifact(requestWorkspace, instruction) {
	const expected = requestedArtifactExtensions(instruction);
	if (!expected.size) return undefined;
	const files = await walk(requestWorkspace);
	const candidates = await Promise.all(files
		.filter((file) => expected.has(path.extname(file).toLowerCase()) && DELIVERABLE_TYPES.has(path.extname(file).toLowerCase()))
		.map(async (file) => ({ file, info: await stat(file) })));
	return candidates
		.filter(({ info }) => info.size > 0)
		.sort((left, right) => {
			const typeOrder = PRIMARY_ARTIFACT_ORDER.indexOf(path.extname(left.file).toLowerCase()) - PRIMARY_ARTIFACT_ORDER.indexOf(path.extname(right.file).toLowerCase());
			return typeOrder || right.info.mtimeMs - left.info.mtimeMs;
		})[0]?.file;
}
