#!/usr/bin/env node
import readline from "node:readline";
import { draftOrRevise } from "../services/drafter.mjs";
import { prepareDocumentPreview } from "../services/preview.mjs";
import { research } from "../services/rag.mjs";
import { continueReview, getFindings, startReview } from "../services/reviewer.mjs";
import { translateDocument, translateText } from "../services/translator.mjs";
import { searchPublicLegalSources } from "../services/web.mjs";
import { runDataCode } from "../services/code-runner.mjs";
import { publishWorkspaceArtifact } from "../core/files.mjs";

const tools = [
	{ name: "reviewer_perera_start_review", description: "Start an interactive legal-document review with Reviewer Perera. Accepts one document or a related set (for example, a main agreement and annexures) and reviews the set together. The service first asks party/perspective and factual context questions when needed. IMPORTANT INTERACTION CONTRACT: if the result has requires_user_reply=true, show the returned questions to the user and END the current assistant turn. Never invent answers, never silently choose 'Review normally' or 'Skip', and never call reviewer_perera_continue_review in the same turn. The continuation must wait for a later, real user message. No later research or drafting step is implied.", inputSchema: { type: "object", additionalProperties: false, properties: { file_path: { type: "string", description: "Path to one PDF, DOCX, DOC, ODT, Markdown, or text document." }, file_paths: { type: "array", minItems: 1, items: { type: "string" }, description: "All related local documents that must be considered together. Include the main agreement and every annexure supplied for this review." }, primary_file_path: { type: "string", description: "For a multi-document review, the path of the main agreement; other files are treated as related documents or annexures." }, perspective: { type: "string", description: "Party to protect only when the user already stated it. Do not ask the user again if it is explicit." }, instructions: { type: "string", description: "The user's complete review request and stated concerns, without adding assumptions." } } }, annotations: { title: "Start interactive review", readOnlyHint: false, destructiveHint: false } },
	{ name: "reviewer_perera_continue_review", description: "Continue an existing Reviewer Perera review using the VERBATIM answer from a later user message. Call this only after reviewer_perera_start_review or a prior continuation returned requires_user_reply=true and the user then replied. Do not manufacture, summarize, or default the response on the user's behalf. If this tool again returns requires_user_reply=true, present those questions and end the turn. When complete it returns a downloadable annotated DOCX artifact.", inputSchema: { type: "object", additionalProperties: false, required: ["review_id", "response"], properties: { review_id: { type: "string", description: "Opaque review_id returned by Reviewer Perera." }, response: { type: "string", minLength: 1, description: "The user's actual reply from the later turn, verbatim. 'Review normally' or 'Skip' is valid only when the user actually said it." } } }, annotations: { title: "Continue interactive review", readOnlyHint: false, destructiveHint: false } },
	{ name: "reviewer_perera_get_findings", description: "Retrieve structured clause-level findings for a completed Reviewer Perera review. Useful when another specialist needs exact clauses, classifications, comments, and recommendations.", inputSchema: { type: "object", additionalProperties: false, required: ["review_id"], properties: { review_id: { type: "string" } } } },
	{ name: "rag_chat_research", description: "Research a Sri Lankan legal question through the citation-linked legal research service. The result includes answer plus a delivery contract and linked_authorities. DELIVERY-MODE DECISION: use direct_answer ONLY when the user's requested final response is legal research itself. If the user also asks for an email, letter, draft, submission, complaint, advice note, or any separately written work product—even if you will write it yourself without another tool—use supporting_work_product. STRICT CITATION DELIVERY: direct_answer must be delivered verbatim, preserving every Markdown hyperlink, heading, authority, and conclusion. For supporting_work_product, preserve every authority URL associated with each retained legal proposition; never invent or substitute a citation. Optional text or JSON files can supply relevant context.", inputSchema: { type: "object", additionalProperties: false, required: ["question", "delivery_mode"], properties: { question: { type: "string" }, delivery_mode: { type: "string", enum: ["direct_answer", "supporting_work_product"], description: "direct_answer only for research as the final response; supporting_work_product for research supporting an email, letter, draft, complaint, submission, or explanation." }, context_files: { type: "array", items: { type: "string" }, description: "Optional local UTF-8 text, Markdown, or JSON context files." } } } },
	{ name: "drafter_weeramantry_draft_or_revise", description: "Create or revise a substantial, formal legal work product with Drafter Weeramantry. Use ONLY when the user explicitly requests a downloadable DOCX/PDF/Markdown file, a formal legal instrument (agreement, contract, deed, affidavit, pleading, submission, legal opinion, policy, or letter of demand), or a revision of such a document. The service maintains Markdown and performs a full DOCX rendering pipeline. Do NOT use for an ordinary email, short complaint, chat response, memo, summary, explanation, research answer, presentation, slide deck, spreadsheet, or other visual/data artifact: write those directly in chat or use the matching discovered skill. If the user later asks to turn a chat email into a formal downloadable legal document, then use this tool.", inputSchema: { type: "object", additionalProperties: false, required: ["instruction"], properties: { instruction: { type: "string" }, source_files: { type: "array", items: { type: "string" }, description: "Optional local source documents and context files." }, conversation_id: { type: "string", description: "Optional prior Drafter conversation id." } } } },
	{ name: "translator_siriwardena_translate_document", description: "Translate a PDF, DOC, DOCX, or supported image between English, Sinhala, and Tamil with Translator Siriwardena. Returns translated text and local generated document paths when available.", inputSchema: { type: "object", additionalProperties: false, required: ["file_path", "target_language"], properties: { file_path: { type: "string" }, target_language: { type: "string" }, instructions: { type: "string" } } } },
	{ name: "web_search_public_legal_sources", description: "Search current public web sources when the question depends on a current Gazette, regulation, legal-news development, current parliamentary/court status, international law, or material not expected in the Sri Lankan legal corpus. Do not put client facts or personal data in the query. Use RAG for stable Sri Lankan legal authorities; use both tools when a stable rule may have changed. Returns linked sources only—read their limits before stating a legal conclusion.", inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 3, maxLength: 320 }, max_results: { type: "integer", minimum: 1, maximum: 10 } } } },
	{ name: "code_runner_data_transform", description: "Run a small JavaScript data transformation for calculations, schedules, tables, or structured analysis. This is an isolated data-only runner: no network, filesystem, modules, shell commands, or document creation. Code receives `input` and must return a JSON-serializable value. Use it when calculation or deterministic reshaping materially improves a legal work product; do not use it for ordinary prose.", inputSchema: { type: "object", additionalProperties: false, required: ["code"], properties: { code: { type: "string", minLength: 1, maxLength: 12000 }, input: {} } } },
	{ name: "workbench_publish_artifact", description: "Publish a completed legal artifact that Pi created with a document skill in Junior Silva's workspace. Call this after creating a final PPTX, XLSX, DOCX, PDF, Markdown, text, or JSON file so the user receives a protected download URL. Do not publish source scripts, temporary files, or files outside Junior Silva's workspace.", inputSchema: { type: "object", additionalProperties: false, required: ["file_path"], properties: { file_path: { type: "string", description: "Absolute path of the completed artifact under JUNIOR_SILVA_WORKSPACE_ROOT." }, title: { type: "string", description: "Optional safe download filename without an extension." } } }, annotations: { title: "Publish completed legal artifact", readOnlyHint: false, destructiveHint: false } },
	{ name: "translator_siriwardena_translate_text", description: "Translate supplied text between English, Sinhala, and Tamil with Translator Siriwardena.", inputSchema: { type: "object", additionalProperties: false, required: ["text", "target_language"], properties: { text: { type: "string" }, target_language: { type: "string" } } } },
	{ name: "librechat_prepare_document_preview", description: "Prepare a safe user-visible LibreChat side-panel preview for one completed local DOCX, PDF, PPTX, XLSX, Markdown, text, or JSON deliverable. DEFAULT DELIVERY RULE: after the final user-facing artifact exists, call this once for the primary final file before replying, unless the user asked for download-only output or the result is a short chat-only email. Use the completed file path returned by Reviewer Perera, Drafter Weeramantry, Translator Siriwardena, or workbench_publish_artifact. Do not use it for intermediate files, source scripts, duplicate formats, internal working files, or an artifact already previewed in this turn. It does not modify the original file or replace its protected download.", inputSchema: { type: "object", additionalProperties: false, required: ["file_path"], properties: { file_path: { type: "string", description: "Completed local artifact path returned by a prior tool." }, title: { type: "string", description: "Optional concise title shown in LibreChat's artifact panel." } } }, annotations: { title: "Prepare document preview", readOnlyHint: true, destructiveHint: false } },
];

const handlers = new Map([
	["reviewer_perera_start_review", startReview], ["reviewer_perera_continue_review", continueReview], ["reviewer_perera_get_findings", getFindings],
	["rag_chat_research", research], ["drafter_weeramantry_draft_or_revise", draftOrRevise],
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
	if (message.method === "initialize") { result(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "junior-silva-legal-services", version: "2.0.0" }, instructions: "Independent specialist tools for legal research, interactive document review, drafting, and translation. Select tools from their capability descriptions; no fixed workflow is imposed." }); return; }
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
