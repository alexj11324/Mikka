#!/bin/bash
# Infrastructure only: the socket is restricted to the trusted runner group.
# The desktop user has no sudo, runner-group or docker-group membership. All hosted tasks
# must be launched with an explicit network and filesystem isolation policy.
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then exit 1; fi
# Per-sandbox SSH host keys; the template image ships none.
if command -v ssh-keygen >/dev/null; then ssh-keygen -A >/dev/null; fi
install -d -m 710 -o root -g mikka-runner /run/mikka-container
install -d -m 700 /workspace/.mikka-docker
umask 077
exec 9>/run/mikka-container/daemon.lock
flock -n 9 || exit 0
pidfile=/run/mikka-container/dockerd.pid
if [ -s "$pidfile" ]; then
  read -r prior_pid < "$pidfile"
  if [[ "$prior_pid" =~ ^[0-9]+$ ]] && kill -0 "$prior_pid" 2>/dev/null; then exit 1; fi
  rm -f "$pidfile"
fi
exec dockerd --group mikka-runner --iptables=false --ip-masq=false --bridge=none --storage-driver=vfs \
  --data-root /workspace/.mikka-docker --pidfile /run/mikka-container/dockerd.pid \
  --host unix:///run/mikka-container/docker.sock \
  >>/run/mikka-container/daemon.log 2>&1
