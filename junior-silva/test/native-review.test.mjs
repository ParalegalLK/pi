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
	recordReviewCheckpointOutcome,
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
	assert.equal(set.documents.find((item) => item.role === "review_target")?.path, path.resolve(fixture.primary));
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
	const findings = [
		{ clause_number: "6.1", anchor_text: "The Developer assigns all source code, tools and deliverables to the Client immediately.", category: "commercial", severity: "material commercial risk", title: "No background IP carve-out", explanation: "The wording captures existing tools.", recommendation: "Exclude background IP and license it only as needed.", authority_urls: ["https://lex.paralegal.lk/"] },
		{ clause_number: "99", anchor_text: "This wording does not occur in the document.", category: "legal", title: "Unsupported" },
	];
	const waiting = await finalizeReviewDocument({
		review_context_file: prepared.review_context_file,
		perspective: "Developer",
		findings,
	});
	assert.equal(waiting.completion, "review-awaiting-evidence-checkpoint");
	const checkpoint = await recordReviewCheckpointOutcome({ review_context_file: prepared.review_context_file, outcome: "review_normally", user_response: "review normally" });
	assert.equal(checkpoint.checkpoint.status, "completed");
	const result = await finalizeReviewDocument({ review_context_file: prepared.review_context_file, perspective: "Developer", findings });
	assert.equal(result.accepted.length, 1);
	assert.equal(result.rejected.length, 1);
	assert.match(await readFile(result.review_markdown.local_path, "utf8"), /No background IP carve-out/);
	assert.match(await readFile(result.review_markdown.local_path, "utf8"), /https:\/\/lex\.paralegal\.lk/);
	assert.ok((await readFile(result.reviewed_docx.local_path)).subarray(0, 2).equals(Buffer.from("PK")));
	assert.ok(result.artifact_markup.startsWith(":::artifact{"));
	assert.equal(result.annotation_coverage.annotated_count, 1);
});

test("immediate or chat-only review is the narrow evidence-checkpoint exception", async (t) => {
	const fixture = await fixtureSet();
	t.after(() => rm(fixture.directory, { recursive: true, force: true }));
	const prepared = await prepareReviewDocumentSet({ file_path: fixture.primary, user_context: "Please provide an immediate chat-only review." });
	assert.equal(prepared.checkpoint.status, "not_required");
});

test("native review finalises every review target while retaining annexures as supporting evidence", async (t) => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "junior-silva-multi-review-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const first = path.join(directory, "service-agreement.txt");
	const second = path.join(directory, "data-processing-agreement.txt");
	const annexure = path.join(directory, "Annex A.txt");
	await writeFile(first, "6.1 Ownership\nThe Supplier assigns all existing tools to the Client.\n", "utf8");
	await writeFile(second, "4.2 Liability\nThe Processor has unlimited liability for all losses.\n", "utf8");
	await writeFile(annexure, "Annex A sets operational service levels only.\n", "utf8");
	const prepared = await prepareReviewDocumentSet({ file_paths: [first, second, annexure], user_context: "Protect the Supplier." });
	assert.deepEqual(prepared.review_targets.map((target) => target.filename), ["service-agreement.txt", "data-processing-agreement.txt"]);
	await recordReviewCheckpointOutcome({ review_context_file: prepared.review_context_file, outcome: "skip", user_response: "skip" });
	const result = await finalizeReviewDocument({
		review_context_file: prepared.review_context_file,
		perspective: "Supplier",
		findings: [
			{ target_id: "review-target-1", clause_number: "6.1", anchor_text: "The Supplier assigns all existing tools to the Client.", commercial_impact: "Material Commercial Risk", category: "commercial", title: "Background IP", explanation: "The assignment captures existing tools.", recommendation: "Carve out background IP." },
			{ target_id: "review-target-2", clause_number: "4.2", anchor_text: "The Processor has unlimited liability for all losses.", commercial_impact: "Material Commercial Risk", category: "commercial", title: "Unlimited liability", explanation: "The clause has no proportionate cap.", recommendation: "Add a cap." },
		],
	});
	assert.equal(result.reviews.length, 2);
	assert.ok(result.reviews.every((review) => review.annotation_coverage.annotated_count === 1));
	assert.ok(result.reviews.every((review) => review.reviewed_docx.name.startsWith("Reviewed_")));
	assert.ok(result.reviews.every((review) => review.reviewed_docx.download_url));
	assert.ok(result.artifact_markups.length === 2);
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
