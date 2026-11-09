# This file builds two images:
#   bridge (the default):  docker compose build junior-silva-v2
#   pi-sandbox:            docker build --target pi-sandbox -t junior-silva-pi:local .
#
# The base image is pinned by digest, so a moved tag can't start a surprise full rebuild. The digest
# is the multi-platform index, so the same line builds on x86 and ARM servers. To move to a newer
# base on purpose, run `docker buildx imagetools inspect node:24-bookworm-slim` and copy its Digest.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

# Stage 1: build Pi from source. The bridge image continues from here, because it still runs Pi
# itself until P3.7. These steps are the same as before the split, so the build cache still applies.
FROM ${NODE_IMAGE} AS build

ENV NODE_ENV=production \
    PI_SKIP_VERSION_CHECK=1 \
    JUNIOR_SILVA_DATA_ROOT=/data \
    JUNIOR_SILVA_ARTIFACT_ROOT=/data/artifacts \
    JUNIOR_SILVA_UPLOAD_ROOT=/data/uploads \
    PI_CODING_AGENT_DIR=/data/pi-agent \
    PI_CODING_AGENT_SESSION_DIR=/data/sessions

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates libreoffice-impress libreoffice-writer pandoc poppler-utils python3 python3-pip python3-defusedxml tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*
# bayoo-docx adds Word comments to the standard python-docx API. The native
# review renderer uses it to keep comments and highlights at source clauses.
RUN python3 -m pip install --break-system-packages --no-cache-dir "bayoo-docx>=0.2.14"

COPY package.json package-lock.json ./
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig.json tsconfig.base.json biome.json ./
RUN npm ci --include=dev --ignore-scripts \
      --fetch-retries=5 \
      --fetch-retry-mintimeout=10000 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=600000
RUN npx playwright install --with-deps chromium
RUN mkdir -p /ms-playwright && cp -a /root/.cache/ms-playwright/. /ms-playwright/ && chmod -R a+rX /ms-playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Provider catalog JSON is generated and intentionally ignored by Git. Remove
# any developer-hydrated copy first: Docker's overlay filesystem cannot rename
# that copied lower-layer directory into the generator's temporary staging area.
RUN rm -rf packages/ai/src/providers/data \
    && npm run hydrate:model-data \
    && npm run build:offline

# Stage 2: the Pi sandbox image. Each Pi run gets its own container from this image (plan 3.10).
# It holds only Pi, its 4 hosted extensions, the skills, and the tools and libraries they use:
# no server code, tests or keys. Everything is built in, because the container has no internet.
FROM ${NODE_IMAGE} AS pi-sandbox
WORKDIR /app
# Debian names fd "fdfind". Pi looks for both names.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fd-find libreoffice-calc libreoffice-impress libreoffice-writer pandoc poppler-utils \
      python3 python3-defusedxml python3-pip qpdf ripgrep tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*
# Every Python package is pinned, including the ones the libraries pull in. --no-deps installs
# exactly this list, and pip check stops the build if the list misses something.
COPY deploy/pi-libs/requirements.txt /tmp/pi-libs/requirements.txt
RUN python3 -m pip install --break-system-packages --no-cache-dir --no-deps -r /tmp/pi-libs/requirements.txt \
    && python3 -m pip check \
    && rm -rf /tmp/pi-libs
# The /node_modules link lets scripts in any folder, such as a chat's folder, load these libraries.
COPY deploy/pi-libs/package.json deploy/pi-libs/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
      --fetch-retries=5 \
      --fetch-retry-mintimeout=10000 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=600000 \
    && npm cache clean --force \
    && ln -s /app/node_modules /node_modules
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /var/lib/apt/lists/*
# Pi's built package, with the files npm would publish.
COPY --from=build /app/packages/coding-agent/package.json /app/packages/coding-agent/README.md /app/packages/coding-agent/CHANGELOG.md ./packages/coding-agent/
COPY --from=build /app/packages/coding-agent/dist ./packages/coding-agent/dist
COPY --from=build /app/packages/coding-agent/docs ./packages/coding-agent/docs
COPY --from=build /app/packages/coding-agent/examples ./packages/coding-agent/examples
COPY --from=build /app/packages/coding-agent/schemas ./packages/coding-agent/schemas
COPY deploy/pi-libs/check-pi-packages.mjs /tmp/check-pi-packages.mjs
# Also removes npm's own logs from the steps above. They hold no secrets, but don't belong in the image.
RUN node /tmp/check-pi-packages.mjs && rm -rf /tmp/check-pi-packages.mjs /root/.npm
# Only the 4 hosted extensions, and the one bridge file two of them import.
COPY .pi/extensions/junior-silva-legal-context.ts .pi/extensions/junior-silva-scope-guard.ts \
     .pi/extensions/legal-research-citation-delivery.ts .pi/extensions/librechat-preview-delivery.ts ./.pi/extensions/
COPY junior-silva/core/legal-scope.mjs ./junior-silva/core/legal-scope.mjs
# Pi's tool helper only forwards tool calls to the bridge, and holds no tool code. It goes where
# .pi/mcp.json already looks.
COPY .pi/mcp.json ./.pi/mcp.json
COPY junior-silva/mcp/sandbox-launcher.mjs ./junior-silva/mcp/launcher.mjs
COPY .agents/skills ./.agents/skills
# The start-up script checks the runner's settings, fills Pi's settings folder (/run/pi-agent, in
# memory), makes this message's folder, then starts Pi.
COPY deploy/pi-entrypoint.sh ./deploy/pi-entrypoint.sh
COPY deploy/pi-agent-seed ./deploy/pi-agent-seed
ENV NODE_ENV=production \
    LANG=C.UTF-8 \
    TZ=Asia/Colombo \
    PI_OFFLINE=1 \
    PI_TELEMETRY=0 \
    PI_SKIP_VERSION_CHECK=1
USER node
ENTRYPOINT ["/app/deploy/pi-entrypoint.sh"]

# Stage 3: the bridge image. Keep it last: `docker compose build` builds the last stage.
FROM build AS bridge
COPY junior-silva/package.json junior-silva/package-lock.json ./junior-silva/
RUN npm --prefix junior-silva ci --omit=dev --ignore-scripts

COPY .pi ./.pi
COPY .agents ./.agents
COPY junior-silva ./junior-silva
COPY Overview.md ./Overview.md
RUN mkdir -p /data/artifacts /data/uploads /data/sessions /data/pi-agent && chown -R node:node /data
USER node

EXPOSE 8126
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8126/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "junior-silva/server/openai.mjs"]
