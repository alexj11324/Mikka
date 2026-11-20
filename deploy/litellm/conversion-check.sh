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
# Any failing command names itself; the master key is never part of a command line.
trap 'echo "conversion proof failed at line $LINENO: $BASH_COMMAND" >&2' ERR
network="litellm-proof-$$"
key="sk-$(openssl rand -hex 32)"
cleanup() { docker rm -f litellm-proof litellm-proof-provider > /dev/null 2>&1 || true; docker network rm "$network" > /dev/null 2>&1 || true; }
trap cleanup EXIT
docker network create "$network" > /dev/null
docker run -d --name litellm-proof-provider --network "$network" --cap-drop ALL --security-opt=no-new-privileges \
  -v "$(cd "$(dirname "$0")" && pwd)/mock-provider.py:/mock-provider.py:ro" --entrypoint python "$image" /mock-provider.py 9911 > /dev/null
docker run -d --name litellm-proof --network "$network" --cap-drop ALL --security-opt=no-new-privileges -p 127.0.0.1:4012:4000 \
  -e LITELLM_LOCAL_MODEL_COST_MAP=True -e LITELLM_MASTER_KEY="$key" \
  -e AI_GATEWAY_API_KEY=sk-person-key -e VERCEL_AI_GATEWAY_API_BASE=http://litellm-proof-provider:9911/v1 "$image" > /dev/null
for _ in $(seq 1 90); do
  curl -fsS --noproxy '*' http://127.0.0.1:4012/health/liveliness > /dev/null 2>&1 && break
  sleep 2
done
curl -fsS --noproxy '*' http://127.0.0.1:4012/health/liveliness > /dev/null
# TAP regardless of Node's default reporter, so the counts below are exact.
output=$(NODE_OPTIONS=--test-reporter=tap MIKKA_LITELLM_TEST_URL=http://127.0.0.1:4012 MIKKA_LITELLM_TEST_MASTER_KEY="$key" \
  MIKKA_LITELLM_TEST_PROVIDER=http://litellm-proof-provider:9911/v1 NO_PROXY=127.0.0.1,localhost \
  corepack pnpm run --silent test:model-gateway-litellm 2>&1) || {
  # Show why, never the generated key; then the converter's own log tail.
  printf '%s\n' "$output" | sed "s/$key/<master-key>/g" | tail -n 60 >&2
  docker logs --tail 40 litellm-proof 2>&1 | sed "s/$key/<master-key>/g" >&2
  exit 1
}
printf '%s\n' "$output" | grep -E '^ok |^# (pass|fail|skipped)'
# Both BYOK conversions and both quota wildcard bridges ran: no skipped proof.
printf '%s\n' "$output" | grep -qx '# pass 4' && printf '%s\n' "$output" | grep -qx '# skipped 0'
echo "LiteLLM conversion proof passed"
