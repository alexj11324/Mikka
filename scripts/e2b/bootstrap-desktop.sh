#!/bin/bash
# The bot's computer: E2B's official desktop template (decision 2026-11-01-2331)
# plus Mikka's viewer gateway, lease driver and desktop driver.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# Runs use no Docker (decision 2026-11-01-1312); docker.io stays for the bot computer.
apt-get install -y -qq python3-aiohttp docker.io
# Keep the existing browser launcher path while using the inherited Chrome binary.
ln -s /usr/bin/google-chrome /usr/bin/chromium
# Preserve only upstream desktop defaults; displays never copy mutable home data.
install -D -m 0644 /home/user/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml /opt/mikka/computer/desktop-config/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml
install -D -m 0644 /home/user/.config/autostart/screensaver.desktop /opt/mikka/computer/desktop-config/autostart/screensaver.desktop
curl -fsSL https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.38.0/cua-driver-rs-0.38.0-linux-x86_64-binary.tar.gz -o /tmp/cua-driver.tar.gz
echo '31ab9709dd91ce73677e49b9f3e75c6f0d3e4d9625c286c9e58262bfbea698dd  /tmp/cua-driver.tar.gz' | sha256sum --check --strict
tar -xzf /tmp/cua-driver.tar.gz -C /opt/mikka/computer
rm /tmp/cua-driver.tar.gz
/opt/mikka/computer/cua-driver --version
