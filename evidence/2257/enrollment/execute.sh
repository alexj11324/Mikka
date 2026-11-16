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
# Observe the real public package paths that the service UID could not read.
python3 - "$base" <<'PYTHON'
from pathlib import Path
import re,sys
p=Path(sys.argv[1])
raw=(p/'run/case/daemon.log').read_text()
passed='Invalid registration token' in raw
candidates={v.rstrip("':.,") for v in re.findall(r'[/][^\s]+?package[.]json',raw)}
for v in sorted(candidates):
 f=Path(v)
 if f.is_relative_to(p/'product') and f.is_file():
  print('Public package location:',f.relative_to(p/'product'),'mode',oct(f.stat().st_mode&0o777),'hardLinks',f.stat().st_nlink)
print('Cold device CLI reached validation:',passed)
if not passed and 'ERR_INVALID_PACKAGE_CONFIG' not in raw: raise RuntimeError('unexpected preflight error class')
PYTHON
# A fresh copy install prevents chmod on hardlinked store/original-checkout
# inodes. Enumerate and normalize only copies in this dedicated public tree.
cd "$base/product"
# Do this group before network isolation in production; here packages are
# already in the local store and the rerun is deliberately offline.
find . -type d -name node_modules -prune -exec rm -rf -- {} +
(umask 022; ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --offline --frozen-lockfile --ignore-scripts --package-import-method=copy > "$base/copy-install.log" 2>&1)
find "$base/product" -type d -name node_modules -prune -exec chmod -R a+rX -- {} +
rc=0
"$base/bin/device-launch" "$(command -v node)" --import tsx packages/daemon/bin/mikka.ts daemon login --registration-token-stdin --server https://127.0.0.1:3859/mikka --data-dir "$base/device" </dev/null > "$base/run/case/after-loader.log" 2>&1 || rc=$?
test "$rc" = 1
rg -Fq 'Invalid registration token' "$base/run/case/after-loader.log"
echo "Repaired device CLI consumed expected validation fixture"
mv "$base/run/case/daemon.log" "$base/run/case/before-loader.log"
export MIKKA_BUILD_REVISION="$MIKKA_TEST_DEPLOYMENT_SHA"
step() {
  echo "Verification phase $1"
  echo "$1" > "$base/stage"
  shift
  "$@" > "$base/build.log" 2>&1 || {
    python3 "$GITHUB_WORKSPACE/review/evidence/2257/enrollment/classify.py" "$base"
    exit 1
  }
}
# Keep the exact worker-visible installed dependencies from initial admission.
# Build-time installation links additional generated artifacts in another public
# source tree and returns only the immutable compiled app for this source.
cd "$GITHUB_WORKSPACE/product"
step build_frontend node apps/frontend/scripts/build.mjs --server-pages
step build_api node apps/api/scripts/build.mjs
mkdir -p apps/eve
cp -a "$base/product/apps/eve/.output" apps/eve/.output
step package_eve node scripts/package-eve.mjs
cp -a .output "$base/product/.output"
cd "$base/product"
step verify_attestation node --input-type=module -e "await (await import('./scripts/start-app.mjs')).readCompiledBuild(process.cwd())"
echo ordinary_enrollment > "$base/stage"
chmod 700 "$GITHUB_WORKSPACE" "$RUNNER_TEMP"
bash "$GITHUB_WORKSPACE/review/evidence/2257/full-daemon/run.sh" "$base"
