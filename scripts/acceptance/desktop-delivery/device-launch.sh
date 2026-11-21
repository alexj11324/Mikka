#!/usr/bin/env bash
set -euo pipefail
base=$(dirname "$(dirname "$(realpath "$0")")")
program=$1
shift
cd "$base/product"
# The CLI receives a one-use grant on stdin. Shell/forge/model credentials,
# Electron's profiles and the private UI checkout are outside its authority.
exec sudo -n -u mikka-e-device -- env -i PATH="$PATH" HOME="$base/device/home" LANG=C.UTF-8 \
  SSL_CERT_FILE="$base/device/ca.pem" NODE_EXTRA_CA_CERTS="$base/device/ca.pem" \
  MIKKA_TEST_MODE=1 CI=true GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL="$base/device/gitconfig" \
  "$program" "$@"
