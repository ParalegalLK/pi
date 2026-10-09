# Junior Silva V2 — development history

This is a factual implementation history for engineers continuing work on Junior Silva V2. It intentionally excludes credentials, user files, session contents, and deployment-specific values.

## Native review finalisation — two-tool surface

- Replaced the fragmented production review-tool surface with `review_prepare_document_set` and `review_finalize_document`.
- Preparation reads the whole supplied evidence set, distinguishes the primary document from annexures/supporting material, creates a clause inventory and a commercial-coverage prompt, and **does not** ask interview questions. Pi may ask a normal chat question only after examining this evidence and only where a material fact remains unresolved.
- Finalisation accepts Pi's proposed findings, validates each exact source anchor, rejects unsupported findings, preserves authority URLs, and creates both `legal-review.md` and `Reviewed_document.docx`.
- The renderer copies DOCX sources and applies comments/highlights at original matched text. Multi-paragraph extracted anchors fall back to the most distinctive source line. PDF/text sources produce a standalone review report rather than pretending the original file was annotated.
- Added `bayoo-docx` to the Docker image because its compatible `add_comment` API is required for actual Word comments. The Windows wrapper maps paths safely into WSL for the portable renderer.
- Focused tests cover tool exposure, complete evidence preparation, rejection of unsupported findings, Markdown/DOCX delivery, PDF/text report generation, and actual DOCX comment/highlight XML. A synthetic Pi CLI review also confirmed Pi selected preparation, finalisation, preview generation, and delivered both artifacts.

## Evidence-aware review clarification and annexure handling

- Refined the `sri-lankan-legal-review` skill and legal-context extension after testing a pleading against an underlying agreement supplied later in the conversation.
- Pi must now read the initial prepared evidence packet before deciding whether a clarification is material. It cannot silently assume facts required by a pleading, agreement, or filing-ready document.
- The skill directs Pi to ask focused questions for unresolved material facts and, where none remains for a substantive review, offer one optional evidence checkpoint for additional agreements, correspondence, policies, notices, asset records, or evidence.
- A reply containing only a document path/upload is explicitly treated as newly supplied evidence. Pi must rerun `review_prepare_document_set` using the original document and all related material, read the revised packet, and reassess; it must not treat the upload as an ignored non-answer.
- `review normally` and `skip` now close every evidence/clarification checkpoint. Pi may complete research but must finalise without another question, clearly recording residual evidence gaps or assumptions.
- End-to-end CLI verification used a draft plaint and a later-supplied employment agreement. The second packet contained both documents; findings identified source-grounded inconsistencies including the pleaded employment/salary characterization versus the underlying internship/stipend agreement and an unsupported physical-laptop recovery claim. The final DOCX contained embedded Word comments and highlight/shading XML.

## Foundation — Pi 1.0 and capability-first design

- Junior Silva V2 was created from the official Pi 1.0.0 codebase rather than modifying Junior Silva V1 / Senior Barrister Bandara.
- The design choice was to expose neutral specialist capabilities and let Pi select them. No central workflow engine, mandatory review → research → draft sequence, hidden matter router, or per-task orchestration prompt was added.
- A local stdio MCP server was registered in .pi/mcp.json with direct exposure.

## Initial legal-service MCP integration

Implemented junior-silva/mcp/server.mjs and the service adapters under junior-silva/services.

- **Reviewer Perera V2:** separated start, continuation and findings retrieval because Reviewer is interactive and asynchronous.
  - Tool descriptions require Pi to surface Reviewer’s real questions and wait for the user’s later reply.
  - Pi must not manufacture “review normally” or “skip.”
  - The adapter can package a main agreement plus annexures into a labeled combined review packet.
- **RAG Chat Server:** returns the research answer, delivery metadata and linked authorities.
- **Drafter Weeramantry:** downloads produced DOCX/Markdown/PDF deliverables into local artifact storage.
- **Translator Siriwardena:** exposes separate document and text translation paths so a simple translation does not invoke drafting.
- **Public web search:** added Serper-based current-public-source search for Gazettes, current legal developments, international legal questions and other material outside the stable domestic corpus.
- **Data-only code runner:** added isolated JavaScript calculations/table reshaping. It is deliberately not a shell or document-production tool.

## Artifact handling and cross-service file hand-off

- Added core/files.mjs, core/document-text.mjs, core/http.mjs, and core/environment.mjs.
- Inputs are extension/size validated and service outputs are localized under an operation-specific artifact directory.
- HMAC-protected download tokens prevent the UI from exposing upstream private Drafter/Reviewer file links.
- Upload-as-Text and provider uploads are turned into private local files. Multiple related files can be passed to the review tool together.
- Runtime artifacts, uploads, sessions, workspace files, agent state and .env are ignored by Git and excluded from Docker build context.

## Citation-preserving legal research delivery

- Direct RAG answers are delivered verbatim when research itself is the requested final work product; this retains RAG’s headings, conclusion and Markdown authority links.
- Composite requests—such as “research then draft an email”—were losing links during Pi synthesis. legal-research-citation-delivery.ts was added to observe RAG results, collect authority links, find retained authority names in the final response, and restore original Markdown links.
- The extension does not invent citations, overwrite existing links, or force a linked-authority appendix when links are already present.

## Legal scope, current-time awareness and document-skill usage

- Added junior-silva-legal-context.ts as the product-policy extension.
- It gives Junior Silva’s greeting, rejects clearly unrelated tasks, and adds a legal-only policy on every agent run.
- It supplies the current Asia/Colombo date/time at runtime so current-law/news questions are interpreted against the real date rather than model-training assumptions. This does **not** discard older case law or Acts; relevance remains a question of legal role and the user’s question.
- Document skills copied from LibreChat were placed in .agents/skills: DOCX, legal DOCX, PDF, PPTX, XLSX, writing-style and doc coauthoring.
- Hosted Pi was changed to allow Pi’s built-in execution tools. This enables Pi to read a skill, execute its scripts/code and create legal presentations, spreadsheets, PDFs and documents. The same extension blocks misuse of Drafter for PPTX/XLSX/visual artifacts and directs Pi to matching skills plus artifact publishing.
- This is intentionally functional rather than fully sandboxed; see the security note in Overview.md before exposing it to untrusted public users.

## OpenAI-compatible service and LibreChat integration

- Added junior-silva/server/openai.mjs and Docker support.
- The service exposes /health, /v1/models, /v1/chat/completions, and protected artifact downloads.
- Pi’s streamed specialist-tool progress is converted into OpenAI-compatible SSE reasoning_content, enabling LibreChat visible status/thought updates.
- The bridge starts Pi with all three Junior Silva extensions and uses the configured provider/model/think level.
- Conversation work is serialized per conversation key to prevent overlapping turns from corrupting an interactive review sequence.
- Compose uses the junior-silva-v2 service on container port 8126, published at host 127.0.0.1:8132, plus an optional interactive CLI profile.

## LibreChat artifact previews

- Added workbench_publish_artifact, librechat_prepare_document_preview, core/previews.mjs, services/preview.mjs, and librechat-preview-delivery.ts.
- The legal-context extension now directs Pi to normally preview the single primary completed artifact in LibreChat while avoiding short chat-only emails, intermediate assets and duplicate formats.
- The preview-delivery extension makes preview markup deterministic once Pi elected to call the preview tool.
- Supported preview formats are DOCX, reviewed DOCX, PDF, PPTX, XLSX, Markdown, TXT and JSON.
- Reviewed DOCX previews parse Word comment ranges and place comments beside matched source clauses in derived HTML. This corrected the earlier poor preview that collected all comments in one place. The original annotated Word document is unchanged.
- PPTX previews show extracted slide text in a gallery; XLSX previews show a bounded worksheet/table inspection. These are inspection views, not replacements for native Office rendering.

## Testing and documentation

- Added focused unit coverage for file safety, citation delivery and Colombo temporal context under junior-silva/test.
- Added TESTING.md with a required focused-first test order, preview checks and the wider regression checklist: web/RAG/drafting/translation, combined research, citation links, document-skill output, legal scope, uploads, multiple document review and prompt/secrets protection.
- Manual focused preview tests successfully exercised DOCX, reviewed DOCX, PDF, Markdown, PPTX and XLSX preparation, as well as final Artifact-markup injection.
- git diff --check, targeted Node syntax checks, and focused V2 tests have been used for validation.
- The upstream Pi full check is currently blocked by an unrelated generated-model typing mismatch in packages/ai/test/together-models.test.ts: DeepSeek-V4-Pro is not in the generated Together model union. Future maintainers should not change that unrelated upstream test merely to validate Junior Silva V2 work.

## Docker build compatibility fix

- Docker builds encountered an OverlayFS cross-device rename error while hydrate:model-data attempted to replace the copied packages/ai/src/providers/data directory.
- The V2 Dockerfile now removes that generated directory before npm run hydrate:model-data and npm run build:offline, allowing the generator to recreate it in one writable layer.

## Native review and drafting migration

- Replaced the production MCP exposure of Reviewer Perera V2 and Drafter Weeramantry with Pi-native legal tools. Their adapter files remain temporarily for rollback/reference, but the production MCP server no longer declares or routes to them.
- Added `core/native-review.mjs`: it reads a primary document with all supporting evidence, produces a source clause inventory, applies the nine-dimension commercial-coverage challenge adapted from Reviewer V3, validates every proposed finding against its original anchor text, and renders reports from accepted findings only.
- Added `core/precedents.mjs`: it searches and reads a private, read-only external drafting corpus with bounded excerpts, explicitly treating it as structural precedent rather than legal authority. It also checks final textual drafts for unresolved placeholders.
- Added the `sri-lankan-legal-review` and `sri-lankan-legal-drafting` skills. These tell Pi to inspect evidence first, use RAG for Sri Lankan legal propositions, keep safe clauses in revisions, produce before/after comparisons for material amendments, and never disclose precedent paths or confidential source material.
- Updated the OpenAI bridge so each turn supplies every upload already attached to the same conversation, not only files uploaded in the latest message. This lets later employment agreements, annexures, or supporting evidence materially inform review/drafting rather than being mistaken for a text-only answer.
- Added focused deterministic native-review tests for multi-document packets, anchor acceptance/rejection, coverage evidence, generated review reports, and placeholder detection.

## Windows CLI legal-DOCX recovery

- A local CLI plaint test revealed that the launcher did not export/create `JUNIOR_SILVA_WORKSPACE_ROOT`. Pi consequently chose an undeclared project `tmp` path, and its Markdown validator initially raced a missing file.
- The Windows launcher now creates and exports the configured workspace before Pi starts. Draft validation now rejects an empty file rather than incorrectly returning a clean result.
- The normal legal-DOCX build script requires Bash/Pandoc. Windows/Git-Bash had no Pandoc, so a portable WSL/Python-docx renderer and PowerShell wrapper were added to the legal-DOCX skill. Pi uses that route when the full pipeline is unavailable, writes the Markdown and DOCX in the configured workspace, then can publish/preview the DOCX normally.

## Current branch state and handoff

- Current deployment branch: **feat/deployment-test**.
- Recent V2 commits include:
  - a1dad37d8 — initial Junior Silva V2 legal MCP workbench.
  - 3c3815f7c — LibreChat artifact previews, PPTX/XLSX preview support, preview delivery policy and TESTING.md.
- There is a separate dev branch containing earlier legal-scope and chronology work. The deployment branch has the current V2 integration and should be treated as the source of truth for this worktree.
- Before deploying a newer commit, rebuild/recreate junior-silva-v2, check /health, check an MCP-dependent legal route, and then run focused tests for the changed feature before the full TESTING.md suite.

## Pending engineering priorities

1. Add source/authority and quotation verification rather than relying solely on retrieved citation links.
2. Implement robust per-user/matter authorization, data retention, deletion and audit controls for production multi-user deployment.
3. Place the full Pi built-in execution environment inside a stronger isolated workspace/egress sandbox if external/untrusted users retain access.
4. Add adversarial OOXML/ZIP preview tests and improve native visual fidelity for PPTX/PDF/XLSX previews where needed.
5. Decide whether to wire Firecrawl/Jina into services/web.mjs; their environment configuration exists but the current code only calls Serper.
6. Build a golden legal-answer/review evaluation set with verified Sri Lankan authorities, expected citation links, and regression assertions.
