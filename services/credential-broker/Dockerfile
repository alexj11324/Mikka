# syntax=docker/dockerfile:1
# Run the existing broker build on the pinned checkout, then use this package
# directory as the build context. Only the compiled handlers enter the image.
FROM node:24-bookworm-slim
ARG MIKKA_BUILD_REVISION
ARG MIKKA_UI_OVERLAY_SHA
ARG MIKKA_DEPLOYMENT_ID
LABEL org.opencontainers.image.revision=${MIKKA_BUILD_REVISION} \
      com.mikka.overlay=${MIKKA_UI_OVERLAY_SHA} \
      com.mikka.release=${MIKKA_DEPLOYMENT_ID}
ENV NODE_ENV=production MIKKA_EDITION=cloud PORT=3000
WORKDIR /app
COPY --chown=node:node package.json server.mjs ./
COPY --chown=node:node dist/fill.js dist/oidc.js ./dist/
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
