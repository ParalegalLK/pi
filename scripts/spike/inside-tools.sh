#!/usr/bin/env bash
# Runs inside the sandbox: exercises the real document tools and times each one.
# Prints "name OK|FAIL milliseconds" lines for js-spike.sh to read.
set -u
cd /tmp

step() {
	local name="$1"
	shift
	local started finished result
	started="$(date +%s%3N)"
	if "$@" >/tmp/step.log 2>&1; then result=OK; else result=FAIL; fi
	finished="$(date +%s%3N)"
	echo "$name $result $((finished - started))"
	if [ "$result" = FAIL ]; then tail -n 3 /tmp/step.log | cut -c1-200 | sed 's/^/  | /'; fi
}

printf '# Test\n\n1. Hello world paragraph.\n\n2. Second paragraph.\n' > t.md

step node-start node -e 0
step pi-version node /app/packages/coding-agent/dist/bundle/cli.js --version
step pandoc pandoc t.md -o t.docx
step libreoffice soffice --headless --convert-to pdf --outdir /tmp /tmp/t.docx
step pdftotext pdftotext t.pdf t.txt
step pdftoppm pdftoppm -png -r 80 t.pdf page
step tesseract tesseract page-1.png stdout -l eng
step legal-docx-build bash /app/.agents/skills/legal-docx-build/build-legal-docx.sh /tmp/t.md /tmp/out.docx
step chromium node /spike/inside-chromium.cjs
