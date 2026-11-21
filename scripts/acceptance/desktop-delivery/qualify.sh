#!/usr/bin/env bash
# Run the complete window/API/worker group on loopback only. A runner-owned
# Unix socket exposes the same disposable PG17 instance inside that namespace.
set -euo pipefail
umask 077
base=$(realpath "${E_DESKTOP_BASE:?}")
[[ "$base" =~ ^/tmp/mikka-desktop-delivery\.[[:alnum:]]{8}$ ]]
test "$(git -C "$base/product" rev-parse HEAD)" = "$GITHUB_SHA"
test "$GITHUB_REF" = refs/heads/main
test "$GITHUB_WORKFLOW_SHA" = "$GITHUB_SHA"
archive="$GITHUB_WORKSPACE/apps/desktop/release-acceptance"
test -f "$archive/linux-unpacked/resources/app.asar"
chmod 700 "$GITHUB_WORKSPACE" "$RUNNER_TEMP"
for worker in mikka-e-device mikka-e-model; do
  test "$(id -u "$worker")" = "$(cat "$base/accounts/created-$worker")"
  sudo -n -u "$worker" -- test ! -r "$archive/linux-unpacked/resources/app.asar"
  sudo -n -u "$worker" -- test ! -x "$GITHUB_WORKSPACE/.hosted-ui"
  sudo -n -u "$worker" -- test ! -x "$RUNNER_TEMP"
  sudo -n -u "$worker" -- test ! -x "$HOME"
  sudo -n -u "$worker" -- test ! -r /var/run/docker.sock
done
echo same-disposable-postgres > "$base/stage"
reader=$(docker compose ps -q postgres)
test "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$reader")" = mikka-selfhost-ci
test "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$reader")" = postgres
version=$(docker exec "$reader" psql -XAt -U mikka -d postgres -c 'SHOW server_version_num')
[[ "$version" =~ ^17[0-9]{4}$ ]]
docker exec "$reader" postgres --version > "$base/run/case/pg.version"
secret="$base/accounts/database-password"
openssl rand -hex 28 > "$secret"
# Both names must be new on this existing instance.
{ printf 'CREATE ROLE e2e LOGIN PASSWORD '\'''; tr -d '\n' < "$secret"; printf "';\nCREATE DATABASE mikka_e2e OWNER e2e;\n"; } \
  | docker exec -i "$reader" psql -Xqv ON_ERROR_STOP=1 -U mikka -d postgres
address=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}' "$reader" | sed '/^$/d')
[[ "$address" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
socket="$base/run/postgres.sock"
socat "UNIX-LISTEN:$socket,mode=0600,fork" "TCP4:$address:5432" &
bridge=$!
trap 'kill "$bridge" 2>/dev/null || true' EXIT
for n in {1..30}; do [[ -S "$socket" ]] && break; sleep .1; done
test -S "$socket"
echo offline-installed-window > "$base/stage"
sudo env -i PATH="$PATH" HOME="$HOME" USER="$(id -un)" LANG=C.UTF-8 \
  GITHUB_REPOSITORY="$GITHUB_REPOSITORY" GITHUB_SHA="$GITHUB_SHA" GITHUB_REF="$GITHUB_REF" \
  GITHUB_ACTIONS=true GITHUB_WORKSPACE="$GITHUB_WORKSPACE" RUNNER_TEMP="$RUNNER_TEMP" \
  MIKKA_UI_OVERLAY_SHA="$EXPECTED_OVERLAY_SHA" MIKKA_DESKTOP_EXECUTABLE="$archive/linux-unpacked/mikka-selfhost-acceptance" \
  PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}" \
  E_MODEL_QA_DIR="$base/model-state" E_MODEL_HOME="$base/model-state/home" E_GATE_QA_DIR="$base/run/case" \
  E_DEVICE_DATA_DIR="$base/device" E_DEVICE_GIT_CONFIG="$base/device/gitconfig" E_DEVICE_TRUST="$base/device/ca.pem" \
  E_ISOLATE_RUNTIME_PREPARE="$base/bin/runtime-prepare" E_MODEL_LAUNCH="$base/bin/model-launch" E_DEVICE_LAUNCH="$base/bin/device-launch" \
  E_EXISTING_PG_PASSWORD_FILE="$secret" E_DESKTOP_WINDOW=1 \
  unshare --net bash -euc '
    ip link set lo up
    test -z "$(ip route show default)" && test -z "$(ip -6 route show default)"
    # The installed window and OS browser expose ephemeral debugging sockets to
    # Playwright. Workers can only answer existing requests or contact the API.
    for worker in mikka-e-model mikka-e-device; do
      uid=$(id -u "$worker")
      for filter in iptables ip6tables; do
        "$filter" -A OUTPUT -m owner --uid-owner "$uid" -m conntrack --ctstate ESTABLISHED -j ACCEPT
        if [[ "$filter" == iptables && "$worker" == mikka-e-device ]]; then
          "$filter" -A OUTPUT -m owner --uid-owner "$uid" -p tcp -d 127.0.0.1 --dport 3859 -j ACCEPT
        fi
        "$filter" -A OUTPUT -m owner --uid-owner "$uid" -j REJECT
      done
    done
    exec setpriv --reuid="$1" --regid="$2" --init-groups bash "$3/scripts/acceptance/desktop-delivery/session.sh" "$4"
  ' isolate "$(id -u)" "$(id -g)" "$GITHUB_WORKSPACE" "$base"
