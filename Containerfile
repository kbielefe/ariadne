# Ariadne v2 image: the server (web UI + API + MCP + relay). Runners run on the host, where the
# claude CLI and its login live. Needs the Adtran VPN for the npm registry.
ARG NODE_IMAGE=artifactory.adtran.com/docker/node:24-alpine@sha256:333f6b3eca25980d5682c26207665b93c9417786b21760b2764d5821d9704c8a

FROM ${NODE_IMAGE} AS builder
ARG NPM_REGISTRY=https://artifactory.adtran.com:443/artifactory/api/npm/npm/
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
