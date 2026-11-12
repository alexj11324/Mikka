# syntax=docker/dockerfile:1
# Official Node24 multi-platform index; CF uses its linux/amd64 manifest.
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=node:node .output/cf-eve/ ./
USER node
EXPOSE 8080
CMD ["node", "runtime/start.mjs"]
