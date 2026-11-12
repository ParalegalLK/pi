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
- [ ] Thought-process delivery.
- [ ] Pi uses document-creation skills, writes/runs code, and produces XLSX and PPTX artifacts.
- [ ] Legal scope blocks legally unrelated requests.
- [ ] LibreChat canvas previews for eligible final artifacts.
- [ ] Multiple related documents can be reviewed in one query.
- [ ] Upload as text.
- [ ] Upload as document.
- [ ] Large text supplied as a document still works.
- [ ] Legal scope blocks attempts to expose API keys or internal service details.

## Isolation check

`scripts/js-isolation-check.sh --yes` attacks the walls of the running stack as a test user B, against a test user A's data. It prints PASS, FAIL or LATER for each row of the isolation table in `task/tracker.md` (section 5), and its exit code is the number of failures. Its pieces are in `junior-silva/test/isolation/`.

- Run it only when nobody is using the stack. It takes about 10 minutes, switches the bridge to a stand-in model with a test key, and stops the runner briefly. It puts everything back when it ends; if it can't, run `docker compose up -d`.
- It needs the stack started with `docker compose up -d`, a bridge image built from the current code (`docker compose build`), `.env`, and `docker`, `python3`, `curl` and `ss` on the machine. It uses no real model and never prints a secret value.
- On a shared server it matters most that Pi can't reach the server's other services. So from a slot, it tries every TCP port the host listens on, on each of the host's addresses (P7.8). Ports open only to the host's own loopback are left out, because a container can't reach them. Its control is that they answer from the host itself. Any the host itself can't connect to, often because of its own firewall, are listed as proving nothing.
- Direct probes run a script inside a real Pi container, started with the runner's own Docker settings but without Pi, because Pi's guard would block some attacks first and hide a weak wall.
- Full-chain tests run real Pi through the real bridge and runner, with the stand-in model scripting the attacks. Each one first proves the attack really ran.
- It runs with the provider the stack is set to, Anthropic or Google (`PI_PROVIDER`). The stand-in model answers in that provider's format, and the crafted model calls use that provider's form: for Google, `fileData`, `googleSearch`, `urlContext`, `codeExecution` and `cachedContent`. A call to the other provider's route must get 404. To prove both, run it once with each.
- Every wall test has a positive control, such as user A's file being on disk while B tries to read it. A failed control counts as a failure.

Then, by hand in LibreChat with two accounts:

- [ ] Account A uploads a small test document and asks about it.
- [ ] Account B asks for A's document by its exact path in the data folder (the 29 Oct attack). It must fail.
- [ ] Stop works for both, chat titles appear, and a file Junior Silva made downloads.

## Load test

`scripts/js-load-test.py` measures how many workflows the running stack can handle at once (`task/deployment/plan.md`, M10).
- **A workflow:** one message sent straight to the bridge, the way LibreChat sends it. It comes from a made-up test user in a new chat, and asks for research and a Word document.
- **The order:** a baseline (one workflow, three times, one after another), then 2, 3, 5, 7 and 10 at once. After each level, it watches memory recovery for 3 minutes.

- It uses the real model, so every workflow costs money. Run it only when nobody is using the stack.
- `JS_SLOTS` must be at least the highest level. For the test only:
  - raise it in `.env`, run `docker compose up -d`, and wait a minute for the runner to make the slots;
  - put it back afterwards, and remove the extra `js-slot-*` networks.
- Run it in the background, so Ctrl+C can't cut off its clean-up (MG12):
  - start it with `nohup scripts/js-load-test.py --yes > ../js-load-test.log 2>&1 &`;
  - watch it with `tail -f ../js-load-test.log`;
  - stop it early with `touch ../js-load-test.stop`.
- `--check-only` runs the checks and 10 seconds of sampling, with no workflows. `--cleanup <results folder>` removes the test users a cut-off run left behind.
- **Before each level,** it stops if:
  - free RAM is under 2 GiB, or disk under 3 GB;
  - the load is at or above the CPU count;
  - a Pi run is going;
  - or another container restarted.
- **During a level,** it hangs up that level's chats if free RAM falls under 1 GiB, swap thrashes, or another container restarts.
- **Results** go to `../js-load-<time>/`. They hold no chat text and no secrets:
  - `server.txt`;
  - `runs.csv`, one row per workflow;
  - `samples.csv`, every 2 seconds;
  - `levels.csv`;
  - `summary.txt`, each level against the stable limits.

# Review clarification/evidence scenarios

Before the broader suite, verify review interaction behavior for a substantive pleading or agreement:

- Start a review with the primary document only. After preparation, Pi must either ask focused material questions or offer the optional evidence checkpoint; it must not finalise by silently assuming missing operative facts.
- Reply to that question/checkpoint using only a related document path/upload. Pi must treat it as new evidence, rerun `review_prepare_document_set` with the full document set, then reassess before finalising.
- Start another review with the primary document and related evidence together. Pi should read both before asking questions. If it asks a remaining focused question and the user says `skip`, Pi may finalise but must identify the unresolved evidence gap.

## Direct legal-source detail retrieval

- For “tax cases decided by Judge Mahinda Samayawardhena in 2026,” confirm Pi calls `legal_source_retrieve_details` with `operation: case_catalog`, not `rag_chat_research`. The trace should show exact judge resolution, a 2026 filter, a tax subject query, paginated case metadata, and source links.
- For a misspelled or ambiguous judge name, confirm the direct tool returns bounded candidate names and Pi asks for clarification rather than selecting a judge.
- For “what variants of Judge X's name exist in the judgment collection?”, confirm Pi calls `facet_values` first and returns every matching indexed label/count. For a surname that matches multiple labels, confirm a later case request asks for a selection or explicitly searches the returned label set; it must not silently choose the highest-count label.
- For “What legal principles emerge from those tax cases?”, confirm Pi retrieves selected case details and uses `rag_chat_research` for the resulting analysis rather than treating the catalogue alone as a legal conclusion.
- First obtain a normal Sri Lankan legal answer through `rag_chat_research`; confirm RAG remains the primary synthesis and citation tool where the user asks for analysis.
- When more detail about a cited authority is necessary, use `legal_source_retrieve_details` to find a known case and then retrieve bounded `decision_text` with its original link.
- Verify a case-chunk query returns a matching source passage and PDF link; verify book retrieval returns the book/chapter identifiers and reader context.
- Verify legislation retrieval discovers an Act through Lex, retrieves its complete ordered original sections with the Act ID, and retrieves an exact provision using that Act ID plus `section_number`. Use the Twenty Second Amendment to the Constitution (four sections) and section 57 of the Consumer Affairs Authority Act as controlled checks. Preserve only links returned by Lex; never invent amendment history or URLs. If the configured legislation endpoint is unavailable, it must fail without exposing an API key or raw service diagnostics. Respect Lex's five reader-page loads per minute limit during live checks.
- Confirm the final response retains relevant authority hyperlinks and does not expose Typesense hosts, keys, collection configuration, or internal field/control details to the user.
