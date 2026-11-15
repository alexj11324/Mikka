# Pinned to the version the gateway's conversion checks ran against.
FROM python:3.13-slim
RUN pip install --no-cache-dir 'litellm[proxy]==1.109.1'
COPY config.yaml /app/config.yaml
EXPOSE 4000
CMD ["litellm", "--config", "/app/config.yaml", "--port", "4000", "--host", "0.0.0.0"]
