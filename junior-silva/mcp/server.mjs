#!/usr/bin/env node
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import {
	finalizeReviewDocument,
	prepareReviewDocumentSet,
	recordReviewCheckpointOutcome,
} from "../core/native-review.mjs";
import { readPrecedent, searchPrecedents, validateDraft } from "../core/precedents.mjs";
import { prepareDocumentPreview } from "../services/preview.mjs";
import { research } from "../services/rag.mjs";
import { translateDocument, translateText } from "../services/translator.mjs";
import { searchPublicLegalSources } from "../services/web.mjs";
import { runDataCode } from "../services/code-runner.mjs";
import { publishWorkspaceArtifact } from "../core/files.mjs";
import { retrieveLegalSourceDetails } from "../core/typesense-legal-sources.mjs";

const tools = [
	{ name: "review_prepare_document_set", description: "Prepare a complete Sri Lankan legal review set from every supplied agreement, pleading, annexure, image, evidence file, or later attachment. It extracts all readable documents, suggests review targets versus supporting material, and maps clauses/coverage separately for every target. Set review_file_paths when the user identifies documents to mark up; set supporting_file_paths for context-only documents. Without explicit roles, substantive agreements/pleadings are selected as review targets while clear annexures/evidence are supporting. If the result is genuinely ambiguous, ask the user before finalising. The returned context begins an evidence checkpoint. After an actual later user answer, call review_record_checkpoint_outcome; if a document is supplied, prepare a fresh combined set. Only then finalise every selected target.", inputSchema: { type: "object", additionalProperties: false, properties: { file_path: { type: "string" }, file_paths: { type: "array", minItems: 1, items: { type: "string" } }, primary_file_path: { type: "string", description: "Backward-compatible alias for a single review target." }, review_file_paths: { type: "array", items: { type: "string" }, description: "One or more documents that should each receive their own annotated review." }, supporting_file_paths: { type: "array", items: { type: "string" }, description: "Context-only documents that inform the review but are not marked up." }, user_context: { type: "string" } } }, annotations: { title: "Prepare legal review", readOnlyHint: true, destructiveHint: false } },
	{ name: "review_record_checkpoint_outcome", description: "Record an actual user response to the evidence checkpoint of a prepared substantive review. Call this only in a later turn after the user has answered, said 'review normally', or said 'skip'—never automatically in the same turn as review_prepare_document_set. If the user supplied a new document, do not call this: instead call review_prepare_document_set again with the complete combined file set. This tool does not ask the question; Pi asks naturally in chat.", inputSchema: { type: "object", additionalProperties: false, required: ["review_context_file", "outcome"], properties: { review_context_file: { type: "string" }, outcome: { type: "string", enum: ["review_normally", "skip", "answered"] }, user_response: { type: "string" } } }, annotations: { title: "Record review evidence decision", readOnlyHint: false, destructiveHint: false } },
	{ name: "review_finalize_document", description: "Finish every selected review target only after its evidence checkpoint is completed or the user explicitly requested chat-only analysis. Give it the review_context_file and source-grounded findings. Each finding needs exact anchor_text, clause_number where known, category, severity, title, explanation, recommendation, and authority_urls. For multiple targets, include target_id returned by preparation (or target_file) on each finding; an unlabelled anchor is accepted only when it matches exactly one selected target. Set compliance_status='Illegal' only with supporting Sri Lankan authority_urls; otherwise classify lawful adverse wording as commercial_impact='Material Commercial Risk' or 'Negotiation Point'. This tool validates anchors, verifies annotation coverage, creates a separate reviewed DOCX and Markdown report for each target, returns protected download links, and emits a LibreChat preview for every reviewed DOCX. Every accepted finding receives a comment and highlight at the original DOCX clause or corresponding extracted PDF/text/image clause.", inputSchema: { type: "object", additionalProperties: false, required: ["review_context_file", "findings"], properties: { review_context_file: { type: "string" }, findings: { type: "array", minItems: 1, items: { type: "object", additionalProperties: true } }, perspective: { type: "string" }, title: { type: "string" } } }, annotations: { title: "Finalize reviewed document", readOnlyHint: false, destructiveHint: false } },
	{ name: "legal_precedent_search", description: "Search the private, read-only drafting-precedent corpus for structure or clause patterns. Use only for substantial Sri Lankan legal drafting where a precedent improves form. It is not legal authority: never cite it, reveal its path, or treat it as law.", inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 3 }, document_type: { type: "string" }, max_results: { type: "integer", minimum: 1, maximum: 10 } } }, annotations: { title: "Search drafting precedents", readOnlyHint: true, destructiveHint: false } },
	{ name: "legal_precedent_read", description: "Read a bounded excerpt of a private precedent selected by legal_precedent_search. Use the structure and clause pattern only. Do not copy source-specific facts, parties, values, personal data, foreign-law provisions, or legal conclusions.", inputSchema: { type: "object", additionalProperties: false, required: ["precedent_id"], properties: { precedent_id: { type: "string" } } }, annotations: { title: "Read drafting precedent", readOnlyHint: true, destructiveHint: false } },
	{ name: "legal_validate_draft", description: "Check a final Markdown or text legal draft for unresolved placeholders and basic drafting hygiene before producing the requested work product. Do not use it as legal validation; validate legal propositions separately with Sri Lankan RAG research.", inputSchema: { type: "object", additionalProperties: false, required: ["file_path"], properties: { file_path: { type: "string" } } }, annotations: { title: "Validate legal draft", readOnlyHint: true, destructiveHint: false } },
	{ name: "rag_chat_research", description: "Research a Sri Lankan legal question through the citation-linked legal research service. The result includes answer plus a delivery contract and linked_authorities. DELIVERY-MODE DECISION: use direct_answer ONLY when the user's requested final response is legal research itself. If the user also asks for an email, letter, draft, submission, complaint, advice note, or any separately written work product—even if you will write it yourself without another tool—use supporting_work_product. STRICT CITATION DELIVERY: direct_answer must be delivered verbatim, preserving every Markdown hyperlink, heading, authority, and conclusion. For supporting_work_product, preserve every authority URL associated with each retained legal proposition; never invent or substitute a citation. Optional text or JSON files can supply relevant context.", inputSchema: { type: "object", additionalProperties: false, required: ["question", "delivery_mode"], properties: { question: { type: "string" }, delivery_mode: { type: "string", enum: ["direct_answer", "supporting_work_product"], description: "direct_answer only for research as the final response; supporting_work_product for research supporting an email, letter, draft, complaint, submission, or explanation." }, context_files: { type: "array", items: { type: "string" }, description: "Optional local UTF-8 text, Markdown, or JSON context files." } } } },
	{ name: "legal_source_retrieve_details", description: "Read bounded material from the read-only Sri Lankan legal source collections behind research. Use operation=case_catalog first for a simple indexed case list defined by judge, year/month, subject, court, report series, report year/volume/page, or action type. Pass every stated constraint separately. The tool resolves ordinary judge spelling differences, omitted middle names, court names, report abbreviations, and month names against bounded indexed facets; ask the user only if the result is genuinely ambiguous. Never compose raw database filters. Use operation=capabilities only when you need to learn the documented safe filter set; do not expose internal source configuration. Use operation=amendment_catalog with source=legislation, legislation_title, and amendment_year for a factual list of structured Lex amendment entries—for example, every indexed amendment to the Companies Act in 2025. It returns all matching entries in the selected Act record, not a synthesized conclusion. Use retrieve for only selected case/Act records needing fuller text. Use RAG Chat for holdings, legal analysis, authority selection, comparison, or a synthesized citation-linked conclusion. For cases, chunks and books this reads Typesense. Legislation uses Lex’s structured SQLite authority API rather than the unreliable Typesense fallback. Returned material is evidence, not a conclusion: preserve source links and never invent amendment history or URLs.", inputSchema: { type: "object", additionalProperties: false, required: ["source", "operation"], properties: { source: { type: "string", enum: ["case_decision", "case_chunk", "legislation", "book"] }, operation: { type: "string", enum: ["find", "retrieve", "case_catalog", "amendment_catalog", "capabilities"] }, query: { type: "string", description: "Focused legal text query or authority name. For case_catalog, use subject_query for a legal topic." }, subject_query: { type: "string", description: "For case_catalog: pass a stated legal topic, such as tax or murder, so it is searched in indexed decisions." }, judge_name: { type: "string", description: "For case_catalog: a natural judge name. The tool safely resolves minor spelling and name-format differences, but reports genuine ambiguity." }, decision_year: { type: "integer", minimum: 1800, maximum: 2200, description: "For case_catalog: exact decision year." }, decision_month: { type: "string", description: "For case_catalog: month number or natural month name, resolved against indexed values." }, court: { type: "string", description: "For case_catalog: natural court name or abbreviation, resolved against indexed values." }, report: { type: "string", description: "For case_catalog: report series such as NLR or CLW, resolved against indexed values." }, report_year: { type: "integer", minimum: 1800, maximum: 2200, description: "For case_catalog: exact law-report year." }, volume_num: { type: "integer", minimum: 1, maximum: 100000, description: "For case_catalog: exact report volume." }, page_num: { type: "integer", minimum: 1, maximum: 100000, description: "For case_catalog: exact report page." }, action_type: { type: "string", description: "For case_catalog: action type, resolved against indexed values." }, amendment_year: { type: "integer", minimum: 1800, maximum: 2200, description: "For source=legislation and operation=amendment_catalog: year in which structured amendment entries are sought." }, page: { type: "integer", minimum: 1, maximum: 100, description: "For case_catalog only: result page." }, page_size: { type: "integer", minimum: 1, maximum: 20, description: "For case_catalog only: cases per page." }, record_id: { type: "string", description: "Identifier returned by a prior call: an Act ID such as legislation_C_145, a numeric Lex section-row ID, or a case/source record id." }, case_number: { type: "string" }, party_name: { type: "string" }, legislation_title: { type: "string", description: "For legislation discovery or amendment_catalog: Act title." }, legislation_scope: { type: "string", enum: ["legislation", "section", "metadata"], description: "For source=legislation retrieve: full Act sections, one exact Act section, or metadata only." }, section_number: { type: "string", description: "Exact section number under the supplied Act ID. Do not pass it as a section record id." }, fields: { type: "array", items: { type: "string" }, description: "Only request fields needed; case_catalog always retains stable case, topic-evidence, judge, report, year, and link fields." }, max_results: { type: "integer", minimum: 1, maximum: 8 }, max_field_characters: { type: "integer", minimum: 1000, maximum: 60000 } } }, annotations: { title: "Retrieve legal source detail", readOnlyHint: true, destructiveHint: false } },
	{ name: "translator_siriwardena_translate_document", description: "Translate a PDF, DOC, DOCX, or supported image between English, Sinhala, and Tamil with Translator Siriwardena. Returns translated text and local generated document paths when available.", inputSchema: { type: "object", additionalProperties: false, required: ["file_path", "target_language"], properties: { file_path: { type: "string" }, target_language: { type: "string" }, instructions: { type: "string" } } } },
	{ name: "web_search_public_legal_sources", description: "Search current public web sources when the question depends on a current Gazette, regulation, legal-news development, current parliamentary/court status, international law, or material not expected in the Sri Lankan legal corpus. Do not put client facts or personal data in the query. Use RAG for stable Sri Lankan legal authorities; use both tools when a stable rule may have changed. Returns linked sources only—read their limits before stating a legal conclusion.", inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 3, maxLength: 320 }, max_results: { type: "integer", minimum: 1, maximum: 10 } } } },
	{ name: "code_runner_data_transform", description: "Run a small JavaScript data transformation for calculations, schedules, tables, or structured analysis. This is an isolated data-only runner: no network, filesystem, modules, shell commands, or document creation. Code receives `input` and must return a JSON-serializable value. Use it when calculation or deterministic reshaping materially improves a legal work product; do not use it for ordinary prose.", inputSchema: { type: "object", additionalProperties: false, required: ["code"], properties: { code: { type: "string", minLength: 1, maxLength: 12000 }, input: {} } } },
	{ name: "workbench_publish_artifact", description: "Publish a completed legal artifact that Pi created with a document skill in Junior Silva's workspace. Call this only after the requested PPTX, XLSX, DOCX, PDF, Markdown, text, or JSON file has been validated. A file that merely exists in the workspace is not delivered: do not send the final answer until this tool returns its protected download URL. This tool also prepares a safe preview. Do not publish source scripts, temporary files, or files outside Junior Silva's workspace.", inputSchema: { type: "object", additionalProperties: false, required: ["file_path"], properties: { file_path: { type: "string", description: "Absolute path of the completed artifact under JUNIOR_SILVA_WORKSPACE_ROOT." }, title: { type: "string", description: "Optional safe download filename without an extension." } } }, annotations: { title: "Publish completed legal artifact", readOnlyHint: false, destructiveHint: false } },
	{ name: "translator_siriwardena_translate_text", description: "Translate supplied text between English, Sinhala, and Tamil with Translator Siriwardena.", inputSchema: { type: "object", additionalProperties: false, required: ["text", "target_language"], properties: { text: { type: "string" }, target_language: { type: "string" } } } },
	{ name: "librechat_prepare_document_preview", description: "Prepare a safe user-visible LibreChat side-panel preview for one completed local DOCX, PDF, PPTX, XLSX, Markdown, text, or JSON deliverable. DEFAULT DELIVERY RULE: after the final user-facing artifact exists, call this once for the primary final file before replying, unless the user asked for download-only output or the result is a short chat-only email. Use the completed file path returned by Reviewer Perera, Drafter Weeramantry, Translator Siriwardena, or workbench_publish_artifact. Do not use it for intermediate files, source scripts, duplicate formats, internal working files, or an artifact already previewed in this turn. It does not modify the original file or replace its protected download.", inputSchema: { type: "object", additionalProperties: false, required: ["file_path"], properties: { file_path: { type: "string", description: "Completed local artifact path returned by a prior tool." }, title: { type: "string", description: "Optional concise title shown in LibreChat's artifact panel." } } }, annotations: { title: "Prepare document preview", readOnlyHint: true, destructiveHint: false } },
];

const handlers = new Map([
	["review_prepare_document_set", prepareReviewDocumentSet], ["review_record_checkpoint_outcome", recordReviewCheckpointOutcome], ["review_finalize_document", finalizeReviewDocument],
	["legal_precedent_search", searchPrecedents],
	["legal_precedent_read", readPrecedent], ["legal_validate_draft", validateDraft],
	["rag_chat_research", research],
	["legal_source_retrieve_details", retrieveLegalSourceDetails],
	["web_search_public_legal_sources", searchPublicLegalSources],
	["code_runner_data_transform", runDataCode],
	["workbench_publish_artifact", (args) => publishWorkspaceArtifact(args.file_path, args.title)],
	["translator_siriwardena_translate_document", translateDocument], ["translator_siriwardena_translate_text", translateText],
	["librechat_prepare_document_preview", prepareDocumentPreview],
]);

export const mcpTools = tools;

function publicArtifact(artifact) {
	if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return undefined;
	const value = artifact;
	const result = {};
	for (const key of ["name", "media_type", "download_url"]) {
		if (typeof value[key] === "string" && value[key]) result[key] = value[key];
	}
	return Object.keys(result).length ? result : undefined;
}

// A completed multi-document review includes full renderer HTML for the
// LibreChat extension. It belongs in structuredContent, not in the model-facing
// text result: embedding it there exceeds Pi's 50 KB tool-result limit and
// prevents Pi from seeing the download links.
export function compactToolResult(toolName, output) {
	if (toolName !== "review_finalize_document" || !output || typeof output !== "object" || Array.isArray(output) || output.completion !== "review-artifacts-ready") return output;
	const reviews = Array.isArray(output.reviews) ? output.reviews.flatMap((review) => {
		if (!review || typeof review !== "object" || Array.isArray(review)) return [];
		const row = {
			target_id: typeof review.target_id === "string" ? review.target_id : undefined,
			source_filename: typeof review.source_filename === "string" ? review.source_filename : undefined,
			reviewed_docx: publicArtifact(review.reviewed_docx),
			review_markdown: publicArtifact(review.review_markdown),
			annotation_coverage: review.annotation_coverage && typeof review.annotation_coverage === "object" ? review.annotation_coverage : undefined,
		};
		return [Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined))];
	}) : [];
	return {
		operation_id: typeof output.operation_id === "string" ? output.operation_id : undefined,
		completion: output.completion,
		reviews,
		reviewed_docx: publicArtifact(output.reviewed_docx),
		review_markdown: publicArtifact(output.review_markdown),
		instruction: "Review artifacts are ready. The user-facing response automatically receives their protected download links and LibreChat previews. Summarize the source-grounded findings without exposing internal paths.",
	};
}

function progressReporter(token, onProgress) {
	let progress = 0;
	return (message) => {
		if (token === undefined || token === null || !message) return;
		progress += 1;
		onProgress({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress, message: String(message).replace(/\s+/g, " ").slice(0, 500) } });
	};
}

export async function dispatchMcpRequest(message, { onProgress = () => {} } = {}) {
	const response = (result) => ({ jsonrpc: "2.0", id: message.id, result });
	const rpcError = (code, errorMessage) => ({ jsonrpc: "2.0", id: message.id, error: { code, message: errorMessage } });
	if (message.method === "initialize") return response({ protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "junior-silva-legal-services", version: "2.1.0" }, instructions: "Independent specialist tools for Sri Lankan legal research, source-anchored native document review, native legal drafting, translation, and legal artifacts. Select tools from their capability descriptions; no fixed workflow is imposed." });
	if (message.method === "notifications/initialized") return undefined;
	if (message.method === "ping") return response({});
	if (message.method === "tools/list") return response({ tools });
	if (message.method === "resources/list") return response({ resources: [] });
	if (message.method === "resources/templates/list") return response({ resourceTemplates: [] });
	if (message.method === "prompts/list") return response({ prompts: [] });
	if (message.method === "tools/call") {
		const handler = handlers.get(message.params?.name);
		if (!handler) return rpcError(-32602, `Unknown tool: ${message.params?.name}`);
		try {
			const toolProgress = progressReporter(message.params?._meta?.progressToken, onProgress);
			const output = await handler(message.params?.arguments || {}, { onProgress: toolProgress });
			return response({ content: [{ type: "text", text: JSON.stringify(compactToolResult(message.params?.name, output), null, 2) }], structuredContent: output });
		}
		catch (caught) { return response({ content: [{ type: "text", text: caught instanceof Error ? caught.message : String(caught) }], isError: true }); }
	}
	if (message.id !== undefined) return rpcError(-32601, `Method not found: ${message.method}`);
	return undefined;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
	const lines = readline.createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
	lines.on("line", (line) => {
		if (!line.trim()) return;
		try { void dispatchMcpRequest(JSON.parse(line), { onProgress: send }).then((value) => { if (value) send(value); }); } catch (caught) { console.error(caught instanceof Error ? caught.message : String(caught)); }
	});
}
