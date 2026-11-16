#!/usr/bin/env bash
# Prove the built image converts both gateway protocols to Chat Completions:
# run it beside deploy/litellm/mock-provider.py (a Chat-Completions-only
# provider) on a private Docker network and run the public gateway test
# tests/model-gateway-litellm.test.ts against it. Claude Code's Anthropic
# messages (with a tool call) and Codex's Responses must both complete and
# settle from the usage LiteLLM converted. Used by
# .github/workflows/cloudflare-litellm-image.yml before publication.
set -euo pipefail
image="$1"
network="litellm-proof-$$"
key="sk-$(openssl rand -hex 32)"
cleanup() { docker rm -f litellm-proof litellm-proof-provider > /dev/null 2>&1 || true; docker network rm "$network" > /dev/null 2>&1 || true; }
trap cleanup EXIT
docker network create "$network" > /dev/null
docker run -d --name litellm-proof-provider --network "$network" --cap-drop ALL --security-opt=no-new-privileges \
  -v "$PWD/deploy/litellm/mock-provider.py:/mock-provider.py:ro" --entrypoint python "$image" /mock-provider.py 9911 > /dev/null
docker run -d --name litellm-proof --network "$network" --cap-drop ALL --security-opt=no-new-privileges -p 127.0.0.1:4012:4000 \
  -e LITELLM_LOCAL_MODEL_COST_MAP=True -e LITELLM_MASTER_KEY="$key" "$image" > /dev/null
for _ in $(seq 1 90); do
  curl -fsS --noproxy '*' http://127.0.0.1:4012/health/liveliness > /dev/null 2>&1 && break
  sleep 2
done
curl -fsS --noproxy '*' http://127.0.0.1:4012/health/liveliness > /dev/null
output=$(MIKKA_LITELLM_TEST_URL=http://127.0.0.1:4012 MIKKA_LITELLM_TEST_MASTER_KEY="$key" \
  MIKKA_LITELLM_TEST_PROVIDER=http://litellm-proof-provider:9911/v1 NO_PROXY=127.0.0.1,localhost \
  corepack pnpm run --silent test:model-gateway-litellm 2>&1) || { printf '%s\n' "$output" | grep -E '^(not )?ok |^# ' >&2; exit 1; }
printf '%s\n' "$output" | grep -E '^ok |^# (pass|fail|skipped)'
# Both conversions ran: a skipped test is not a proof.
printf '%s\n' "$output" | grep -qx '# pass 2' && printf '%s\n' "$output" | grep -qx '# skipped 0'
echo "LiteLLM conversion proof passed"
