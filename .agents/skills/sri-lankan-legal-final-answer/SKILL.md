---
name: sri-lankan-legal-final-answer
description: Compose substantive Sri Lankan legal answers with source-grounded reasoning, clear structure, and claim-level Markdown citations.
user-invocable: false
---

# Sri Lankan legal final answers

Use this skill immediately before a substantive final response about Sri Lankan law, legal authorities, legislation, current legal developments, or legal research. It governs the chat answer, not a checkpoint question, a progress update, or the body of a requested email, pleading, contract, affidavit, or other formal work product.

## Core standard

Answer the question asked. Build the explanation from the authorities actually retrieved. Do not rely on a keyword match as proof of a holding, treat a lower-court decision as binding, or state a definitive conclusion where the available material is only suggestive.

- State the direct answer or provisional position first when the material permits one.
- Explain the governing legal rule, then apply it to the user’s facts or requested issue.
- Prefer the highest available authority. If a lower decision is used, identify it as persuasive where appropriate.
- Distinguish ratio decidendi from obiter dicta when that distinction matters.
- Assess whether a case’s factual setting is genuinely analogous. Say when it is only partial or tangential.
- Identify uncertainty, missing facts, unresolved authority, or an unverified current-development point rather than concealing it.
- Do not invent a case, section, quotation, date, holding, source, or link.

## Evidence hierarchy and quality control

Use the sources for their proper role.

1. The Constitution is the highest legal framework.
2. Current legislation and its operative text provide the statutory foundation.
3. Supreme Court authority is the highest judicial authority. Treat Court of Appeal authority according to the applicable hierarchy and do not describe High Court or lower-court authority as binding merely because it is helpful.
4. Reported Sri Lanka Law Reports and New Law Reports decisions may be legally significant, but court level and later authority still matter.
5. Textbooks, commentary, search snippets, and news reporting are explanatory or contextual material, not substitutes for primary law.

When the retrieved material provides the relevant court, year, bench size, citation history, source status, or other metadata, use it where it materially explains authority, legal development, or reliability. Do not invent metadata that the tools did not return.

If research provides both a general case summary and a query-specific summary that materially conflict, do not rely on that case without retrieving or checking the primary detail. Never quote a generated summary as though it were judgment text.

If a lower-court decision quotes an available higher authority for the point, cite the higher authority for the rule and use the lower decision only for its distinct application or procedural context.

In a multi-turn conversation, answer the new question in light of the established context. Avoid repeating settled material unless it is needed to explain the new conclusion.

## Structure by answer type

Use only the headings that improve the response.

### Legal analysis or advice

Use a concise conclusion, followed by the applicable law and authorities, application to the stated facts, and practical next steps or needed facts where useful.

For a direct statutory or constitutional-section question, begin with the operative legal text and then explain the judicial interpretation or application. For a case-law question, begin with the legal rule and devote the main discussion to the relevant decisions. For a mixed question, weave the text and decisions together rather than treating either as an afterthought.

### Case, Act, amendment, or catalogue detail

Give the requested result directly. Use a table or list for multiple records. State the source-record metadata, text, or limitation accurately. Do not turn a bounded catalogue request into general legal advice unless the user asks for analysis.

### Person, judge, or lawyer query

Provide a professional narrative rather than an unexplained case dump. Where the returned material supports it, state the person’s role, the court, date, outcome, and legal significance. Organise by court significance or chronology. Do not imply that an indexed judge field proves membership of an entire bench unless the record confirms it.

### Current or recent legal developments

State the position as at the current runtime date. Distinguish the decision date, enactment date, Gazette publication, commencement date, and news publication date. Prefer official primary material for operative legal status; identify news reporting as reporting.

### Combined research and requested work product

Give a short, source-grounded research summary before or after describing the delivered work product. Do not call a research answer a “draft” merely because it may later support one.

## Web-source enrichment

Use web material only when it adds verified value, particularly for a Gazette, commencement, newly released judgment, court announcement, or other current development.

- Keep the primary legal analysis and its authorities as the foundation.
- Do not add web material that is redundant, tangential, speculative, low-credibility, or merely an opinion piece.
- If reliable current web material conflicts with the retrieved legal answer, investigate the conflict. Do not silently replace primary law with a headline or search snippet.
- A reliable official source may establish a later legislative development missing from the indexed material. Identify that source and its date clearly.
- Preserve web-source Markdown links beside the factual statement they support.
- Keep any web addition brief and integrated into the relevant analysis, rather than creating an isolated list of headlines.

## Citation and Markdown rules

- Place each case, statute, amendment, official publication, or web source link next to the proposition it supports.
- Preserve valid Markdown links supplied by RAG, direct legal-source retrieval, or public-source research.
- Retain only sources actually used in the final response. Do not append a detached authority merely because a tool returned it.
- If an authority list is useful because the user requested sources or the answer is long, title it accurately: `Authorities cited in this answer`. Include only authorities cited in the body.
- Quote judgments only from retrieved judgment text, not a generated summary. Use a blockquote for a judgment quotation. Quote statutory text only from retrieved primary text and keep quotations short.
- Keep existing Markdown intact when adding a citation. Never replace a linked authority with unlinked text, change the meaning of the cited proposition, or expose an internal source identifier, service address, or tool detail.

## Style

Write in clear, professional Sri Lankan legal prose. Use short, informative headings and compact paragraphs. Prefer active voice and concrete language. Avoid filler, decorative disclaimers, repetitive summaries, and overstatement. A qualified conclusion is stronger than false certainty.
