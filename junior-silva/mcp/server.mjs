#!/usr/bin/env node
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import {
	finalizeReviewDocument,
	prepareReviewDocumentSet,
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
	{ name: "review_prepare_document_set", description: "Prepare a complete Sri Lankan legal review context from the primary document plus every related supporting file, annexure, evidence file, or later-supplied attachment. It reads the complete set, identifies primary/supporting material, maps source clauses, and checks coverage areas. Use this once before a substantive review; it does not ask the user questions. First consider whether supplied evidence resolves factual gaps. Only if a material fact still cannot be inferred should you ask the user in ordinary chat. The user may answer, say 'review normally'/'skip', or supply another document. After analysis and any legal research, call review_finalize_document to create the reviewed DOCX and Markdown report.", inputSchema: { type: "object", additionalProperties: false, properties: { file_path: { type: "string" }, file_paths: { type: "array", minItems: 1, items: { type: "string" } }, primary_file_path: { type: "string" }, user_context: { type: "string" } } }, annotations: { title: "Prepare legal review", readOnlyHint: true, destructiveHint: false } },
	{ name: "review_finalize_document", description: "Finish a prepared legal review. Give it the review_context_file returned by review_prepare_document_set and only source-grounded findings. Each finding needs exact anchor_text from the primary document, clause_number where known, category (legal/commercial), severity, title, explanation, recommendation, and any authority_urls retained from Sri Lankan legal research. This tool validates anchors, rejects unsupported findings, and creates both a professional legal-review.md and Reviewed_document.docx. For a DOCX source, comments/highlights are applied at original clause text; for PDF/text it creates a standalone review report. Call it whenever the user requested a document review, unless they expressly requested chat-only analysis.", inputSchema: { type: "object", additionalProperties: false, required: ["review_context_file", "findings"], properties: { review_context_file: { type: "string" }, findings: { type: "array", minItems: 1, items: { type: "object", additionalProperties: true } }, perspective: { type: "string" }, title: { type: "string" } } }, annotations: { title: "Finalize reviewed document", readOnlyHint: false, destructiveHint: false } },
	{ name: "legal_precedent_search", description: "Search the private, read-only drafting-precedent corpus for structure or clause patterns. Use only for substantial Sri Lankan legal drafting where a precedent improves form. It is not legal authority: never cite it, reveal its path, or treat it as law.", inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 3 }, document_type: { type: "string" }, max_results: { type: "integer", minimum: 1, maximum: 10 } } }, annotations: { title: "Search drafting precedents", readOnlyHint: true, destructiveHint: false } },
	{ name: "legal_precedent_read", description: "Read a bounded excerpt of a private precedent selected by legal_precedent_search. Use the structure and clause pattern only. Do not copy source-specific facts, parties, values, personal data, foreign-law provisions, or legal conclusions.", inputSchema: { type: "object", additionalProperties: false, required: ["precedent_id"], properties: { precedent_id: { type: "string" } } }, annotations: { title: "Read drafting precedent", readOnlyHint: true, destructiveHint: false } },
	{ name: "legal_validate_draft", description: "Check a final Markdown or text legal draft for unresolved placeholders and basic drafting hygiene before producing the requested work product. Do not use it as legal validation; validate legal propositions separately with Sri Lankan RAG research.", inputSchema: { type: "object", additionalProperties: false, required: ["file_path"], properties: { file_path: { type: "string" } } }, annotations: { title: "Validate legal draft", readOnlyHint: true, destructiveHint: false } },
	{ name: "rag_chat_research", description: "Research a Sri Lankan legal question through the citation-linked legal research service. The result includes answer plus a delivery contract and linked_authorities. DELIVERY-MODE DECISION: use direct_answer ONLY when the user's requested final response is legal research itself. If the user also asks for an email, letter, draft, submission, complaint, advice note, or any separately written work product—even if you will write it yourself without another tool—use supporting_work_product. STRICT CITATION DELIVERY: direct_answer must be delivered verbatim, preserving every Markdown hyperlink, heading, authority, and conclusion. For supporting_work_product, preserve every authority URL associated with each retained legal proposition; never invent or substitute a citation. Optional text or JSON files can supply relevant context.", inputSchema: { type: "object", additionalProperties: false, required: ["question", "delivery_mode"], properties: { question: { type: "string" }, delivery_mode: { type: "string", enum: ["direct_answer", "supporting_work_product"], description: "direct_answer only for research as the final response; supporting_work_product for research supporting an email, letter, draft, complaint, submission, or explanation." }, context_files: { type: "array", items: { type: "string" }, description: "Optional local UTF-8 text, Markdown, or JSON context files." } } } },
	{ name: "legal_source_retrieve_details", description: "Retrieve bounded underlying detail from the same read-only Sri Lankan legal source collections used behind RAG research. Use RAG Chat first for normal research, synthesis, authority selection and linked citations. Use this only when the answer cites or identifies a case, Act/article/section, or law-book passage and you genuinely need more source detail—such as the judgment text, original Act/section text, or commentary passage—to answer accurately. Do not use it as a replacement for RAG’s legal research pipeline. For cases, chunks and books this reads Typesense. For legislation it uses Lex’s structured SQLite authority API rather than the unreliable Typesense fallback. For an Act, first find its record; retrieve the Act ID for its ordered original sections, or pass the Act ID with section_number for one exact section. A numeric section-row ID may also be retrieved directly. Use metadata only when high-level Act details are enough. Choose only fields needed. Returned material is source evidence, not a conclusion; preserve returned source links and never invent amendment history or amendment URLs.", inputSchema: { type: "object", additionalProperties: false, required: ["source", "operation"], properties: { source: { type: "string", enum: ["case_decision", "case_chunk", "legislation", "book"] }, operation: { type: "string", enum: ["find", "retrieve"] }, query: { type: "string", description: "Focused legal text query or authority name." }, record_id: { type: "string", description: "Identifier returned by a prior call: an Act ID such as legislation_C_145, a numeric Lex section-row ID, or a case/source record id." }, case_number: { type: "string" }, party_name: { type: "string" }, legislation_title: { type: "string" }, legislation_scope: { type: "string", enum: ["legislation", "section", "metadata"], description: "For source=legislation: retrieve full Act sections, one exact Act section, or metadata only." }, section_number: { type: "string", description: "Exact section number under the supplied Act ID. Do not pass it as a section record id." }, fields: { type: "array", items: { type: "string" }, description: "Only request fields needed; the result reports supported fields." }, max_results: { type: "integer", minimum: 1, maximum: 8 }, max_field_characters: { type: "integer", minimum: 1000, maximum: 60000 } } }, annotations: { title: "Retrieve legal source detail", readOnlyHint: true, destructiveHint: false } },
	{ name: "translator_siriwardena_translate_document", description: "Translate a PDF, DOC, DOCX, or supported image between English, Sinhala, and Tamil with Translator Siriwardena. Returns translated text and local generated document paths when available.", inputSchema: { type: "object", additionalProperties: false, required: ["file_path", "target_language"], properties: { file_path: { type: "string" }, target_language: { type: "string" }, instructions: { type: "string" } } } },
	{ name: "web_search_public_legal_sources", description: "Search current public web sources when the question depends on a current Gazette, regulation, legal-news development, current parliamentary/court status, international law, or material not expected in the Sri Lankan legal corpus. Do not put client facts or personal data in the query. Use RAG for stable Sri Lankan legal authorities; use both tools when a stable rule may have changed. Returns linked sources only—read their limits before stating a legal conclusion.", inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 3, maxLength: 320 }, max_results: { type: "integer", minimum: 1, maximum: 10 } } } },
	{ name: "code_runner_data_transform", description: "Run a small JavaScript data transformation for calculations, schedules, tables, or structured analysis. This is an isolated data-only runner: no network, filesystem, modules, shell commands, or document creation. Code receives `input` and must return a JSON-serializable value. Use it when calculation or deterministic reshaping materially improves a legal work product; do not use it for ordinary prose.", inputSchema: { type: "object", additionalProperties: false, required: ["code"], properties: { code: { type: "string", minLength: 1, maxLength: 12000 }, input: {} } } },
	{ name: "workbench_publish_artifact", description: "Publish a completed legal artifact that Pi created with a document skill in Junior Silva's workspace. Call this after creating a final PPTX, XLSX, DOCX, PDF, Markdown, text, or JSON file so the user receives a protected download URL. Do not publish source scripts, temporary files, or files outside Junior Silva's workspace.", inputSchema: { type: "object", additionalProperties: false, required: ["file_path"], properties: { file_path: { type: "string", description: "Absolute path of the completed artifact under JUNIOR_SILVA_WORKSPACE_ROOT." }, title: { type: "string", description: "Optional safe download filename without an extension." } } }, annotations: { title: "Publish completed legal artifact", readOnlyHint: false, destructiveHint: false } },
	{ name: "translator_siriwardena_translate_text", description: "Translate supplied text between English, Sinhala, and Tamil with Translator Siriwardena.", inputSchema: { type: "object", additionalProperties: false, required: ["text", "target_language"], properties: { text: { type: "string" }, target_language: { type: "string" } } } },
	{ name: "librechat_prepare_document_preview", description: "Prepare a safe user-visible LibreChat side-panel preview for one completed local DOCX, PDF, PPTX, XLSX, Markdown, text, or JSON deliverable. DEFAULT DELIVERY RULE: after the final user-facing artifact exists, call this once for the primary final file before replying, unless the user asked for download-only output or the result is a short chat-only email. Use the completed file path returned by Reviewer Perera, Drafter Weeramantry, Translator Siriwardena, or workbench_publish_artifact. Do not use it for intermediate files, source scripts, duplicate formats, internal working files, or an artifact already previewed in this turn. It does not modify the original file or replace its protected download.", inputSchema: { type: "object", additionalProperties: false, required: ["file_path"], properties: { file_path: { type: "string", description: "Completed local artifact path returned by a prior tool." }, title: { type: "string", description: "Optional concise title shown in LibreChat's artifact panel." } } }, annotations: { title: "Prepare document preview", readOnlyHint: true, destructiveHint: false } },
];

const handlers = new Map([
	["review_prepare_document_set", prepareReviewDocumentSet], ["review_finalize_document", finalizeReviewDocument],
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
			return response({ content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output });
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
