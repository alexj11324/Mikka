#!/usr/bin/env bash
set -euo pipefail

[[ "$(uname -s)" == Linux ]] || { echo 'Run Eve image checks in cloud Linux or CI.' >&2; exit 1; }
export MIKKA_BUILD_REVISION="$(git rev-parse HEAD)"
export MIKKA_DEPLOYMENT_ID="${MIKKA_DEPLOYMENT_ID:-$(node lib/deployment-id.mjs)}"

# Fail on model selection, cancellation and packaging contracts before compiling.
node --experimental-test-module-mocks --import ./scripts/server-test.mjs --import tsx --test \
  lib/abuse/model.test.ts lib/eve/runtime.test.ts lib/eve/streaming-model.test.ts \
  lib/eve/projection.test.ts lib/eve/session-control-delivery.test.mjs \
  scripts/build-eve.test.mjs scripts/package-eve.test.mjs \
  cloudflare/eve-runtime/test/package.test.mjs scripts/verify-eve-image.test.mjs

# These are this compiler's disposable outputs, never the agent's local state.
rm -rf apps/eve/.output .output/eve .output/cf-eve
bash scripts/build-cloudflare-eve-image.sh --independent
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
docker build -f cloudflare/eve-runtime/Dockerfile --iidfile "$temporary/image-id" -t mikka-eve-qualification .
node scripts/verify-eve-image.mjs "$(cat "$temporary/image-id")"
