#!/usr/bin/env bash
set -euo pipefail

# Install frozen dependencies before running this script. Compilation never
# receives network access, an OIDC token, or a provider credential.
base_image="$(sed -nE 's/^FROM (node:24-[^ ]+@sha256:[a-f0-9]{64})$/\1/p' cloudflare/eve-runtime/Dockerfile)"
[[ "$base_image" =~ ^node:24-[^/]+@sha256:[a-f0-9]{64}$ ]]
docker run --rm --network none --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$PWD,dst=/workspace" --workdir /workspace \
  --env CI=true --env XDG_CACHE_HOME=/tmp/mikka-build-cache \
  --env NITRO_PRESET=node-server --env MIKKA_EVE_WORKFLOW_WORLD=cloudflare \
  --env NODE_OPTIONS=--max-old-space-size=6144 \
  --env MIKKA_BUILD_REVISION --env MIKKA_UI_OVERLAY_SHA --env MIKKA_DEPLOYMENT_ID \
  --env NEXT_PUBLIC_MIKKA_BUILD --env NEXT_PUBLIC_POSTHOG_KEY \
  "$base_image" bash -eu -o pipefail -c '
    node --experimental-strip-types scripts/generate-agent-ui-prompt.mjs
    node scripts/build-eve.mjs
    node apps/frontend/scripts/build.mjs web
    node apps/api/scripts/build.mjs
    node scripts/package-eve.mjs
    node scripts/package-cf-eve-host.mjs
  '
