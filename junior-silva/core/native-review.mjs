import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildReviewPacket, extractDocumentText } from "./document-text.mjs";
import { inputFile, operationDirectory, saveJson, describeArtifact } from "./files.mjs";
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
	return {
		accepted: hasSourceAnchor(source, anchor),
		finding: {
			id: createHash("sha256").update(normalized(anchor) + "\0" + normalized(item.explanation)).digest("hex").slice(0, 16),
			clause_number: String(item.clause_number || matchingClause?.clause_number || "N/A"),
			anchor_text: anchor,
			category: String(item.category || item.review_axis || "commercial").toLowerCase() === "legal" ? "legal" : "commercial",
			severity: String(item.severity || item.commercial_impact || item.compliance_status || "negotiation point").toLowerCase(),
			title: String(item.title || item.legal_concept || "Contractual risk").trim(),
			explanation: String(item.explanation || "").trim(),
			recommendation: String(item.recommendation || item.suggestion || "").trim(),
			authority_urls: Array.isArray(item.authority_urls) ? item.authority_urls.filter((url) => typeof url === "string" && /^https?:\/\//i.test(url)) : [],
		},
	};
}

export async function readDocumentSet(args, { onProgress = () => {} } = {}) {
	const filePaths = Array.isArray(args.file_paths) ? args.file_paths : [];
	const requested = [...new Set([...filePaths, ...(args.file_path ? [args.file_path] : []), ...(args.primary_file_path ? [args.primary_file_path] : [])])];
	if (!requested.length) throw new Error("Provide primary_file_path, file_path, or file_paths.");
	onProgress("Reading the supplied legal documents and supporting evidence…");
	const files = await Promise.all(requested.map((filename) => inputFile(filename)));
	const primary = path.resolve(args.primary_file_path || files[0].absolute);
	const documents = [];
	for (const file of files) {
		const text = (await extractDocumentText(file.absolute)).trim();
		if (!text) throw new Error(file.name + " did not contain extractable text");
		documents.push({
			path: file.absolute,
			filename: file.name,
			sha256: createHash("sha256").update(file.bytes).digest("hex"),
			role: file.absolute === primary ? "primary" : "supporting",
			characters: text.length,
			excerpt: text.slice(0, 1800),
		});
	}
	const operation = await operationDirectory("native-review-context");
	const packetFile = path.join(operation.directory, "document-set.md");
	await writeFile(packetFile, await buildReviewPacket(documents.map((document) => document.path), primary), "utf8");
	const ledgerFile = await saveJson(operation.directory, "document-ledger.json", {
		created_at: new Date().toISOString(), primary_file: primary, documents, user_context: String(args.user_context || "").trim(),
	});
	return {
		operation_id: operation.id,
		documents,
		packet_file: packetFile,
		ledger_file: ledgerFile,
		instruction: "Read this packet before asking more questions or reviewing. Supporting documents may answer earlier questions; identify what they resolve and ask only for genuinely missing facts.",
	};
}

/**
 * Build the complete, reusable evidence packet for a review.  This deliberately
 * performs no interview: Pi can see the supplied evidence first and only then
 * decide whether a factual question is genuinely necessary.
 */
export async function prepareReviewDocumentSet(args, { onProgress = () => {} } = {}) {
	const documentSet = await readDocumentSet(args, { onProgress });
	const primary = documentSet.documents.find((document) => document.role === "primary");
	if (!primary) throw new Error("A primary review document could not be identified.");
	onProgress("Mapping the primary document and checking material commercial coverage…");
	const source = await extractDocumentText(primary.path);
	const clauses = clauseInventory(source);
	const dimensions = DIMENSIONS.map(([dimension, terms]) => {
		const evidence = clauses.filter((clause) => terms.some((term) => normalized(clause.text).includes(term)))
			.map((clause) => clause.clause_number).filter((item, index, values) => values.indexOf(item) === index);
		return { dimension, status: evidence.length ? "addressed" : "not_present", evidence_clause_numbers: evidence };
	});
	const operation = await operationDirectory("review-preparation");
	const sourceTextFile = path.join(operation.directory, "primary-source.txt");
	await writeFile(sourceTextFile, source, "utf8");
	const checkpointRequired = requiresEvidenceCheckpoint(args.user_context);
	const contextFile = await saveJson(operation.directory, "review-context.json", {
		created_at: new Date().toISOString(),
		primary_file: primary.path,
		primary_filename: primary.filename,
		source_text_file: sourceTextFile,
		document_packet: documentSet.packet_file,
		document_ledger: documentSet.ledger_file,
		documents: documentSet.documents,
		clauses,
		commercial_coverage: dimensions,
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
		primary_file: primary.path,
		primary_filename: primary.filename,
		document_packet: documentSet.packet_file,
		document_ledger: documentSet.ledger_file,
		clause_inventory: clauses,
		commercial_coverage: dimensions,
		checkpoint: { required: checkpointRequired, status: checkpointRequired ? "pending" : "not_required" },
		instruction: checkpointRequired
			? "This preparation contains all supplied evidence, source anchors, and coverage prompts. Review the packet before deciding whether a short factual question is necessary. Do not invent an answer to any question. Before calling review_finalize_document, ask the user once whether they want to provide more relevant evidence; they may upload it, answer, say 'review normally', or say 'skip'. After an actual user response, call review_record_checkpoint_outcome. Do not record an outcome yourself in the same turn."
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
			"**Category:** " + item.category + "; **severity:** " + item.severity, "",
			item.explanation || "Further legal/commercial explanation is required.", "",
			"**Recommended protection:** " + (item.recommendation || "Specify a negotiated amendment."), "",
			...(item.authority_urls.length ? ["**Authorities:** " + item.authority_urls.map((url) => `[source](${url})`).join("; "), ""] : []),
		]),
	].join("\n").trim() + "\n";
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
	const source = await readFile(context.source_text_file, "utf8");
	const inventory = Array.isArray(context.clauses) ? context.clauses : clauseInventory(source);
	onProgress("Validating proposed findings against the exact primary-document wording…");
	const accepted = [];
	const rejected = [];
	const seen = new Set();
	for (const candidate of args.findings) {
		const result = normalisedFinding(candidate, inventory, source);
		const key = normalized(result.finding.anchor_text) + "\0" + result.finding.category;
		if (!result.accepted) rejected.push({ finding: result.finding, reason: "The proposed source anchor was not found reliably in the primary document." });
		else if (!seen.has(key)) { seen.add(key); accepted.push(result.finding); }
	}
	if (!accepted.length) throw new Error("No findings could be anchored reliably in the source document. Refine the exact anchor_text before finalising.");
	const operation = await operationDirectory("review-final");
	const findingsFile = await saveJson(operation.directory, "validated-findings.json", { source_file: context.primary_file, accepted, rejected });
	const title = String(args.title || `Legal Review — ${context.primary_filename}`).trim();
	const perspective = String(args.perspective || "Not specified").trim();
	const reportFile = path.join(operation.directory, "legal-review.md");
	await writeFile(reportFile, markdownReview(title, perspective, accepted), "utf8");
	const docxFile = path.join(operation.directory, "Reviewed_document.docx");
	onProgress("Creating the source-anchored reviewed DOCX and clause-by-clause report…");
	const render = await renderReviewDocx({ sourceFile: context.primary_file, sourceTextFile: context.source_text_file, findingsFile, outputFile: docxFile, title, perspective });
	const annotation = JSON.parse(render.stdout || "{}");
	if (annotation.annotated_count !== accepted.length) {
		throw new Error(`Reviewed DOCX annotation coverage is incomplete (${annotation.annotated_count || 0}/${accepted.length}). Refine anchor_text to match the original Word clauses before finalising.`);
	}
	const preview = await preparePreview(docxFile, "Reviewed document");
	return {
		operation_id: operation.id,
		completion: "review-artifacts-ready",
		accepted,
		rejected,
		findings_file: findingsFile,
		review_markdown: describeArtifact(reportFile, operation.id),
		reviewed_docx: describeArtifact(docxFile, operation.id),
		annotation_coverage: annotation,
		artifact_markup: preview.markup,
		instruction: "The review deliverables are complete. Give the user the Reviewed_document.docx and legal-review.md artifacts. The reviewed DOCX annotation coverage has been verified. Do not claim rejected findings as source-grounded. If additional evidence arrives, run review_prepare_document_set again with the entire document set before finalising a revised review.",
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
