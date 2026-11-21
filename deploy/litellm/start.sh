#!/bin/sh
set -eu

if [ -n "${NEON_AI_GATEWAY_BASE_URL:-}" ]; then
  export NEON_AI_GATEWAY_CHAT_URL="${NEON_AI_GATEWAY_BASE_URL%/}/v1"
fi

exec litellm --config /app/config.yaml --port 4000 --host 0.0.0.0
