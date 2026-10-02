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
      ca-certificates libreoffice-writer pandoc poppler-utils python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig.json tsconfig.base.json biome.json ./
RUN npm ci --include=dev --ignore-scripts
RUN npm run build:offline

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
