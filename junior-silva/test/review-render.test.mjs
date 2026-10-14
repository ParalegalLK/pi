import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import JSZip from "jszip";
import { finalizeReviewDocument, prepareReviewDocumentSet, recordReviewCheckpointOutcome } from "../core/native-review.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function run(command, args) {
	return new Promise((resolve, reject) => {
		execFile(command, args, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout));
	});
}

function wslPath(filename) {
	const parsed = path.parse(path.resolve(filename));
	return `/mnt/${parsed.root[0].toLowerCase()}/${path.relative(parsed.root, filename).replace(/\\/g, "/")}`;
}

async function createDocx(filename) {
	const source = [
		"from docx import Document",
		"import sys",
		"d=Document()",
		"d.add_paragraph('6.1 Intellectual Property')",
		"d.add_paragraph('The Developer assigns all source code, tools and deliverables to the Client immediately.')",
		"t=d.add_table(rows=1, cols=1)",
		"t.cell(0,0).text='13.3 The Developer has unlimited liability for all losses.'",
		"d.save(sys.argv[1])",
	].join("; ");
	if (process.platform === "win32") return run("wsl.exe", ["-d", "Ubuntu", "--", "python3", "-c", source, wslPath(filename)]);
	return run("python3", ["-c", source, filename]);
}

test("native DOCX review verifies comments and highlights in body and table clauses", async (t) => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "junior-silva-render-review-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const source = path.join(directory, "agreement.docx");
	await createDocx(source);
	const prepared = await prepareReviewDocumentSet({ file_path: source, user_context: "Protect the Developer." });
	await recordReviewCheckpointOutcome({ review_context_file: prepared.review_context_file, outcome: "skip", user_response: "skip" });
	const result = await finalizeReviewDocument({
		review_context_file: prepared.review_context_file,
		perspective: "Developer",
		findings: [
			{ clause_number: "6.1", anchor_text: "The Developer assigns all source code, tools and deliverables to the Client immediately.", category: "commercial", severity: "material commercial risk", title: "Background IP", explanation: "Captures existing tools.", recommendation: "Exclude background IP." },
			{ clause_number: "13.3", anchor_text: "The Developer has unlimited liability for all losses.", category: "commercial", severity: "material commercial risk", title: "Unlimited liability", explanation: "No cap.", recommendation: "Add a proportionate cap." },
		],
	});
	assert.equal(result.annotation_coverage.annotated_count, 2);
	const zip = await JSZip.loadAsync(await readFile(result.reviewed_docx.local_path));
	const comments = await zip.file("word/comments.xml")?.async("string");
	const document = await zip.file("word/document.xml")?.async("string");
	assert.match(comments || "", /Captures existing tools/);
	assert.match(comments || "", /No cap/);
	assert.match(comments || "", /MATERIAL COMMERCIAL RISK/);
	assert.match(document || "", /commentRangeStart/);
	assert.match(document || "", /FFC000/);
});

test("native renderer uses V2/V3 classifications rather than loose severity wording", async (t) => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "junior-silva-review-colours-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const source = path.join(directory, "classification.txt");
	await (await import("node:fs/promises")).writeFile(source, "1. The agreement waives a mandatory statutory right.\n2. The supplier has uncapped liability.\n3. The client may request monthly reports.\n", "utf8");
	const prepared = await prepareReviewDocumentSet({ file_path: source, user_context: "Please provide an immediate chat-only review." });
	const result = await finalizeReviewDocument({
		review_context_file: prepared.review_context_file,
		findings: [
			{ anchor_text: "The agreement waives a mandatory statutory right.", compliance_status: "Illegal", category: "legal", severity: "high", title: "Statutory waiver", explanation: "Conflicts with mandatory law.", recommendation: "Remove the waiver.", authority_urls: ["https://lex.paralegal.lk/example"] },
			{ anchor_text: "The supplier has uncapped liability.", commercial_impact: "Material Commercial Risk", category: "commercial", severity: "medium", title: "Liability", explanation: "Exposure is uncapped.", recommendation: "Add a cap." },
			{ anchor_text: "The client may request monthly reports.", commercial_impact: "Negotiation Point", category: "commercial", severity: "high", title: "Reporting", explanation: "Reporting can be scoped.", recommendation: "Define the reporting format." },
		],
	});
	const zip = await JSZip.loadAsync(await readFile(result.reviewed_docx.local_path));
	const comments = await zip.file("word/comments.xml")?.async("string");
	const document = await zip.file("word/document.xml")?.async("string");
	assert.match(comments || "", /ILLEGAL \/ NON-COMPLIANT/);
	assert.match(comments || "", /MATERIAL COMMERCIAL RISK/);
	assert.match(comments || "", /NEGOTIATION POINT/);
	assert.match(document || "", /FF0000/);
	assert.match(document || "", /FFC000/);
	assert.match(document || "", /FFFF00/);
});
