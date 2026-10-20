# Run Junior Silva V2 locally as Pi CLI

This guide starts from a fresh clone of the ParalegalLK Pi fork and ends with an interactive Junior Silva CLI. It supports Windows, Linux/WSL, and the packaged Docker CLI.

Junior Silva is a Pi capability layer. Pi starts the local MCP server itself through stdio; there is no separate MCP container to build or run. The MCP tools call the legal services configured in `.env`.

**Native and Docker are different runtimes.** Native CLI runs Pi, MCP and every document dependency directly on the host. Docker CLI runs Pi, MCP and every document dependency inside one `junior-silva-v2:local` image. Native CLI does not use that Docker image as a helper.

## Choose a runtime mode

| Mode | Starts locally | Uses remote services | Best for |
| --- | --- | --- | --- |
| Windows native | Pi, MCP and host-installed document tools | Usually RAG and other authorised services | Windows development; WSL is recommended for document tooling. |
| Linux/WSL native | Pi, MCP and host-installed document tools | Usually authorised remote services | Linux development and debugging. |
| Docker CLI | Pi, MCP and all document tools in one V2 image | Local Docker services or authorised remote services | Recommended full-featured local CLI. |

The Junior Silva repository does **not** contain RAG Chat Server, Lex, the Translator, or the Drafter knowledge base. For normal users, those are organisation services and must be configured as remote endpoints. On the main developer laptop, RAG Chat Server may instead run locally in WSL at `http://127.0.0.1:8123`.

## 1. Prerequisites

Install or obtain access to the following before setup:

- Git, with access to the private `ParalegalLK/pi` repository.
- Node.js 24 or later and npm for a native CLI installation.
- Docker Desktop on Windows, or Docker Engine plus the Compose plugin on Linux, for Docker mode or the OpenAI-compatible endpoint.
- PowerShell 7 or Windows PowerShell for Windows; Bash for Linux/WSL.
- An authorised model-provider API key: Anthropic for the default configuration, or Google if you change `PI_PROVIDER` to `google`.
- An authorised RAG Chat Server base URL and RAG API key. Do not use another team’s internal service address or token without approval.
- Optional service credentials for web search, translation, Lex/Typesense source details, and the hosted HTTP endpoint.
- Optional: WSL on Windows. It is recommended for the portable legal-DOCX renderer when native Windows lacks Pandoc or LibreOffice.

The Docker image includes LibreOffice, Pandoc, Python, DOCX review-rendering dependencies, Tesseract, Poppler and Playwright Chromium, as well as Pi, the Junior Silva MCP server, extensions, skills and application code. It is one image, not a primary image plus helper images. A Docker CLI session is merely a short-lived container created from that image.

Native installation does **not** use this image and does **not** obtain its operating-system dependencies automatically. A native user needs compatible host tooling, or should use Docker mode. The Linux setup script can install the supported Ubuntu/Debian dependency set only when explicitly asked with `--install-native-dependencies`.

## 2. Clone the correct fork

Use the maintained ParalegalLK fork and the `dev` branch.

### Windows PowerShell

```powershell
cd 'D:\Intern\Work'
git clone git@github.com:ParalegalLK/pi.git junior-silva-v2
cd .\junior-silva-v2
git switch dev
git pull --ff-only origin dev
```

### Linux or WSL

```bash
mkdir -p ~/work
cd ~/work
git clone git@github.com:ParalegalLK/pi.git junior-silva-v2
cd junior-silva-v2
git switch dev
git pull --ff-only origin dev
```

If Git reports that `dev` is unavailable, run `git fetch origin` and ask the project maintainer which branch is approved. Do not substitute the unrelated upstream Pi repository: Junior Silva files are in the ParalegalLK fork.

## 3. Create and configure `.env`

Copy the safe template. It has public/default settings and empty placeholders only; it deliberately contains no keys or tokens.

### Windows

```powershell
Copy-Item .env.example .env
notepad .env
```

### Linux/WSL

```bash
cp .env.example .env
nano .env
```

At minimum, configure one reasoning provider and RAG:

```dotenv
PI_PROVIDER=anthropic
PI_MODEL=claude-sonnet-5-5
PI_THINKING=medium
ANTHROPIC_API_KEY=YOUR_ANTHROPIC_KEY

# Developer laptop with RAG Chat Server published from WSL:
RAG_BASE_URL=http://127.0.0.1:8123
RAG_API_KEY=YOUR_RAG_KEY
```

For an authorised remote RAG service, replace only the base URL with the endpoint supplied by the organisation:

```dotenv
RAG_BASE_URL=https://YOUR_ORG_RAG_HOST
RAG_API_KEY=YOUR_RAG_KEY
```

To use Gemini instead, set all three model values coherently:

```dotenv
PI_PROVIDER=google
PI_MODEL=gemini-3.7-flash
PI_THINKING=medium
GEMINI_API_KEY=YOUR_GEMINI_KEY
```

### Configure capabilities after adding their credentials

| Capability | Required settings |
| --- | --- |
| Current public legal/news research | `WEB_SEARCH_ENABLED=true`, `WEB_SEARCH_API_KEY=...`. Required for current-news/gazette research but not every stable-law request. |
| Translation | `TRANSLATOR_API_KEY=...`; needed for translation requests. The template already supplies the public Translator base URL. |
| Lex Acts/constitutional source detail | `JUNIOR_LEX_LEGISLATION_ENABLED=true`, `JUNIOR_LEX_LEGISLATION_API_KEY=...` |
| Typesense case/book/chunk source detail | `JUNIOR_TYPESENSE_ENABLED=true` plus the scoped source keys. The template supplies only public hosts, ports and collection names. |
| OpenAI-compatible local endpoint | `JUNIOR_SILVA_API_KEY=...` and `JUNIOR_SILVA_ARTIFACT_SECRET=...` |

RAG should be treated as a core configuration item for a capable Sri Lankan legal assistant. The remaining entries are capability-specific: users who need current law/news should enable web search, and users who need translation should configure the Translator.

`WEB_SCRAPER_*` and `WEB_RERANKER_*` are reserved configuration today: the active public-search adapter calls Serper only. Firecrawl and Jina are not currently fallbacks, so those values may remain disabled.

Never commit `.env`. It is ignored by Git. Do not put a credential in `LOCAL_CLI_SETUP.md`, `.env.example`, source code, screenshots, chat prompts, or an artifact.

### Drafter knowledge base directory

Native Junior Silva drafting can consult an approved private precedent corpus. Obtain the `clean-kb` directory from the authorised Drafter Weeramantri repository/export. Do not copy the corpus into this repository or commit it. The corpus is guidance for drafting structure only. The Drafter knowledge base is strongly recommended for high-quality precedent-aware drafting.

Configure both paths:

```dotenv
# Native Windows/Linux CLI: actual local path to the downloaded clean-kb folder
JUNIOR_SILVA_KB_ROOT=/absolute/path/to/clean-kb

# Docker CLI/endpoint: host path mounted read-only inside the container as /kb
JUNIOR_SILVA_KB_HOST_PATH=/absolute/path/to/clean-kb
```

Examples:

```dotenv
# Windows native
JUNIOR_SILVA_KB_ROOT=D:\LegalData\drafter-weeramantry\clean-kb
JUNIOR_SILVA_KB_HOST_PATH=D:\LegalData\drafter-weeramantry\clean-kb

# Linux/WSL
JUNIOR_SILVA_KB_ROOT=/home/alice/work/drafter-weeramantry/clean-kb
JUNIOR_SILVA_KB_HOST_PATH=/home/alice/work/drafter-weeramantry/clean-kb
```


## 4. Fast automated setup

The scripts create `.env` if absent, check the selected provider key, install/build what the chosen mode needs, and can launch Pi. They never overwrite an existing `.env`, print its secrets, create model-provider keys, or start a separate RAG deployment.

### Windows native CLI

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\Setup-JuniorSilvaV2.ps1 -Mode Native
# Edit .env if this was the first run, then:
.\Setup-JuniorSilvaV2.ps1 -Mode Native -Launch
```

### Linux/WSL native CLI

```bash
chmod +x Start-JuniorSilvaV2.sh setup-junior-silva-v2.sh
./setup-junior-silva-v2.sh --mode native
# Edit .env if this was the first run, then:
./setup-junior-silva-v2.sh --mode native --launch
```

For a fully capable Ubuntu/Debian native runtime, let the script install host document/review dependencies. This uses `sudo` and installs LibreOffice, Pandoc, Python packages, Tesseract, Poppler and Chromium support:

```bash
./setup-junior-silva-v2.sh --mode native --install-native-dependencies --launch
```

Use Docker mode instead if you do not want these packages installed on the host.

### Docker CLI and local endpoint

Docker mode builds the Junior Silva V2 image, creates the named external networks required by Compose if missing, starts the local OpenAI-compatible endpoint, and optionally opens the interactive Docker CLI.

Before Docker mode, set these endpoint secrets in `.env`:

```dotenv
JUNIOR_SILVA_API_KEY=GENERATE_A_LONG_RANDOM_VALUE
JUNIOR_SILVA_ARTIFACT_SECRET=GENERATE_A_SECOND_LONG_RANDOM_VALUE
```

Windows:

```powershell
.\Setup-JuniorSilvaV2.ps1 -Mode Docker
.\Setup-JuniorSilvaV2.ps1 -Mode Docker -Launch -SkipBuild
```

Linux/WSL:

```bash
./setup-junior-silva-v2.sh --mode docker
./setup-junior-silva-v2.sh --mode docker --launch --skip-build
```

For standalone Docker users with remote legal services, set the Docker-specific values rather than relying on the organisation’s local container names:

```dotenv
JUNIOR_SILVA_DOCKER_RAG_BASE_URL=https://YOUR_ORG_RAG_HOST
# These are normally blank because V2 native review/drafting is local to Pi.
JUNIOR_SILVA_DOCKER_REVIEWER_BASE_URL=
JUNIOR_SILVA_DOCKER_DRAFTER_BASE_URL=
```

On Docker Desktop, if your developer RAG is in WSL and published to localhost, the Docker-specific RAG value is normally `http://host.docker.internal:8123`. On native Linux, prefer the organisation’s remote RAG endpoint unless Docker host networking has been deliberately configured by your administrator.

For a normal Ubuntu user who wants the complete feature set with organisation-hosted services, Docker CLI is recommended: it needs Docker only and provides the same packaged document environment used by the endpoint. Native Linux is appropriate for development or debugging, but requires the host dependencies above.

### Starting again later

Native CLI does not reinstall or rebuild anything on a normal startup:

```bash
./Start-JuniorSilvaV2.sh
```

Docker CLI reuses the cached `junior-silva-v2:local` image and does not rebuild during a normal interactive launch:

```bash
docker compose --profile cli run --rm junior-silva-cli
```

After pulling Pi/Junior Silva source changes, rerun setup without `--skip-build`: native mode rebuilds the Node bundles, while Docker mode rebuilds the V2 image. Only use `--skip-build` when the source and dependencies are unchanged.

## 4. Manual alternative (Optional: If Fast automated setup scripts are not used) 

Use these commands if you do not want the setup scripts.

### Native Windows

```powershell
npm ci --ignore-scripts
npm run hydrate:model-data
npm run build:offline
npm --prefix junior-silva ci --omit=dev --ignore-scripts
.\Start-JuniorSilvaV2.ps1
```

### Native Linux/WSL

```bash
npm ci --ignore-scripts
npm run hydrate:model-data
npm run build:offline
npm --prefix junior-silva ci --omit=dev --ignore-scripts
./Start-JuniorSilvaV2.sh
```

### Docker endpoint and CLI

```bash
docker network inspect librechat_default >/dev/null 2>&1 || docker network create librechat_default
docker network inspect rag-chat-server_default >/dev/null 2>&1 || docker network create rag-chat-server_default
docker compose build junior-silva-v2
docker compose up -d junior-silva-v2
curl http://127.0.0.1:8132/health
docker compose --profile cli run --rm junior-silva-cli
```

## 5. First-run checks

For native CLI, use a short legal question such as:

```text
What remedies are generally available for breach of contract under Sri Lankan law?
```

For Docker endpoint health:

```bash
curl http://127.0.0.1:8132/health
curl http://127.0.0.1:8132/v1/models
```

Expected health response:

```json
{"ok":true}
```

If RAG research fails, first verify the endpoint from the same operating-system environment running Pi:

```bash
curl -i "$RAG_BASE_URL/health"
```

Do not expose a private RAG service, Pi endpoint, or artifact download route directly to the public internet without reverse-proxy authentication, TLS, access controls and appropriate container/host isolation.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `Missing .env` | Copy `.env.example` to `.env`, then add the selected provider key. |
| Provider authentication error | Confirm `PI_PROVIDER`, `PI_MODEL`, and its matching API key are consistent. |
| RAG tool cannot connect | Native: check `RAG_BASE_URL` from the host. Docker: set `JUNIOR_SILVA_DOCKER_RAG_BASE_URL` to an address reachable inside the container. |
| Docker Compose reports a missing external network | Run the setup script in Docker mode, or create the named network shown in `.env`. |
| Precedent search has no result | Confirm the authorised `clean-kb` folder exists and the appropriate `JUNIOR_SILVA_KB_*` path is readable. |
| Native DOCX generation is limited | Use WSL or Docker, where the portable/full document tooling is available. |
| Model catalogue/build error after a new Pi update | Follow [update_guide.md](update_guide.md) rather than changing unrelated upstream tests. |

For product-level checks after a change, follow [TESTING.md](TESTING.md). For architecture and tool details, see [Overview.md](Overview.md) and [Architecture.md](Architecture.md).
