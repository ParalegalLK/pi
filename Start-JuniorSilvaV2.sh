#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

if [[ ! -f .env ]]; then
  echo "Missing .env. Copy .env.example to .env, add the required provider key, then run Setup-JuniorSilvaV2 or this launcher again." >&2
  exit 1
fi

env_value() {
  local name="$1"
  local line
  line="$(grep -E "^${name}=" .env | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%$'\r'}"
  line="${line%\"}"
  line="${line#\"}"
  line="${line%\'}"
  line="${line#\'}"
  printf '%s' "$line"
}

export GEMINI_API_KEY="$(env_value GEMINI_API_KEY)"
export ANTHROPIC_API_KEY="$(env_value ANTHROPIC_API_KEY)"

workspace_root="$(env_value JUNIOR_SILVA_WORKSPACE_ROOT)"
if [[ -z "$workspace_root" ]]; then
  workspace_root="$script_dir/junior-silva/workspace"
fi
mkdir -p "$workspace_root"
export JUNIOR_SILVA_WORKSPACE_ROOT="$workspace_root"

for name in JUNIOR_SILVA_KB_ROOT JUNIOR_SILVA_DATA_ROOT JUNIOR_SILVA_ARTIFACT_ROOT JUNIOR_SILVA_UPLOAD_ROOT; do
  value="$(env_value "$name")"
  if [[ -n "$value" ]]; then
    export "$name=$value"
  fi
done

provider="$(env_value PI_PROVIDER)"
model="$(env_value PI_MODEL)"
thinking="$(env_value PI_THINKING)"
provider="${provider:-google}"
model="${model:-gemini-3.7-flash}"
thinking="${thinking:-medium}"

exec node packages/coding-agent/dist/bundle/cli.js \
  --tui-mode regular \
  --approve \
  --provider "$provider" \
  --model "$model" \
  --thinking "$thinking" \
  --extension "$script_dir/.pi/extensions/junior-silva-legal-context.ts" \
  --extension "$script_dir/.pi/extensions/junior-silva-scope-guard.ts" \
  --extension "$script_dir/.pi/extensions/legal-research-citation-delivery.ts" \
  --extension "$script_dir/.pi/extensions/librechat-preview-delivery.ts" \
  --extension "$script_dir/.pi/extensions/junior-silva-local-trace.ts" \
  "$@"
