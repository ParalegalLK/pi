# Junior Silva V2 — Development History

This history records the development of the independent Junior Silva V2 integration in this Pi repository. It deliberately excludes credentials, user documents, and runtime artifacts.

## 1. Baseline and design decision

- Junior Silva V2 was started from the official Pi `1.0.0` release.
- It is intentionally separate from the earlier Junior Silva / Senior Barrister Bandara implementation, which used a central OpenAI-compatible workflow bridge and a managed matter workflow.
- The core decision for V2 was to preserve Pi's own agency: Pi is given specialist capabilities and their accurate contracts, then decides whether to use a tool, which tool to use, and the order of calls.
- No fixed review → research → draft workflow, hidden routing prompt, or matter-orchestration policy was added.

## 2. Native MCP capability layer

- A local standards-compliant stdio MCP server was added at `junior-silva/mcp/server.mjs`.
- Project registration is in `.pi/mcp.json`, so the normal Pi CLI discovers the legal-service tools as native MCP tools.
- The following services are exposed through focused, independently usable tools:

  - **Reviewer Perera V2** — starts an interactive review, continues it only with a later real user answer, and retrieves structured findings.
  - **RAG Chat Server** — provides Sri Lankan legal research while retaining structured responses and authority links.
  - **Drafter Weeramantry** — creates or revises legal documents and returns localized deliverables.
  - **Translator Siriwardena** — translates either documents or supplied text without unnecessarily invoking drafting.

- Tool descriptions state capabilities, input/output contracts, and interactive boundaries. They do not instruct Pi to follow a preset multi-service workflow.

## 3. Files, artifacts, and cross-service hand-off

- `junior-silva/core/document-text.mjs` extracts and packages PDF/DOCX/text inputs. Related documents and annexures are labelled in a combined review packet when a review tool receives several files.
- `junior-silva/core/files.mjs` validates local input paths, supported formats, filenames, output origins, and downloads.
- Service outputs are localized under `junior-silva/artifacts/<operation-id>/` on Windows, or `/data/artifacts/<operation-id>/` in Docker.
- Tool results return safe local artifact paths and protected links rather than exposing a provider's private download URL.
- Runtime uploads, sessions, audits, and artifacts are intentionally excluded from Git.

## 4. Interactive review behaviour

- Reviewer Perera is asynchronous and may ask legal-context questions before it can produce an annotated review.
- V2 therefore separates `start_review` from `continue_review` rather than auto-answering the reviewer.
- The start result explicitly tells Pi that the questions must be shown to the user and that Pi must wait for a later reply.
- The continuation tool accepts the user’s actual reply, including a user choice such as “review normally” or “skip”, and returns the completed annotated DOCX once available.
- A completed review can be used as input to a later RAG, drafting, or translation request only when the user asks for that work.

## 5. Citation quality and legal research

- The RAG tool contract was refined so that Pi must preserve the RAG service’s substantive answer, headings, conclusion, and Markdown hyperlinks to cases, legislation, books, and other authorities.
- A Pi extension at `.pi/extensions/legal-research-citation-delivery.ts` reinforces this delivery requirement. It is a presentation safeguard, not a legal-research workflow controller.
- This addresses an early issue where Pi would paraphrase RAG output and accidentally strip useful authority links.

## 6. Local CLI and Docker/OpenAI endpoint

- `Start-JuniorSilvaV2.ps1` launches the ordinary interactive Pi CLI on Windows and retains Pi’s usual UI and built-in capabilities.
- `Dockerfile` and `docker-compose.yml` add a Docker deployment for WSL.
- The Docker service runs an OpenAI-compatible HTTP/SSE bridge at `junior-silva/server/openai.mjs`.
- It exposes model `junior-silva-v2` on host port `8132` (container port `8126`), avoiding the port already occupied locally by Reviewer Perera V2.
- The hosted endpoint uses `--no-builtin-tools`, exposing only the legal MCP capability set to LibreChat users; the direct Pi CLI remains unrestricted.
- MCP progress notifications are converted to `reasoning_content`, allowing compatible clients to display service status as visible thoughts.

## 7. Upload and attachment handling

- Standard provider/data-URL attachments are supported.
- LibreChat-style “Upload as Text” envelopes are reconstructed as private Markdown upload files so Pi can pass meaningful content to the appropriate legal tool.
- Attachment fetching is restricted to configured origins; redirect handling, input-size limits, and file-type validation are enforced.
- These protections prevent arbitrary URL fetches and keep uploaded legal material inside the V2 runtime boundary.

## 8. Skills

- LibreChat document-related skills were copied under `.agents/skills/` for use by interactive Pi where appropriate.
- The copied skills include document, PDF, presentation, spreadsheet, legal-DOCX, co-authoring, and writing-style materials together with their supporting resources.
- They are supporting capabilities only. No new Junior Silva workflow skill was introduced.

## 9. Validation performed

- Pi reported version `1.0.0`, and the MCP server connected with the expected legal tools.
- A related three-document agreement/annexure review was combined into one packet; Pi presented Reviewer Perera’s actual questions and waited for the user response.
- The subsequent user response completed the same review, retained a Background-IP concern, reported clause 6.1 findings, and produced a valid annotated DOCX.
- LibreChat-style Upload as Text content was reconstructed and tested through the interactive review path.
- Reviewer and Drafter deliverables were localized; protected DOCX/Markdown download routes returned valid files and MIME types.
- The Docker endpoint independently selected RAG for a legal question and retained linked Lex/NLR/SLLR authorities and structured sections.
- The Docker endpoint independently selected Translator Siriwardena and returned translated Sinhala text.
- The image built successfully, passed its health check, and the Docker CLI reported Pi `1.0.0`.

## 10. Known operational limitations

- Drafter turnaround remains dependent on Drafter Weeramantry’s external queue/model capacity. The V2 adapter preserves provider progress and has bounded timeouts, but does not modify the Drafter service itself.
- Service credentials and published URLs are runtime configuration in `.env`; they are not source-controlled.
- A production LibreChat deployment still needs its own endpoint/reverse-proxy configuration and the public artifact URL to be set for that environment.

## 11. Repository and secrecy policy

- `.env` is ignored. `.env.example` contains empty placeholder values and safe defaults only.
- Generated artifacts, uploaded source documents, session transcripts, audit traces, and dependencies are ignored.
- API keys, integration tokens, user documents, provider URLs containing credentials, and temporary service outputs must never be force-added or committed.
- Before any commit, inspect `git status --short`, `git diff --cached`, and the staged file list. Commit source/config templates only.

## 12. Current development state

- The working branch is `dev`, based on Pi `1.0.0`.
- The V2 implementation files are currently local worktree changes awaiting a deliberate user-controlled review, stage, commit, and push.
- No commit or push is made as part of this history update.

## 13. Citation delivery and optional LibreChat previews

- The RAG adapter now returns a structured authority bundle in addition to its normal linked research answer.
- Research calls identify whether RAG is the direct final answer or support for a separate user-requested work product. This prevents a research-backed email or letter from losing the original case/legislation URLs during synthesis.
- The citation-delivery extension preserves existing links, restores matching authority links in combined responses, and adds a small linked-authority section only when a combined answer would otherwise lose every available authority link.
- An optional `librechat_prepare_document_preview` MCP tool was added. Pi may choose it for substantial completed deliverables. It renders Markdown natively and produces local sanitized HTML previews for DOCX and PDF files.
- Reviewed-DOCX preview generation reads Word comments and anchors from OOXML and places reviewer notes beside the matching rendered clauses. The original downloadable DOCX/PDF is not modified.

## 14. Tool-routing, citation, web, and code-runner refinements (5 October 2026)

- Citation preservation was corrected at the delivery boundary rather than by changing RAG Chat. The citation-delivery extension now recognises the actual native MCP research tool name (`rag_chat_research`, including Pi's namespaced variants), reads both textual and structured authority results, preserves already-linked Markdown, and restores a compact **Linked authorities supporting this draft** section only if a research-backed combined deliverable would otherwise lose every authority link.
- This specifically covers the difference between a direct research answer (where Pi generally returned RAG's answer verbatim) and a combined task such as “research, then draft an email”, where a later model synthesis had previously reduced linked citations to plain case or Act names.
- Drafter Weeramantry's MCP description was narrowed to its intended role: downloadable formal legal instruments, substantial legal-document revisions, or requested DOCX/PDF/Markdown work products. It expressly tells Pi not to use Drafter for ordinary emails, short complaint letters, chat replies, summaries, or legal research. Those should normally be written directly in chat unless the user expressly requests a formatted downloadable document.
- Added optional public-web research and a sandboxed data-transform capability to the MCP service. Public web research currently discovers sources through Serper; the configuration also holds optional Firecrawl and Jina settings for a subsequent verified-fetch/rerank stage. The data runner is deliberately limited to data-only JavaScript transformations and blocks filesystem, process, shell, network, module-loading, and dynamic-code facilities.
- Runtime feature flags and credentials remain in `.env` only. The web and code facilities can be enabled or disabled independently without changing Pi's legal-service contracts.
- Validation covered MCP registration, JavaScript syntax checks, web-search discovery, isolated data transformation, explicit RAG research with authority links, and a research-backed drafting response. A Gemini 3.7 Flash test confirmed the configured runtime model and successful linked-authority restoration.

## 15. Outstanding temporal-grounding improvement

- A current-events test exposed that Pi itself was not supplied with a runtime “current date” context. It incorrectly described a September 2026 event as future despite the runtime date being 5 October 2026 (Asia/Colombo).
- This is a temporal-grounding defect, not a reason to restrict historical searches. The planned correction is to inject the live Asia/Colombo date into every Pi request and web-research result, then require current-status answers to distinguish event, publication, and legal-commencement dates against that runtime reference.

## 16. Legal scope and runtime chronology safeguards (6 October 2026)

- Added a Junior Silva Pi extension that constrains both the interactive CLI and the OpenAI-compatible endpoint to Sri Lankan legal work. It gives the requested Junior Silva greeting for a simple greeting and declines clearly non-legal requests such as ordinary coding, essays, and casual tasks.
- The hosted endpoint already uses `--no-builtin-tools`; the local launcher now uses the same legal-only tool boundary. Legal MCP tools remain available in both environments.
- Added a live `Asia/Colombo` clock to Pi's system context, RAG requests, and public-web research results. It tells the model to evaluate dates against the actual runtime date and to distinguish event, publication, Gazette, and commencement dates. It does not contain an instruction to discard or downgrade older legal authorities.
- The code-runner remains the existing data-only transformation tool. A general arbitrary-code executor was not added because it would require a separately approved, properly isolated execution service.
