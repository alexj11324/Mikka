#!/usr/bin/env bash
set -euo pipefail
umask 077
base=$(dirname "$(dirname "$(realpath "$0")")")
qa="$base/run/case"
test "$1" = "$base" && test "$2" = "$qa"
model="$base/model-state"
cd "$base/product"
if [[ "$(jq -r .world .output/eve/mikka-eve-build.json)" == '@workflow/world-postgres' ]]; then
  echo postgres-workflow-schema > "$base/stage"
  WORKFLOW_POSTGRES_URL="$DATABASE_URL" node apps/eve/node_modules/@workflow/world-postgres/bin/setup.js > "$qa/workflow-setup.log" 2>&1
  node --input-type=module - <<'JS'
import assert from 'node:assert/strict'
import { Client } from 'pg'
const client = new Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
try {
  const {rows} = await client.query("select current_database() as db, current_user as owner, count(*)::int as installed from workflow_drizzle.workflow_migrations")
  assert.equal(rows[0].db, 'mikka_e2e')
  assert.equal(rows[0].owner, 'e2e')
  assert.ok(rows[0].installed > 0)
} finally { await client.end() }
JS
fi
echo offline-installed-window > "$base/stage"
sudo install -d -m 700 -o mikka-e-device -g mikka-e-device "$base/device/home"
sudo install -d -m 700 -o mikka-e-model -g mikka-e-model "$model/home"
sudo install -m 444 "$qa/ephemeral-ca.pem" "$base/device/ca.pem"
install -m 444 "$qa/ephemeral-ca.pem" "$model/ephemeral-ca.pem"
# Each TLS listener has a distinct leaf. No model can read the API's key or the CA signing key.
openssl req -newkey rsa:2048 -nodes -sha256 -subj '/CN=127.0.0.1' \
  -keyout "$qa/model.key" -out "$qa/model.csr" >/dev/null 2>&1
openssl x509 -req -in "$qa/model.csr" -CA "$qa/ephemeral-ca.pem" -CAkey "$qa/local-ca.key" \
  -CAcreateserial -days 1 -sha256 -extfile "$qa/leaf.ext" -out "$model/endpoint.pem" >/dev/null 2>&1
sudo install -m 400 -o mikka-e-model -g mikka-e-model "$qa/model.key" "$model/endpoint.key"
rm "$qa/model.key"
chmod 444 "$model/endpoint.pem"
for file in results.jsonl claude-results.jsonl; do
  sudo install -m 640 -o mikka-e-model -g "$(id -gn)" /dev/null "$model/$file"
  sudo -n -u mikka-e-model -- test -w "$model/$file"
  test -r "$model/$file"
  test ! -w "$model/$file"
done
sudo -n -u mikka-e-device -- env -i PATH="$PATH" HOME="$base/device/home" \
  bash -euc '
    dir=$1
    git init -q --initial-branch=main "$dir/work"
    git -C "$dir/work" -c user.name="Synthetic fixture" -c user.email=qa@example.invalid commit --allow-empty -m "Isolated worktree" -q
    git clone -q --bare "$dir/work" "$dir/origin.git"
    git config --file "$dir/gitconfig" "url.file://$dir/origin.git.insteadOf" https://github.com/mikka-e2e/core-loop.git
    git config --file "$dir/gitconfig" protocol.file.allow always
  ' fixture "$base/device"
for worker in mikka-e-device mikka-e-model; do
  sudo -n -u "$worker" -- test ! -r "$qa/endpoint.key"
  sudo -n -u "$worker" -- test ! -r "$qa/local-ca.key"
  sudo -n -u "$worker" -- test ! -x "$qa"
  sudo -n -u "$worker" -- test ! -x "$GITHUB_WORKSPACE"
  sudo -n -u "$worker" -- test ! -x "$RUNNER_TEMP"
done

# Load the same CLI from the service UID before a one-use enrollment is issued.
echo device-cli-loader > "$base/stage"
"$base/bin/device-launch" "$(command -v node)" --import tsx packages/daemon/bin/mikka.ts daemon --help > "$qa/device-help" 2>"$qa/daemon.log"
grep -q 'mikka daemon' "$qa/device-help"
echo offline-installed-window > "$base/stage"
