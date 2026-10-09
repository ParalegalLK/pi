# Junior Silva V2 acceptance tests

## Required test order

Run the focused tests for the feature changed in the current work first. Do not begin the full regression suite until those focused tests pass. This makes a new regression visible immediately rather than after a long end-to-end run. Record the command, environment, result, and relevant log/session identifier for each failure.

## Focused preview-delivery tests

- [ ] A completed DOCX is published, then prepared as one LibreChat preview; its protected download remains available.
- [ ] A reviewed DOCX preview shows the reviewed document and preserves its original downloadable file.
- [ ] A PDF is prepared as a LibreChat preview.
- [ ] An XLSX is prepared as a LibreChat spreadsheet preview.
- [ ] A PPTX is prepared as a LibreChat slide-gallery preview.
- [ ] A substantive Markdown legal analysis is prepared as a LibreChat preview.
- [ ] A short email delivered only in chat does not create a preview.
- [ ] A single completed deliverable creates no duplicate preview in the same turn.

## Focused native review and drafting tests

- [ ] `node --test junior-silva/test/native-review.test.mjs` passes.
- [ ] A primary agreement plus a later-supplied annexure/employment agreement is read through `legal_read_document_set`; the ledger identifies both and the review uses the supporting facts before asking questions.
- [ ] A proposed clause finding without a reliable source anchor is rejected and is absent from the review report.
- [ ] A material risk with a reliable source anchor survives validation and retains its clause number, quotation, recommendation, and RAG authority link.
- [ ] The trace contains native `legal_*` review/drafting calls and contains no Reviewer Perera or Drafter Weeramantry MCP calls.
- [ ] A formal revision retains safe clauses, provides a before/after comparison for material changes, and reports unresolved `[FILL]` placeholders.

## Full regression suite

- [ ] Web search.
- [ ] Legal research through rag-chat-server (Researcher Silva).
- [ ] Legal drafting through Drafter Weeramantry.
- [ ] Simple email drafting without Drafter.
- [ ] Translation through Translator Siriwardena.
- [ ] Pi correctly recognizes temporal relevance of web-search findings based on current time.
- [ ] Web search plus rag-chat-server combined research.
- [ ] Citation insertion and retained hyperlinks in the final answer.
- [ ] Thought-process delivery. Coderunner-specific thought messages remain a follow-up to evaluate separately.
- [ ] Pi uses document-creation skills, writes/runs code, and produces XLSX and PPTX artifacts.
- [ ] Legal scope blocks legally unrelated requests.
- [ ] LibreChat canvas previews for eligible final artifacts.
- [ ] Multiple related documents can be reviewed in one query.
- [ ] Upload as text.
- [ ] Upload as document.
- [ ] Large text supplied as a document still works.
- [ ] Legal scope blocks attempts to expose API keys or internal service details.
# Review clarification/evidence scenarios

Before the broader suite, verify review interaction behavior for a substantive pleading or agreement:

- Start a review with the primary document only. After preparation, Pi must either ask focused material questions or offer the optional evidence checkpoint; it must not finalise by silently assuming missing operative facts.
- Reply to that question/checkpoint using only a related document path/upload. Pi must treat it as new evidence, rerun `review_prepare_document_set` with the full document set, then reassess before finalising.
- Start another review with the primary document and related evidence together. Pi should read both before asking questions. If it asks a remaining focused question and the user says `skip`, Pi may finalise but must identify the unresolved evidence gap.
