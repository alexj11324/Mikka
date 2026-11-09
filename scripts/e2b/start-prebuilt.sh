#!/bin/bash
# This starts before E2B freezes the ready template. Only anonymous processes
# enter the image: the application's normal owner-bound handoff comes later.
set -euo pipefail
mikka_start_phase=entry
mikka_start_mark() {
  mikka_start_phase="$1"
  printf 'mikka-prebuilt-start %s\n' "$mikka_start_phase"
}
# A failed command may contain private arguments. Retain only the last fixed
# phase and the original shell status; successful exec keeps the original PID.
trap 'mikka_start_status=$?; if [[ "$mikka_start_status" -ne 0 ]]; then printf "mikka-prebuilt-start-failed %s %s\n" "$mikka_start_phase" "$mikka_start_status" >&2; fi' EXIT
mikka_start_mark entry
[[ ! -e /home/user/.mikka/bootstrap.json && ! -e /home/user/.mikka/worker/device.json ]]
[[ ! -e /home/user/.mikka/preloaded.pid && ! -e /run/mikka-viewer/key ]]
mikka_start_mark preconditions_verified
# No viewer, anonymous worker, task or native process starts until both
# effective OUTPUT rules have been verified on this boot.
mikka_start_mark guard_prepare
python3 /opt/mikka/runtime/ingress-v1/guard.py prepare >/dev/null
mikka_start_mark guard_prepared
# E2B recreates /run after the install layer. Restore the root-owned fixed
# execution fence before the anonymous daemon or any native child can run.
mikka_start_mark control_install
python3 /opt/mikka/worker/packages/daemon/scripts/workspace-control-install.py
mikka_start_mark control_installed
if [[ -f /opt/mikka/computer/viewer-gateway.py ]]; then
  # /run is recreated by E2B's final boot; the install-layer directory is gone.
  install -d -m 710 -o root -g user /run/mikka-viewer
  PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/opt/mikka/computer \
    python3 /opt/mikka/computer/viewer-gateway.py >>/run/mikka-viewer/gateway.log 2>&1 &
fi
mikka_start_mark worker_exec
exec runuser -u user -- env \
  PATH="/opt/mikka/runtime/node/bin:/opt/mikka/runtime/harness-bin:$PATH" \
  HOME=/home/user \
  /opt/mikka/runtime/node/bin/node /opt/mikka/worker/packages/daemon/dist/cloud/cloud-worker.js --wait-bootstrap
