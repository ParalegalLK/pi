---
name: sri-lankan-legal-research
description: Route Sri Lankan case-catalogue requests to direct indexed sources and legal-analysis requests to citation-linked research.
---

# Sri Lankan legal research

Use this skill for Sri Lankan legal research requests where the difference between an indexed case list and a legal analysis affects the source tool.

## Choose the source deliberately

Use `legal_source_retrieve_details` with `operation: "case_catalog"` for a bounded factual list from the indexed decisions collection. It is appropriate when the user asks for cases by a judge, decision year/month, court, report series, report year/volume/page, party, case number, action type, or legal subject. Supply every known constraint separately. For example, use `judge_name`, `decision_year`, and `subject_query: "tax"` for “tax cases decided by Judge X in 2026.” Never omit a named subject such as tax or murder: without `subject_query`, the tool returns all cases matching only its structured filters.

The tool resolves ordinary spelling/name-format differences in judges and canonicalises courts, reports, action types, and month values against bounded indexed facets. Do not ask the user merely because they omitted a middle name or used a minor spelling variant. Ask only when `filter_resolution` says `needs_confirmation`, and present the returned candidates without adding guesses.

For “what amendments were made to [named Act] in [year]”, use `source: "legislation"` and `operation: "amendment_catalog"`, with `legislation_title` and `amendment_year`. That reads the structured Lex Act record and returns all matching indexed amendment entries. Do not use RAG or web search solely to enumerate those amendments. Use RAG only when the user then asks what the amendments mean or how they affect a legal issue.

Use `operation: "retrieve"` only after selecting a returned record when the response needs bounded decision text, keywords, legislation metadata, or original links. Read only the fields needed for the request.

Use `rag_chat_research` when the user asks what cases hold, how authorities compare, what rule applies, how a court may decide, or another synthesized legal conclusion. A catalogue result can provide candidate authorities for a later RAG-supported analysis, but it does not replace legal reasoning.

## Source integrity

- Preserve links returned by the source for any case you cite.
- Treat `judge_final` as the indexed judge field. Do not imply that it necessarily represents every member of a panel unless the returned decision metadata confirms that.
- A topic match in a summary or decision text is not, by itself, proof of the ratio or outcome. Retrieve relevant detail before describing a holding.
- Never expose Typesense hosts, collection names, filter syntax, API keys, or internal source configuration.
