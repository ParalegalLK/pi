#!/usr/bin/env python3
"""Post-process DOCX to add section break after TOC with Roman numeral
page numbering for front matter and Arabic page 1 for the main body."""

import sys
import copy
from docx import Document
from docx.oxml.ns import qn
from docx.oxml import OxmlElement


def run(docx_path):
    doc = Document(docx_path)
    body = doc.element.body

    # Find the TOC structured document tag
    sdt = body.find(qn('w:sdt'))
    if sdt is None:
        print("  No TOC found, skipping page numbering setup")
        return

    # Get the final (only) section properties
    final_sectPr = doc.sections[-1]._sectPr

    # Build a section-break paragraph to insert after the TOC.
    # This defines the END of the TOC section (front matter).
    p = OxmlElement('w:p')
    pPr = OxmlElement('w:pPr')
    sectPr = OxmlElement('w:sectPr')

    # Copy layout properties from the final section
    for tag in ['w:footerReference', 'w:headerReference',
                'w:pgSz', 'w:pgMar', 'w:cols', 'w:docGrid']:
        for el in final_sectPr.findall(qn(tag)):
            sectPr.append(copy.deepcopy(el))

    # Section type: next page
    sect_type = OxmlElement('w:type')
    sect_type.set(qn('w:val'), 'nextPage')
    sectPr.append(sect_type)

    # Roman numeral page numbering for the TOC section
    pgNum = OxmlElement('w:pgNumType')
    pgNum.set(qn('w:fmt'), 'lowerRoman')
    sectPr.append(pgNum)

    pPr.append(sectPr)
    p.append(pPr)

    # Insert after the TOC SDT
    sdt.addnext(p)

    # Update the final sectPr (body section) to Arabic page 1
    existing_pgNum = final_sectPr.find(qn('w:pgNumType'))
    if existing_pgNum is not None:
        final_sectPr.remove(existing_pgNum)
    pgNum2 = OxmlElement('w:pgNumType')
    pgNum2.set(qn('w:fmt'), 'decimal')
    pgNum2.set(qn('w:start'), '1')
    final_sectPr.append(pgNum2)

    doc.save(docx_path)
    print("  TOC: Roman numeral pages | Body: Arabic pages starting at 1")


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print("Usage: apply_toc_page_numbering.py <file.docx>")
        sys.exit(1)
    run(sys.argv[1])
