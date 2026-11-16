#!/usr/bin/env bash
set -euo pipefail
umask 077
project="$1/product"
base="$2"
mkdir -p "$base"/{material,harness,run/case,accounts,bin}
chmod 711 "$base"
git init -q "$base/product"
git -C "$base/product" fetch -q --depth 1 "file://$project" "$PUBLIC_SOURCE"
git -C "$base/product" checkout -q --detach FETCH_HEAD
test "$(git -C "$base/product" rev-parse HEAD)" = "$PUBLIC_SOURCE"
harness="$1/original/evidence/2257/local-provider"
cp "$harness"/{package.json,package-lock.json,provider.mjs} "$base/harness/"
cp "$1/original-review/evidence/2271/current-review/provider.mjs" "$base/harness/provider-current.mjs"
cp "$1/review/evidence/2257/full-daemon/provider-relay.mjs" "$base/harness/relay.mjs"
(cd "$base/harness" && npm ci --omit=optional --ignore-scripts --no-audit --no-fund >/dev/null)
(cd "$base/product" && umask 022 && ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --prefer-offline --frozen-lockfile --ignore-scripts >/dev/null)
curl -fsSL --retry 2 'https://huggingface.co/bartowski/SmolLM2-135M-Instruct-GGUF/resolve/d255afaffd3441b95abca9b5cc4c819b93f66936/SmolLM2-135M-Instruct-Q4_K_M.gguf' -o "$base/material/model.gguf"
echo "2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d  $base/material/model.gguf" | sha256sum -c -
if ! command -v setfacl >/dev/null; then sudo apt-get -qq update; sudo apt-get install -y --no-install-recommends acl; fi
mkdir -p "$base"/{device,model-state}
for worker in mikka-e-device mikka-e-model; do sudo useradd --system --user-group --no-create-home "$worker"; done
for name in codex claude_code; do node "$base/product/packages/daemon/harness/cli.mjs" "$base/device/harness" "$name" >/dev/null; done
sudo chown -R mikka-e-device:mikka-e-device "$base/device"
chmod 700 "$HOME"
sudo chmod 710 "$base/device"
sudo setfacl -m "u:$(id -un):rx" "$base/device"
sudo setfacl -R -m "u:$(id -un):rX" "$base/device/harness"
sudo chown "$(id -un):mikka-e-model" "$base/model-state"
chmod 2770 "$base/model-state"
chmod 700 "$base/run" "$base/accounts"
find "$base/product" -type d -name node_modules -prune -o -type d -exec chmod a+rx {} +
find "$base/product" -type d -name node_modules -prune -o -type f -exec chmod a+r {} +
chmod -R a+rX "$base/harness" "$base/material"
for name in device-launch model-launch runtime-prepare; do
  install -m 755 "$base/product/scripts/acceptance/desktop-delivery/$name.sh" "$base/bin/$name"
done
chmod 755 "$base/bin"
mkdir -p "$base/product/.cache/e-codex-actual"
cp "$1/review/evidence/2257/full-daemon/full-daemon.mts" "$base/product/.cache/e-codex-actual/full-daemon.mts"
python3 - "$base/product/.cache/e-codex-actual/full-daemon.mts" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]);s=p.read_text()
line=[l for l in s.splitlines() if 'if(native){const {withPackagedDeliveryWindow}' in l]
assert len(line)==1
p.write_text(s.replace(line[0], "  record('independent_registration_and_native_discovery');"))
PY
