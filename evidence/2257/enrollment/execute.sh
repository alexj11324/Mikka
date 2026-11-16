#!/usr/bin/env bash
set -euo pipefail
base=$1
umask 077
cd "$base/product"
export RAYON_NUM_THREADS=2 UV_THREADPOOL_SIZE=2 NODE_OPTIONS=--max-old-space-size=3072
sudo install -d -m 700 -o mikka-e-device -g mikka-e-device "$base/device/home"
sudo -u mikka-e-device bash -c 'test -x "$1" && test -r "$2/node_modules/tsx/package.json" && test -r "$2/packages/daemon/bin/mikka.ts"' _ "$(command -v node)" "$PWD" && echo worker-can-read-CLI-and-tsx
# The blank input is intentionally invalid. Only a correctly loaded entrypoint
# can reach its normal validation. No raw CLI output is printed.
rc=0; "$base/bin/device-launch" "$(command -v node)" --import tsx packages/daemon/bin/mikka.ts daemon login --registration-token-stdin --server https://127.0.0.1:3859/mikka --data-dir "$base/device" </dev/null >"$base/run/case/daemon.log" 2>&1 || rc=$?
echo "inputOnlyDiagnosticExit=$rc"
python3 "$GITHUB_WORKSPACE/review/evidence/2257/enrollment/classify.py" "$base"
node scripts/build-eve.mjs > "$base/build.log" 2>&1
node apps/frontend/scripts/build.mjs --server-pages >> "$base/build.log" 2>&1
node apps/api/scripts/build.mjs >> "$base/build.log" 2>&1
node scripts/package-eve.mjs >> "$base/build.log" 2>&1
chmod 700 "$GITHUB_WORKSPACE" "$RUNNER_TEMP"
bash "$GITHUB_WORKSPACE/review/evidence/2257/full-daemon/run.sh" "$base"
