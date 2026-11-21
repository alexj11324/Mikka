#!/usr/bin/env bash
set -euo pipefail
image="${1:?The built task image is required}"

docker run --rm --network none --cap-drop ALL --security-opt=no-new-privileges \
  --user 1000:1000 --entrypoint sh "$image" -ec '
    test -w /workspace
    test -x /usr/local/bin/sandbox-shim
    test -x /usr/bin/unshare
    test -x /usr/bin/setpriv
    /usr/bin/python3 -I -c "import ast, os, signal, sys; assert os.pidfd_open and signal.pidfd_send_signal; [ast.parse(open(p).read()) for p in sys.argv[1:]]" /opt/mikka/task-sandbox/*.py
    test -s /opt/mikka/worker/packages/daemon/dist/cloud/cloud-worker.js
    test -r /opt/mikka/worker/.mikka-original-cli.json
    node --version
    git --version
    claude --version
    codex --version
  '

docker run --rm --network none --cap-add NET_ADMIN \
  --mount "type=bind,source=$PWD/cloudflare/task-sandbox/review-guest-image.test.py,target=/opt/mikka/review-guest-image.test.py,readonly" \
  --entrypoint sh "$image" -ec '
    export PYTHONDONTWRITEBYTECODE=1
    python3 -I /opt/mikka/runtime/ingress-v1/guard.py prepare-cloudflare
    python3 -I /opt/mikka/task-sandbox/workspace-control-install.py --cloudflare-task
    test "$(stat -c %u:%g:%a /run/mikka-review-control/machine.lock)" = 0:1000:660
    python3 -I /opt/mikka/runtime/ingress-v1/guard.py verify
    python3 -c "import sys;sys.path[:0]=[\"/opt/mikka/preview\",\"/opt/mikka/runtime/preview-python-3.14.0\"];import aiohttp,preview_firewall;assert aiohttp.__version__ == \"3.14.0\""
    python3 -I /opt/mikka/review-guest-image.test.py
  '
