#!/usr/bin/env node
import readline from "node:readline";
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

const tools = [
	{ name: "review_prepare_document_set", description: "Prepare a complete Sri Lankan legal review context from the primary document plus every related supporting file, annexure, evidence file, or later-supplied attachment. It reads the complete set, identifies primary/supporting material, maps source clauses, and checks coverage areas. Use this once before a substantive review; it does not ask the user questions. First consider whether supplied evidence resolves factual gaps. Only if a material fact still cannot be inferred should you ask the user in ordinary chat. The user may answer, say 'review normally'/'skip', or supply another document. After analysis and any legal research, call review_finalize_document to create the reviewed DOCX and Markdown report.", inputSchema: { type: "object", additionalProperties: false, properties: { file_path: { type: "string" }, file_paths: { type: "array", minItems: 1, items: { type: "string" } }, primary_file_path: { type: "string" }, user_context: { type: "string" } } }, annotations: { title: "Prepare legal review", readOnlyHint: true, destructiveHint: false } },
	{ name: "review_finalize_document", description: "Finish a prepared legal review. Give it the review_context_file returned by review_prepare_document_set and only source-grounded findings. Each finding needs exact anchor_text from the primary document, clause_number where known, category (legal/commercial), severity, title, explanation, recommendation, and any authority_urls retained from Sri Lankan legal research. This tool validates anchors, rejects unsupported findings, and creates both a professional legal-review.md and Reviewed_document.docx. For a DOCX source, comments/highlights are applied at original clause text; for PDF/text it creates a standalone review report. Call it whenever the user requested a document review, unless they expressly requested chat-only analysis.", inputSchema: { type: "object", additionalProperties: false, required: ["review_context_file", "findings"], properties: { review_context_file: { type: "string" }, findings: { type: "array", minItems: 1, items: { type: "object", additionalProperties: true } }, perspective: { type: "string" }, title: { type: "string" } } }, annotations: { title: "Finalize reviewed document", readOnlyHint: false, destructiveHint: false } },
	{ name: "legal_precedent_search", description: "Search the private, read-only drafting-precedent corpus for structure or clause patterns. Use only for substantial Sri Lankan legal drafting where a precedent improves form. It is not legal authority: never cite it, reveal its path, or treat it as law.", inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 3 }, document_type: { type: "string" }, max_results: { type: "integer", minimum: 1, maximum: 10 } } }, annotations: { title: "Search drafting precedents", readOnlyHint: true, destructiveHint: false } },
	{ name: "legal_precedent_read", description: "Read a bounded excerpt of a private precedent selected by legal_precedent_search. Use the structure and clause pattern only. Do not copy source-specific facts, parties, values, personal data, foreign-law provisions, or legal conclusions.", inputSchema: { type: "object", additionalProperties: false, required: ["precedent_id"], properties: { precedent_id: { type: "string" } } }, annotations: { title: "Read drafting precedent", readOnlyHint: true, destructiveHint: false } },
	{ name: "legal_validate_draft", description: "Check a final Markdown or text legal draft for unresolved placeholders and basic drafting hygiene before producing the requested work product. Do not use it as legal validation; validate legal propositions separately with Sri Lankan RAG research.", inputSchema: { type: "object", additionalProperties: false, required: ["file_path"], properties: { file_path: { type: "string" } } }, annotations: { title: "Validate legal draft", readOnlyHint: true, destructiveHint: false } },
	{ name: "rag_chat_research", description: "Research a Sri Lankan legal question through the citation-linked legal research service. The result includes answer plus a delivery contract and linked_authorities. DELIVERY-MODE DECISION: use direct_answer ONLY when the user's requested final response is legal research itself. If the user also asks for an email, letter, draft, submission, complaint, advice note, or any separately written work product—even if you will write it yourself without another tool—use supporting_work_product. STRICT CITATION DELIVERY: direct_answer must be delivered verbatim, preserving every Markdown hyperlink, heading, authority, and conclusion. For supporting_work_product, preserve every authority URL associated with each retained legal proposition; never invent or substitute a citation. Optional text or JSON files can supply relevant context.", inputSchema: { type: "object", additionalProperties: false, required: ["question", "delivery_mode"], properties: { question: { type: "string" }, delivery_mode: { type: "string", enum: ["direct_answer", "supporting_work_product"], description: "direct_answer only for research as the final response; supporting_work_product for research supporting an email, letter, draft, complaint, submission, or explanation." }, context_files: { type: "array", items: { type: "string" }, description: "Optional local UTF-8 text, Markdown, or JSON context files." } } } },
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
	["web_search_public_legal_sources", searchPublicLegalSources],
	["code_runner_data_transform", runDataCode],
	["workbench_publish_artifact", (args) => publishWorkspaceArtifact(args.file_path, args.title)],
	["translator_siriwardena_translate_document", translateDocument], ["translator_siriwardena_translate_text", translateText],
	["librechat_prepare_document_preview", prepareDocumentPreview],
]);

function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function result(id, value) { send({ jsonrpc: "2.0", id, result: value }); }
function rpcError(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

function progressReporter(token) {
	let progress = 0;
	return (message) => {
		if (token === undefined || token === null || !message) return;
		progress += 1;
		send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress, message: String(message).replace(/\s+/g, " ").slice(0, 500) } });
	};
}

async function handle(message) {
	if (message.method === "initialize") { result(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "junior-silva-legal-services", version: "2.1.0" }, instructions: "Independent specialist tools for Sri Lankan legal research, source-anchored native document review, native legal drafting, translation, and legal artifacts. Select tools from their capability descriptions; no fixed workflow is imposed." }); return; }
	if (message.method === "notifications/initialized") return;
	if (message.method === "ping") { result(message.id, {}); return; }
	if (message.method === "tools/list") { result(message.id, { tools }); return; }
	if (message.method === "resources/list") { result(message.id, { resources: [] }); return; }
	if (message.method === "resources/templates/list") { result(message.id, { resourceTemplates: [] }); return; }
	if (message.method === "prompts/list") { result(message.id, { prompts: [] }); return; }
	if (message.method === "tools/call") {
		const handler = handlers.get(message.params?.name);
		if (!handler) { rpcError(message.id, -32602, `Unknown tool: ${message.params?.name}`); return; }
		try {
			const onProgress = progressReporter(message.params?._meta?.progressToken);
			const output = await handler(message.params?.arguments || {}, { onProgress });
			result(message.id, { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output });
		}
		catch (caught) { result(message.id, { content: [{ type: "text", text: caught instanceof Error ? caught.message : String(caught) }], isError: true }); }
		return;
	}
	if (message.id !== undefined) rpcError(message.id, -32601, `Method not found: ${message.method}`);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
lines.on("line", (line) => {
	if (!line.trim()) return;
	try { void handle(JSON.parse(line)); } catch (caught) { console.error(caught instanceof Error ? caught.message : String(caught)); }
});
