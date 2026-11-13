#!/usr/bin/env bash
set -euo pipefail

# The trusted caller provides a frozen workspace and network-isolated Node 24.
node --experimental-strip-types scripts/generate-agent-ui-prompt.mjs
node scripts/build-eve.mjs
case "${1:-}" in
  '')
    node apps/frontend/scripts/build.mjs web
    node apps/api/scripts/build.mjs
    ;;
  --prebuilt-api) ;;
  *) echo 'Unknown Eve compiler mode' >&2; exit 1 ;;
esac
node scripts/package-eve.mjs
if [[ "${1:-}" == --prebuilt-api ]]; then
  node scripts/cloudflare-runtime-release.mjs package-prebuilt-eve
else
  node scripts/package-cf-eve-host.mjs
fi
