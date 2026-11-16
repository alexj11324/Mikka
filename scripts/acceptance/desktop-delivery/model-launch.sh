#!/usr/bin/env bash
set -euo pipefail
base=$(dirname "$(dirname "$(realpath "$0")")")
# The sole inherited credential is the generated key of this local CPU provider.
# Do not expose its value in argv or the caller's environment to a model process.
exec sudo -n --preserve-env=E_LOOPBACK_KEY -u mikka-e-model -- \
  env -u SUDO_COMMAND -u SUDO_UID -u SUDO_GID -u SUDO_USER \
  PATH="$PATH" HOME="$base/model-state/home" LANG=C.UTF-8 E_CODEX_QA="$base/model-state" \
  E_WEIGHT_FILE="$base/material/model.gguf" NODE_EXTRA_CA_CERTS="$base/model-state/ephemeral-ca.pem" \
  SSL_CERT_FILE="$base/model-state/ephemeral-ca.pem" "$@"
