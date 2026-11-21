#!/usr/bin/env bash
set -euo pipefail
base=${E_DESKTOP_BASE:-}
[[ "$base" =~ ^/tmp/mikka-desktop-delivery\.[[:alnum:]]{8}$ ]] || exit 0
for worker in mikka-e-device mikka-e-model; do
  if [[ -f "$base/accounts/created-$worker" ]] && uid=$(id -u "$worker" 2>/dev/null) && [[ "$uid" == "$(cat "$base/accounts/created-$worker")" ]]; then
    sudo pkill -TERM -u "$uid" || true
    for i in {1..10}; do pgrep -u "$uid" >/dev/null || break; sleep .2; done
    sudo pkill -KILL -u "$uid" || true
    sudo userdel "$worker"
  fi
done
sudo rm -rf -- "$base"
