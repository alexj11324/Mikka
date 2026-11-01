#!/bin/bash
# Plain E2B base image. No Cua Spaces/FSL components or platform credentials.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq xvfb openbox x11vnc x11-utils x11-apps xdotool libxdo3 chromium python3-aiohttp docker.io bubblewrap xz-utils ffmpeg git gh
# Native worker and test tooling require Node 24; use a pinned official build.
curl -fsSL https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz -o /tmp/mikka-node.tar.xz
echo '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647  /tmp/mikka-node.tar.xz' | sha256sum --check --strict
tar -xJf /tmp/mikka-node.tar.xz -C /usr/local --strip-components=1
rm /tmp/mikka-node.tar.xz
corepack enable
# The hosted control process is distinct from the desktop/task account.
# Docker socket access is restricted to its dedicated infrastructure group.
groupadd --system mikka-runner
useradd --system --create-home --gid mikka-runner --shell /usr/sbin/nologin mikka-runner
mkdir -p /opt/mikka/computer /workspace
curl -fsSL https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.38.0/cua-driver-rs-0.38.0-linux-x86_64-binary.tar.gz -o /tmp/cua-driver.tar.gz
echo '31ab9709dd91ce73677e49b9f3e75c6f0d3e4d9625c286c9e58262bfbea698dd  /tmp/cua-driver.tar.gz' | sha256sum --check --strict
tar -xzf /tmp/cua-driver.tar.gz -C /opt/mikka/computer
rm /tmp/cua-driver.tar.gz
/opt/mikka/computer/cua-driver --version
# The hosted Codex CLI is installed after the worker source (build-template.py)
# from packages/daemon/harness/pins.json, the same pins a device daemon uses.
# Agent commands run as user; infrastructure and viewer grants stay root-only.
install -d -m 700 /run/mikka-viewer
# E2B's envd control-plane credential remains server-side and can still launch
# infrastructure as root. The task's OS user must not have sudo access.
rm -f /etc/sudoers.d/user
gpasswd -d user sudo >/dev/null 2>&1 || true
# The base image also grants sudo through an image-specific include. Removing
# only one include is insufficient. Only root infrastructure may execute sudo.
chown root:root /usr/bin/sudo
chmod 0700 /usr/bin/sudo
# A public template must not ship SSH host private keys: every sandbox would
# share them. Keys are generated per sandbox at boot (start-container-runtime.sh).
rm -f /etc/ssh/ssh_host_*
