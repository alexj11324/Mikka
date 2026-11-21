#!/usr/bin/env bash
# Start the image with no network and no capabilities, wait until it is live,
# and check that it refuses a call without the master key. Used by
# .github/workflows/cloudflare-litellm-image.yml before publication.
set -euo pipefail
image="$1"
docker run -d --name litellm-check --network none --cap-drop ALL --security-opt=no-new-privileges \
  -e LITELLM_LOCAL_MODEL_COST_MAP=True -e LITELLM_MASTER_KEY="$(openssl rand -hex 32)" "$image" > /dev/null
trap 'docker rm -f litellm-check > /dev/null' EXIT
docker exec litellm-check python -c '
import json, time, urllib.error, urllib.request
base = "http://127.0.0.1:4000"
for _ in range(90):
    try:
        urllib.request.urlopen(base + "/health/liveliness", timeout=2).read()
        break
    except Exception:
        time.sleep(2)
else:
    raise SystemExit("LiteLLM did not become live")
request = urllib.request.Request(base + "/v1/messages", data=b"{}", method="POST", headers={"content-type": "application/json"})
try:
    urllib.request.urlopen(request, timeout=10)
    raise SystemExit("LiteLLM accepted a call without the master key")
except urllib.error.HTTPError as error:
    assert error.code == 401, error.code
print("offline LiteLLM check passed")
'
