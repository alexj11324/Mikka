# Pinned to the version the gateway's conversion checks ran against.
FROM python:3.13-slim
RUN pip install --no-cache-dir 'litellm[proxy]==1.109.1'
COPY config.yaml start.sh /app/
EXPOSE 4000
CMD ["/bin/sh", "/app/start.sh"]
