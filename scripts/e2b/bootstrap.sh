#!/bin/bash
# Plain E2B base image. No Cua Spaces/FSL components or platform credentials.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq xvfb openbox x11vnc x11-utils x11-apps xdotool libxdo3 chromium python3-aiohttp docker.io bubblewrap
mkdir -p /opt/mikka/computer /workspace
curl -fsSL https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.38.0/cua-driver-rs-0.38.0-linux-x86_64-binary.tar.gz -o /tmp/cua-driver.tar.gz
echo '31ab9709dd91ce73677e49b9f3e75c6f0d3e4d9625c286c9e58262bfbea698dd  /tmp/cua-driver.tar.gz' | sha256sum --check --strict
tar -xzf /tmp/cua-driver.tar.gz -C /opt/mikka/computer
rm /tmp/cua-driver.tar.gz
/opt/mikka/computer/cua-driver --version
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
