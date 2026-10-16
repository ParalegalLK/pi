#!/usr/bin/env python3
"""
Convert bullet points within numbered paragraphs to (a), (b), (c) sub-paragraphs.

Per UK legal formatting rules:
- Bullet points should NOT be used for legal reasoning
- Sub-paragraphs should use (a), (b), (c) or (i), (ii), (iii)
"""

import re
import sys
from pathlib import Path


def bullets_to_letters(text: str) -> str:
    """
    Convert markdown bullet points to lettered sub-paragraphs.

    Handles blank lines between bullets (common in markdown for readability).

    Converts:
        1. Some paragraph text:

           - First item

           - Second item

           - Third item

    To:
        1. Some paragraph text:

           (a) First item;

           (b) Second item;

           (c) Third item.
    """
    lines = text.split('\n')
    result = []

    i = 0
    while i < len(lines):
        line = lines[i]

        # Check if this line starts a bullet list (with or without indentation)
        bullet_match = re.match(r'^(\s*)[-*]\s+(.*)$', line)

        if bullet_match:
            indent = bullet_match.group(1)
            indent_len = len(indent)

            # Collect all bullets at this indent level (allowing blank lines between)
            bullets = []
            bullet_line_indices = []  # Track which result indices are bullets

            while i < len(lines):
                current_line = lines[i]
                bm = re.match(r'^(\s*)[-*]\s+(.*)$', current_line)

                if bm and len(bm.group(1)) == indent_len:
                    # This is a bullet at our indent level
                    bullets.append(bm.group(2))
                    bullet_line_indices.append(len(result) + len(bullets) - 1)
                    i += 1
                elif current_line.strip() == '':
                    # Blank line - might be between bullets, peek ahead
                    # Look ahead to see if there's another bullet coming
                    j = i + 1
                    while j < len(lines) and lines[j].strip() == '':
                        j += 1
                    if j < len(lines):
                        next_bm = re.match(r'^(\s*)[-*]\s+', lines[j])
                        if next_bm and len(next_bm.group(1)) == indent_len:
                            # There's another bullet coming, this blank line is part of the list
                            bullets.append('')  # Placeholder for blank line
                            i += 1
                            continue
                    # No more bullets, end of list
                    break
                elif current_line.startswith(indent + '  ') and bullets and bullets[-1] != '':
                    # Continuation line (more indented than bullet)
                    bullets[-1] += ' ' + current_line.strip()
                    i += 1
                else:
                    # Something else, end of bullet list
                    break

            # Convert to lettered sub-paragraphs
            letters = 'abcdefghijklmnopqrstuvwxyz'
            letter_idx = 0
            # Count actual bullets (not blank lines)
            actual_bullets = [b for b in bullets if b != '']
            num_bullets = len(actual_bullets)

            for j, bullet in enumerate(bullets):
                if bullet == '':
                    # Preserve blank line
                    result.append('')
                else:
                    letter = letters[letter_idx] if letter_idx < len(letters) else str(letter_idx + 1)
                    is_last = (letter_idx == num_bullets - 1)
                    is_penultimate = (letter_idx == num_bullets - 2)

                    # Strip existing terminal punctuation so we can apply our own
                    bullet_text = bullet.rstrip()
                    # Remove trailing "; and" or "; and;" first, then ";" or "."
                    if re.search(r';\s*and\s*;?\s*$', bullet_text):
                        bullet_text = re.sub(r';\s*and\s*;?\s*$', '', bullet_text).rstrip()
                    else:
                        bullet_text = bullet_text.rstrip(';').rstrip('.')

                    # Apply punctuation: ; on all, ; and on penultimate, . on last
                    if is_last:
                        punctuation = '.'
                    elif is_penultimate:
                        punctuation = '; and'
                    else:
                        punctuation = ';'

                    # No indentation - let it be a regular paragraph, not a nested list
                    result.append(f'({letter}) {bullet_text}{punctuation}')
                    letter_idx += 1
        else:
            result.append(line)
            i += 1

    return '\n'.join(result)


def main():
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <markdown_file>", file=sys.stderr)
        sys.exit(1)

    filepath = Path(sys.argv[1])
    text = filepath.read_text()
    converted = bullets_to_letters(text)
    filepath.write_text(converted)
    print(f"Converted bullets to sub-paragraphs in {filepath}")


if __name__ == '__main__':
    main()
