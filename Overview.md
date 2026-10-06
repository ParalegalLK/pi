# Junior Silva V2 — implemented architecture and operation

Junior Silva V2 is implemented on the official Pi `1.0.0` codebase. It deliberately has no central workflow engine, prescribed review→research→draft sequence, matter router, or hidden task-specific prompt. Pi receives a small set of accurately described specialist tools through native MCP and independently decides whether to call them, in what order, or not at all.

```text
Windows Pi CLI or LibreChat
            ↓
          Pi 1.0
            ↓ native MCP tool selection
Junior Silva Legal Services MCP (stdio)
    ├── Reviewer Perera V2 — interactive single/multi-document review
    ├── RAG Chat Server — linked Sri Lankan legal research
    ├── Drafter Weeramantry — drafting and revision with local artifacts
    ├── Translator Siriwardena — text and document translation
    └── LibreChat preview preparation — optional local artifact rendering
```

## Implemented repository layout

```text
pi/
├── .agents/skills/                  copied LibreChat document skills
├── .pi/mcp.json                     project MCP registration
├── junior-silva/
│   ├── cli/docker-cli.mjs           full interactive Pi inside Docker
│   ├── core/
│   │   ├── document-text.mjs        PDF/DOCX extraction and multi-file packets
│   │   ├── environment.mjs          .env loader and data locations
│   │   ├── files.mjs                validation, localization, protected links
│   │   └── http.mjs                 JSON/SSE service clients
│   ├── mcp/server.mjs               standards-compliant stdio MCP server
│   ├── server/openai.mjs            OpenAI-compatible HTTP/SSE endpoint
│   └── services/                    reviewer, RAG, drafter, translator adapters
├── Dockerfile
├── docker-compose.yml
├── Start-JuniorSilvaV2.ps1
├── .env                             real local settings; ignored by Git
└── .env.example                     safe configuration template
```

## Tool behavior

- `reviewer_perera_start_review` accepts one document or a related document set. For multiple files it extracts and labels the primary agreement and annexures in one combined review packet. When Reviewer Perera asks questions, the result explicitly requires a later user reply; Pi presents the questions and ends its turn.
- `reviewer_perera_continue_review` accepts only the later user's real answer. It preserves the original legal objective, waits safely for Reviewer Perera's asynchronous job, and returns the localized annotated `Reviewed_document.docx`.
- `reviewer_perera_get_findings` returns the protected structured clause findings for an already completed review.
- `rag_chat_research` returns the RAG service's client-ready research. Its contract tells Pi to retain the service's substantive structure, conclusion, and Markdown links to cases, legislation, and books. It distinguishes a direct research answer from research supporting a separate work product, so citation links survive synthesis into an email or letter.
- `drafter_weeramantry_draft_or_revise` accepts instructions plus optional local source files. Remote Drafter outputs are downloaded locally and returned as protected DOCX/Markdown/PDF artifacts.
- `translator_siriwardena_translate_document` and `translator_siriwardena_translate_text` expose document and direct-text translation separately, preventing unnecessary drafting calls for plain translation.
- `librechat_prepare_document_preview` is an optional presentation tool. Pi may use it when the user asks to inspect a completed DOCX, PDF, Markdown, text, or JSON deliverable. It creates a sanitized LibreChat Artifact preview and never changes the source file.

All specialist services emit MCP progress notifications. The OpenAI-compatible bridge converts those to `reasoning_content`, which LibreChat can display as the visible thought/status stream.

For RAG-only requests, the exact linked RAG response is delivered verbatim. For combined requests, a citation-delivery extension restores known original links where an authority label is retained and adds a concise linked-authority section only if the combined work product would otherwise contain none.

## Files and downloads

Generated files are localized under `junior-silva/artifacts/<operation-id>/` on Windows or `/data/artifacts/<operation-id>/` in Docker. Tool results include a local `file_uri` and a protected HMAC download URL. Drafter's private `/files/...` links are never passed directly to the user.

LibreChat “Upload as Text” envelopes are normalized into private Markdown files under the upload directory. Ordinary data-URL/provider attachments are supported, while HTTP attachment retrieval is restricted to `JUNIOR_SILVA_ATTACHMENT_ORIGINS` and redirects are rejected. Upload size and file-type checks apply.

## Running Pi directly on Windows

```powershell
cd 'D:\Intern\Work\Junior Silva V2\pi'
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\Start-JuniorSilvaV2.ps1
```

The launcher keeps Pi's regular CLI/TUI. On the first run, approve the trusted project MCP registration. This interactive CLI retains Pi's normal built-in capabilities and the copied skills in addition to the seven legal MCP tools.

## Running the Dockerized OpenAI-compatible endpoint

Docker runs inside WSL:

```bash
cd '/mnt/d/Intern/Work/Junior Silva V2/pi'
docker compose build junior-silva-v2
docker compose up -d junior-silva-v2
curl http://127.0.0.1:8132/health
```

The local endpoint is `http://127.0.0.1:8132/v1`, the model name is `junior-silva-v2`, and authentication uses `JUNIOR_SILVA_API_KEY`. Host port 8132 is intentional because the local Reviewer V2 container already occupies 8126. Inside Docker, Junior Silva still listens on 8126.

The hosted endpoint exposes only the legal MCP tools (`--no-builtin-tools`). This prevents LibreChat users from obtaining a shell or file editor. The interactive Windows/Docker CLI remains full Pi.

To use the full CLI inside Docker:

```bash
docker compose --profile cli run --rm junior-silva-cli
```

## LibreChat endpoint shape

Configure a normal OpenAI-compatible custom endpoint with:

- base URL: `http://junior-silva-v2:8126/v1` when LibreChat shares `librechat_default`
- API key: the same value as `JUNIOR_SILVA_API_KEY`
- fixed model: `junior-silva-v2`
- model fetching: disabled or enabled through `/v1/models`

For browser-downloadable artifacts in a deployed environment, set `JUNIOR_SILVA_PUBLIC_URL` to the externally reachable reverse-proxy path rather than the internal Docker hostname.

## Verified behavior

- Pi reports version `1.0.0`; all eight MCP tools connect.
- A three-document agreement/annexure review was sent as one combined packet. Pi asked Reviewer Perera's real questions and did not auto-answer them.
- A later real user answer completed the same review, retained the Background-IP concern, produced clause 6.1 findings, and returned a valid annotated DOCX.
- LibreChat-style Upload as Text was reconstructed, reviewed interactively, and completed only after the user's second-turn answers.
- Protected Reviewer and Drafter DOCX/Markdown downloads returned HTTP 200 with correct MIME types and valid content.
- Dockerized Pi independently selected RAG for a legal question and preserved linked Lex/NLR/SLLR authorities and answer sections.
- Dockerized Pi independently selected Translator Siriwardena and returned Sinhala text.
- DOCX, reviewed DOCX, PDF, and Markdown previews were generated locally into safe LibreChat Artifact markup; reviewed-DOCX previews retain a dashboard and reviewer comments beside the matched clauses while leaving the original DOCX unchanged.
- The image builds, the container is healthy on port 8132, and the Docker CLI reports Pi `1.0.0`.

## Original approved implementation plan

The following is the original plan retained for traceability.

I have inspected the fresh Pi checkout, V1 integrations, and LibreChat skills. No files have been changed.

# Proposed architecture

Pi will use its native MCP support:

```text
User request
    ↓
Pi model
    ↓ chooses tools from their descriptions
Built-in Pi MCP client
    ↓ stdio
Junior Silva Legal Services MCP server
    ├── Reviewer Perera V2
    ├── Drafter Weeramantry
    ├── Translator Siriwardena
    └── RAG Chat Server
```

There will be no central workflow engine, routing prompt, matter manager, or prescribed review→research→draft sequence.

Pi will see the available capabilities and decide which tools to call, in which order, based on the conversation.

## 1. MCP server

Add one local, standards-compliant stdio MCP server inside the fresh Pi repository.

Proposed structure:

```text
D:\Intern\Work\Junior Silva V2\pi\
├── .agents\
│   └── skills\
├── .pi\
│   └── mcp.json
├── junior-silva\
│   ├── mcp\
│   │   └── server.ts
│   ├── services\
│   │   ├── reviewer-perera.ts
│   │   ├── drafter-weeramantry.ts
│   │   ├── translator-siriwardena.ts
│   │   └── rag-chat.ts
│   ├── core\
│   │   ├── environment.ts
│   │   ├── files.ts
│   │   ├── http.ts
│   │   └── errors.ts
│   └── tests\
├── .env
└── .env.example
```

`.pi/mcp.json` will register this as a project MCP server with `direct` exposure. The tool set is small, so Pi can see the complete tool descriptions without using tool search or codemode discovery.

Only Pi’s built-in MCP extension will be needed. I will not add a custom routing extension.

## 2. MCP tools

### Reviewer Perera

Reviewer is interactive, so its API needs separate tools rather than pretending one call can pause for user answers:

- `reviewer_perera_start_review`
  - Accepts a PDF/DOCX path, protected party, and any context already supplied by the user.
  - Starts the review.
  - Returns the reviewer’s actual questions or a completed review.

- `reviewer_perera_continue_review`
  - Accepts the returned review/conversation ID and the user’s answers.
  - Continues until more questions or completion.
  - Downloads the completed annotated DOCX locally.

- `reviewer_perera_get_findings`
  - Retrieves the structured clause-level findings for a completed review.

These descriptions will explain capabilities, inputs, and outputs, but will not instruct Pi to run research or drafting afterward.

### RAG Chat Server

- `rag_chat_research`
  - Answers Sri Lankan legal questions using the RAG service.
  - Preserves citations and hyperlinks returned by RAG.
  - Can accept optional review findings or supplied legal context.
  - Does not automatically invoke review or drafting.

This will cover both ordinary legal questions and follow-up questions about reviewed clauses without imposing a fixed workflow.

### Drafter Weeramantry

- `drafter_weeramantry_draft_or_revise`
  - Creates a new legal document or revises an existing one.
  - Accepts instructions and optional source documents, findings, or research.
  - Downloads returned DOCX/Markdown outputs into the local V2 artifacts directory.
  - Its description will clearly distinguish drafting, revision, and preserving unaffected provisions.

### Translator Siriwardena

- `translator_siriwardena_translate_document`
  - Translates a PDF, DOC, DOCX, image, or a previously produced local artifact.
  - Downloads all document outputs locally.

- `translator_siriwardena_translate_text`
  - Translates pasted text directly.
  - Returns text rather than manufacturing a document unnecessarily.

## 3. File passing

There will be no V1-style matter store or workflow-managed artifact graph.

Instead:

1. Each tool accepts normal local file paths.
2. Service-generated URLs are downloaded automatically.
3. Outputs are stored under:

```text
junior-silva\artifacts\<operation-id>\
```

4. Every tool returns structured results containing the local paths.
5. Pi can pass those returned paths into another tool when the user requests a subsequent operation.

Example:

```text
User asks for a draft
→ Pi calls Drafter
→ MCP downloads draft.docx
→ tool returns its local path

User then asks to translate it
→ Pi calls Translator with that path
```

The MCP server will validate extensions, file existence, output origins, download sizes, timeouts, and filenames.

## 4. Tool-selection behaviour

There will be no routing rules such as “always review before drafting.”

Expected autonomous behaviour:

- “What is the effect of a binna marriage on inheritance?”
  - Pi chooses RAG.

- “Review this agreement for the Developer.”
  - Pi chooses Reviewer and relays its questions.

- “Draft a lease agreement.”
  - Pi chooses Drafter.

- “Translate this agreement into Sinhala.”
  - Pi chooses Translator.

- “Review this, then prepare a revised version.”
  - Pi can choose Reviewer followed by Drafter because the user requested both.

- “Draft an agreement.”
  - Pi does not call RAG or Reviewer unless it independently determines one is necessary or the user asks for them.

The only routing information Pi receives will be the MCP server description, individual tool descriptions, schemas, and returned data.

## 5. LibreChat skills

Copy the complete skill directories—not only their `SKILL.md` files—into `.agents/skills`:

- `docx`
- `pdf`
- `pptx`
- `xlsx`
- `legal-docx-build`
- `writing-style`
- `doc-coauthoring`

Scripts, templates, OOXML schemas, reference documents, Lua filters, and licence files will be preserved.

Two safeguards:

- `doc-coauthoring` contains an explicit staged workflow, so I will keep it manual-only rather than letting it silently impose that workflow on ordinary requests.
- `writing-style` will remain an auxiliary skill rather than appearing as a user-facing action.

No central “Junior Silva workflow” skill will be created.

I will also audit Windows compatibility because some LibreChat skills assume a Linux sandbox or `/mnt/data`. Only environment/path compatibility will be adapted; their document-quality instructions will remain intact.

## 6. Environment and secrets

Create:

- `.env` — real local configuration, ignored by Git.
- `.env.example` — names and safe defaults only.

I will copy the secrets required for this V2 runtime directly from V1 without printing them:

- Current Pi provider/model configuration and its API key.
- Reviewer URL and integration token.
- RAG URL and API key.
- Drafter URL, API key, and timeout settings.
- Translator URL and API key.

I will not copy unrelated V1 secrets such as the old Bandara HTTP gateway token, Typesense credentials, web-search keys, document-worker token, or LibreChat-facing settings because this V2 design does not use them.

For Windows-to-WSL connectivity, service URLs will come from `.env`. The infrastructure layer will resolve published localhost ports and can fall back to the current WSL address when necessary. Pi itself will not need instructions about WSL or Docker.

## 7. Security boundaries

The MCP layer will include:

- Input-path allowlisting.
- Supported-extension and size validation.
- Download-origin allowlisting per service.
- Safe generated filenames.
- Request timeouts and cancellation.
- No API keys in tool results, errors, logs, or MCP configuration.
- Redacted HTTP diagnostics.
- Read-only/idempotent MCP annotations where applicable.
- `.env`, downloaded artifacts, state, and traces excluded through `.gitignore`.

## 8. Testing

### Protocol tests

- MCP initialization succeeds.
- `pi mcp list` shows the server connected.
- Every tool has the intended name, description, schema, and annotations.
- No credential appears in MCP metadata or errors.

### Individual service tests

- Reviewer: start, answer questions, obtain annotated DOCX, retrieve findings.
- RAG: answer a Sri Lankan legal question with working citation links.
- Drafter: produce a DOCX and Markdown draft and save both locally.
- Translator: translate direct text and a saved document.
- Confirm all downloaded artifacts open correctly.

### Autonomous Pi tests

Run Pi without any workflow prompt and verify tool traces for:

1. Legal research only.
2. Document review only.
3. Drafting only.
4. Translation only.
5. Draft → review.
6. Review → legal follow-up question.
7. Draft → translation.
8. Review → draft revision → translation.
9. An unrelated/general request where no legal service tool should be called.

### Skill tests

Validate Pi discovers each copied skill and test representative DOCX, PDF, PPTX, XLSX, and legal-DOCX output.

### Repository checks

After implementation:

- Run the Pi repository’s required `npm run check`.
- Run focused MCP and adapter tests.
- Inspect Git status for accidental artifacts or secrets.
- Verify no V1 routing fragments or workflow prompts were copied.

This gives V2 a deliberately thin architecture: native Pi reasoning, one neutral MCP capability layer, four external legal services, and artifact skills. No hard-coded orchestration is carried over from V1.
