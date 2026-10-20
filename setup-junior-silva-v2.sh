#!/usr/bin/env bash
set -euo pipefail

mode="native"
launch=false
skip_build=false
install_native_dependencies=false

usage() {
  cat <<'EOF'
Usage: ./setup-junior-silva-v2.sh [--mode native|docker] [--launch] [--skip-build] [--install-native-dependencies]

Creates .env from .env.example when needed, validates the selected Pi provider,
installs/builds the native runtime or builds/starts the Docker endpoint.

--install-native-dependencies installs the Ubuntu/Debian system packages needed
for native document/review/preview skills. It uses sudo and is valid only with
--mode native.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) mode="${2:-}"; shift 2 ;;
    --launch) launch=true; shift ;;
    --skip-build) skip_build=true; shift ;;
    --install-native-dependencies) install_native_dependencies=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$mode" != "native" && "$mode" != "docker" ]]; then
  echo "--mode must be native or docker" >&2
  exit 2
fi
if [[ "$mode" == "docker" && "$install_native_dependencies" == true ]]; then
  echo '--install-native-dependencies is valid only with --mode native.' >&2
  exit 2
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing $1. $2" >&2
    exit 1
  fi
}

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

configured_value() {
  local value
  value="$(env_value "$1")"
  [[ -n "$value" && ! "$value" =~ ^\<.*\>$ && ! "$value" =~ ^(YOUR_|CHANGE_ME) ]]
}

require_command git 'Install Git, then rerun this script.'

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo 'Created .env from .env.example.'
  echo 'Add a provider key and authorised service credentials to .env, then rerun this script.'
  exit 0
fi

provider="$(env_value PI_PROVIDER)"
provider="${provider:-google}"
case "$provider" in
  anthropic) provider_key='ANTHROPIC_API_KEY' ;;
  google) provider_key='GEMINI_API_KEY' ;;
  *) echo "Unsupported PI_PROVIDER '$provider'. Configure a supported provider and its key in .env." >&2; exit 1 ;;
esac
if ! configured_value "$provider_key"; then
  echo "Set $provider_key in .env before starting Pi." >&2
  exit 1
fi

if [[ "$mode" == 'native' ]]; then
  require_command node 'Install Node.js 24 or later, then rerun this script.'
  require_command npm 'Install npm with Node.js, then rerun this script.'
  if [[ "$install_native_dependencies" == true ]]; then
    require_command sudo 'Run as root or install sudo before using --install-native-dependencies.'
    require_command apt-get 'This installer currently supports Ubuntu/Debian hosts with apt-get.'
    if [[ -r /etc/os-release ]]; then
      . /etc/os-release
      if [[ "${ID:-}" != 'ubuntu' && "${ID:-}" != 'debian' ]]; then
        echo "This native dependency installer supports Ubuntu/Debian only; detected '${ID:-unknown}'." >&2
        exit 1
      fi
    fi
    sudo apt-get update
    sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
      ca-certificates libreoffice-impress libreoffice-writer pandoc \
      poppler-utils python3 python3-pip python3-defusedxml tesseract-ocr
  fi
  if [[ "$skip_build" != true ]]; then
    npm ci --ignore-scripts
    npm run hydrate:model-data
    npm run build:offline
    npm --prefix junior-silva ci --omit=dev --ignore-scripts
  fi
  if [[ "$install_native_dependencies" == true ]]; then
    sudo python3 -m pip install --break-system-packages --no-cache-dir 'bayoo-docx>=0.2.14'
    sudo env "PATH=$PATH" npx playwright install-deps chromium
    npx playwright install chromium
  fi
  if [[ "$launch" == true ]]; then
    exec ./Start-JuniorSilvaV2.sh
  fi
  echo 'Native setup is complete. Start Pi with: ./Start-JuniorSilvaV2.sh'
  exit 0
fi

require_command docker 'Install Docker Engine/Desktop with Docker Compose, then rerun this script.'
docker compose version >/dev/null

librechat_network="$(env_value LIBRECHAT_NETWORK)"
rag_network="$(env_value RAG_NETWORK)"
for network in "${librechat_network:-librechat_default}" "${rag_network:-rag-chat-server_default}"; do
  if ! docker network inspect "$network" >/dev/null 2>&1; then
    docker network create "$network" >/dev/null
  fi
done

if ! configured_value JUNIOR_SILVA_API_KEY; then
  echo 'Set JUNIOR_SILVA_API_KEY in .env before starting the Docker endpoint.' >&2
  exit 1
fi
if ! configured_value JUNIOR_SILVA_ARTIFACT_SECRET; then
  echo 'Set JUNIOR_SILVA_ARTIFACT_SECRET in .env before starting the Docker endpoint.' >&2
  exit 1
fi

if [[ "$skip_build" != true ]]; then
  docker compose build junior-silva-v2
fi
docker compose up -d junior-silva-v2
docker compose ps junior-silva-v2

if [[ "$launch" == true ]]; then
  exec docker compose --profile cli run --rm junior-silva-cli
fi

echo 'Docker endpoint is running. Health check: curl http://127.0.0.1:8132/health'
echo 'Start the Docker CLI with: docker compose --profile cli run --rm junior-silva-cli'
