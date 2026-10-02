---
name: legal-docx-build
description: Build a formatted Word DOCX from one or more Markdown drafts of a legal document (writ petition, submission, affidavit, legal brief, application, motion, objection). Produces continuous numbered paragraphs, (a)(b)(c) sub-paragraphs, (i)(ii)(iii) nested lists, real Word auto-numbering, page breaks between sections, and a table of contents with Roman-numeral front matter and Arabic body page numbers. Use when the user wants to compile/convert/render research or drafts into a final court-ready legal Word document, or to combine multiple Markdown parts into one continuously numbered DOCX.
---

# Legal DOCX Build

Converts Markdown legal drafts into a court-ready Word `.docx` via a fixed Pandoc pipeline with post-processors. The whole build is one script — do not re-implement the steps inline.

## Workflow

This skill runs inside LibreChat's code sandbox. By the time it is invoked, the conversation usually already holds the substance of the document: legal research findings, case law, uploaded documents, and the user's instructions. The workflow is:

1. **Compose the final document first.** Synthesize the gathered context into the finished legal document (submission, motion, objection, petition, affidavit — whatever the user asked for) as complete legal prose. Write it as Markdown following the authoring conventions below, using `create_file` to a path under `/mnt/data` (e.g. `/mnt/data/submission.md`). Do not leave placeholders for content the conversation already contains; ask the user only for genuinely missing case-specific facts (party names, case numbers, dates).
2. **Build the DOCX** with the script below.
3. **Deliver the generated `.docx`** to the user as the run's output file.

## Usage

```bash
bash skills/legal-docx-build/build-legal-docx.sh <source.md> [source2.md ...] <output.docx>
```

The **last** argument is always the output path; everything before it is input Markdown (concatenated in order). The output directory is created if missing.

Examples:

```bash
# Single draft
bash skills/legal-docx-build/build-legal-docx.sh /mnt/data/draft.md /mnt/data/petition.docx

# Combine parts into one continuously numbered document
bash skills/legal-docx-build/build-legal-docx.sh /mnt/data/part1.md /mnt/data/part2.md /mnt/data/combined.docx
```

## Authoring conventions (IMPORTANT)

The build applies real Word auto-numbering to paragraphs and headings. Author the Markdown so the pipeline can do its job — never number things manually:

- **Document title**: make the very first line a single `#` heading with the document title. It is rendered as a centered, unnumbered Title (not a numbered section) and kept out of the TOC.
- **Major sections**: one `#` heading each (`# Introduction`, `# The Statutory Framework`, `# Prayer`). They are auto-numbered `1`, `2`, `3` …, each starts on a new page, and each gets a TOC entry.
- **Sub-sections**: `##` headings, auto-numbered `1.1`, `1.2` ….
- **Do NOT manually number `#`/`##` headings.** Never write `# I. Introduction` or `## A. Background` — the auto-numbering would double up (`1.1 I. Introduction`). Manual `I.`/`II.`/`1.` prefixes on `#`/`##` headings are stripped by the build as a safety net.
- **Lettered sub-headings** (`A. Affairs of State — Section 123`): use `###` headings and write the letter yourself (`### A. Affairs of State — Section 123`). `###` headings are deliberately left unnumbered, styled, and appear in the TOC. Do not author them as plain bold text.
- **Body paragraphs**: number every one `1.` — the build renumbers them continuously across all input files (`1.`, `2.`, `3.` …), so each file can safely use `1.` throughout.
- **`(a)(b)(c)` sub-paragraphs**: write `-`/`*` bullets. The build converts them to `(a)`, `(b)`, `(c)` … with legal punctuation (`;` between items, `; and` before the last, `.` to close).
- **`(i)(ii)(iii)` runs**: write an indented numbered list under a paragraph ending in `:` — it is inlined as `(i) …; (ii) …; and (iii) ….`.
- **Quotations** from judgments/statutes: block quotes (`>`) render italic.
- All-caps headings are converted to title case automatically.

## What the build does (in order)

1. **Combine + continuous numbering** — every `N.` paragraph is renumbered sequentially across all input files (part 2 continues from where part 1 ended). A leading `#` title is hoisted to the unnumbered Title style; manual `I.`/`1.` prefixes on `#`/`##` headings are stripped; all-caps headings become title case.
2. **Bullets → sub-paragraphs** — Markdown `-`/`*` bullets become `(a)`, `(b)`, `(c)` … with legal punctuation.
3. **Page breaks** — a page break is inserted before each `#` heading after the first.
4. **Nested numbered lists → (i)(ii)(iii)** — indented numbered sub-lists are inlined as Roman-numeral runs.
5. **Strip LaTeX** — raw `{=latex}` blocks are removed.
6. **Pandoc → DOCX** — using `utils/reference.docx` for styles and `filters/legal-docx-format.lua`; adds a numbered TOC (depth 3).
7. **Word auto-numbering** — plain-text `N.` and `(a)` prefixes are replaced with real Word `<w:numPr>` auto-numbering, and headings get multilevel `1` / `1.1` numbering.
8. **TOC page numbering** — front matter (TOC) gets lower-Roman page numbers; the body restarts at Arabic page 1.

## Environment toggles

Set these before the command to vary output:

- `LEGAL_NO_TOC=1` — skip the table of contents (also skips step 8). Use for short documents like affidavits and motions.
- `LEGAL_NO_PAGEBREAKS=1` — do not insert page breaks between `#` sections (single-flow documents).

```bash
LEGAL_NO_TOC=1 bash skills/legal-docx-build/build-legal-docx.sh /mnt/data/affidavit.md /mnt/data/affidavit.docx
```

## Customizing styles

Fonts, margins, and paragraph styles live in `utils/reference.docx`. To change them, open that file in Word, edit the named styles (`First Paragraph`, `Body Text`, `Heading 1`, `Heading 2`, `Title`, TOC styles), and save. The numbering/indent geometry for auto-numbered paragraphs is set in `utils/apply_legal_numbering.py` (`_make_level` calls).
