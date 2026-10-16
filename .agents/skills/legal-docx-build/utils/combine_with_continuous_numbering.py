#!/usr/bin/env python3
"""
Combines multiple markdown files with continuous paragraph numbering.
Each top-level section starts on a new page, and paragraphs are renumbered
continuously across all files (e.g., if file 1 ends at para 31, file 2 starts at 32).
"""

import re
import sys
from pathlib import Path

RE_HEADING = re.compile(r'^(#{1,6})\s+(.+)$')
RE_HEADING_ENUM = re.compile(
    r'^(?:[IVXLCDM]{1,7}[.)]|\d+(?:\.\d+)*[.)]|\d+(?:\.\d+)+|[A-Z][.)](?!\s*[A-Z][.)]))\s+'
)


def to_title_case(text: str) -> str:
    """
    Convert all-caps text to title case, preserving acronyms and special cases.
    """
    # List of words that should remain uppercase (acronyms, etc.)
    preserve_upper = {'PIL', 'GSMB', 'ASHA', 'SLCC', 'EIA', 'IML', 'CA', 'CEA', 'BOI'}

    # Small words that should be lowercase (unless first or last word)
    small_words = {'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs'}

    words = text.split()
    result = []

    for i, word in enumerate(words):
        # Remove leading/trailing punctuation for checking
        stripped = word.strip('–—-()[]{}.,;:!?')

        if stripped in preserve_upper:
            # Keep acronyms in uppercase
            result.append(word)
        elif i == 0 or i == len(words) - 1:
            # First and last words are always capitalized
            result.append(word.capitalize())
        elif stripped.lower() in small_words:
            # Small words are lowercase (unless first/last)
            result.append(word.lower())
        else:
            # Everything else is title case
            result.append(word.capitalize())

    return ' '.join(result)


def _mostly_upper(text: str) -> bool:
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return False
    return text.isupper() or sum(c.isupper() for c in letters) > len(letters) * 0.7


def transform_headings(content: str) -> str:
    """
    Normalize heading lines across the combined document:
    - Strip manual enumeration prefixes ("I.", "II.", "1.", "2.1") from level 1-2
      headings — the DOCX build applies its own multilevel auto-numbering, and a
      manual prefix would double up ("1.1 I. Introduction"). Level 3+ headings
      keep their prefixes (they are unnumbered by design, so manual "A." letters
      belong there).
    - Convert mostly-uppercase headings to title case.
    """
    output_lines = []
    for line in content.split('\n'):
        match = RE_HEADING.match(line)
        if not match:
            output_lines.append(line)
            continue
        hashes, text = match.group(1), match.group(2)
        if len(hashes) <= 2:
            text = RE_HEADING_ENUM.sub('', text)
        if _mostly_upper(text):
            text = to_title_case(text)
        output_lines.append(f"{hashes} {text}")
    return '\n'.join(output_lines)


def hoist_title(content: str) -> str:
    """
    If the document opens with a "# Title" heading, hoist it into a Pandoc YAML
    title block so it renders in the Title style — centered, unnumbered, and
    excluded from the TOC — instead of being auto-numbered as section 1.

    When the opening heading was the only "#" and the sections were authored as
    "##", the "##" headings are promoted to "#" so sections number 1, 2, 3
    rather than 1.1, 1.2 under a phantom parent. Deeper headings are left
    alone — "###" stays the unnumbered lettered level either way. A document
    with no headings after the opening one is left untouched (single-heading
    docs like affidavits keep their heading as the sole section).
    """
    lines = content.split('\n')
    first_idx = next((i for i, l in enumerate(lines) if l.strip()), None)
    if first_idx is None:
        return content
    match = re.match(r'^#\s+(.+)$', lines[first_idx])
    if match is None:
        return content

    rest = lines[first_idx + 1:]
    has_h1 = any(re.match(r'^#\s', l) for l in rest)
    has_h2 = any(re.match(r'^##\s', l) for l in rest)
    if not has_h1 and not has_h2:
        return content

    title = match.group(1).strip()
    if _mostly_upper(title):
        title = to_title_case(title)

    if not has_h1:
        rest = [re.sub(r'^##(\s)', r'#\1', l) for l in rest]

    body = '\n'.join(rest).lstrip('\n')
    escaped = title.replace('\\', '\\\\').replace('"', '\\"')
    return f'---\ntitle: "{escaped}"\n---\n\n{body}'


def renumber_paragraphs(content: str, start_num: int) -> tuple[str, int]:
    """
    Renumber paragraphs in markdown content, starting from start_num.
    Returns (renumbered_content, next_number).

    Matches patterns like:
    - "1. Some text"
    - "12. Some text"

    at the beginning of lines. Every paragraph may safely be numbered "1." —
    the counter rewrites them all in sequence. Heading normalization happens
    separately in transform_headings.
    """
    lines = content.split('\n')
    output_lines = []
    current_num = start_num

    for line in lines:
        if RE_HEADING.match(line):
            output_lines.append(line)
            continue

        # Match paragraph numbers at start of line: "1. ", "123. ", etc.
        match = re.match(r'^(\d+)\.\s+(.*)$', line)
        if match:
            # Replace with continuous numbering
            rest_of_line = match.group(2)
            output_lines.append(f"{current_num}. {rest_of_line}")
            current_num += 1
        else:
            # Keep line as-is
            output_lines.append(line)

    return '\n'.join(output_lines), current_num


def main():
    if len(sys.argv) < 3:
        print("Usage: combine_with_continuous_numbering.py output_file input_file1 [input_file2 ...]")
        sys.exit(1)

    output_file = Path(sys.argv[1])
    input_files = [Path(f) for f in sys.argv[2:]]

    # Verify all input files exist
    for f in input_files:
        if not f.exists():
            print(f"Error: file not found: {f}")
            sys.exit(1)

    combined_content = []
    current_para_num = 1

    for i, input_file in enumerate(input_files):
        print(f"Processing {input_file.name}...", file=sys.stderr)

        content = input_file.read_text(encoding='utf-8')

        # Renumber paragraphs in this file
        renumbered, next_num = renumber_paragraphs(content, current_para_num)

        # Add to combined content
        if i > 0:
            # Add page break before each new file (except the first)
            # Check if this file starts with a heading
            if renumbered.strip().startswith('#'):
                # Page break will be added by LaTeX before section headings
                combined_content.append(renumbered)
            else:
                # Add explicit page break
                combined_content.append('\\newpage\n\n' + renumbered)
        else:
            combined_content.append(renumbered)

        # Update paragraph counter for next file
        current_para_num = next_num

        para_count = next_num - current_para_num
        if para_count > 0:
            print(f"  Renumbered {para_count} paragraphs", file=sys.stderr)

    combined = hoist_title('\n\n'.join(combined_content))
    combined = transform_headings(combined)

    output_file.write_text(combined, encoding='utf-8')
    print(f"\n✓ Combined {len(input_files)} files into {output_file}", file=sys.stderr)
    print(f"  Total paragraphs: {current_para_num - 1}", file=sys.stderr)


if __name__ == '__main__':
    main()