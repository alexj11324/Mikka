# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS subscription-workers
WORKDIR /source
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
COPY scripts/build-subscription-worker.mjs ./scripts/
COPY packages/subscription-worker/ ./packages/subscription-worker/
ENV MIKKA_BUILD_BYOS_WORKER=1
RUN node scripts/build-subscription-worker.mjs

FROM node:24-bookworm-slim AS build
WORKDIR /source
ENV CI=true ELECTRON_SKIP_BINARY_DOWNLOAD=1 NEXT_TELEMETRY_DISABLED=1 NITRO_PRESET=node-server MIKKA_BUILD_BYOS_WORKER=1
RUN npm install --global pnpm@10.34.3
COPY . .
COPY --from=subscription-workers /source/packages/subscription-worker/bin/ ./packages/subscription-worker/bin/
RUN --mount=type=cache,id=mikka-pnpm,target=/pnpm/store \
    --mount=type=secret,id=ffmpeg_github_token,env=FFMPEG_GITHUB_TOKEN,required=false \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
ARG MIKKA_BUILD_REVISION
ENV MIKKA_BUILD_REVISION=${MIKKA_BUILD_REVISION}
RUN pnpm generate:agent-ui && pnpm build:app

FROM node:24-bookworm-slim AS runtime
ARG MIKKA_BUILD_REVISION
ARG MIKKA_BUILD_WORKER_SHA
LABEL org.opencontainers.image.source="https://github.com/alexj11324/Mikka" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.revision="${MIKKA_BUILD_REVISION}"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 MIKKA_DATA_DIR=/data \
    WORKFLOW_TARGET_WORLD=local WORKFLOW_LOCAL_DATA_DIR=/data/workflow \
    MIKKA_CLOUD_WORKER_SOURCE_COMMIT=${MIKKA_BUILD_REVISION} MIKKA_CLOUD_WORKER_SHA=${MIKKA_BUILD_WORKER_SHA} \
    MIKKA_BYOS_WORKER_BINARY=/app/packages/subscription-worker/bin/mikka-subscription-worker \
    MIKKA_BYOS_ENROLLMENT_BINARY=/app/packages/subscription-worker/bin/mikka-subscription-enrollment
WORKDIR /app
COPY --from=subscription-workers /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build --chown=node:node /source/.output/ ./
COPY --from=build --chown=node:node /source/drizzle/ ./drizzle/
COPY --from=build --chown=node:node /source/scripts/ ./scripts/
RUN ln -s server/node_modules node_modules && mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 CMD ["node", "scripts/self-hosted-health.mjs"]
CMD ["node", "scripts/self-hosted-start.mjs"]
