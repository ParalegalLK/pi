---
name: sri-lankan-legal-review
description: Review a Sri Lankan legal document or related document set with source-anchored legal and commercial findings.
---

# Sri Lankan legal review

Pi is the review coordinator. Select only the steps justified by the user's request and supplied documents.

## Evidence-first review

1. Call `review_prepare_document_set` once with every uploaded document. It creates the evidence packet, identifies one or more review targets versus supporting material, and builds separate clause inventories/coverage checklists for every target. Use explicit `review_file_paths` and `supporting_file_paths` when the user makes roles clear. Otherwise assess the packet, filenames, headings and cross-references. Do not silently treat the first upload as the only review target. Supporting files may resolve factual questions; read the returned packet before asking anything. Ask a concise role question only when the intended review targets remain genuinely ambiguous.
2. Run a clarification checkpoint after reviewing that material. Identify whether any material fact the document assumes is not established by the supplied evidence—for example, the operative contract/policy term, notices and correspondence, dates, property issue/return records, loss evidence, party identity, jurisdiction, or the procedural act said to have occurred. Ask focused questions for unresolved material facts; do not silently assume them.
3. For every substantive review of a pleading, agreement, or other filing-ready document, complete the returned evidence checkpoint before finalising. Ask whether the user has further agreements, correspondence, policies, asset records, notices, or evidence to be considered. The user may upload a document, answer, say “review normally”, or say “skip”. This checkpoint is waived only when the user expressly asks for immediate review or chat-only analysis.
4. This is ordinary chat, not a review tool. Do not record a checkpoint outcome during the same turn that prepared the review; wait for the user's actual later response. If the user responds to a question/checkpoint by giving a file path or uploading a document instead of answering in prose, treat it as additional evidence—not as an answer to be ignored. Call `review_prepare_document_set` again with the original primary document and every related document, read the updated packet, and only then decide whether a question remains. If the user says “review normally” or “skip”, call `review_record_checkpoint_outcome` before finalising. Clearly label each unresolved evidence gap or assumption in the final review.
5. Identify proposed findings only where you can quote or closely anchor the original wording. Include source anchor, clause/paragraph, protected party, category, severity, explanation, and recommended protection. When more than one target is selected, include the returned `target_id` for every finding.
6. Use `rag_chat_research` to validate Sri Lankan legal propositions, authorities, remedies, or compliance consequences. Do not call a clause illegal merely because it is commercially unfavourable. Preserve authority URLs in the proposed findings. Choose three clear, distinct category names appropriate to the document and user's perspective, assign red, orange and yellow once each, and place each finding in one category. Support assertions of illegality or non-compliance with relevant authority; explain uncertainty where appropriate.
7. Call `review_finalize_document` with the prepared context and proposed findings. It refuses early finalisation while a required evidence checkpoint is pending, rejects unanchored findings, verifies DOCX annotation coverage, creates a separate reviewed DOCX and Markdown report for every selected target, and returns protected download links/previews. Never report a rejected clause-specific finding as source-grounded or expose local artifact paths.

## Finding granularity and annotation quality

A finding represents one distinct legal or commercial issue, not every clause that relates to it. Before finalising, consolidate proposed findings that have the same risk, practical consequence, and recommended protection. Use one primary finding and one most operative source anchor. A comment may explain relevant cross-references, but do not repeat substantially the same explanation and recommendation at several clauses merely because they relate to the same issue. Give the same `issue_key` to any candidates that truly describe the same issue.

Choose the narrowest continuous original wording that creates the issue: normally the relevant subclause, obligation, exclusion, consequence, definition limb, or payment/termination trigger. Prefer one to three complete sentences or the smallest complete contractual unit needed to understand the risk. Do not anchor a section heading, schedule heading, table title, or clause label when the operative obligation appears below it. Use a heading as an anchor only if the heading itself creates the legal or commercial issue and there is no more specific operative wording.

For a missing protection, do not invent absent text. Mark the nearest meaningful insertion point instead: the affected operative clause, related clause group, schedule entry, or a relevant heading where a new clause belongs. Set `missing_protection: true`, state why that location is the appropriate placement point, and make the comment clear that the concern is an omission rather than wording already present in that anchor.

A useful finding identifies the exact operative text or placement point, one distinct issue, the protected party and practical consequence, one proportionate recommendation, and authority URLs only where it asserts legal non-compliance.

## Deliverable standard

- Use the three chosen document-appropriate categories consistently in findings, comments, the colour legend and the report.
- State clause number and a short source quotation for every finding.
- Explain the risk plainly for the protected party and state a proportionate amendment.
- Cite linked Sri Lankan authorities only where RAG research supports them.
- Preserve the original document; the review is a separate artifact.
- Unless the user expressly asks for chat-only analysis, a requested document review is complete only after `review_finalize_document` returns its two deliverables with verified annotation coverage. For a DOCX source, comments/highlights are attached at accepted original source anchors. For PDF/text, the reviewed DOCX preserves the extracted source wording and attaches comments/highlights at the corresponding extracted clauses.
