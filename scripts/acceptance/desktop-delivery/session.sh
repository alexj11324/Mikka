#!/usr/bin/env bash
set -euo pipefail
base=$1
umask 077
socat TCP4-LISTEN:15471,bind=127.0.0.1,reuseaddr,fork "UNIX-CONNECT:$base/run/postgres.sock" &
bridge=$!
trap 'kill "$bridge" 2>/dev/null || true' EXIT
dbus-run-session -- bash -euc '
  printf "%s" "disposable-desktop-delivery-keyring" | gnome-keyring-daemon --unlock --components=secrets
  xvfb-run -a "$1/bin/run" "$1"
' desktop "$base"
