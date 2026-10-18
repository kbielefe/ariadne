# Ariadne image: the server (web UI + API + MCP).
# Base images are Docker Hub names so work laptops can proxy them via Artifactory
# and home machines can pull directly. Override NPM_REGISTRY if you need a mirror.
ARG NODE_IMAGE=docker.io/library/node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f

FROM ${NODE_IMAGE} AS builder
ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG PNPM_VERSION=10.34.5
ENV npm_config_registry=${NPM_REGISTRY} CI=true
RUN npm install -g "pnpm@${PNPM_VERSION}"
WORKDIR /src
COPY pnpm-lock.yaml package.json ./
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline && pnpm build && test -f dist/server.mjs && test -f dist/web/index.html

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production ARIADNE_WEB_DIR=/app/web ARIADNE_MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=builder --chown=root:root /src/dist/server.mjs /app/server.mjs
COPY --from=builder --chown=root:root /src/dist/web /app/web
COPY --from=builder --chown=root:root /src/dist/migrations /app/migrations
USER node
EXPOSE 3100
CMD ["node", "/app/server.mjs"]
