#!/usr/bin/env bash
# Export only Git objects from the public repository after the earlier official receipt is retained.
set -euo pipefail
umask 077
test "$GITHUB_REPOSITORY" = alexj11324/Mikka
test "$GITHUB_REF" = refs/heads/main
test "$GITHUB_WORKFLOW_SHA" = "$GITHUB_SHA"
base=$(mktemp -d /tmp/mikka-desktop-delivery.XXXXXXXX)
chmod 711 "$base"
echo "E_DESKTOP_BASE=$base" >> "$GITHUB_ENV"
stage() { echo "Desktop delivery preparation: $1"; printf '%s\n' "$1" > "$base/stage"; }
stage public-checkout
source="$GITHUB_WORKSPACE"
git init -q "$base/product"
git -C "$base/product" fetch -q --depth 1 "file://$source" "$GITHUB_SHA"
git -C "$base/product" checkout -q --detach FETCH_HEAD
test "$(git -C "$base/product" rev-parse HEAD)" = "$GITHUB_SHA"
product="$base/product"
mkdir -p "$base"/{material,harness,run/case,accounts,bin}
# These are reviewed, immutable objects from this repository's original E evidence.
delivery=b80e31e5f803c52a518f98e87f1b5f7fbfca6d51
stage pinned-public-materials
df -h /tmp
for evidence in "$delivery" 46d60aa6802ef48600fbe2fa3d48015b14f6d50b 0f109ccec64515a7196d81eed656a29c9f0c75c9; do
  if ! git -C "$source" cat-file -e "$evidence^{commit}"; then
    git -C "$source" fetch -q --depth 1 origin "$evidence"
  fi
done
historical=46d60aa6802ef48600fbe2fa3d48015b14f6d50b
for file in package.json package-lock.json provider.mjs; do
  git -C "$source" show "$historical:evidence/2257/local-provider/$file" > "$base/harness/$file"
done
git -C "$source" show '0f109ccec64515a7196d81eed656a29c9f0c75c9:evidence/2271/current-review/provider.mjs' > "$base/harness/provider-current.mjs"
git -C "$source" show "$delivery:evidence/2257/full-daemon/provider-relay.mjs" > "$base/harness/relay.mjs"
git -C "$source" show "$delivery:evidence/2257/full-daemon/run.sh" > "$base/bin/run"
chmod 700 "$base/bin/run"
mkdir -p "$product/.cache/e-codex-actual"
git -C "$source" show "$delivery:evidence/2257/full-daemon/full-daemon.mts" > "$product/.cache/e-codex-actual/full-daemon.mts"
echo "$delivery" > "$base/driver.revision"
(cd "$base/harness" && npm ci --omit=optional --ignore-scripts --no-audit --no-fund > "$base/model-install.log")
curl -fsSL --retry 2 'https://huggingface.co/bartowski/SmolLM2-135M-Instruct-GGUF/resolve/d255afaffd3441b95abca9b5cc4c819b93f66936/SmolLM2-135M-Instruct-Q4_K_M.gguf' -o "$base/material/model.gguf"
echo "2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d  $base/material/model.gguf" | sha256sum -c -
stage exact-compiled-community-image
(
  cd "$product"
  # Extract the actual build used by the earlier checks, including its independent
  # compiled test-environment attestation. No desktop or private source is copied.
  container=$(docker create "$MIKKA_IMAGE")
  trap 'docker rm -v "$container" >/dev/null' EXIT
  test "$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container")" = "$GITHUB_SHA"
  docker inspect -f '{{.Image}}' "$container" > "$base/image.id"
  # /app contains the image's complete .output plus a small set of scripts and migrations.
  # Preserve bundled runtime assets and internal symlinks, including Eve's own resources.
  docker cp "$container:/app" .output
  test "$(jq -r .revision .output/eve/mikka-eve-build.json)" = "$GITHUB_SHA"
  MIKKA_TEST_DEPLOYMENT_SHA="$GITHUB_SHA" node --input-type=module \
    -e "await (await import('./scripts/start-app.mjs')).readCompiledBuild(process.cwd())"
  stage public-source-dependencies
  # A warm pnpm store can contain runner-only files. Copy this public lock's
  # packages before changing permissions so no shared cache inode is touched.
  umask 022
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --package-import-method=copy --prefer-offline --frozen-lockfile --ignore-scripts > "$base/product-install.log" 2>&1
)

stage worker-identities
for tool in certutil socat setfacl; do
  if ! command -v "$tool" >/dev/null; then
    sudo apt-get -qq update
    sudo apt-get install -y --no-install-recommends acl libnss3-tools socat
    break
  fi
done
for worker in mikka-e-device mikka-e-model; do
  sudo useradd --system --user-group --no-create-home "$worker"
  id -u "$worker" > "$base/accounts/created-$worker"
done
mkdir -p "$base"/{device,model-state}
stage pinned-native-clis
for harness in codex claude_code; do
  node "$product/packages/daemon/harness/cli.mjs" "$base/device/harness" "$harness" > "$base/$harness-install.log"
done
sudo chown -R mikka-e-device:mikka-e-device "$base/device"
# GitHub runner users have dedicated /home/runner, a per-job container and fresh identities.
# No other user on this ephemeral host may traverse the runner's session or releases.
chmod 700 "$HOME"
sudo chmod 710 "$base/device"
sudo setfacl -m "u:$(id -un):rx" "$base/device"
sudo setfacl -R -m "u:$(id -un):rX" "$base/device/harness"
sudo chown "$(id -un):mikka-e-model" "$base/model-state"
chmod 2770 "$base/model-state"
# Only these public copies and pinned model materials are readable by workers.
chmod 700 "$base/run" "$base/accounts"
# Grant read and traverse access to this disposable copy only. chmod does not
# dereference symlinks during traversal; deployed product and private assets have separate roots.
chmod -R a+rX "$product"
chmod -R a+rX "$base/harness" "$base/material"
for file in device-launch model-launch runtime-prepare; do
  install -m 755 "$product/scripts/acceptance/desktop-delivery/$file.sh" "$base/bin/$file"
done
chmod 755 "$base/bin"
stage prepared
