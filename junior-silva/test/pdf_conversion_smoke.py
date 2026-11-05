"""Integration smoke test for the PDF review conversion and Word annotation."""
import json
import base64
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import fitz
from docx import Document
from pdf2docx import Converter

renderer = Path(__file__).resolve().parents[1] / "review" / "render_review_docx.py"
with tempfile.TemporaryDirectory(prefix="review-pdf-test-") as directory:
    root = Path(directory)
    pdf = root / "source.pdf"
    out = root / "review.docx"
    findings = root / "findings.json"
    document = fitz.open()
    page = document.new_page()
    page.insert_text((180, 70), "SERVICE AGREEMENT", fontname="hebo", fontsize=16)
    page.insert_text((72, 120), "The Developer assigns all existing source code to the Client immediately.", fontsize=11)
    png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aZkAAAAASUVORK5CYII=")
    page.insert_image(fitz.Rect(75, 155, 115, 195), stream=png)
    document.save(str(pdf))
    document.close()
    converted = root / "converted.docx"
    converter = Converter(str(pdf))
    try:
        converter.convert(str(converted))
    finally:
        converter.close()
    source = Document(str(converted))
    source_margins = tuple(getattr(source.sections[0], f"{side}_margin") for side in ("top", "bottom", "left", "right"))
    source_images = len(source.inline_shapes)
    findings.write_text(json.dumps({"accepted": [{"anchor_text": "The Developer assigns all existing source code to the Client immediately.", "classification": "material_commercial_risk", "explanation": "The clause assigns existing code.", "recommendation": "Protect background IP."}]}), encoding="utf-8")
    result = subprocess.run([sys.executable, str(renderer), "--source", str(pdf), "--findings", str(findings), "--output", str(out)], capture_output=True, text=True, check=True)
    summary = json.loads(result.stdout)
    assert summary["annotated_count"] == 1, summary
    assert "reconstructed" in summary["formatting_notice"], summary
    reviewed = Document(str(out))
    assert len(reviewed.sections) >= 2
    assert all(getattr(reviewed.sections[0], f"{side}_margin").inches == 1 for side in ("top", "bottom", "left", "right"))
    assert tuple(getattr(reviewed.sections[1], f"{side}_margin") for side in ("top", "bottom", "left", "right")) == source_margins
    assert all(getattr(reviewed.sections[-1], f"{side}_margin").inches == 1 for side in ("top", "bottom", "left", "right"))
    cover_table = reviewed.tables[0]
    available = reviewed.sections[0].page_width - reviewed.sections[0].left_margin - reviewed.sections[0].right_margin
    assert sum(cell.width for cell in cover_table.rows[0].cells) <= available + 635
    assert [cell.width for cell in cover_table.rows[0].cells] == [cell.width for cell in cover_table.rows[1].cells]
    assert source_images >= 1 and len(reviewed.inline_shapes) >= source_images
    text = "\n".join(p.text for p in reviewed.paragraphs)
    assert "SERVICE AGREEMENT" in text
    assert "🔴 Red Highlight" in text
    assert any(run.bold for p in reviewed.paragraphs if "SERVICE AGREEMENT" in p.text for run in p.runs)
    if os.environ.get("JUNIOR_REVIEW_SMOKE_OUTPUT"):
        shutil.copy2(out, os.environ["JUNIOR_REVIEW_SMOKE_OUTPUT"])
    print("PDF conversion and annotation smoke test passed")
