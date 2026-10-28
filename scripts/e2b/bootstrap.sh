#!/bin/bash
# Plain E2B base image. No Cua Spaces/FSL components or platform credentials.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq xvfb openbox x11vnc x11-utils x11-apps xdotool libxdo3 chromium python3-aiohttp docker.io bubblewrap xz-utils ffmpeg
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
# The hosted Codex adapter executes the official, version-pinned native CLI.
# Its authentication is provided later by the owner-bound broker, not baked
# into the image or imported from a developer's machine.
curl -fsSL https://registry.npmjs.org/@openai/codex/-/codex-0.163.0-linux-x64.tgz -o /tmp/mikka-codex.tgz
echo 'bb045a3acad8a202d085cc4033f1a8796af0d1021610c468edcf6033cb0a02f89591940796ef6444b2793e4b9f6d5f800468f2660230885749d0b089d0de9ef3  /tmp/mikka-codex.tgz' | sha512sum --check --strict
tar -xzf /tmp/mikka-codex.tgz -O package/vendor/x86_64-unknown-linux-musl/bin/codex > /usr/local/bin/codex
chmod 0755 /usr/local/bin/codex
rm /tmp/mikka-codex.tgz
/usr/local/bin/codex --version
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
