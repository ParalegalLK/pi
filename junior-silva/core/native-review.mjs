import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildReviewPacket, extractDocumentText } from "./document-text.mjs";
import { inputFile, operationDirectory, saveJson, describeArtifact, safeFilename } from "./files.mjs";
import { renderReviewDocx } from "./review-render.mjs";
import { preparePreview } from "./previews.mjs";

const DIMENSIONS = [
	["rights, duties and performance", ["shall", "must", "obligation", "performance", "deliver", "service level"]],
	["money, pricing and value exchange", ["payment", "fee", "price", "invoice", "charge", "cost", "interest"]],
	["acceptance, quality and operational control", ["acceptance", "reject", "quality", "standard", "approval", "warranty"]],
	["ownership, data, assets and control", ["intellectual property", "source code", "ownership", "licence", "license", "data", "deliverable"]],
	["liability, indemnity, insurance and risk allocation", ["liability", "indemn", "damages", "loss", "insurance", "limitation"]],
	["remedies, dispute leverage and enforcement", ["remedy", "breach", "suspend", "withhold", "injunction", "dispute", "court"]],
	["duration, termination, transition and exit", ["term", "terminate", "termination", "notice", "transition", "handover", "expiry"]],
	["confidentiality, privacy, regulatory and security obligations", ["confidential", "privacy", "security", "personal data", "regulatory", "compliance"]],
	["governance, change, assignment and procedural enforceability", ["amend", "change", "assign", "assignment", "governing law", "entire agreement", "waiver"]],
];

function normalized(value) {
	return String(value || "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function wordSet(value) {
	return new Set(normalized(value).split(/[^a-z0-9]+/).filter((item) => item.length > 2));
}

function hasSourceAnchor(source, anchor) {
	const sourceText = normalized(source);
	const target = normalized(anchor);
	if (target.length < 12) return false;
	if (sourceText.includes(target)) return true;
	const sourceWords = wordSet(sourceText);
	const targetWords = wordSet(target);
	const overlap = [...targetWords].filter((word) => sourceWords.has(word)).length;
	return overlap >= Math.max(5, Math.ceil(targetWords.size * 0.8));
}

function clauseNumber(line) {
	const match = /^\s*((?:\d+)(?:\.\d+){0,5}[.)]?)\s+/.exec(line);
	return match?.[1]?.replace(/[.)]$/, "") || "";
}

function requiresEvidenceCheckpoint(userContext) {
	// An explicit immediate/chat-only request intentionally opts out. All other
	// substantive native reviews receive one user-controlled evidence checkpoint.
	return !/\b(?:immediate(?:ly)?|chat[ -]?only|without (?:questions|follow-?up)|no follow-?up)\b/i.test(String(userContext || ""));
}

export function clauseInventory(text) {
	const clauses = [];
	let current;
	for (const raw of String(text || "").replace(/\r\n/g, "\n").split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const number = clauseNumber(line);
		const heading = /^[A-Z][A-Z\s,&/-]{4,}$/.test(line);
		if (number || heading) {
			if (current?.text) clauses.push(current);
			current = { clause_number: number || "N/A", heading: line.replace(/^\s*(?:\d+(?:\.\d+)*[.)]?)\s*/, ""), text: line };
		} else if (current) {
			current.text = current.text + "\n" + line;
		} else {
			current = { clause_number: "N/A", heading: "", text: line };
		}
	}
	if (current?.text) clauses.push(current);
	if (!clauses.length && String(text || "").trim()) clauses.push({ clause_number: "N/A", heading: "", text: String(text).trim() });
	return clauses.map((item, index) => ({ ...item, index: index + 1, anchor_text: item.text.slice(0, 1600) }));
}

function normalisedFinding(value, inventory, source) {
	const item = value && typeof value === "object" ? value : {};
	const anchor = String(item.anchor_text || item.issue_text || item.flagged_clause || "").trim();
	const matchingClause = inventory.find((clause) => hasSourceAnchor(clause.text, anchor));
	const authorityUrls = Array.isArray(item.authority_urls) ? item.authority_urls.filter((url) => typeof url === "string" && /^https?:\/\//i.test(url)) : [];
	const compliance = normalized(item.compliance_status || item.classification);
	const commercialImpact = normalized(item.commercial_impact || item.severity);
	const requestedIllegal = compliance === "illegal" || compliance === "illegal / non-compliant" || /\billegal\b|non-compliant/.test(compliance);
	const classification = requestedIllegal && authorityUrls.length
		? "illegal_non_compliant"
		: commercialImpact === "material commercial risk" || normalized(item.classification) === "material commercial risk"
			? "material_commercial_risk"
			: "negotiation_point";
	return {
		accepted: hasSourceAnchor(source, anchor),
		finding: {
			id: createHash("sha256").update(normalized(anchor) + "\0" + normalized(item.explanation)).digest("hex").slice(0, 16),
			clause_number: String(item.clause_number || matchingClause?.clause_number || "N/A"),
			anchor_text: anchor,
			category: String(item.category || item.review_axis || "commercial").toLowerCase() === "legal" ? "legal" : "commercial",
			classification,
			severity: String(item.severity || item.commercial_impact || item.compliance_status || "negotiation point").toLowerCase(),
			title: String(item.title || item.legal_concept || "Contractual risk").trim(),
			explanation: String(item.explanation || "").trim(),
			recommendation: String(item.recommendation || item.suggestion || "").trim(),
			authority_urls: authorityUrls,
		},
	};
}

function likelySupporting(filename) {
	return /(?:annex(?:ure)?|appendix|schedule|exhibit|attachment|support(?:ing)?|evidence|correspondence|notice|invoice|statement)/i.test(path.basename(filename));
}

function requestedPaths(args) {
	const values = [
		...(Array.isArray(args.file_paths) ? args.file_paths : []),
		...(Array.isArray(args.review_file_paths) ? args.review_file_paths : []),
		...(Array.isArray(args.supporting_file_paths) ? args.supporting_file_paths : []),
		...(args.file_path ? [args.file_path] : []),
		...(args.primary_file_path ? [args.primary_file_path] : []),
	];
	return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function targetSelection(args, files) {
	const explicitTargets = new Set([
		...(Array.isArray(args.review_file_paths) ? args.review_file_paths : []),
		...(args.primary_file_path ? [args.primary_file_path] : []),
	].map((item) => path.resolve(item)));
	const explicitSupporting = new Set((Array.isArray(args.supporting_file_paths) ? args.supporting_file_paths : []).map((item) => path.resolve(item)));
	const hasExplicitTargets = explicitTargets.size > 0;
	return files.map((file) => {
		const absolute = file.absolute;
		const role = explicitSupporting.has(absolute) ? "supporting"
			: explicitTargets.has(absolute) ? "review_target"
			: hasExplicitTargets ? "supporting"
			: likelySupporting(file.name) ? "supporting" : "review_target";
		return { ...file, role };
	});
}

export async function readDocumentSet(args, { onProgress = () => {} } = {}) {
	const requested = requestedPaths(args);
	if (!requested.length) throw new Error("Provide primary_file_path, file_path, or file_paths.");
	onProgress("Reading the supplied legal documents and supporting evidence…");
	const inputs = await Promise.all(requested.map((filename) => inputFile(filename)));
	const files = targetSelection(args, inputs);
	if (!files.some((file) => file.role === "review_target")) throw new Error("Select at least one document to review.");
	const documents = [];
	for (const file of files) {
		const text = (await extractDocumentText(file.absolute)).trim();
		if (!text) throw new Error(file.name + " did not contain extractable text");
		documents.push({
			path: file.absolute,
			filename: file.name,
			sha256: createHash("sha256").update(file.bytes).digest("hex"),
			role: file.role,
			characters: text.length,
			excerpt: text.slice(0, 1800),
		});
	}
	const operation = await operationDirectory("native-review-context");
	const packetFile = path.join(operation.directory, "document-set.md");
	const primary = documents.find((document) => document.role === "review_target");
	await writeFile(packetFile, await buildReviewPacket(documents.map((document) => document.path), primary.path), "utf8");
	const ledgerFile = await saveJson(operation.directory, "document-ledger.json", {
		created_at: new Date().toISOString(), primary_file: primary.path, review_targets: documents.filter((document) => document.role === "review_target").map((document) => document.path), documents, user_context: String(args.user_context || "").trim(),
	});
	return {
		operation_id: operation.id,
		documents,
		packet_file: packetFile,
		ledger_file: ledgerFile,
		review_targets: documents.filter((document) => document.role === "review_target"),
		instruction: "Read this packet before asking more questions or reviewing. Every review_target requires its own annotated deliverable. Supporting documents may answer earlier questions; identify what they resolve and ask only for genuinely missing facts.",
	};
}

/**
 * Build the complete, reusable evidence packet for a review.  This deliberately
 * performs no interview: Pi can see the supplied evidence first and only then
 * decide whether a factual question is genuinely necessary.
 */
export async function prepareReviewDocumentSet(args, { onProgress = () => {} } = {}) {
	const documentSet = await readDocumentSet(args, { onProgress });
	const reviewTargets = documentSet.review_targets;
	if (!reviewTargets.length) throw new Error("A review target could not be identified.");
	onProgress("Mapping every selected review document and checking material commercial coverage…");
	const operation = await operationDirectory("review-preparation");
	const targets = [];
	for (const [index, target] of reviewTargets.entries()) {
		const source = await extractDocumentText(target.path);
		const clauses = clauseInventory(source);
		const dimensions = DIMENSIONS.map(([dimension, terms]) => {
			const evidence = clauses.filter((clause) => terms.some((term) => normalized(clause.text).includes(term)))
				.map((clause) => clause.clause_number).filter((item, position, values) => values.indexOf(item) === position);
			return { dimension, status: evidence.length ? "addressed" : "not_present", evidence_clause_numbers: evidence };
		});
		const sourceTextFile = path.join(operation.directory, `review-target-${index + 1}-source.txt`);
		await writeFile(sourceTextFile, source, "utf8");
		targets.push({ id: `review-target-${index + 1}`, file: target.path, filename: target.filename, source_text_file: sourceTextFile, clauses, commercial_coverage: dimensions });
	}
	const primary = targets[0];
	const checkpointRequired = requiresEvidenceCheckpoint(args.user_context);
	const contextFile = await saveJson(operation.directory, "review-context.json", {
		created_at: new Date().toISOString(),
		primary_file: primary.file,
		primary_filename: primary.filename,
		source_text_file: primary.source_text_file,
		document_packet: documentSet.packet_file,
		document_ledger: documentSet.ledger_file,
		documents: documentSet.documents,
		targets,
		clauses: primary.clauses,
		commercial_coverage: primary.commercial_coverage,
		user_context: String(args.user_context || "").trim(),
		checkpoint: {
			required: checkpointRequired,
			status: checkpointRequired ? "pending" : "not_required",
			message: checkpointRequired
				? "Before an annotated review is finalised, give the user one opportunity to provide further relevant evidence or expressly proceed without it."
				: "The user expressly requested an immediate/chat-only review, so no evidence checkpoint is required.",
		},
	});
	return {
		operation_id: operation.id,
		review_context_file: contextFile,
		primary_file: primary.file,
		primary_filename: primary.filename,
		review_targets: targets.map((target) => ({ id: target.id, file: target.file, filename: target.filename })),
		document_packet: documentSet.packet_file,
		document_ledger: documentSet.ledger_file,
		clause_inventory: primary.clauses,
		commercial_coverage: primary.commercial_coverage,
		checkpoint: { required: checkpointRequired, status: checkpointRequired ? "pending" : "not_required" },
		instruction: checkpointRequired
			? "This preparation contains all supplied evidence, source anchors, and coverage prompts. Review every review target before deciding whether a short factual question is necessary. Do not invent an answer to any question. Before calling review_finalize_document, ask the user once whether they want to provide more relevant evidence; they may upload it, answer, say 'review normally', or say 'skip'. After an actual user response, call review_record_checkpoint_outcome. Do not record an outcome yourself in the same turn. Findings must identify target_id when more than one document is selected."
			: "This preparation contains all supplied evidence, source anchors, and coverage prompts. The user expressly requested immediate/chat-only review, so complete the source-grounded review without an evidence checkpoint.",
	};
}

/** Record the user's actual decision at a review evidence checkpoint. */
export async function recordReviewCheckpointOutcome(args, { onProgress = () => {} } = {}) {
	if (!args.review_context_file) throw new Error("review_context_file is required.");
	const allowed = new Set(["review_normally", "skip", "answered"]);
	const outcome = String(args.outcome || "");
	if (!allowed.has(outcome)) throw new Error("outcome must be review_normally, skip, or answered.");
	onProgress("Recording the user’s review-evidence decision…");
	const context = JSON.parse(await readFile(args.review_context_file, "utf8"));
	context.checkpoint = {
		required: true,
		status: "completed",
		outcome,
		user_response: String(args.user_response || "").trim().slice(0, 4000),
		completed_at: new Date().toISOString(),
	};
	await writeFile(args.review_context_file, `${JSON.stringify(context, null, 2)}\n`, "utf8");
	return {
		review_context_file: args.review_context_file,
		checkpoint: context.checkpoint,
		instruction: outcome === "answered"
			? "Use the user's answer and any supplied supporting document. If new documents were supplied, prepare a fresh combined document set before finalising."
			: "The user chose to proceed without further evidence. Complete needed research and finalise the source-grounded review.",
	};
}

export async function buildClauseInventory(args, { onProgress = () => {} } = {}) {
	if (!args.file_path) throw new Error("file_path is required");
	onProgress("Building a clause and paragraph inventory from the primary document…");
	const file = await inputFile(args.file_path);
	const clauses = clauseInventory(await extractDocumentText(file.absolute));
	const operation = await operationDirectory("clause-inventory");
	const inventoryFile = await saveJson(operation.directory, "clause-inventory.json", { source_file: file.absolute, clauses });
	return { operation_id: operation.id, source_file: file.absolute, inventory_file: inventoryFile, clauses };
}

export async function validateReviewFindings(args, { onProgress = () => {} } = {}) {
	if (!args.file_path) throw new Error("file_path is required");
	if (!Array.isArray(args.findings)) throw new Error("findings must be an array");
	onProgress("Checking proposed review findings against the source clauses…");
	const file = await inputFile(args.file_path);
	const source = await extractDocumentText(file.absolute);
	const inventory = clauseInventory(source);
	const accepted = [];
	const rejected = [];
	const seen = new Set();
	for (const candidate of args.findings) {
		const result = normalisedFinding(candidate, inventory, source);
		const key = normalized(result.finding.anchor_text) + "\0" + result.finding.category;
		if (!result.accepted) rejected.push({ finding: result.finding, reason: "The proposed source anchor was not found reliably in the primary document." });
		else if (!seen.has(key)) {
			seen.add(key);
			accepted.push(result.finding);
		}
	}
	const operation = await operationDirectory("validated-review");
	const findingsFile = await saveJson(operation.directory, "validated-findings.json", { source_file: file.absolute, accepted, rejected });
	return {
		operation_id: operation.id,
		findings_file: findingsFile,
		accepted,
		rejected,
		instruction: "Only accepted findings may be presented as clause-specific findings or rendered into an annotated review. Use rag_chat_research before calling a clause unlawful or non-compliant.",
	};
}

function markdownReview(title, perspective, accepted) {
	return [
		"# " + title, "", "**Protected party:** " + perspective, "",
		"## Validated findings", "",
		...accepted.flatMap((item, index) => [
			"### " + (index + 1) + ". " + item.title + " — Clause " + item.clause_number, "",
			"**Source clause:** " + item.anchor_text, "",
			"**Classification:** " + item.classification.replaceAll("_", " ") + "; **severity:** " + item.severity, "",
			item.explanation || "Further legal/commercial explanation is required.", "",
			"**Recommended protection:** " + (item.recommendation || "Specify a negotiated amendment."), "",
			...(item.authority_urls.length ? ["**Authorities:** " + item.authority_urls.map((url) => `[source](${url})`).join("; "), ""] : []),
		]),
	].join("\n").trim() + "\n";
}

function findingsForTarget(findings, target, targetCount) {
	const accepted = [];
	const rejected = [];
	const seen = new Set();
	for (const candidate of findings) {
		const requestedTarget = String(candidate?.target_id || candidate?.target_file || candidate?.source_file || "").trim();
		if (requestedTarget && requestedTarget !== target.id && path.resolve(requestedTarget) !== path.resolve(target.file)) continue;
		const result = normalisedFinding(candidate, target.clauses, target.source);
		const explicitOtherTarget = requestedTarget && requestedTarget !== target.id && path.resolve(requestedTarget) !== path.resolve(target.file);
		if (explicitOtherTarget) continue;
		if (!result.accepted) {
			if (!requestedTarget && targetCount > 1) continue;
			rejected.push({ finding: result.finding, reason: "The proposed source anchor was not found reliably in this review target." });
			continue;
		}
		const key = normalized(result.finding.anchor_text) + "\0" + result.finding.classification;
		if (!seen.has(key)) { seen.add(key); accepted.push(result.finding); }
	}
	return { accepted, rejected };
}

function reviewName(filename, extension) {
	const base = safeFilename(path.basename(filename, path.extname(filename)), "document").replace(/\s+/g, "_");
	return `${base}${extension}`;
}

/** Validate source-grounded findings and create the final Markdown + DOCX review deliverables. */
export async function finalizeReviewDocument(args, { onProgress = () => {} } = {}) {
	if (!args.review_context_file) throw new Error("review_context_file is required; first use review_prepare_document_set.");
	if (!Array.isArray(args.findings) || !args.findings.length) throw new Error("findings must be a non-empty array.");
	const context = JSON.parse(await readFile(args.review_context_file, "utf8"));
	if (context.checkpoint?.required && context.checkpoint.status !== "completed") {
		return {
			completion: "review-awaiting-evidence-checkpoint",
			review_context_file: args.review_context_file,
			checkpoint: context.checkpoint,
			instruction: "Do not finalise yet. Ask the user whether they have further relevant agreements, correspondence, notices, policies, records, or evidence to provide. They may upload it, answer a focused question, say 'review normally', or say 'skip'. Wait for the actual user response, then call review_record_checkpoint_outcome before retrying finalisation.",
		};
	}
	const storedTargets = Array.isArray(context.targets) && context.targets.length ? context.targets : [{ id: "review-target-1", file: context.primary_file, filename: context.primary_filename, source_text_file: context.source_text_file, clauses: context.clauses, commercial_coverage: context.commercial_coverage }];
	const targets = await Promise.all(storedTargets.map(async (target) => ({ ...target, source: await readFile(target.source_text_file, "utf8"), clauses: Array.isArray(target.clauses) ? target.clauses : clauseInventory(await readFile(target.source_text_file, "utf8")) })));
	onProgress("Validating proposed findings against every selected review document…");
	const grouped = targets.map((target) => ({ target, ...findingsForTarget(args.findings, target, targets.length) }));
	const allAccepted = grouped.flatMap((item) => item.accepted);
	const allRejected = grouped.flatMap((item) => item.rejected);
	if (!allAccepted.length) throw new Error("No findings could be anchored reliably in the selected review documents. Refine exact anchor_text and, for multiple documents, identify target_id.");
	const operation = await operationDirectory("review-final");
	const perspective = String(args.perspective || "Not specified").trim();
	const reviews = [];
	for (const { target, accepted, rejected } of grouped) {
		if (!accepted.length) continue;
		const findingsFile = await saveJson(operation.directory, `${reviewName(target.filename, "")}-validated-findings.json`, { source_file: target.file, accepted, rejected });
		const title = String(args.title || `Legal Review — ${target.filename}`).trim();
		const reportFile = path.join(operation.directory, `legal-review-${reviewName(target.filename, ".md")}`);
		await writeFile(reportFile, markdownReview(title, perspective, accepted), "utf8");
		const docxFile = path.join(operation.directory, `Reviewed_${reviewName(target.filename, ".docx")}`);
		onProgress(`Creating the source-anchored reviewed DOCX for ${target.filename}…`);
		const render = await renderReviewDocx({ sourceFile: target.file, sourceTextFile: target.source_text_file, findingsFile, outputFile: docxFile, title, perspective });
		const annotation = JSON.parse(render.stdout || "{}");
		if (annotation.annotated_count !== accepted.length) throw new Error(`Reviewed DOCX annotation coverage is incomplete for ${target.filename} (${annotation.annotated_count || 0}/${accepted.length}). Refine anchor_text before finalising.`);
		const preview = await preparePreview(docxFile, `Reviewed ${path.basename(target.filename, path.extname(target.filename))}`);
		reviews.push({ target_id: target.id, source_filename: target.filename, accepted, rejected, findings_file: findingsFile, review_markdown: describeArtifact(reportFile, operation.id), reviewed_docx: describeArtifact(docxFile, operation.id), annotation_coverage: annotation, artifact_markup: preview.markup });
	}
	if (!reviews.length) throw new Error("No review target has source-anchored findings to publish.");
	const first = reviews[0];
	return {
		operation_id: operation.id,
		completion: "review-artifacts-ready",
		accepted: allAccepted,
		rejected: allRejected,
		reviews,
		findings_file: first.findings_file,
		review_markdown: first.review_markdown,
		reviewed_docx: first.reviewed_docx,
		annotation_coverage: first.annotation_coverage,
		artifact_markup: first.artifact_markup,
		artifact_markups: reviews.map((item) => item.artifact_markup),
		instruction: "The review deliverables are complete. Give the user the protected download links for every reviewed DOCX and Markdown report returned in reviews. The reviewed DOCX annotation coverage has been verified. Do not expose local paths or file URIs. Do not claim rejected findings as source-grounded. If additional evidence arrives, run review_prepare_document_set again with the entire document set before finalising a revised review.",
	};
}

export async function auditCommercialCoverage(args, { onProgress = () => {} } = {}) {
	if (!args.file_path) throw new Error("file_path is required");
	onProgress("Checking commercial review coverage across material decision areas…");
	const file = await inputFile(args.file_path);
	const inventory = clauseInventory(await extractDocumentText(file.absolute));
	const dimensions = DIMENSIONS.map(([dimension, terms]) => {
		const evidence = inventory.filter((clause) => terms.some((term) => normalized(clause.text).includes(term))).map((clause) => clause.clause_number).filter((item, index, values) => values.indexOf(item) === index);
		return { dimension, status: evidence.length ? "addressed" : "not_present", evidence_clause_numbers: evidence };
	});
	const operation = await operationDirectory("commercial-coverage");
	const auditFile = await saveJson(operation.directory, "commercial-coverage-audit.json", { source_file: file.absolute, dimensions });
	return {
		operation_id: operation.id,
		audit_file: auditFile,
		dimensions,
		instruction: "Use this as a completeness checklist. Read every material clause and identify only source-grounded risks to the protected party; missing boilerplate alone is not a clause finding.",
	};
}

export async function renderReviewReport(args, { onProgress = () => {} } = {}) {
	if (!args.findings_file) throw new Error("findings_file is required");
	onProgress("Preparing validated native review findings for document rendering…");
	const findings = JSON.parse(await readFile(args.findings_file, "utf8"));
	const accepted = Array.isArray(findings.accepted) ? findings.accepted : [];
	const operation = await operationDirectory("native-review-report");
	const reportFile = path.join(operation.directory, "native-review-report.md");
	const title = String(args.title || "Sri Lankan Legal Review").trim();
	const sections = [
		"# " + title, "", "Protected party: " + String(args.perspective || "Not specified"), "", "## Validated findings", "",
		...accepted.flatMap((item, index) => [
			"### " + (index + 1) + ". " + item.title + " — Clause " + item.clause_number, "",
			"**Source clause:** " + item.anchor_text, "",
			"**Category:** " + item.category + "; **severity:** " + item.severity, "",
			item.explanation || "Further legal/commercial explanation is required.", "",
			"**Recommended protection:** " + (item.recommendation || "Specify a negotiated amendment."), "",
		]),
	];
	await writeFile(reportFile, sections.join("\n").trim() + "\n", "utf8");
	return {
		operation_id: operation.id,
		report_file: reportFile,
		report_artifact: describeArtifact(reportFile, operation.id),
		findings: accepted,
		instruction: "Use the DOCX skill to create an annotated DOCX from the primary document and accepted findings. Preserve the original source document and attach comments only at accepted anchor text.",
	};
}
