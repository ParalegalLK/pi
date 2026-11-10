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

Docker mode builds the bridge, runner and Pi images, and starts the bridge and the
runner. Each message's Pi runs in its own gVisor container, so Docker needs gVisor
(scripts/js-install-gvisor.sh) and these .env settings: JS_IDENTITY_SECRET,
JS_RUNNER_SECRET, JS_HOST_DATA_ROOT and JS_DOCKER_GID.

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
# Each message's Pi runs in its own gVisor container.
if ! docker info --format '{{json .Runtimes}}' | grep -q '"runsc"'; then
  echo 'Docker has no gVisor runtime (runsc). Install it with scripts/js-install-gvisor.sh, then rerun this script.' >&2
  exit 1
fi

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
if ! configured_value JS_IDENTITY_SECRET; then
  echo 'Set JS_IDENTITY_SECRET in .env before starting the Docker endpoint. Generate it with: openssl rand -hex 32' >&2
  exit 1
fi
runner_secret="$(env_value JS_RUNNER_SECRET)"
if (( ${#runner_secret} < 32 )); then
  echo 'Set JS_RUNNER_SECRET in .env, with at least 32 characters, before starting the Docker endpoint. Generate it with: openssl rand -hex 32' >&2
  exit 1
fi
unset runner_secret
data_root="$(env_value JS_HOST_DATA_ROOT)"
if [[ "$data_root" != /* || "$(realpath -m -- "$data_root")/" == "$(realpath -- "$script_dir")/"* ]]; then
  echo 'Set JS_HOST_DATA_ROOT in .env to an absolute host folder for the chats, outside this repository.' >&2
  exit 1
fi
if [[ ! "$(env_value JS_DOCKER_GID)" =~ ^[0-9]+$ ]]; then
  echo "Set JS_DOCKER_GID in .env to the Docker group's number: getent group docker | cut -d: -f3" >&2
  exit 1
fi
# The bridge and Pi run as user 1000. Docker would make a missing folder owned by root.
if [[ ! -d "$data_root" ]]; then
  mkdir -p -m 700 "$data_root"
  echo "Created the data folder $data_root."
fi
if [[ "$(stat -c %u "$data_root")" != 1000 ]]; then
  echo "The data folder $data_root must be owned by user 1000, which runs the bridge and Pi: sudo chown -R 1000:1000 '$data_root'" >&2
  exit 1
fi

cli_command=(docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile cli run --rm junior-silva-cli)
if [[ "$skip_build" != true ]]; then
  docker compose build junior-silva-v2 junior-silva-runner
  echo 'Building the Pi image. The first build can take a long time.'
  docker compose build junior-silva-pi
fi
docker compose up -d
docker compose ps

if [[ "$launch" == true ]]; then
  exec "${cli_command[@]}"
fi

echo 'Docker endpoint is running. Health check: curl http://127.0.0.1:8132/health'
echo "Start the Docker CLI with: ${cli_command[*]}"
