#!/usr/bin/env bash
# The official package retains the exact selected private UI while main may advance.
set -euo pipefail
umask 077
stage=CHECK_INPUTS
trap 'echo "::error::OFFICIAL_UI_${stage}_FAILED" >&2' ERR
[[ "$EXPECTED_OVERLAY_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ -n "${HOSTED_UI_READ_KEY:-}" ]]
stage=SETUP_AUTH
key_dir=$(mktemp -d)
trap 'rm -rf -- "$key_dir"' EXIT
printf '%s\n' "$HOSTED_UI_READ_KEY" > "$key_dir/key"
unset HOSTED_UI_READ_KEY
known_hosts="$PWD/scripts/acceptance/desktop-delivery/github-known-hosts"
# Match the pinned release checkout's RSA host identity and fail closed on rotation.
test -r "$known_hosts"
printf -v GIT_SSH_COMMAND 'ssh -F /dev/null -i %q -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile=%q' "$key_dir/key" "$known_hosts"
export GIT_SSH_COMMAND
stage=INIT_REPOSITORY
git init --quiet .hosted-ui 2>/dev/null
stage=FETCH_FIXED_SHA
git -C .hosted-ui fetch --quiet --no-tags --depth=1 git@github.com:alexj11324/mikka-hosted-ui.git "$EXPECTED_OVERLAY_SHA" 2>/dev/null
stage=CHECKOUT_FIXED_SHA
git -C .hosted-ui checkout --quiet --detach FETCH_HEAD 2>/dev/null
test "$(git -C .hosted-ui rev-parse HEAD 2>/dev/null)" = "$EXPECTED_OVERLAY_SHA"
stage=VERIFY_MAIN_ANCESTRY
node --input-type=module -e "import { verifyOverlayMain } from './scripts/cloudflare-native-oci.mjs'; try { verifyOverlayMain('.hosted-ui', process.env.EXPECTED_OVERLAY_SHA) } catch { process.exitCode = 1 }"
