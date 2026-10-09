import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.resolve(here, "../review/render_review_docx.py");
const windowsRenderer = path.resolve(here, "../review/render_review_docx.ps1");

function execute(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { windowsHide: true });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (value) => { stdout += value; });
		child.stderr.on("data", (value) => { stderr += value; });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) return resolve({ stdout, stderr });
			reject(new Error(`Review DOCX renderer failed (${code}): ${(stderr || stdout).trim().slice(0, 1200)}`));
		});
	});
}

/** Render a source-anchored review DOCX. On Windows the portable wrapper uses WSL. */
export async function renderReviewDocx({ sourceFile, sourceTextFile, findingsFile, outputFile, title, perspective }) {
	const argumentsList = ["--findings", findingsFile, "--output", outputFile, "--title", title, "--perspective", perspective];
	if (sourceFile) argumentsList.push("--source", sourceFile);
	if (sourceTextFile) argumentsList.push("--source-text", sourceTextFile);
	if (process.platform === "win32") {
		return execute("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", windowsRenderer, "-Findings", findingsFile, "-Output", outputFile, "-Title", title, "-Perspective", perspective, ...(sourceFile ? ["-Source", sourceFile] : []), ...(sourceTextFile ? ["-SourceText", sourceTextFile] : [])]);
	}
	return execute("python3", [renderer, ...argumentsList]);
}
