#!/usr/bin/env python3
"""Create a source-anchored legal review DOCX with Word comments/highlights."""

import argparse
import json
import os
import re
import tempfile
from copy import deepcopy
from pathlib import Path

import docx
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.section import WD_SECTION
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor
from docx.text.run import Run


def clean(value):
    return re.sub(r"\s+", " ", re.sub(r"[*_`]+", "", str(value or ""))).strip()


def add_shading(run, color):
    rpr = run._r.get_or_add_rPr()
    shade = rpr.find(qn("w:shd"))
    if shade is None:
        shade = OxmlElement("w:shd")
        rpr.append(shade)
    shade.set(qn("w:val"), "clear")
    shade.set(qn("w:fill"), color)


def best_range(text, anchor):
    source = clean(text).lower()
    target = clean(anchor).lower()
    if not source or not target:
        return None
    idx = source.find(target)
    if idx >= 0:
        # The normalised index may differ from raw text only where formatting
        # whitespace differs. Exact raw matching is preferred below.
        raw = text.lower().find(clean(anchor).lower())
        return (raw, raw + len(clean(anchor))) if raw >= 0 else None
    words = target.split()
    if len(words) >= 6:
        first, last = " ".join(words[:4]), " ".join(words[-4:])
        start = text.lower().find(first)
        end = text.lower().find(last, start + len(first))
        if start >= 0 and end >= 0:
            return start, end + len(last)
    return None


def comment_text(finding):
    classification = str(finding.get("classification", "negotiation_point")).lower()
    labels = {
        "illegal_non_compliant": ("🔴", "ILLEGAL / NON-COMPLIANT"),
        "material_commercial_risk": ("🟠", "MATERIAL COMMERCIAL RISK"),
        "negotiation_point": ("🟡", "NEGOTIATION POINT"),
    }
    emoji, label = labels.get(classification, ("🔴" if finding.get("color", "").lower() == "red" else "🟠" if finding.get("color", "").lower() == "orange" else "🟡", finding.get("classification", "Review finding")))
    authorities = "\n".join(finding.get("authority_urls") or [])
    return "\n\n".join(part for part in [
        f"{emoji} [{label}]",
        f"Explanation: {finding.get('explanation') or 'See the review report.'}",
        f"Recommended protection: {finding.get('recommendation') or 'Consider a proportionate amendment.'}",
        f"Authorities:\n{authorities}" if authorities else "",
    ] if part)


def annotate_paragraph(paragraph, finding):
    anchor = finding.get("anchor_text", "")
    runs = list(paragraph.runs)
    # Work from direct Word runs rather than clearing/rebuilding the paragraph.
    # That keeps unrelated runs, hyperlinks, paragraph properties, and table
    # formatting intact in the reviewed copy.
    run_text = "".join(run.text for run in runs)
    match = best_range(run_text, anchor)
    # Extracted source anchors can span several Word paragraphs. In that case,
    # attach the comment to the most distinctive original line rather than
    # silently producing an unannotated copy of the source document.
    if not match:
        fragments = sorted((clean(line) for line in str(anchor).splitlines()), key=len, reverse=True)
        for fragment in fragments:
            if len(fragment) < 18:
                continue
            match = best_range(run_text, fragment)
            if match:
                break
    if not match:
        return False
    start, end = match
    if not run_text:
        return False
    classification = str(finding.get("classification", "negotiation_point")).lower()
    color = {"red": "FF0000", "orange": "FFC000", "yellow": "FFFF00"}.get(str(finding.get("color", "")).lower()) or {
        "illegal_non_compliant": "FF0000",
        "material_commercial_risk": "FFC000",
        "negotiation_point": "FFFF00",
    }.get(classification, "FFFF00")
    cursor = 0
    highlighted_runs = []
    for source_run in runs:
        text = source_run.text
        run_start, run_end = cursor, cursor + len(text)
        cursor = run_end
        if not text or run_end <= start or run_start >= end:
            continue
        pieces = [
            (text[:max(0, start - run_start)], False),
            (text[max(0, start - run_start):min(len(text), end - run_start)], True),
            (text[min(len(text), end - run_start):], False),
        ]
        replacement_nodes = []
        for piece, highlighted in pieces:
            if not piece:
                continue
            node = deepcopy(source_run._r)
            replacement = Run(node, paragraph)
            replacement.text = piece
            if highlighted:
                add_shading(replacement, color)
                highlighted_runs.append(replacement)
            replacement_nodes.append(node)
        for node in replacement_nodes:
            source_run._r.addprevious(node)
        source_run._r.getparent().remove(source_run._r)
    if not highlighted_runs:
        return False
    # One logical finding receives one Word comment, even where its highlighted
    # text crosses several differently formatted runs.
    document = getattr(paragraph.part, "document", None)
    if document is not None and hasattr(document, "add_comment"):
        document.add_comment(highlighted_runs, comment_text(finding), author="Junior Silva", initials="JS")
    else:
        highlighted_runs[0].add_comment(comment_text(finding), author="Junior Silva", initials="JS")
    return True


def document_paragraphs(document):
    """Yield body, table-cell, header and footer paragraphs exactly once."""
    seen = set()
    def emit(paragraphs):
        for paragraph in paragraphs:
            marker = id(paragraph._p)
            if marker not in seen:
                seen.add(marker)
                yield paragraph
    yield from emit(document.paragraphs)
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                yield from emit(cell.paragraphs)
                for nested in cell.tables:
                    for nested_row in nested.rows:
                        for nested_cell in nested_row.cells:
                            yield from emit(nested_cell.paragraphs)
    for section in document.sections:
        yield from emit(section.header.paragraphs)
        yield from emit(section.footer.paragraphs)


def borders(table):
    # python-docx/bayoo-docx exposes the existing tblPr node directly; unlike
    # paragraph properties it has no get_or_add_tblPr helper.
    tbl_pr = table._tbl.tblPr
    node = OxmlElement("w:tblBorders")
    for name in ("top", "left", "bottom", "right", "insideH", "insideV"):
        border = OxmlElement(f"w:{name}")
        border.set(qn("w:val"), "single")
        border.set(qn("w:sz"), "4")
        border.set(qn("w:color"), "808080")
        node.append(border)
    tbl_pr.append(node)


def add_cover(document, title, perspective, findings, categories=None):
    # Insert before the first body element, which might itself be a table.
    cover_section = deepcopy(document.sections[0]._sectPr)
    for tag in ("w:headerReference", "w:footerReference"):
        for element in cover_section.findall(qn(tag)):
            cover_section.remove(element)
    margins = cover_section.find(qn("w:pgMar"))
    if margins is None:
        margins = OxmlElement("w:pgMar")
        cover_section.append(margins)
    for side in ("top", "bottom", "left", "right"):
        margins.set(qn(f"w:{side}"), "1440")  # One inch, in twips.
    section_type = cover_section.find(qn("w:type"))
    if section_type is None:
        section_type = OxmlElement("w:type")
        cover_section.insert(0, section_type)
    section_type.set(qn("w:val"), "nextPage")
    marker = document.add_paragraph()
    document._body._body.insert(0, marker._p)
    anchor = marker
    title_p = anchor.insert_paragraph_before(title)
    title_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title_p.runs[0].bold = True
    title_p.runs[0].font.size = Pt(18)
    party = anchor.insert_paragraph_before(f"Protected party: {perspective or 'Not specified'}")
    party.runs[0].bold = True
    anchor.insert_paragraph_before(f"Validated findings: {len(findings)}")
    anchor.insert_paragraph_before("Legal and commercial findings are highlighted in the source text and explained in Word comments.")
    table = document.add_table(rows=1, cols=4)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    section = document.sections[0]
    usable_width = max(section.page_width - Inches(2), Inches(3))
    widths = [int(usable_width * fraction) for fraction in (0.08, 0.27, 0.15, 0.50)]
    for column, width in zip(table.columns, widths):
        column.width = width
    table_width = table._tbl.tblPr.find(qn("w:tblW"))
    table_width.set(qn("w:type"), "dxa")
    table_width.set(qn("w:w"), str(round(usable_width / 635)))
    borders(table)
    for cell, label in zip(table.rows[0].cells, ["No.", "Classification", "Clause", "Finding"]):
        cell.text = label
        cell.paragraphs[0].runs[0].bold = True
    for index, finding in enumerate(findings, 1):
        cells = table.add_row().cells
        cells[0].text = str(index)
        labels = {
            "illegal_non_compliant": "Illegal / Non-compliant",
            "material_commercial_risk": "Material Commercial Risk",
            "negotiation_point": "Negotiation Point",
        }
        cells[1].text = labels.get(str(finding.get("classification", "")).lower(), str(finding.get("classification", "Review finding")))
        cells[2].text = str(finding.get("clause_number", "N/A"))
        cells[3].text = str(finding.get("title", "Contractual risk"))
    # Word uses cell widths as well as the grid; setting only grid widths leaves
    # the original full-width cells and can push the table off the cover page.
    for row in table.rows:
        for cell, width in zip(row.cells, widths):
            cell.width = width
    anchor._p.addprevious(table._tbl)
    anchor.insert_paragraph_before("")
    legend = categories or [{"color": "Red", "name": "Illegal / Non-compliant under Sri Lankan law"}, {"color": "Orange", "name": "Material commercial risk for the selected party"}, {"color": "Yellow", "name": "Negotiation point (lawful but worth improving)"}]
    circles = {"red": "🔴", "orange": "🟠", "yellow": "🟡"}
    for category in legend:
        anchor.insert_paragraph_before(f"{circles.get(category['color'].lower(), '●')} {category['color'].capitalize()} Highlight = {category['name']}")
    section_break = anchor.insert_paragraph_before("")
    section_break._p.get_or_add_pPr().append(cover_section)
    anchor._p.getparent().remove(anchor._p)


def add_extracted_source(document, source_text):
    """Add extracted PDF/text source as annotatable Word paragraphs.

    PDF and plain-text inputs cannot retain their original Word runs, but the
    resulting review DOCX can still preserve the extracted source wording and
    attach comments/highlights at the matching clauses.
    """
    if not source_text:
        return
    document.add_heading("Reviewed source text", level=1)
    for line in source_text.splitlines():
        if line.strip():
            document.add_paragraph(line.strip())


def add_findings_body(document, findings):
    # The converted source can have zero margins. Start a new report section
    # rather than changing those margins on the source pages.
    section = document.add_section(WD_SECTION.NEW_PAGE)
    section.top_margin = section.bottom_margin = Inches(1)
    section.left_margin = section.right_margin = Inches(1)
    document.add_heading("Clause-by-clause review findings", level=1)
    for index, finding in enumerate(findings, 1):
        document.add_heading(f"{index}. {finding.get('title', 'Contractual risk')} — Clause {finding.get('clause_number', 'N/A')}", level=2)
        document.add_paragraph(f"Source: {finding.get('anchor_text', '')}")
        document.add_paragraph(finding.get("explanation") or "")
        document.add_paragraph("Recommended protection: " + (finding.get("recommendation") or ""))
        for url in finding.get("authority_urls") or []:
            document.add_paragraph(url, style="List Bullet")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--findings", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--source")
    parser.add_argument("--source-text")
    parser.add_argument("--title", default="Sri Lankan Legal Review")
    parser.add_argument("--perspective", default="")
    args = parser.parse_args()
    findings = json.loads(Path(args.findings).read_text(encoding="utf-8"))
    categories = findings.get("categories") if isinstance(findings, dict) else None
    if isinstance(findings, dict):
        findings = findings.get("accepted", [])
    if not isinstance(findings, list):
        raise SystemExit("Findings JSON must be an array.")
    source = Path(args.source) if args.source else None
    source_text = Path(args.source_text).read_text(encoding="utf-8") if args.source_text else ""
    annotation_ledger = []
    conversion_warning = None
    if source and source.suffix.lower() == ".docx" and source.is_file():
        document = docx.Document(str(source))
    elif source and source.suffix.lower() == ".pdf" and source.is_file():
        try:
            from pdf2docx import Converter
            with tempfile.TemporaryDirectory(prefix="junior-review-pdf-") as directory:
                converted = str(Path(directory) / "source.docx")
                converter = Converter(str(source))
                try:
                    converter.convert(converted)
                finally:
                    converter.close()
                document = docx.Document(converted)
            if not any(p.text.strip() for p in document_paragraphs(document)):
                raise ValueError("PDF conversion returned no editable text")
            conversion_warning = "PDF layout is reconstructed; verify formatting and reading order against the original."
        except Exception:
            document = docx.Document()
            add_extracted_source(document, source_text)
            conversion_warning = "PDF layout could not be reconstructed; the review uses extracted text and does not preserve the original formatting."
    else:
        document = docx.Document()
        add_extracted_source(document, source_text)
        conversion_warning = "Only extracted source text was available; original formatting could not be preserved."
    for finding in findings:
        annotated = False
        for paragraph in document_paragraphs(document):
            if annotate_paragraph(paragraph, finding):
                annotated = True
                break
        annotation_ledger.append({
            "id": finding.get("id"),
            "clause_number": finding.get("clause_number", "N/A"),
            "title": finding.get("title", "Contractual risk"),
            "status": "annotated" if annotated else "unmatched",
        })
    if not (source and source.suffix.lower() == ".docx" and source.is_file()):
        add_findings_body(document, findings)
    add_cover(document, args.title, args.perspective, findings, categories)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    document.save(output)
    print(json.dumps({
        "output": str(output),
        "total_findings": len(findings),
        "annotated_count": sum(1 for item in annotation_ledger if item["status"] == "annotated"),
        "annotation_ledger": annotation_ledger,
        "formatting_notice": conversion_warning,
    }))


if __name__ == "__main__":
    main()
