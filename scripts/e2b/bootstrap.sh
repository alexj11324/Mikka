#!/bin/bash
# Mikka worker on top of an official E2B template (desktop, claude or codex;
# decision 2026-11-01-2335). No platform credentials. Everything runs as the
# template's default user `user`: no extra users, no sandbox, sudo unchanged.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq xz-utils git gh curl
# Native worker and test tooling require Node 24; use a pinned official build.
curl -fsSL https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz -o /tmp/mikka-node.tar.xz
echo '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647  /tmp/mikka-node.tar.xz' | sha256sum --check --strict
# Tar overlays retain incompatible nested npm dependencies from the base image.
rm -rf /usr/local/lib/node_modules/npm
tar -xJf /tmp/mikka-node.tar.xz -C /usr/local --strip-components=1
rm /tmp/mikka-node.tar.xz
corepack enable
mkdir -p /opt/mikka/computer /workspace
install -d -m 710 -o root -g user /run/mikka-viewer
# A public template must not ship SSH host private keys: every sandbox would
# share them. Keys are generated per sandbox at boot (start-container-runtime.sh).
rm -f /etc/ssh/ssh_host_*
