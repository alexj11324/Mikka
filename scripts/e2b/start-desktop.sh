#!/bin/bash
set -euo pipefail
# Operator-only entry point; never expose this script as a model tool.
display=${1:?display number required}
[[ "$display" =~ ^[1-9][0-9]{0,2}$ ]] || exit 2
export DISPLAY=:$display
exec 9>"/tmp/mikka-desktop-$display.lock"
flock -n 9 || exit 0
profile=/home/user/.mikka/profiles/$display
mkdir -p "$profile"
chmod 700 "$profile"
Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp > /tmp/xvfb-$display.log 2>&1 &
for i in {1..50}; do xdpyinfo >/dev/null 2>&1 && break; sleep .1; done
xdpyinfo >/dev/null
openbox > /tmp/openbox-$display.log 2>&1 &
# Raw VNC/CDP are loopback only. The authenticated gateway is the sole ingress.
x11vnc -display "$DISPLAY" -localhost -rfbport "$((5900+display))" -forever -shared -nopw > /tmp/vnc-$display.log 2>&1 &
x11vnc -display "$DISPLAY" -localhost -rfbport "$((6900+display))" -forever -shared -nopw -viewonly > /tmp/vnc-view-$display.log 2>&1 &
chromium --no-sandbox --disable-gpu --disable-software-rasterizer --disable-dev-shm-usage --no-first-run --no-default-browser-check --password-store=basic --user-data-dir="$profile" --remote-debugging-address=127.0.0.1 --remote-debugging-port="$((9200+display))" --window-size=1280,800 about:blank > /tmp/chrome-$display.log 2>&1 &
wait
