#!/usr/bin/env bash
# Timed real requests through today's running bridge, for P0.7 and L9 in
# task/plan.md. These are REAL model calls on the provider key in pi/.env, so
# they cost money. Test questions only, no client data.
#
#   scripts/spike/baseline.sh <results-file>
set -euo pipefail

results="${1:?Usage: baseline.sh <results-file>}"
pi_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
url="${JS_BASELINE_URL:-http://127.0.0.1:8132}"
stamp="$(date +%Y%m%d%H%M%S)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Read into a variable and pass it through stdin, so it is never printed or
# visible on a command line.
api_key="$(grep -E '^JUNIOR_SILVA_API_KEY=' "$pi_dir/.env" | tail -1 | cut -d= -f2- | tr -d "\"'\r")"
if [ -z "$api_key" ]; then
	echo "JUNIOR_SILVA_API_KEY is not set in $pi_dir/.env" >&2
	exit 1
fi

ask() {
	local name="$1" prompt="$2" started finished status
	PROMPT="$prompt" python3 -c 'import json, os; print(json.dumps({"model": "junior-silva-v2", "stream": False, "messages": [{"role": "user", "content": os.environ["PROMPT"]}]}))' > "$work/body.json"
	started="$((${EPOCHREALTIME/[.,]/} / 1000))"
	status="$(printf 'header = "Authorization: Bearer %s"\n' "$api_key" | curl -sS -K - --max-time 900 -o "$work/$name.json" -w '%{http_code}' \
		-H 'Content-Type: application/json' \
		-H 'x-librechat-user-id: aaaaaaaaaaaaaaaaaaaaaaaa' \
		-H "x-librechat-conversation-id: baseline-$name-$stamp" \
		--data-binary "@$work/body.json" "$url/v1/chat/completions" || echo failed)"
	finished="$((${EPOCHREALTIME/[.,]/} / 1000))"
	python3 - "$work/$name.json" "$name" "$status" "$((finished - started))" <<'PY' | tee -a "$results"
import json, re, sys
path, name, status, ms = sys.argv[1:5]
try:
    data = json.load(open(path, encoding="utf-8"))
    text = data["choices"][0]["message"]["content"]
    usage = data.get("usage", {})
except Exception:
    text, usage = "", {}
links = len(re.findall(r"/files/", text))
print(f"{name}: http={status} seconds={int(ms) / 1000:.1f} answer_chars={len(text)} download_links={links} prompt_tokens={usage.get('prompt_tokens')} completion_tokens={usage.get('completion_tokens')}")
PY
}

ask simple "In two sentences, what does a letter of demand do in Sri Lankan legal practice?"
ask docx "Draft a one-page letter of demand as a DOCX for a fictional unpaid invoice of LKR 100,000 between two fictional companies. Keep it short."
ask research "What is the latest amendment to the Companies Act of Sri Lanka? Check current official sources, and read the official PDF if the search results don't give the exact wording."

{
	echo "hosts named in today's session files:"
	find "$pi_dir/junior-silva/sessions" -name "*baseline*" -o -name "*.jsonl" -newer "$0" 2>/dev/null | xargs -r cat 2>/dev/null | grep -oE 'https?://[A-Za-z0-9.-]+' | sed -E 's#https?://##' | sort | uniq -c | sort -rn | head -20
} | tee -a "$results"
