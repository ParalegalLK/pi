import { lstat, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { currentChat } from "./chat-scope.mjs";

const MAX_SCAN_ENTRIES = 5000;
const MAX_SCAN_DEPTH = 12;
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

const insideWorkspace = (file, workspace) => file.startsWith(`${workspace}${path.sep}`);

// Pi can swap anything in this folder for a shortcut, so each folder's real path is
// checked before it's read. Names are streamed, so a huge folder can't fill memory
// before the limit applies.
async function walk(directory, workspace, scan, depth = 0) {
	if (depth > MAX_SCAN_DEPTH) throw new Error("The folder is nested too deeply.");
	const real = await realpath(directory);
	if (!insideWorkspace(real, workspace)) throw new Error("The folder is outside this chat's workspace.");
	for await (const child of await opendir(real)) {
		scan.entries += 1;
		if (scan.entries > MAX_SCAN_ENTRIES) throw new Error("The folder has too many files.");
		const filename = path.join(real, child.name);
		if (child.isDirectory()) await walk(filename, workspace, scan, depth + 1);
		else if (child.isFile()) scan.files.push(filename);
	}
}

// Only scan the directory allocated to the active request. This deliberately
// never considers files created by another request or a previous conversation.
// Any problem means no file, so the user still gets Pi's own answer.
export async function newestRequestedArtifact(requestWorkspace, instruction) {
	const expected = requestedArtifactExtensions(instruction);
	if (!expected.size) return undefined;
	const chat = currentChat();
	try {
		const workspace = await realpath(chat.folders.workspace);
		const scan = { entries: 0, files: [] };
		await walk(requestWorkspace, workspace, scan);
		const candidates = await Promise.all(scan.files
			.filter((file) => expected.has(path.extname(file).toLowerCase()) && DELIVERABLE_TYPES.has(path.extname(file).toLowerCase()))
			.map(async (file) => ({ file, info: await lstat(file) })));
		const newest = candidates
			.filter(({ info }) => info.isFile() && info.size > 0)
			.sort((left, right) => {
				const typeOrder = PRIMARY_ARTIFACT_ORDER.indexOf(path.extname(left.file).toLowerCase()) - PRIMARY_ARTIFACT_ORDER.indexOf(path.extname(right.file).toLowerCase());
				return typeOrder || right.info.mtimeMs - left.info.mtimeMs;
			})[0]?.file;
		return newest && insideWorkspace(await realpath(newest), workspace) ? newest : undefined;
	} catch {
		return undefined;
	}
}
