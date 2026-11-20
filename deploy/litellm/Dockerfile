# Pinned to the version the gateway's conversion checks ran against.
FROM python:3.13-slim
RUN pip install --no-cache-dir 'litellm[proxy]==1.109.1'
COPY config.yaml start.sh /app/
EXPOSE 4000
CMD ["/bin/sh", "/app/start.sh"]

LABEL org.opencontainers.image.title="Mikka LiteLLM runtime" \
      org.opencontainers.image.description="Model protocol proxy for Mikka services." \
      org.opencontainers.image.documentation="https://github.com/alexj11324/Mikka/blob/main/docs/operations/build-source-of-truth.md#service-builds-and-release-manifests"
