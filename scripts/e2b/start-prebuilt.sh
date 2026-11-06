#!/bin/bash
# This starts before E2B freezes the ready template. Only anonymous processes
# enter the image: the application's normal owner-bound handoff comes later.
set -euo pipefail
[[ ! -e /home/user/.mikka/bootstrap.json && ! -e /home/user/.mikka/worker/device.json ]]
[[ ! -e /home/user/.mikka/preloaded.pid && ! -e /run/mikka-viewer/key ]]
if [[ -f /opt/mikka/computer/viewer-gateway.py ]]; then
  # /run is recreated by E2B's final boot; the install-layer directory is gone.
  install -d -m 710 -o root -g user /run/mikka-viewer
  PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/opt/mikka/computer \
    python3 /opt/mikka/computer/viewer-gateway.py >>/run/mikka-viewer/gateway.log 2>&1 &
fi
exec runuser -u user -- env \
  PATH="/opt/mikka/runtime/node/bin:/opt/mikka/runtime/harness-bin:$PATH" \
  HOME=/home/user \
  /opt/mikka/runtime/node/bin/node /opt/mikka/worker/packages/daemon/dist/cloud/cloud-worker.js --wait-bootstrap
