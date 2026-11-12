#!/usr/bin/env bash
set -euo pipefail

# The trusted caller provides a frozen workspace and network-isolated Node 24.
node --experimental-strip-types scripts/generate-agent-ui-prompt.mjs
node scripts/build-eve.mjs
node apps/frontend/scripts/build.mjs web
node apps/api/scripts/build.mjs
node scripts/package-eve.mjs
node scripts/package-cf-eve-host.mjs
