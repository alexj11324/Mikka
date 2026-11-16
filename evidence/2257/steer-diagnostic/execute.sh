#!/usr/bin/env bash
set -euo pipefail
base=$1
umask 077
cd "$base/product"
export RAYON_NUM_THREADS=2 UV_THREADPOOL_SIZE=2 NODE_OPTIONS=--max-old-space-size=3072
export MIKKA_BUILD_REVISION="$MIKKA_TEST_DEPLOYMENT_SHA"
step() {
  echo "Verification phase $1"
  echo "$1" > "$base/stage"
  shift
  "$@" > "$base/build.log" 2>&1 || {
    python3 "$GITHUB_WORKSPACE/review/evidence/2257/steer-diagnostic/diagnostics.py" "$base"
    exit 1
  }
}
# Keep the exact worker-visible installed dependencies from initial admission.
# Build-time installation links additional generated artifacts in another public
# source tree and returns only the immutable compiled app for this source.
cd "$GITHUB_WORKSPACE/product"
step build_eve node scripts/build-eve.mjs
step build_frontend node apps/frontend/scripts/build.mjs --server-pages
step build_api node apps/api/scripts/build.mjs
step package_eve node scripts/package-eve.mjs
cp -a .output "$base/product/.output"
cd "$base/product"
step verify_attestation node --input-type=module -e "await (await import('./scripts/start-app.mjs')).readCompiledBuild(process.cwd())"
echo ordinary_enrollment > "$base/stage"
chmod 700 "$GITHUB_WORKSPACE" "$RUNNER_TEMP"
bash "$GITHUB_WORKSPACE/review/evidence/2257/full-daemon/run.sh" "$base"
