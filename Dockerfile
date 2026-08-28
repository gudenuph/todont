# The host runs Node 16 and every service in a container, so the tracker brings
# its own Node rather than asking the box to upgrade under everything else.

# ----------------------------------------------------------------- build
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Copy every workspace manifest first so the dependency layer caches on its own.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY mcp/package.json mcp/
RUN npm ci

COPY . .
RUN npm run build --workspace server \
 && npm run build --workspace web

# ------------------------------------------------------- production deps
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY mcp/package.json mcp/
# better-sqlite3 is native; prebuild-install fetches a binary matching this
# image's Node, so no compiler is needed in the final image.
RUN npm ci --omit=dev

# ---------------------------------------------------------------- runtime
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    DATA_DIR=/data \
    WEB_DIST=/app/web/dist \
    SERVE_WEB=true \
    HOST=0.0.0.0 \
    PORT=4310

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data/uploads \
 && chown -R node:node /data

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/server/dist  ./server/dist
COPY --from=build /app/web/dist     ./web/dist
COPY server/package.json            ./server/package.json
COPY package.json                   ./package.json

USER node
EXPOSE 4310

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4310/api/health || exit 1

CMD ["node", "server/dist/index.js"]
