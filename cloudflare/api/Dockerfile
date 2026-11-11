# syntax=docker/dockerfile:1
# "release" is the node-server output built for this exact public+private release.
FROM node:24-bookworm-slim
WORKDIR /app
ARG MIKKA_BUILD_REVISION
ARG MIKKA_UI_OVERLAY_SHA
ARG MIKKA_DEPLOYMENT_ID
LABEL org.opencontainers.image.revision=${MIKKA_BUILD_REVISION}
ENV NODE_ENV=production MIKKA_EDITION=cloud MIKKA_DEPLOYMENT_STAGE=production HOST=0.0.0.0 PORT=3000
COPY --from=release --chown=node:node /server/ ./server/
COPY --from=release --chown=node:node /lib/ ./lib/
COPY --from=release --chown=node:node /packages/ ./packages/
COPY --from=release --chown=node:node /scripts/ ./scripts/
COPY --from=release --chown=node:node /mikka-build.json /world-business.mjs ./
COPY --chown=node:node start.mjs ./
RUN ln -s server/node_modules node_modules
USER node
RUN node start.mjs verify-image
EXPOSE 3000
CMD ["node", "start.mjs"]
