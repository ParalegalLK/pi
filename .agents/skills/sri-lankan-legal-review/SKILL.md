---
name: sri-lankan-legal-review
description: Review a Sri Lankan legal document or related document set with source-anchored legal and commercial findings.
---

# Sri Lankan legal review

Pi is the review coordinator. Select only the steps justified by the user's request and supplied documents.

## Evidence-first review

1. Call `review_prepare_document_set` once with every primary and supporting document. It creates the evidence packet, clause inventory, and commercial-coverage checklist together. Supporting files may resolve factual questions; read the returned packet before asking anything.
2. Run a clarification checkpoint after reviewing that material. Identify whether any material fact the document assumes is not established by the supplied evidence—for example, the operative contract/policy term, notices and correspondence, dates, property issue/return records, loss evidence, party identity, jurisdiction, or the procedural act said to have occurred. Ask focused questions for unresolved material facts; do not silently assume them.
3. If there are no focused questions but the request is a substantive review of a pleading, agreement, or other filing-ready document, offer one optional evidence checkpoint before finalising: ask whether the user has further agreements, correspondence, policies, asset records, notices, or evidence to be considered. The user may upload a document, answer, say “review normally”, or say “skip”. Do not offer this checkpoint when the user expressly asks for immediate review, chat-only analysis, or indicates no further material exists.
4. This is ordinary chat, not a review tool. If the user responds to a question/checkpoint by giving a file path or uploading a document instead of answering in prose, treat it as additional evidence—not as an answer to be ignored. Call `review_prepare_document_set` again with the original primary document and every related document, read the updated packet, and only then decide whether a question remains. If the user says “review normally” or “skip”, that closes every clarification/evidence checkpoint for this review: do any necessary legal research, then finalise without asking another evidence question. Clearly label each unresolved evidence gap or assumption in the final review.
5. Identify proposed findings only where you can quote or closely anchor the original wording. Include source anchor, clause/paragraph, protected party, category, severity, explanation, and recommended protection.
6. Use `rag_chat_research` to validate Sri Lankan legal propositions, authorities, remedies, or compliance consequences. Do not call a clause illegal merely because it is commercially unfavourable. Preserve authority URLs in the proposed findings.
7. Call `review_finalize_document` with the prepared context and proposed findings. It rejects unanchored findings and creates both the reviewed DOCX and Markdown report. Never report a rejected clause-specific finding as source-grounded.

## Deliverable standard

- Distinguish **legal/compliance risk**, **material commercial risk**, and **negotiation point**.
- State clause number and a short source quotation for every finding.
- Explain the risk plainly for the protected party and state a proportionate amendment.
- Cite linked Sri Lankan authorities only where RAG research supports them.
- Preserve the original document; the review is a separate artifact.
- Unless the user expressly asks for chat-only analysis, a requested document review is complete only after `review_finalize_document` returns its two deliverables. For a DOCX source, comments/highlights are attached at accepted source anchors; for PDF/text, the DOCX is a standalone professional review report.
