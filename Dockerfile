FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PI_SKIP_VERSION_CHECK=1 \
    JUNIOR_SILVA_DATA_ROOT=/data \
    JUNIOR_SILVA_ARTIFACT_ROOT=/data/artifacts \
    JUNIOR_SILVA_UPLOAD_ROOT=/data/uploads \
    PI_CODING_AGENT_DIR=/data/pi-agent \
    PI_CODING_AGENT_SESSION_DIR=/data/sessions

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates libreoffice-impress libreoffice-writer pandoc poppler-utils python3 python3-pip python3-defusedxml \
    && rm -rf /var/lib/apt/lists/*

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
# Provider catalog JSON is generated and intentionally ignored by Git. Hydrate
# it inside the image so a fresh clone can build without local developer state.
RUN npm run hydrate:model-data && npm run build:offline

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
