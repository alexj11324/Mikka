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
# Desktop preferences and application launches stay with this Bot's display.
export XDG_CONFIG_HOME="$profile/config"
mkdir -p "$XDG_CONFIG_HOME/pcmanfm/default"
if [[ ! -f "$XDG_CONFIG_HOME/pcmanfm/default/desktop-items-0.conf" ]]; then
cat > "$XDG_CONFIG_HOME/pcmanfm/default/desktop-items-0.conf" <<'EOF'
[*]
wallpaper_mode=color
desktop_bg=#343434
desktop_fg=#ffffff
desktop_shadow=#000000
show_wm_menu=1
show_trash=1
EOF
fi
Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp > /tmp/xvfb-$display.log 2>&1 &
for i in {1..50}; do xdpyinfo >/dev/null 2>&1 && break; sleep .1; done
xdpyinfo >/dev/null
openbox > /tmp/openbox-$display.log 2>&1 &
pcmanfm --desktop > /tmp/pcmanfm-$display.log 2>&1 &
tint2 > /tmp/tint2-$display.log 2>&1 &
# E2B publicly forwards even loopback TCP listeners. Use Unix VNC sockets;
# Chromium must have no unauthenticated CDP TCP listener.
socketdir=/home/user/.mikka/vnc
mkdir -p "$socketdir"
chmod 700 "$socketdir"
# Another controller (CUA) can move the pointer between VNC sessions. Always
# inject the client's coordinates even when they match x11vnc's cached input.
x11vnc -display "$DISPLAY" -rfbport 0 -rfbportv6 0 -no6 -unixsock "$socketdir/$display-control.sock" -forever -shared -nopw -always_inject > /tmp/vnc-$display.log 2>&1 &
x11vnc -display "$DISPLAY" -rfbport 0 -rfbportv6 0 -no6 -unixsock "$socketdir/$display-view.sock" -forever -shared -nopw -viewonly > /tmp/vnc-view-$display.log 2>&1 &
if [[ "${MIKKA_MANAGED_CHROME:-0}" != "1" ]]; then
chromium --no-sandbox --disable-gpu --disable-software-rasterizer --disable-dev-shm-usage --no-first-run --no-default-browser-check --password-store=basic --user-data-dir="$profile" --window-size=1280,800 about:blank > /tmp/chrome-$display.log 2>&1 &
fi
wait
