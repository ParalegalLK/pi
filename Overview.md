# Junior Silva V2 — engineering handover

Junior Silva V2 is a Sri Lankan legal-assistant integration built on the official Pi 1.0.0 codebase. It is deliberately a **thin capability layer**, not a workflow engine: Pi sees independent specialist tools through MCP and chooses whether to use them, in what order, and with which returned files.

The current deployment branch is **feat/deployment-test**. The upstream Pi base is preserved in the same repository; this document identifies the application-specific handover surface.

## Design principles

- **Pi decides the sequence.** There is no mandatory review → research → draft pipeline, matter router, or task-specific orchestration prompt.
- **Tools describe contracts, not workflows.** Each MCP tool says what it can do, what it needs, and what it returns. Pi uses source-anchored native review/drafting tools and asks for user facts only after it has read the available evidence.
- **Legal-only product boundary.** The legal-context extension handles greetings and clearly non-legal requests and appends legal-only policy on every agent run.
- **Sri Lankan legal focus.** Stable domestic research goes to RAG Chat Server; current/public developments can use web search; Pi may use both where a current source could change a stable legal rule.
- **Localize service artifacts.** Provider download links are never shown as user-facing links. Returned files are downloaded to controlled artifact folders and exposed through HMAC-protected download URLs.
- **Preserve sources.** Direct RAG research is delivered verbatim. In composite work, known RAG authority links are restored where the final text retains the associated authority.
- **The original file remains authoritative.** LibreChat previews are read-only derived views; they never alter DOCX, PDF, PPTX, XLSX, Markdown, or other source artifacts.

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
| junior-silva/cli/docker-cli.mjs | Starts the same Pi configuration in the optional Docker CLI profile. |
| junior-silva/server/openai.mjs | OpenAI-compatible HTTP/SSE endpoint used by LibreChat. |
| junior-silva/mcp/server.mjs | Standards-compliant stdio MCP server exposing specialist tools. |

The HTTP endpoint provides /health, /v1/models, /v1/chat/completions, and protected artifact-download routes. It serializes a conversation key so related turns do not race each other, translates MCP progress into SSE reasoning_content, and persists Pi sessions beneath the configured data root.

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
│       ├── sri-lankan-legal-review/         evidence-first native review guidance
│       ├── writing-style/                   writing-quality guidance
│       └── xlsx/                            workbook creation/recalculation guidance
├── .pi/
│   ├── mcp.json                             registers the local direct MCP server
│   └── extensions/
│       ├── junior-silva-legal-context.ts    scope, greeting/refusal, Colombo time,
│       │                                    artifact-skill instructions and preview policy
│       ├── legal-research-citation-delivery.ts
│       │                                    preserves/restores RAG authority hyperlinks
│       └── librechat-preview-delivery.ts    inserts prepared Artifact markup into final output
├── junior-silva/
│   ├── cli/
│   │   └── docker-cli.mjs                   Docker CLI launcher with the three extensions
│   ├── core/
│   │   ├── document-text.mjs                PDF/DOCX/text extraction; multi-file review packets
│   │   ├── environment.mjs                  .env loader and configured runtime roots
│   │   ├── files.mjs                        validation, localization, HMAC links, publishing
│   │   ├── http.mjs                         JSON/SSE request helpers and redacted diagnostics
│   │   ├── legal-research.mjs               extracts RAG authorities/delivery metadata
│   │   ├── native-review.mjs                source anchors, clause inventory, coverage audit, validated reports
│   │   ├── precedents.mjs                   read-only private drafting-precedent retrieval and draft hygiene
│   │   ├── previews.mjs                     safe DOCX/PDF/PPTX/XLSX/Markdown/text/JSON previews
│   │   └── time.mjs                         Colombo temporal context for current-source research
│   ├── mcp/
│   │   └── server.mjs                       MCP protocol implementation and tool declarations
│   ├── review/
│   │   ├── render_review_docx.py            source-anchored DOCX comments/highlights renderer
│   │   └── render_review_docx.ps1           Windows/WSL renderer wrapper
│   ├── server/
│   │   └── openai.mjs                       OpenAI-compatible LibreChat bridge and SSE progress
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
│       ├── legal-research.test.mjs          linked-authority delivery tests
│       ├── mcp-native-tools.test.mjs         native review/drafting MCP contract tests
│       ├── native-review.test.mjs            document-set, anchors and review rendering tests
│       ├── time.test.mjs                    Colombo temporal-context tests
│       └── fixtures/                        non-sensitive test fixtures
├── .dockerignore                            keeps secrets/runtime data out of Docker context
├── .env                                     local/server secrets; ignored by Git
├── .env.example                             safe configuration template
├── .gitignore                               excludes secrets, sessions, uploads and artifacts
├── Dockerfile                               Pi build plus V2 runtime image
├── docker-compose.yml                       HTTP service and optional interactive CLI profile
├── Start-JuniorSilvaV2.ps1                  Windows Pi launcher
├── TESTING.md                               focused-first acceptance and regression checklist
├── Overview.md                              this operational handover
└── History.md                               chronological implementation record
~~~

## Agent policy and extensions

### junior-silva-legal-context.ts

This is the **product policy extension**, not a hidden workflow. Pi loads it explicitly from both the Windows/Docker CLI launcher and the OpenAI bridge. Because Pi invokes its before_agent_start handler before every agent run, its appended system-prompt section is the effective top-level Junior Silva policy.

It provides:

- the Junior Silva legal greeting;
- a lightweight refusal for clearly non-legal requests;
- a system policy limiting work to Sri Lankan legal work and refusing prompt, credential, service-address, source-code, and internal-architecture extraction;
- the live Asia/Colombo date and time, so the agent does not treat already-past dates as future merely from model-training assumptions;
- directions to use discovered document skills and publish final skill-created artifacts;
- directions to read the native Sri Lankan legal review/drafting skills and to use their source-anchored tools;
- a default instruction to prepare one LibreChat preview for an eligible final artifact.

The agent still decides whether tools are needed and how to answer a legal request. The extension does not prescribe a service sequence.

### legal-research-citation-delivery.ts

RAG returns a formatted answer and links found in that answer. This extension observes RAG tool results. For research-only requests it substitutes the direct RAG answer exactly; for composite work it recognizes retained authority names and restores the corresponding original Markdown links. It avoids inventing citations and does not alter an existing Markdown link.

### librechat-preview-delivery.ts

When Pi calls librechat_prepare_document_preview, this extension captures the safe Artifact markup returned by the tool and appends it deterministically to the final assistant response. LibreChat then renders the side-panel/canvas artifact. Pi remains responsible for deciding that a preview is appropriate.

## MCP tools and contracts

All tools are declared in junior-silva/mcp/server.mjs and exposed directly by .pi/mcp.json.

| Tool | What it does | Important contract |
| --- | --- | --- |
| review_prepare_document_set | Reads the complete primary/supporting evidence set, maps the primary document, and checks commercial coverage. | Does not interview the user. Pi reads the returned evidence before deciding whether a question is genuinely necessary. |
| review_finalize_document | Validates proposed findings against the prepared source and creates legal-review.md plus Reviewed_document.docx. | Unsupported anchors are rejected. DOCX inputs receive source-positioned Word comments/highlights; PDF/text inputs receive a standalone professional review report. |
| legal_precedent_search / legal_precedent_read | Read a bounded excerpt from a private, read-only drafting corpus. | Structure only, never legal authority or user-visible source material. |
| legal_validate_draft | Finds unresolved placeholders and basic hygiene issues in a draft. | Legal propositions still require RAG validation. |
| rag_chat_research | Queries Sri Lankan legal research with authority links. | direct_answer is for research as the final answer; supporting_work_product is for research underpinning an email, letter, complaint, etc. |
| translator_siriwardena_translate_document | Translates a supported document. | Returns localized generated files where the service provides them. |
| translator_siriwardena_translate_text | Translates supplied text. | Avoids unnecessary document drafting. |
| web_search_public_legal_sources | Searches current public legal/news sources. | No client personal facts in query; use RAG too when current sources may change stable law. |
| code_runner_data_transform | Executes a small deterministic JavaScript calculation/table transform. | No network, filesystem, modules, shell, or document creation. |
| workbench_publish_artifact | Publishes a final skill-created workspace artifact. | Only final user-facing artifact files in the configured workspace. |
| librechat_prepare_document_preview | Generates a side-panel preview for a final artifact. | Preview once per primary final file; never replaces the original download. |

### Evidence-aware review conversation

The review skill supplies a flexible evidence protocol rather than a fixed service workflow:

1. Pi prepares and reads the complete supplied document set before asking any question.
2. It asks focused questions only for material facts unsupported by that evidence (for example, the operative term, notice, asset record, loss proof, party identity, jurisdiction, or procedural act).
3. Where a substantive pleading or agreement leaves no focused question, Pi offers one optional evidence checkpoint for further agreements, correspondence, policies, notices, asset records, or supporting material.
4. A user reply consisting only of a file path/upload is new evidence, not an implied answer. Pi rebuilds the packet with the original and every related document, then reassesses.
5. `review normally` or `skip` closes the checkpoint. Pi completes any needed research and finalises the report without asking another evidence question, expressly identifying unresolved gaps or assumptions.

This preserves normal conversation: Pi may choose whether research, a question, a review, a draft, or a preview is justified by the request; it is not forced into a review sequence.

## Documents, artifacts and previews

### Input and hand-off

- Supported inbound file types are PDF, DOCX, DOC, ODT, PPTX, XLSX, TXT, Markdown, JSON, PNG, JPG and JPEG; normal size limit is 50 MB.
- Related agreements and annexures are extracted into one labeled review packet, with an optional designated primary document.
- LibreChat provider uploads and Upload-as-Text envelopes are normalized to local private files before Pi sees them.
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
| private precedents | JUNIOR_SILVA_KB_ROOT, JUNIOR_SILVA_KB_HOST_PATH | Optional host-mounted, read-only Drafter precedent corpus; never copied into the image or repository. |
| public web | WEB_SEARCH_*, optional scraper/reranker settings | Current public-source research. The current adapter calls Serper; scraper/reranker values are reserved configuration until an adapter uses them. |
| endpoint | JUNIOR_SILVA_API_KEY, PUBLIC_URL, MODEL_NAME, PORT | OpenAI-compatible endpoint and artifact URLs. |
| storage | DATA_ROOT, ARTIFACT_ROOT, UPLOAD_ROOT, WORKSPACE_ROOT | Runtime data isolation. |

Default local data paths use junior-silva under the repository. Docker mounts them under /data and mounts the externally shared artifacts, uploads, workspace, sessions, and pi-agent folders for inspection/persistence.

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

The upstream repository-wide npm run check may currently fail in packages/ai/test/together-models.test.ts because DeepSeek-V4-Pro is absent from the generated Together model union. That is an upstream Pi baseline issue, not a Junior Silva V2 source error. Do not edit the unrelated test merely to make a V2 commit pass.

## Known limitations and next engineering work

- PPTX and XLSX previews are content inspections, not pixel-perfect native rendering.
- PDF preview is extracted text, not a page-image rendering.
- Preview parsing has byte/XML limits and sanitization, but OOXML preview code should receive ongoing adversarial/zip-bomb testing.
- Public web research currently searches Serper results; Firecrawl and Jina configuration exists but is not yet invoked by services/web.mjs.
- RAG is the current domestic research authority service in this branch. Direct Typesense research experiments are not part of this V2 deployment branch.
- Native DOCX review rendering currently relies on the available DOCX/legal-DOCX skills after findings are source-validated. A deterministic comment/highlight renderer is a valuable next hardening step.
- A formal authority/citation and quotation verification layer, data-retention/expiry policy, tenant-aware audit access, and legal-answer evaluation corpus remain valuable future work.
