import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	auditCommercialCoverage,
	buildClauseInventory,
	clauseInventory,
	finalizeReviewDocument,
	prepareReviewDocumentSet,
	readDocumentSet,
	renderReviewReport,
	validateReviewFindings,
} from "../core/native-review.mjs";
import { validateDraft } from "../core/precedents.mjs";

async function fixtureSet() {
	const directory = await mkdtemp(path.join(os.tmpdir(), "junior-silva-native-review-"));
	const primary = path.join(directory, "agreement.txt");
	const annexure = path.join(directory, "annexure.txt");
	await writeFile(primary, "1. Scope\nThe Developer shall deliver the application.\n\n6.1 Intellectual Property\nThe Developer assigns all source code, tools and deliverables to the Client immediately.\n\n13.3 Liability\nThe Developer has unlimited liability for all losses.\n", "utf8");
	await writeFile(annexure, "The Developer's existing framework and reusable tools are background intellectual property.\n", "utf8");
	return { directory, primary, annexure };
}

test("native review creates a document set and accepts only source-anchored findings", async (t) => {
	const fixture = await fixtureSet();
	t.after(() => rm(fixture.directory, { recursive: true, force: true }));
	const set = await readDocumentSet({ file_paths: [fixture.primary, fixture.annexure], primary_file_path: fixture.primary, user_context: "Protect the Developer." });
	assert.equal(set.documents.length, 2);
	assert.equal(set.documents.find((item) => item.role === "primary")?.path, path.resolve(fixture.primary));
	assert.match(await readFile(set.packet_file, "utf8"), /background intellectual property/i);

	const inventory = await buildClauseInventory({ file_path: fixture.primary });
	assert.ok(inventory.clauses.some((item) => item.clause_number === "6.1"));
	const validated = await validateReviewFindings({
		file_path: fixture.primary,
		findings: [
			{ clause_number: "6.1", anchor_text: "The Developer assigns all source code, tools and deliverables to the Client immediately.", category: "commercial", severity: "material commercial risk", title: "No background IP carve-out", explanation: "The wording captures existing tools.", recommendation: "Exclude background IP and license it only as needed." },
			{ clause_number: "99", anchor_text: "This wording does not occur in the document.", category: "legal", title: "Unsupported" },
		],
	});
	assert.equal(validated.accepted.length, 1);
	assert.equal(validated.accepted[0].clause_number, "6.1");
	assert.equal(validated.rejected.length, 1);
	const report = await renderReviewReport({ findings_file: validated.findings_file, perspective: "Developer" });
	assert.match(await readFile(report.report_file, "utf8"), /No background IP carve-out/);
});

test("two-tool review preparation and finalisation create source-grounded review artifacts", async (t) => {
	const fixture = await fixtureSet();
	t.after(() => rm(fixture.directory, { recursive: true, force: true }));
	const prepared = await prepareReviewDocumentSet({ file_paths: [fixture.primary, fixture.annexure], primary_file_path: fixture.primary, user_context: "Protect the Developer." });
	assert.equal(prepared.primary_file, path.resolve(fixture.primary));
	assert.ok(prepared.clause_inventory.some((item) => item.clause_number === "6.1"));
	const result = await finalizeReviewDocument({
		review_context_file: prepared.review_context_file,
		perspective: "Developer",
		findings: [
			{ clause_number: "6.1", anchor_text: "The Developer assigns all source code, tools and deliverables to the Client immediately.", category: "commercial", severity: "material commercial risk", title: "No background IP carve-out", explanation: "The wording captures existing tools.", recommendation: "Exclude background IP and license it only as needed.", authority_urls: ["https://lex.paralegal.lk/"] },
			{ clause_number: "99", anchor_text: "This wording does not occur in the document.", category: "legal", title: "Unsupported" },
		],
	});
	assert.equal(result.accepted.length, 1);
	assert.equal(result.rejected.length, 1);
	assert.match(await readFile(result.review_markdown.local_path, "utf8"), /No background IP carve-out/);
	assert.match(await readFile(result.review_markdown.local_path, "utf8"), /https:\/\/lex\.paralegal\.lk/);
	assert.ok((await readFile(result.reviewed_docx.local_path)).subarray(0, 2).equals(Buffer.from("PK")));
});

test("native review coverage and draft validation expose evidence and unresolved placeholders", async (t) => {
	const fixture = await fixtureSet();
	t.after(() => rm(fixture.directory, { recursive: true, force: true }));
	assert.ok(clauseInventory(await readFile(fixture.primary, "utf8")).length >= 3);
	const coverage = await auditCommercialCoverage({ file_path: fixture.primary });
	assert.ok(coverage.dimensions.some((item) => item.dimension.startsWith("ownership") && item.status === "addressed"));
	const draft = path.join(fixture.directory, "draft.md");
	await writeFile(draft, "# Notice\nDate: [FILL]\n", "utf8");
	const checked = await validateDraft({ file_path: draft });
	assert.deepEqual(checked.flags, [{ type: "placeholder", marker: "[FILL]", count: 1 }]);
	const empty = path.join(fixture.directory, "empty.md");
	await writeFile(empty, "\n", "utf8");
	await assert.rejects(() => validateDraft({ file_path: empty }), /empty/);
});
