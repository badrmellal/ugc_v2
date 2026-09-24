# syntax=docker/dockerfile:1.7

# Base image. Override with --build-arg NODE_IMAGE=... (e.g. mirror.gcr.io/library/node:22-bookworm-slim
# when Docker Hub rate limits pulls).
ARG NODE_IMAGE=node:22-bookworm-slim

# ---- dependencies (all, for building) ----------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund

# ---- build web + server --------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY server server
COPY web web
RUN npm run build --workspace web && npm run build --workspace server

# ---- production dependencies of the server only ------------------------------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server --include-workspace-root=false --no-audit --no-fund

# ---- runtime ---------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates tini python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*

# Word-level caption timing (forced alignment against the known script, fully offline).
RUN python3 -m venv /opt/captions \
  && /opt/captions/bin/pip install --no-cache-dir pocketsphinx==5.1.1

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    LOCAL_STORAGE_DIR=/data/storage \
    WEB_DIST_DIR=/app/web/dist \
    CAPTIONS_PYTHON=/opt/captions/bin/python

WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/assets ./server/assets
COPY --from=build /app/web/dist ./web/dist
COPY package.json ./

RUN mkdir -p /data/storage && chown -R node:node /data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/main.js"]
