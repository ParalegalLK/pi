#!/bin/bash

# Generic build script for legal documents: Markdown → DOCX
# Reusable across projects. Expects to be called with:
#   bash skills/legal-docx-build/build-legal-docx.sh <source.md> <output.docx>
#
# Pipeline:
#   1. Renumber all "1." paragraphs continuously
#   2. Convert bullet points to (a)(b)(c) sub-paragraphs
#   3. Add page breaks before # headings
#   4. Convert nested numbered lists to (i)(ii)(iii)
#   5. Strip LaTeX blocks
#   6. Pandoc → DOCX with reference doc and Lua filters
#   7. Apply Word auto-numbering post-processor
#   8. Apply TOC page numbering (Roman numerals for TOC, Arabic page 1 for body)

set -e

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
UTILS="$SKILL_DIR/utils"
FILTERS="$SKILL_DIR/filters"

if command -v uv >/dev/null 2>&1; then
    PY=(uv run --with python-docx python3)
else
    python3 -c "import docx" 2>/dev/null || pip install --quiet python-docx
    PY=(python3)
fi

if [ $# -lt 2 ]; then
    echo "Usage: $0 <source.md> [source2.md ...] <output.docx>"
    echo ""
    echo "Examples:"
    echo "  $0 draft.md outputs/petition.docx"
    echo "  $0 part1.md part2.md outputs/combined.docx"
    exit 1
fi

# Last argument is output, everything else is input
ARGS=("$@")
OUTPUT="${ARGS[-1]}"
SOURCES=("${ARGS[@]:0:$#-1}")

# Validate inputs
for src in "${SOURCES[@]}"; do
    if [ ! -f "$src" ]; then
        echo "Error: source file not found: $src"
        exit 1
    fi
done

# Create output directory if needed
mkdir -p "$(dirname "$OUTPUT")"

# Temp file in the project directory
TEMP="$(mktemp --suffix=.md)"
trap "rm -f '$TEMP'" EXIT

echo "Building legal DOCX..."
echo "  Sources: ${SOURCES[*]}"
echo "  Output:  $OUTPUT"

# Step 1: Renumber paragraphs continuously
echo "Renumbering paragraphs..."
"${PY[@]}" "$UTILS/combine_with_continuous_numbering.py" "$TEMP" "${SOURCES[@]}"

# Step 2: Convert bullets to (a)(b)(c)
echo "Converting bullets to sub-paragraphs..."
"${PY[@]}" "$UTILS/bullets_to_subparagraphs.py" "$TEMP"

# Step 3: Add page breaks before # headings (skip if LEGAL_NO_PAGEBREAKS=1)
if [ "${LEGAL_NO_PAGEBREAKS:-0}" != "1" ]; then
echo "Adding page breaks between sections..."
"${PY[@]}" - "$TEMP" <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
lines = path.read_text().splitlines()
out = []
first_heading = True
for line in lines:
    if line.startswith("# "):
        if first_heading:
            first_heading = False
        else:
            out.append("")
            out.append("---")
            out.append("")
    out.append(line)
path.write_text("\n".join(out) + "\n")
PY
else
echo "Skipping page breaks (LEGAL_NO_PAGEBREAKS=1)..."
fi

# Step 4: Convert nested numbered lists to (i)(ii)(iii)
echo "Converting nested numbered lists..."
"${PY[@]}" - "$TEMP" <<'PY'
import re, sys
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text()

def convert_nested_list(match):
    intro = match.group(1)
    items_block = match.group(2)
    items = re.findall(r'^\s+\d+\.\s+(.+)$', items_block, re.MULTILINE)
    if not items:
        return match.group(0)
    numerals = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x']
    parts = []
    for idx, item in enumerate(items):
        numeral = numerals[idx] if idx < len(numerals) else str(idx + 1)
        parts.append(f"({numeral}) {item.strip()}")
    if len(parts) > 1:
        result = "; ".join(parts[:-1]) + "; and " + parts[-1] + "."
    else:
        result = parts[0] + "."
    return intro + " " + result

pattern = r'(\d+\.\s+.+?:)\n((?:\s+\d+\.\s+.+\n?)+)'
text = re.sub(pattern, convert_nested_list, text)
path.write_text(text)
PY

# Step 5: Strip LaTeX blocks
"${PY[@]}" - "$TEMP" <<'PY'
import re, sys
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text()
text = re.sub(r'```\{=latex\}.*?```', '', text, flags=re.DOTALL)
path.write_text(text)
PY

# Step 6: Pandoc → DOCX
echo ""
echo "Generating DOCX..."

PANDOC_TOC_ARGS=(--toc --toc-depth=3 --number-sections)
if [ "${LEGAL_NO_TOC:-0}" = "1" ]; then
    echo "Skipping TOC (LEGAL_NO_TOC=1)..."
    PANDOC_TOC_ARGS=()
fi

pandoc "$TEMP" \
    -o "$OUTPUT" \
    "${PANDOC_TOC_ARGS[@]}" \
    --reference-doc="$UTILS/reference.docx" \
    --lua-filter="$FILTERS/legal-docx-format.lua" \
    -V linkcolor:blue \
    -V toccolor:blue \
    -V urlcolor:blue

chmod u+rw "$OUTPUT"

# Step 7: Apply Word auto-numbering
echo "Applying auto-numbering..."
"${PY[@]}" "$UTILS/apply_legal_numbering.py" "$OUTPUT"

# Step 8: Apply TOC page numbering (Roman for TOC, Arabic page 1 for body)
if [ "${LEGAL_NO_TOC:-0}" != "1" ]; then
    echo "Applying TOC page numbering..."
    "${PY[@]}" "$UTILS/apply_toc_page_numbering.py" "$OUTPUT"
fi

echo ""
echo "Done: $OUTPUT"
echo ""
