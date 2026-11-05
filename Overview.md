# Junior Silva V2 — engineering handover

Junior Silva V2 is a Sri Lankan legal-assistant integration built on a fork of Pi; this checkout's `packages/coding-agent/package.json` reports version **1.3.0**. Pi sees specialist tools through MCP and chooses tools for a request, subject to product instructions and enforced review, security and artifact-delivery checks.

This checkout is on **feat/deployment-test**; deployment typically follows a reviewed merge to the fork's **dev** branch. Check Git and the server before deployment. See [update_guide.md](update_guide.md) for upstream updates.

## Design principles

- **Pi selects capabilities.** There is no universal review → research → draft pipeline. Review has an explicit user evidence checkpoint and artifact finalisation requirements; prompts also direct particular catalogue and artifact operations.
- **Tools describe contracts, not workflows.** Each MCP tool says what it can do, what it needs, and what it returns. Pi uses source-anchored native review/drafting tools and asks for user facts only after it has read the available evidence.
- **Legal-only product boundary.** Legal context supplies scope guidance; shared scope guards intercept certain secret-access and bypass attempts. The model judges legal relevance; these controls are not a security sandbox.
- **Sri Lankan legal focus.** Stable domestic research goes to RAG Chat Server; current/public developments can use web search; Pi may use both where a current source could change a stable legal rule.
- **Localize service artifacts.** Provider download links are never shown as user-facing links. Returned files are downloaded to controlled artifact folders and exposed through HMAC-protected download URLs.
- **Preserve sources.** RAG tool contracts request verbatim delivery for direct research and preserve source links in composite work. Citation delivery restores supported links where it can match authorities; verify final citations against their source.
- **The original file remains authoritative.** LibreChat previews are read-only derived views; they never alter DOCX, PDF, PPTX, XLSX, Markdown, or other source artifacts.
- **Stateful document delivery.** Pi retains a session and conversation-keyed document library. Current-turn uploads are deduplicated using source identifiers where available and content hashes; prior files remain accessible when needed. This is not a complete tenant-isolation guarantee.

## Runtime architecture

~~~text
                         ┌───────────────────────────────────────┐
Windows Pi CLI ─────────►│ Pi coding agent                         │
LibreChat custom endpoint│ legal scope + chronology extension      │
                         │ citation delivery + preview extension  │
                         └──────────────┬────────────────────────┘
                                        │ native stdio MCP
                         ┌──────────────▼────────────────────────┐
                         │ Junior Silva Legal Services MCP         │
                         └─┬────────┬─────────┬─────────┬────────┘
                           │        │         │         │
                    Native review  RAG Chat  Native drafting  Translator
                           │        │         │         │
                           └────────┴────┬────┴─────────┘
                                        │
                      local uploads / workspace / artifacts
                                        │
                         ┌──────────────▼────────────────────────┐
                         │ protected downloads + optional          │
                         │ LibreChat side-panel artifact previews  │
                         └────────────────────────────────────────┘
~~~

### Entry points

| Entry point | Purpose |
| --- | --- |
| Start-JuniorSilvaV2.ps1 | Windows launcher for interactive Pi/TUI use. |
| Start-JuniorSilvaV2.sh | Linux/WSL launcher for interactive Pi/TUI use. |
| Setup-JuniorSilvaV2.ps1 / setup-junior-silva-v2.sh | Fresh-clone setup, validation and optional Docker startup. |
| LOCAL_CLI_SETUP.md | Step-by-step Windows, Linux/WSL and Docker local CLI guide. |
| junior-silva/cli/docker-cli.mjs | Starts the same Pi configuration in the optional Docker CLI profile. |
| junior-silva/server/openai.mjs | OpenAI-compatible HTTP/SSE endpoint used by LibreChat. |
| junior-silva/mcp/server.mjs | Standards-compliant stdio MCP server exposing specialist tools. |

The HTTP endpoint provides /health, /v1/models, /v1/chat/completions, and protected artifact-download routes. It serializes a conversation key so related turns do not race each other, translates MCP progress into SSE reasoning_content, and persists Pi sessions beneath the configured data root.

### LibreChat conversation and attachment handling

LibreChat sends a standard history-bearing OpenAI request. Junior Silva derives an HMAC conversation key from supplied LibreChat user/conversation identifiers and reuses `junior-silva-v2-<key>` as Pi's session ID. If a user identifier is absent the code uses `anonymous`; if a conversation identifier is absent it hashes the messages. These headers and shared endpoint credentials do not by themselves establish per-user authorization. With the LibreChat agent preset's `resendFiles: false`, earlier files are not intentionally resent, while ordinary text history remains available to LibreChat.

`server/openai.mjs` deliberately uses the latest user message only when discovering provider attachments and Upload-as-Text envelopes. It stores a conversation-local `.manifest.json` alongside uploads, keyed by source file ID when supplied and by SHA-256 bytes in all cases. A previously retained document is not downloaded or copied again; a same-name replacement with different bytes becomes a distinct retained document. Pi receives only the newly introduced paths for a turn. It retains the earlier paths in its durable session, so it can re-read a prior agreement or supporting document when needed without the bridge blindly reinjecting all documents.

## Full Junior Silva V2 file structure

This intentionally omits ordinary upstream Pi source folders such as packages and scripts.

~~~text
pi/
├── .agents/
│   └── skills/                              copied artifact-production skills
│       ├── doc-coauthoring/                 optional coauthoring guidance
│       ├── docx/                            DOCX generation, OOXML and helpers
│       ├── legal-docx-build/                legal numbering/rendering scripts
│       ├── pdf/                             PDF extraction, creation and checks
│       ├── pptx/                            PowerPoint creation and utilities
│       ├── sri-lankan-legal-drafting/       native legal-drafting decision guidance
│       ├── sri-lankan-legal-final-answer/   final legal-answer synthesis guidance
│       ├── sri-lankan-legal-research/       direct catalogue versus legal-analysis routing
│       ├── sri-lankan-legal-review/         evidence-first native review guidance
│       ├── writing-style/                   writing-quality guidance
│       └── xlsx/                            workbook creation/recalculation guidance
├── .pi/
│   ├── mcp.json                             registers the local direct MCP server
│   └── extensions/
│       ├── junior-silva-legal-context.ts    scope, greeting/refusal, Colombo time,
│       │                                    artifact-skill instructions and preview policy
│       ├── junior-silva-scope-guard.ts      shared request and tool access checks
│       ├── junior-silva-local-trace.ts      interactive CLI trace capture
│       ├── legal-research-citation-delivery.ts
│       │                                    preserves/restores RAG authority hyperlinks
│       └── librechat-preview-delivery.ts    inserts prepared Artifact markup into final output
├── junior-silva/
│   ├── cli/
│   │   └── docker-cli.mjs                   Docker CLI launcher with configured extensions
│   ├── core/
│   │   ├── document-text.mjs                PDF/DOCX/text extraction; multi-file review packets
│   │   ├── environment.mjs                  .env loader and configured runtime roots
│   │   ├── files.mjs                        validation, localization, HMAC links, publishing
│   │   ├── http.mjs                         JSON/SSE request helpers and redacted diagnostics
│   │   ├── legal-research.mjs               extracts RAG authorities/delivery metadata
│   │   ├── legal-scope.mjs                  sensitive request and tool safety checks
│   │   ├── lex-legislation-sources.mjs      Lex Act/section and amendment retrieval
│   │   ├── native-review.mjs                source anchors, clause inventory, coverage audit, validated reports
│   │   ├── precedents.mjs                   read-only private drafting-precedent retrieval and draft hygiene
│   │   ├── previews.mjs                     safe DOCX/PDF/PPTX/XLSX/Markdown/text/JSON previews
│   │   ├── review-render.mjs                invokes native DOCX renderer
│   │   ├── trace.mjs                        local JSON/JSONL tracing and redaction
│   │   ├── typesense-legal-sources.mjs      bounded direct legal-source detail retrieval
│   │   └── time.mjs                         Colombo temporal context for current-source research
│   ├── mcp/
│   │   └── server.mjs                       MCP protocol implementation and tool declarations
│   ├── review/
│   │   ├── render_review_docx.py            source-anchored DOCX comments/highlights renderer
│   │   └── render_review_docx.ps1           Windows/WSL renderer wrapper
│   ├── server/
│   │   └── openai.mjs                       OpenAI bridge, HMAC conversation sessions, upload manifest/deduplication and SSE progress
│   ├── services/
│   │   ├── code-runner.mjs                  isolated JSON-only JavaScript transformation runner
│   │   ├── drafter.mjs                      legacy adapter retained temporarily; not exposed by production MCP
│   │   ├── preview.mjs                      presentation adapter around core/previews
│   │   ├── rag.mjs                          RAG Chat Server adapter and authority extraction
│   │   ├── reviewer.mjs                     legacy adapter retained temporarily; not exposed by production MCP
│   │   ├── translator.mjs                   document/text translator adapters
│   │   └── web.mjs                          Serper legal-news/current-law search
│   └── test/
│       ├── files.test.mjs                   artifact/input safety tests
│       ├── openai-uploads.test.mjs           current-turn upload, history suppression and deduplication tests
│       ├── legal-research.test.mjs          linked-authority delivery tests
│       ├── mcp-native-tools.test.mjs         native review/drafting MCP contract tests
│       ├── native-review.test.mjs            document-set, anchors and review rendering tests
│       ├── pdf_conversion_smoke.py          conversion, cover/source sections and image smoke test
│       ├── review-render.test.mjs           DOCX comments, highlights and formatting tests
│       ├── trace.test.mjs                   structured local trace tests
│       ├── time.test.mjs                    Colombo temporal-context tests
│       ├── typesense-legal-sources.test.mjs direct-source contract tests
│       └── fixtures/                        non-sensitive test fixtures
├── .dockerignore                            keeps secrets/runtime data out of Docker context
├── .env                                     local/server secrets; ignored by Git
├── .env.example                             safe configuration template
├── .gitignore                               excludes secrets, sessions, uploads and artifacts
├── Dockerfile                               Pi build plus V2 runtime image
├── docker-compose.yml                       HTTP service and optional interactive CLI profile
├── Start-JuniorSilvaV2.ps1                  Windows Pi launcher
├── Start-JuniorSilvaV2.sh                   Linux/WSL Pi launcher
├── Setup-JuniorSilvaV2.ps1                  Windows setup and optional Docker runner
├── setup-junior-silva-v2.sh                 Linux/WSL setup and optional Docker runner
├── LOCAL_CLI_SETUP.md                       Fresh-clone local CLI guide
├── LOGGING.md                               local trace capture and viewing instructions
├── TESTING.md                               focused-first acceptance and regression checklist
├── Overview.md                              this operational handover
└── History.md                               chronological implementation record
~~~

## Agent policy and extensions

### junior-silva-legal-context.ts

This is a **product policy extension**. Pi loads it explicitly from CLI launchers and the OpenAI bridge. Its before-agent-start handlers append instructions to Pi's system prompt, including concrete review and delivery requirements.

It provides:

- the Junior Silva legal greeting;
- sensitive-request checks; legal relevance is primarily decided by the model under the scope policy;
- a system policy limiting work to Sri Lankan legal work and refusing prompt, credential, service-address, source-code, and internal-architecture extraction;
- the live Asia/Colombo date and time, so the agent does not treat already-past dates as future merely from model-training assumptions;
- directions to use discovered document skills and publish final skill-created artifacts;
- directions to read the native Sri Lankan legal review/drafting skills and to use their source-anchored tools;
- a default instruction to prepare one LibreChat preview for an eligible final artifact.

The agent chooses research and other tools within those instructions. The review checkpoint and finalisation, among other delivery constraints, are explicitly prescribed and partly enforced by tools.

### legal-research-citation-delivery.ts

RAG returns a formatted answer; the adapter extracts links from it. This extension observes tool results and restores links for supported authority mentions. Delivery behaviour depends on the mode and extension; do not assume it verifies that an authority supports every legal claim.

### librechat-preview-delivery.ts

When Pi calls librechat_prepare_document_preview, this extension captures the safe Artifact markup returned by the tool and appends it deterministically to the final assistant response. LibreChat then renders the side-panel/canvas artifact. Pi remains responsible for deciding that a preview is appropriate.

### Scope and tracing extensions

[junior-silva-scope-guard.ts](.pi/extensions/junior-silva-scope-guard.ts) uses [legal-scope.mjs](junior-silva/core/legal-scope.mjs) to guard selected sensitive requests and tool operations. [junior-silva-local-trace.ts](.pi/extensions/junior-silva-local-trace.ts) captures direct CLI traces. The OpenAI host records its own trace events through [trace.mjs](junior-silva/core/trace.mjs). See [LOGGING.md](LOGGING.md) for locations, settings and local viewing; logs may contain confidential legal material and require restricted access.

## MCP tools and contracts

All tools are declared in junior-silva/mcp/server.mjs and exposed directly by .pi/mcp.json.

| Tool | What it does | Important contract |
| --- | --- | --- |
| review_prepare_document_set | Reads the complete primary/supporting evidence set, maps the primary document, and checks commercial coverage. | Does not interview the user. Pi reads the returned evidence before deciding whether a question is genuinely necessary. |
| review_record_checkpoint_outcome | Records an actual user answer, skip or review-normally response. | New documents require preparing the combined set again. |
| review_finalize_document | Validates findings and creates a reviewed DOCX and Markdown report per selected target. | Pi supplies three document-specific labels for red/orange/yellow; anchored comments and highlights are checked. DOCX is annotated directly; PDF is converted to an editable DOCX where possible, otherwise extracted text is used with a notice. |
| legal_precedent_search / legal_precedent_read | Read a bounded excerpt from a private, read-only drafting corpus. | Structure only, never legal authority or user-visible source material. |
| legal_validate_draft | Finds unresolved placeholders and basic hygiene issues in a draft. | Legal propositions still require RAG validation. |
| rag_chat_research | Queries Sri Lankan legal research with authority links. | direct_answer is for research as the final answer; supporting_work_product is for research underpinning an email, letter, complaint, etc. |
| legal_source_retrieve_details | Discovers indexed case values through `facet_values`; lists decisions through `case_catalog`; and finds/retrieves bounded source material. Cases, case passages and books use scoped Typesense search; Acts/constitutional material use Lex’s structured API for the original Act or exact section. | Start with `facet_values` for a judge-name variant, incomplete name, or another indexed value. It returns every targeted stored label and count, not a global top-facet sample. Use its exact returned labels in `case_catalog` (including multiple labels when the user asks for all matching records). `case_catalog` applies safe structured filters and returns paginated links. Use RAG for legal analysis and synthesis. |
| translator_siriwardena_translate_document | Translates a supported document. | Returns localized generated files where the service provides them. |
| translator_siriwardena_translate_text | Translates supplied text. | Avoids unnecessary document drafting. |
| web_search_public_legal_sources | Searches current public legal/news sources. | No client personal facts in query; use RAG too when current sources may change stable law. |
| code_runner_data_transform | Executes a small deterministic JavaScript calculation/table transform. | No network, filesystem, modules, shell, or document creation. |
| workbench_publish_artifact | Publishes a final skill-created workspace artifact. | Only final user-facing artifact files in the configured workspace. |
| librechat_prepare_document_preview | Generates a side-panel preview for a final artifact. | Preview once per primary final file; never replaces the original download. |

### Evidence-aware review conversation

The review skill and tools implement an evidence protocol with an enforced checkpoint for substantive reviews:

1. Pi prepares and reads the complete supplied document set before asking any question.
2. It asks focused questions only for material facts unsupported by that evidence (for example, the operative term, notice, asset record, loss proof, party identity, jurisdiction, or procedural act).
3. For a substantive review Pi asks about further evidence, even if it has no focused factual question; the user can skip. Explicit immediate/chat-only requests waive the checkpoint.
4. A user reply consisting only of a file path/upload is new evidence, not an implied answer. Pi rebuilds the packet with the original and every related document, then reassesses.
5. `review normally` or `skip` closes the checkpoint. Pi completes any needed research and finalises the report without asking another evidence question, expressly identifying unresolved gaps or assumptions.

The model selects suitable research sources, but the evidence checkpoint and finalisation rules apply when a substantive review is undertaken.

## Documents, artifacts and previews

### Input and hand-off

- Supported inbound file types are PDF, DOCX, DOC, ODT, PPTX, XLSX, TXT, Markdown, JSON, PNG, JPG and JPEG; normal size limit is 50 MB.
- Related agreements and annexures are extracted into one labeled review packet, with an optional designated primary document.
- LibreChat provider attachments are localized where the bridge receives supported original files. Upload-as-Text delivers extracted text, not original DOCX/PDF formatting; LibreChat's provider file-type support depends on its configuration and encoder.
- HTTP attachment retrieval is limited to configured origins and refuses redirects.
- Tool outputs are downloaded/localized beneath junior-silva/artifacts/operation-id locally or /data/artifacts/operation-id in Docker.

### Preview formats

librechat_prepare_document_preview supports DOCX, PDF, PPTX, XLSX, Markdown, TXT and JSON.

- **Reviewed DOCX:** converts document content to sanitized HTML and reads Word comments so a dashboard and each reviewer note appear beside its matching clause. The original Word comments/highlights remain unchanged in the downloadable DOCX.
- **Other DOCX/PDF:** readable derived document/text previews; native files remain authoritative.
- **PPTX:** a gallery of extracted slide text, up to 25 slides; native PowerPoint remains the editable/presentation-quality version.
- **XLSX:** up to four sheets, 30 rows and 12 columns each; native workbook remains authoritative for formulas, formatting and complete data.
- **Markdown/text/JSON:** native LibreChat Markdown/text Artifact preview.

## Skills, code execution and security boundary

The copied .agents/skills are deliberately available to Pi. Current CLI and hosted bridge launches **do not pass the no-builtin-tools flag**. This allows Pi to read skill instructions and run their scripts/code for legal work products such as presentations, spreadsheets, PDFs and documents.

That is functional but it is a material deployment boundary: the legal-scope extension is an agent-policy guardrail, not a security sandbox. A production deployment that accepts untrusted public users should isolate the Pi process, writable workspace and egress at the container/host level, and should not rely solely on prompts to protect the repository or secrets. The MCP code_runner_data_transform tool is separately constrained and is not equivalent to Pi’s built-in execution capabilities.

## Configuration and data paths

.env is loaded by core/environment.mjs and must never be committed. .env.example is the authoritative safe list of expected variables.

| Group | Examples | Purpose |
| --- | --- | --- |
| Pi model | PI_PROVIDER, PI_MODEL, provider API key | Pi’s reasoning model. |
| legal services | RAG_*, TRANSLATOR_* | Active external legal-research and translation endpoints. Legacy Reviewer/Drafter variables may remain during migration but are not used by the production MCP server. |
| direct source detail | JUNIOR_TYPESENSE_*, JUNIOR_LEX_LEGISLATION_* | Optional bounded detail behind RAG-cited cases, passages and books (source-scoped Typesense) plus original Acts/constitutional material and exact sections (Lex API using an internal read-only `X-API-Key`). These values never reach Pi or the user. |
| private precedents | JUNIOR_SILVA_KB_ROOT, JUNIOR_SILVA_KB_HOST_PATH | Optional host-mounted, read-only Drafter precedent corpus; never copied into the image or repository. |
| public web | WEB_SEARCH_*, optional scraper/reranker settings | Current public-source research. The current adapter calls Serper; scraper/reranker values are reserved configuration until an adapter uses them. |
| tracing | JUNIOR_SILVA_TRACE_LOGS, JUNIOR_SILVA_LOG_ROOT, JUNIOR_SILVA_LOG_MAX_VALUE_BYTES | Local structured request/tool traces; restrict access because legal content can be sensitive. |
| endpoint | JUNIOR_SILVA_API_KEY, PUBLIC_URL, MODEL_NAME, PORT | OpenAI-compatible endpoint and artifact URLs. |
| storage | DATA_ROOT, ARTIFACT_ROOT, UPLOAD_ROOT, WORKSPACE_ROOT | Runtime data isolation. |

Default local data paths use junior-silva under the repository. Docker mounts persistent artifacts, uploads, workspace, sessions, pi-agent and logs under /data; confirm the active Compose configuration and host permissions on each deployment.

For an interactive Windows CLI, set `JUNIOR_SILVA_KB_ROOT` to the local `clean-kb` directory. For Docker, set `JUNIOR_SILVA_KB_HOST_PATH` to that host directory; Compose mounts it read-only at `/kb` and sets the container root accordingly. An empty read-only mount is used when no corpus is configured, so the service starts but precedent search reports that it has no matching material.

The Windows launcher creates and exports `JUNIOR_SILVA_WORKSPACE_ROOT` before Pi starts. If Pandoc is unavailable in the Windows/Git-Bash environment, the legal-DOCX skill directs Pi to its WSL-backed portable renderer rather than abandoning the requested DOCX. The portable renderer preserves authored numbering, headings and bullets; Docker retains the full Pandoc pipeline.

## Running and deployment

### Windows interactive Pi

~~~powershell
cd 'D:\Intern\Work\Junior Silva V2\pi'
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\Start-JuniorSilvaV2.ps1
~~~

On first use, approve the project MCP server. The interactive client uses the same extensions and native legal MCP service as the hosted endpoint.

### Docker HTTP endpoint

~~~bash
cd '/mnt/d/Intern/Work/Junior Silva V2/pi'
docker compose build junior-silva-v2
docker compose up -d --force-recreate junior-silva-v2
docker compose ps junior-silva-v2
curl http://127.0.0.1:8132/health
~~~

The container listens on 8126; Compose publishes it as 127.0.0.1:8132. The optional interactive container is started with:

~~~bash
docker compose --profile cli run --rm junior-silva-cli
~~~

Compose connects to librechat_default and rag-chat-server_default external Docker networks by default. The active external service hostnames are RAG Chat Server and Translator; legacy Reviewer/Drafter endpoint configuration can be removed after operational migration.

### LibreChat

Add a normal OpenAI-compatible custom endpoint. In a shared Docker network use:

- base URL: http://junior-silva-v2:8126/v1
- model identifier: value of JUNIOR_SILVA_MODEL_NAME, normally junior-silva-v2
- API key: JUNIOR_SILVA_API_KEY

Set JUNIOR_SILVA_PUBLIC_URL to the public reverse-proxy route, not an internal hostname, so browser artifact downloads work. The OpenAI bridge sends specialist progress as reasoning_content; LibreChat can display it as visible status/thought content.

## Tests and operational checks

TESTING.md is the product acceptance checklist. It requires focused tests for a changed feature before the full regression suite.

Useful focused commands:

~~~powershell
node --test junior-silva/test/files.test.mjs junior-silva/test/legal-research.test.mjs junior-silva/test/time.test.mjs junior-silva/test/native-review.test.mjs junior-silva/test/mcp-native-tools.test.mjs
node --check junior-silva/mcp/server.mjs
node --check junior-silva/server/openai.mjs
git diff --check
~~~

The full upstream `npm run check` should be run when needed; a historical generated Together-model mismatch occurred in an earlier checkout. Verify the current failure before treating it as an upstream baseline or bypassing hooks.

## Known limitations and next engineering work

- PPTX and XLSX previews are content inspections, not pixel-perfect native rendering.
- PDF preview is extracted text, not a page-image rendering.
- Preview parsing has byte/XML limits and sanitization, but OOXML preview code should receive ongoing adversarial/zip-bomb testing.
- Public web research currently searches Serper results; Firecrawl and Jina configuration exists but is not yet invoked by services/web.mjs.
- Direct case/chunk/book retrieval is implemented via Typesense and legislation through Lex; indexed data and conversion can be incomplete or outdated.
- PDF-to-DOCX uses pdf2docx and may differ from the source; scanned or complex PDFs can fall back to extracted text. Verify material notices and source layout. DOCX annotations are produced by the native renderer, not by a document-creation skill.
- A formal authority/citation and quotation verification layer, data-retention/expiry policy, tenant-aware audit access, and legal-answer evaluation corpus remain valuable future work.
