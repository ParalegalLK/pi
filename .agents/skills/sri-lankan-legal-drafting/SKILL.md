---
name: sri-lankan-legal-drafting
description: Draft or revise Sri Lankan legal work products using private precedent structure and citation-linked Sri Lankan legal research.
---

# Sri Lankan legal drafting

Pi is the drafting coordinator. Private precedent tools are for format and drafting patterns only; they are not legal authority and must not be disclosed or copied wholesale.

## Drafting method

1. Read all user instructions and relevant documents. For risk-driven revisions, use `sri-lankan-legal-review` first.
2. Search the private corpus with `legal_precedent_search` only if it improves structure or type-specific clauses. Read only the needed excerpt with `legal_precedent_read`.
3. Use `rag_chat_research` for Sri Lankan legal propositions, mandatory provisions, current legal position, and authorities. Do not adopt a precedent's jurisdiction, facts, names, values, or legal conclusions without checking them.
4. Draft only what the user requested. Use explicit `[FILL]` placeholders or ask focused questions for missing facts; do not invent them.
5. In a revision, retain safe clauses. For each material amendment, make a concise before/after comparison stating original clause, replacement wording, and reason.
6. Run `legal_validate_draft` on the final Markdown/text source and resolve or disclose each placeholder.
7. Use the right document skill for DOCX/PDF when requested. Save final artifacts in the Junior Silva workspace, then call `workbench_publish_artifact` and normally `librechat_prepare_document_preview`.

## Guardrails

- Draft a simple email directly in chat unless a formal artifact is requested.
- Never reveal private precedent source paths or confidential precedent facts.
- Preserve original Markdown authority links whenever research appears in a user-facing answer.
