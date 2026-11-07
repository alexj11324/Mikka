# The upstream community distribution is source-only. Compile its fixed security
# release, never a moving third-party container mirror. This is a CI fixture.
# https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z
FROM golang:1.24.8-bookworm AS build
ENV CGO_ENABLED=0 GOBIN=/out
RUN --mount=type=cache,id=mikka-ci-minio-go,target=/go/pkg/mod \
    --mount=type=cache,id=mikka-ci-minio-build,target=/root/.cache/go-build \
    go install github.com/minio/minio@9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a

FROM node:24-bookworm-slim
COPY --from=build /out/minio /usr/local/bin/minio
RUN mkdir -p /data && chown node:node /data
USER node
ENTRYPOINT ["minio"]
