# syntax=docker/dockerfile:1
FROM node:24.22.1-trixie-slim@sha256:89c5244bc22a9bc3287d89ebc7e49b9cb5bb84cd40e6175ac3421d5a9f68b95a AS tools
ADD --checksum=sha256:1c40544020a2e633068ed43a98eb5c0fed7d64a1c6d6f2382e43df91419dad62 https://registry.npmjs.org/pnpm/-/pnpm-10.34.3.tgz /tmp/pnpm.tgz
RUN mkdir -p /opt/pnpm && tar -xzf /tmp/pnpm.tgz --strip-components=1 -C /opt/pnpm

FROM postgres:17.11-trixie@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f
COPY --from=tools /usr/local/bin/node /usr/local/bin/node
COPY --from=tools /opt/pnpm /opt/pnpm
RUN ln -s /opt/pnpm/bin/pnpm.cjs /usr/local/bin/pnpm
COPY pg17.test.mjs /opt/mikka-engineering/pg17.test.mjs
USER postgres
