# Junior Silva V2 architecture

Junior Silva V2 is a Pi agent with direct MCP legal tools. Pi chooses tools and skills within product instructions; review checkpoints, selected catalogue operations and artifact completion have explicit rules and enforcement. The checkout's coding-agent package reports Pi 1.3.0.

## 1. Query to response flow

```text
CLI → Pi directly; LibreChat → OpenAI-compatible host → Pi
  → Pi starts with legal extensions + skills + direct MCP tools
  → Pi model decides what to read/call/create
  → MCP services / built-in Pi tools run
  → citation + artifact-preview extensions repair final delivery
  → OpenAI response / LibreChat answer, files, preview, usage
```

### Entry points

- Local CLI: [Start-JuniorSilvaV2.ps1](Start-JuniorSilvaV2.ps1)
- Docker CLI: [docker-cli.mjs](junior-silva/cli/docker-cli.mjs)
- LibreChat/OpenAI endpoint: [openai.mjs](junior-silva/server/openai.mjs)

The OpenAI host accepts normal messages, supported provider-file uploads, and LibreChat’s “Upload as Text” envelope. It retains conversation-keyed uploads and deduplicates repeated content. Upload-as-text supplies extracted text, not original formatting. Session identity uses supplied LibreChat identifiers, with `anonymous` and message-hash fallbacks; it is not proof of tenant isolation or authorization.

It then starts Pi with:

- the configured provider/model/thinking level from `.env`;
- Pi built-in tools enabled: `read`, `bash`, `edit`, `write`;
- the configured Junior Silva policy, scope, citation and preview extensions;
- the `junior-silva-legal` direct MCP server; and
- newly introduced document paths; earlier documents remain available in the retained session.

The model then reasons normally and picks tools. It is not forced through one universal workflow. Review and substantial drafting have stronger quality rules because those work products require evidence, annotations, or validation.

## 2. Master prompt, skills, extensions, and tool selection

### I) Master Prompts
The Junior Silva application-level master prompt is the instruction blocks injected by [junior-silva-legal-context.ts](.pi/extensions/junior-silva-legal-context.ts). It is dynamic because the Colombo time is inserted fresh for every run.

Then, Pi creates its ordinary system prompt dynamically in [system-prompt.ts](packages/coding-agent/src/core/system-prompt.ts). It includes:

- Pi’s standard coding-agent instructions;
- currently enabled built-in tools;
- currently loaded MCP tools;
- the available-skills list, including each skill’s path;
- current working directory;
- any project context files; and
- Junior Silva’s appended instructions.

#### Application prompt source of truth

The current literal prompt blocks are defined in [junior-silva-legal-context.ts](.pi/extensions/junior-silva-legal-context.ts). Pi appends these to its generated system prompt on each run; the timestamp and workspace root are inserted at runtime. They cover the review checkpoint, research and catalogue rules, multiple review targets, document-specific review categories, legal scope, artifact completion, previews and final-answer skill. Read the source for the exact current wording rather than relying on a stale pasted snapshot. [junior-silva-scope-guard.ts](.pi/extensions/junior-silva-scope-guard.ts) adds request and tool checks; these are guardrails, not a complete sandbox.

### II) Skills

Skills are separate instruction files. Pi sees their names, descriptions, and locations in its generated system prompt. When the task matches a skill, Pi should use its built-in `read` tool to load that skill before working.

| Skill | Purpose |
|---|---|
| [sri-lankan-legal-research](.agents/skills/sri-lankan-legal-research/SKILL.md) | Routes factual case catalogues, indexed-value discovery, and Act-amendment lists to direct indexed/Lex sources; reserves RAG for holdings, legal analysis, comparison, and synthesis. It prevents incomplete judge names from silently collapsing to one label. |
| [sri-lankan-legal-review](.agents/skills/sri-lankan-legal-review/SKILL.md) | Evidence-first review, multi-document classification, user evidence checkpoint, source-grounded findings, colour classification, annotation validation. |
| [sri-lankan-legal-drafting](.agents/skills/sri-lankan-legal-drafting/SKILL.md) | Native drafting, use of precedent structure without treating it as law, RAG validation, placeholders, before/after changes, final validation and publication. |
| [sri-lankan-legal-final-answer](.agents/skills/sri-lankan-legal-final-answer/SKILL.md) | Consistent source-grounded final legal answers: direct conclusion, authority hierarchy, factual application, calibrated uncertainty, claim-level Markdown citations, and answer-type-specific structure. |
| [legal-docx-build](.agents/skills/legal-docx-build/SKILL.md) | Court-ready legal DOCX from Markdown, with continuous numbering, nested paragraphs, TOC, page numbering, and portable build scripts. |
| [docx](.agents/skills/docx/SKILL.md) | Create/edit/analyse DOCX, tracked changes, comments, formatting, and extraction. |
| [pdf](.agents/skills/pdf/SKILL.md) | PDF extraction, generation, splitting/merging, forms, and validation. |
| [pptx](.agents/skills/pptx/SKILL.md) | Presentation creation/editing; HTML-to-PPTX workflow, thumbnails, visual QA, OOXML work. |
| [xlsx](.agents/skills/xlsx/SKILL.md) | Spreadsheet creation, formulas, formatting, analysis, charts, and recalculation. |
| [doc-coauthoring](.agents/skills/doc-coauthoring/SKILL.md) | Human-guided structured document co-authoring. Disabled for automatic model invocation. |
| [writing-style](.agents/skills/writing-style/SKILL.md) | Shared prose/style rules for other document skills. Disabled for automatic model invocation. |

The legal-research, legal-review, legal-drafting, and legal-final-answer skills are the four Junior Silva-specific legal skills linked above. They are not automatically pasted in full; Pi reads the relevant skill when the task matches its description.

The actual saved Pi sessions confirm that the `.agents/skills` catalog is injected into the model-visible `<available_skills>` list, alongside Pi’s own `.pi/skills`.

### III) Extensions

| Extension | Role |
|---|---|
| [junior-silva-legal-context.ts](.pi/extensions/junior-silva-legal-context.ts) | Legal scope, greeting/refusal interception, review/drafting rules, multi-document rules, Colombo runtime date, artifact delivery, and the mandatory final-answer skill handoff. |
| [junior-silva-scope-guard.ts](.pi/extensions/junior-silva-scope-guard.ts) | Applies shared sensitive-request and tool-access guardrails. |
| [junior-silva-local-trace.ts](.pi/extensions/junior-silva-local-trace.ts) | Captures native CLI model and tool activity using local structured traces. |
| [legal-research-citation-delivery.ts](.pi/extensions/legal-research-citation-delivery.ts) | Preserves RAG’s Markdown links. Returns a direct RAG answer verbatim for pure research; in a Pi synthesis, linkifies only authorities actually cited and never appends an unrelated source list. |
| [librechat-preview-delivery.ts](.pi/extensions/librechat-preview-delivery.ts) | Captures safe artifact markup/download URLs from tools, removes local paths/raw HTML, then appends safe download links and LibreChat canvas markup. |

Launchers also load [junior-silva-scope-guard.ts](.pi/extensions/junior-silva-scope-guard.ts); the native CLI loads [junior-silva-local-trace.ts](.pi/extensions/junior-silva-local-trace.ts). Check each launcher for the exact list.

The greeting and sensitive-request interception are in that extension. The model assesses general legal relevance under the scope prompt; the following refusal is a possible response, not a guarantee of a fixed interceptor:

```text
Hello! I’m Junior Silva from paralegal.lk—how can I help you with your Sri Lankan legal work today?
```

```text
I can help only with Sri Lankan legal work, such as legal research, document review, drafting, translation, or a legal work product. How can I assist with your Sri Lankan legal matter?
```

### IV) MCP tools: descriptions and contracts

The following descriptions are a snapshot of the actual `mcpTools` export on 5 November 2026, including runtime description additions. The authoritative current descriptions and full schemas are in [junior-silva/mcp/server.mjs](junior-silva/mcp/server.mjs); [.pi/mcp.json](.pi/mcp.json) registers the server. The tool is listed with its required and optional top-level inputs; inspect its schema for types, constraints and nested properties.

#### `review_prepare_document_set`

Prepare a complete Sri Lankan legal review set from every supplied agreement, pleading, annexure, image, evidence file, or later attachment. It extracts all readable documents, suggests review targets versus supporting material, and maps clauses/coverage separately for every target. Set review_file_paths when the user identifies documents to mark up; set supporting_file_paths for context-only documents. Without explicit roles, substantive agreements/pleadings are selected as review targets while clear annexures/evidence are supporting. If the result is genuinely ambiguous, ask the user before finalising. The returned context begins an evidence checkpoint. After an actual later user answer, call review_record_checkpoint_outcome; if a document is supplied, prepare a fresh combined set. Only then finalise every selected target.

Inputs: `file_path`, `file_paths`, `primary_file_path`, `review_file_paths`, `supporting_file_paths`, `user_context`.

#### `review_record_checkpoint_outcome`

Record an actual user response to the evidence checkpoint of a prepared substantive review. Call this only in a later turn after the user has answered, said 'review normally', or said 'skip'—never automatically in the same turn as review_prepare_document_set. If the user supplied a new document, do not call this: instead call review_prepare_document_set again with the complete combined file set. This tool does not ask the question; Pi asks naturally in chat.

Inputs: `review_context_file` (required), `outcome` (required), `user_response`.

#### `review_finalize_document`

Finish every selected review target only after its evidence checkpoint is completed or the user explicitly requested chat-only analysis. Give it the review_context_file and source-grounded findings. Each finding needs exact anchor_text, clause_number where known, category, severity, title, explanation, recommendation, and authority_urls. For multiple targets, include target_id returned by preparation (or target_file) on each finding; an unlabelled anchor is accepted only when it matches exactly one selected target. Define exactly three distinct review categories suited to the document and user’s purpose, each with a name and one of red, orange, yellow. Assign every finding to a declared name using classification. Support any assertion of illegality or non-compliance with appropriate authority URLs. This tool validates anchors, verifies annotation coverage, creates a separate reviewed DOCX and Markdown report for each target, returns protected download links, and emits a LibreChat preview for every reviewed DOCX. Every accepted finding receives a comment and highlight at the original DOCX clause or corresponding extracted PDF/text/image clause. Each finding must represent one distinct issue: consolidate substantially identical risk, explanation, and recommendation combinations, using issue_key where candidates describe the same issue. anchor_text must be the narrowest continuous operative wording that creates the issue; do not anchor a heading, clause label, or table title when a specific subclause, obligation, exception, consequence, or definition limb is available. For a missing protection, mark the closest meaningful insertion point and set missing_protection=true with a placement_reason; a heading is acceptable only for that documented omission case. The finaliser annotates the original DOCX or reconstructs a formatted editable DOCX from a PDF, aiming to preserve the visible layout as closely as possible. Preserve original file inputs; report material formatting limitations returned in annotation_coverage.formatting_notice.

Inputs: `review_context_file` (required), `findings` (required), `perspective`, `title`, `categories` (required).

#### `legal_precedent_search`

Search the private, read-only drafting-precedent corpus for structure or clause patterns. Use only for substantial Sri Lankan legal drafting where a precedent improves form. It is not legal authority: never cite it, reveal its path, or treat it as law.

Inputs: `query` (required), `document_type`, `max_results`.

#### `legal_precedent_read`

Read a bounded excerpt of a private precedent selected by legal_precedent_search. Use the structure and clause pattern only. Do not copy source-specific facts, parties, values, personal data, foreign-law provisions, or legal conclusions.

Inputs: `precedent_id` (required).

#### `legal_validate_draft`

Check a final Markdown or text legal draft for unresolved placeholders and basic drafting hygiene before producing the requested work product. Do not use it as legal validation; validate legal propositions separately with Sri Lankan RAG research.

Inputs: `file_path` (required).

#### `rag_chat_research`

Research a Sri Lankan legal question through the citation-linked legal research service. The result includes answer plus a delivery contract and linked_authorities. DELIVERY-MODE DECISION: use direct_answer ONLY when the user's requested final response is legal research itself. If the user also asks for an email, letter, draft, submission, complaint, advice note, or any separately written work product—even if you will write it yourself without another tool—use supporting_work_product. STRICT CITATION DELIVERY: direct_answer must be delivered verbatim, preserving every Markdown hyperlink, heading, authority, and conclusion. For supporting_work_product, preserve every authority URL associated with each retained legal proposition; never invent or substitute a citation. Optional text or JSON files can supply relevant context. RAG Chat is an analytical research source, not a substitute for reading a specific primary instrument where the request turns on its exact title, date, version, or wording. If its answer raises a possible historical naming conflict, use available source tools as needed to resolve it before presenting a conclusion.

Inputs: `question` (required), `delivery_mode` (required), `context_files`.

#### `legal_source_retrieve_details`

Read bounded material from the read-only Sri Lankan legal source collections behind research. For a question about what indexed judge names, court labels, report series, action types, or decision months exist, use operation=facet_values first. It returns matching distinct indexed labels and counts; it does not decide identity. For a simple indexed case list, use operation=case_catalog after selecting one exact returned judge label or an explicit returned label set. Pass every stated year, subject, court, report, and action constraint separately. For an unqualified list, request page_size=20 and use found/returned/has_more to fetch every page; never present a sample as the complete list. Never silently collapse an incomplete judge surname to the highest-count label. Use operation=recent_amendments with source=legislation for current/latest amendment instruments across Acts. Use operation=amendment_catalog with source=legislation, legislation_title, and amendment_year for a factual list of structured Lex amendment entries in one named Act. Use retrieve for selected case/Act records needing fuller text. Use RAG Chat for holdings, legal analysis, authority selection, comparison, or a synthesized citation-linked conclusion. Returned material is evidence, not a conclusion: preserve source links and never invent amendment history or URLs. For named Acts, numbered constitutional amendments, Bills, regulations, and Gazettes, this tool can search structured Lex primary records and retrieve a selected record's title, enactment information, preamble, sections, amendment references, and official links. Use it where the exact instrument, version, or operative wording matters, including where historical Bills and enacted instruments have similar titles. Where the identity or wording of an instrument is material, weigh RAG material against the structured primary record rather than treating either source as automatically conclusive.

Inputs: `source` (required), `operation` (required), `query`, `subject_query`, `judge_name`, `decision_year`, `decision_month`, `court`, `report`, `report_year`, `volume_num`, `page_num`, `action_type`, `amendment_year`, `page`, `page_size`, `record_id`, `case_number`, `party_name`, `legislation_title`, `legislation_scope`, `section_number`, `fields`, `max_results`, `max_field_characters`, `facet_field`, `facet_query`, `judge_labels`, `recent_limit`.

#### `translator_siriwardena_translate_document`

Translate a PDF, DOC, DOCX, or supported image between English, Sinhala, and Tamil with Translator Siriwardena. Returns translated text and local generated document paths when available.

Inputs: `file_path` (required), `target_language` (required), `instructions`.

#### `web_search_public_legal_sources`

Search current public web sources when the question depends on a current Gazette, regulation, legal-news development, current parliamentary/court status, international law, or material not expected in the Sri Lankan legal corpus. Do not put client facts or personal data in the query. For a latest/current Sri Lankan Act, amendment, or case request, pair this with the relevant Lex or direct indexed-source query unless the user expressly limits the source. Prefer official Parliament, Gazette, court, and Government sources. Results are linked leads only: if exact operative wording, commencement, or judgment content matters, read the linked official primary PDF in the workspace before stating it. It can also confirm official Gazettes, Parliament publications, and other current primary material for a named legal instrument. When exact enactment identity or wording matters, compare returned official material with structured primary legislation records where available.

Inputs: `query` (required), `max_results`.

#### `code_runner_data_transform`

Run a small JavaScript data transformation for calculations, schedules, tables, or structured analysis. This is an isolated data-only runner: no network, filesystem, modules, shell commands, or document creation. Code receives `input` and must return a JSON-serializable value. Use it when calculation or deterministic reshaping materially improves a legal work product; do not use it for ordinary prose.

Inputs: `code` (required), `input`.

#### `workbench_publish_artifact`

Publish a completed legal artifact that Pi created with a document skill in Junior Silva's workspace. Call this only after the requested PPTX, XLSX, DOCX, PDF, Markdown, text, or JSON file has been validated. A file that merely exists in the workspace is not delivered: do not send the final answer until this tool returns its protected download URL. This tool also prepares a safe preview. Do not publish source scripts, temporary files, or files outside Junior Silva's workspace.

Inputs: `file_path` (required), `title`.

#### `translator_siriwardena_translate_text`

Translate supplied text between English, Sinhala, and Tamil with Translator Siriwardena.

Inputs: `text` (required), `target_language` (required).

#### `librechat_prepare_document_preview`

Prepare a safe user-visible LibreChat side-panel preview for one completed local DOCX, PDF, PPTX, XLSX, Markdown, text, or JSON deliverable. DEFAULT DELIVERY RULE: after the final user-facing artifact exists, call this once for the primary final file before replying, unless the user asked for download-only output or the result is a short chat-only email. Use the completed file path returned by Reviewer Perera, Drafter Weeramantry, Translator Siriwardena, or workbench_publish_artifact. Do not use it for intermediate files, source scripts, duplicate formats, internal working files, or an artifact already previewed in this turn. It does not modify the original file or replace its protected download.

Inputs: `file_path` (required), `title`.

## 3. How Pi knows what to use

Pi receives:

1. Tool name, full description, JSON input schema, and read-only/destructive hints from MCP `tools/list`.
2. Skill name, description, and absolute file location in the system prompt.
3. Junior Silva’s legal scope and delivery instructions.
4. The user’s request plus uploaded-document paths.

So, for example:

- “What indexed names exist for Judge X?” → reads `sri-lankan-legal-research`, then `legal_source_retrieve_details` with `facet_values`; it preserves distinct labels/counts and does not decide identity.
- “Cases decided by Judge X in 2026 on tax” → reads `sri-lankan-legal-research`, discovers labels first if the supplied name is incomplete, then calls `case_catalog` with the selected exact label or explicit label set; it retrieves detail only for selected case records.
- “What amendments were made to the Companies Act in 2025?” → reads `sri-lankan-legal-research`, then calls Lex through `legal_source_retrieve_details` with `amendment_catalog`; RAG is used only if the user asks for analysis of the amendments.
- “What does this Act say?” → Pi can find and retrieve the named primary Lex record and use RAG or web research as appropriate.
- “What is the latest Gazette?” → Pi considers indexed sources and current public sources, respecting source limits.
- “Review these agreements” → reads review skill, prepares the document set, asks the evidence checkpoint where needed, then finalises annotated reviews.
- “Draft a plaint” → reads drafting skill, may search private precedents and RAG, creates Markdown/DOCX through document skills, validates, publishes, and normally previews it.
- “Make a legal due-diligence PPTX” → reads `pptx` skill, uses normal Pi Bash/code execution to run its scripts, publishes the completed PPTX, then prepares a LibreChat preview.


## 4. Other important implementation details

- **Native review/drafting:** V2 no longer exposes Reviewer Perera or Drafter Weeramantry as MCP tools. Review is native through [native-review.mjs](junior-silva/core/native-review.mjs); drafting is coordinated by Pi using skills, precedents, RAG, and validation. The older [reviewer.mjs](junior-silva/services/reviewer.mjs) and [drafter.mjs](junior-silva/services/drafter.mjs) files remain in the repository, but are not mapped into the current 14-tool MCP server.

- **Review annotations and layout:** [render_review_docx.py](junior-silva/review/render_review_docx.py) annotates original DOCX files or converts text-based PDFs using `pdf2docx`; conversion can fall back to extracted text with a notice. Three Pi-selected categories map to red/orange/yellow. The cover and appended findings use separate sections with margins; source layout and embedded graphics are retained where conversion permits. Finalisation validates anchors, issue keys, categories and annotation coverage. See [review-render.mjs](junior-silva/core/review-render.mjs) and its Windows/WSL wrapper.

- **RAG citations:** [rag.mjs](junior-silva/services/rag.mjs) gets the synthesised RAG answer and extracts Markdown authority links into a delivery bundle. The citation extension can substitute a direct RAG answer when its conditions are satisfied or link cited authorities in a combined answer. It does not independently verify legal support.

- **Legal-source details:** Cases/chunks/books come from Typesense; Acts and sections use Lex’s structured SQLite authority API. `facet_values` discovers bounded matching values for documented case facets before Pi selects a judge/court/report/etc. `case_catalog` then applies only documented structured filters and supports a verified explicit set of indexed judge labels where the request covers more than one label. `amendment_catalog` resolves an Act title, reads its complete structured Lex record, and returns every matching indexed amendment entry for the requested year. The implementation is in [typesense-legal-sources.mjs](junior-silva/core/typesense-legal-sources.mjs) and [lex-legislation-sources.mjs](junior-silva/core/lex-legislation-sources.mjs).

- **Public web research:** [web.mjs](junior-silva/services/web.mjs) uses Serper. It does not itself scrape/rerank through Firecrawl/Jina in the current V2 path.

- **Current time:** Time is injected into the product prompt and also into RAG context through [time.mjs](junior-silva/core/time.mjs). It is not only for web search.

- **Artifact security:** [files.mjs](junior-silva/core/files.mjs) publishes artifacts using capability-style protected download URLs. The final-answer preview extension strips raw `/data`, `/app`, `file_uri`, and raw renderer HTML.

- **Thoughts and tracing:** [openai.mjs](junior-silva/server/openai.mjs) maps progress to curated user-facing labels. [trace.mjs](junior-silva/core/trace.mjs) records request, LLM, tool, final response and usage details in local `traces/<date>/<id>/trace.json` and `events.jsonl`; the local CLI extension also traces. Logs may contain privileged or personal material despite redaction. See [LOGGING.md](LOGGING.md); restrict access and retention.

- **Usage:** The same host aggregates Pi assistant usage from the session and emits OpenAI `usage` in normal responses, or a final streaming usage frame when LibreChat requests it.

- **Code execution distinction:** `code_runner_data_transform` is intentionally restricted. Pi’s normal built-in `bash` tool is what executes document-skill scripts for DOCX/PDF/PPTX/XLSX generation. This is why the document skills can run Python, Node, Pandoc, LibreOffice, and their provided scripts.
