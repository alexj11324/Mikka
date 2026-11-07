# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /source
ENV CI=true ELECTRON_SKIP_BINARY_DOWNLOAD=1 NEXT_TELEMETRY_DISABLED=1 NITRO_PRESET=node-server
RUN npm install --global pnpm@10.34.3
COPY . .
RUN --mount=type=cache,id=mikka-pnpm,target=/pnpm/store pnpm install --frozen-lockfile --store-dir /pnpm/store
ARG MIKKA_BUILD_REVISION
ENV MIKKA_BUILD_REVISION=${MIKKA_BUILD_REVISION}
RUN pnpm generate:agent-ui && pnpm build:app

FROM node:24-bookworm-slim AS runtime
ARG MIKKA_BUILD_REVISION
LABEL org.opencontainers.image.source="https://github.com/alexj11324/Mikka" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.revision="${MIKKA_BUILD_REVISION}"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 MIKKA_DATA_DIR=/data \
    WORKFLOW_TARGET_WORLD=local WORKFLOW_LOCAL_DATA_DIR=/data/workflow
WORKDIR /app
COPY --from=build --chown=node:node /source/.output/ ./
COPY --from=build --chown=node:node /source/drizzle/ ./drizzle/
COPY --from=build --chown=node:node /source/scripts/ ./scripts/
RUN ln -s server/node_modules node_modules && mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 CMD ["node", "scripts/self-hosted-health.mjs"]
CMD ["node", "scripts/self-hosted-start.mjs"]
