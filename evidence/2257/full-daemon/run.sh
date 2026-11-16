#!/usr/bin/env bash
set -eu
umask 077
qbase="$1"
project="$qbase/product"
harness="$qbase/harness"
qa="$qbase/run/case"
mkdir -m 700 -p "$qa"/fixture/{work,home} "$HOME" "$qa/private"
export E_CODEX_QA="$qa" E_WEIGHT_FILE="$qbase/material/model.gguf"
export E_RUN_SOURCE="$(git -C "$project" rev-parse HEAD)"
test -x "${E_DEVICE_DATA_DIR:-$qa/daemon}/harness/codex/0.163.0/bin/codex"
test -x "${E_DEVICE_DATA_DIR:-$qa/daemon}/harness/claude_code/2.1.309/bin/claude"
pgroot=/usr
pg="$pgroot/lib/postgresql/17/bin"
"$pg/postgres" --version > "$qa/pg.version"
export MIKKA_MODEL_KEY_LOOPBACK=1 E_FACTORY_CATALOG=1 MIKKA_TEST_MODE=1 CI=true
export WORKSPACE_SECRETS_KEY="$(openssl rand -hex 32)" E_LOOPBACK_KEY="$(openssl rand -hex 24)"
export BETTER_AUTH_SECRET="$(openssl rand -hex 32)" BETTER_AUTH_URL=https://127.0.0.1:3859 MIKKA_EDITION=community
if [ -n "${E_EXISTING_PG_PASSWORD_FILE:-}" ]; then
  test -f "$E_EXISTING_PG_PASSWORD_FILE" && test ! -L "$E_EXISTING_PG_PASSWORD_FILE"
  test "$(stat -c '%a:%u' "$E_EXISTING_PG_PASSWORD_FILE")" = "600:$(id -u)"
  IFS= read -r pw < "$E_EXISTING_PG_PASSWORD_FILE"
  [[ "$pw" =~ ^[a-f0-9]{48,96}$ ]]
else
  pw="$(openssl rand -hex 28)"
fi
export E2E_DATABASE_URL="postgresql://e2e:$pw@127.0.0.1:15471/mikka_e2e"
export DATABASE_URL="$E2E_DATABASE_URL" MIKKA_DATABASE_URL="$E2E_DATABASE_URL" REQUIRE_DB=1
export E2E_BASE_URL="$BETTER_AUTH_URL" MIKKA_TEST_ENVIRONMENT_FILE="$qa/private/environment.json" MIKKA_TEST_DEPLOYMENT_SHA="$E_RUN_SOURCE" MIKKA_LOCAL_TEST_ACCOUNTS=1
export MIKKA_DEV_SKIP_ENV_FILES=1 NODE_NO_WARNINGS=1 WORKFLOW_TARGET_WORLD=local
cd "$qa"
if [ -z "${E_EXISTING_PG_PASSWORD_FILE:-}" ]; then
printf '%s\n' "$pw" > pg.pass
"$pg/initdb" -D db -L "$pgroot/share/postgresql/17" -A scram-sha-256 -U e2e --pwfile=pg.pass --locale=C --encoding=UTF8 > pg-init.log 2>&1
"$pg/pg_ctl" -D db -l "$qa/pg.log" -o "-p 15471 -h 127.0.0.1 -c unix_socket_directories='' -c shared_buffers=32MB -c dynamic_library_path='$pgroot/lib/postgresql/17/lib'" -w start
fi
modelpid=''; codexpid=''; relaypid=''; apppid=''
function cleanup() {
 set +e
 for p in "$apppid" "$modelpid" "$codexpid" "$relaypid";do if [ -n "$p" ];then kill "$p" 2>/dev/null;fi;done
 if [ -z "${E_EXISTING_PG_PASSWORD_FILE:-}" ]; then "$pg/pg_ctl" -D "$qa/db" -w -m fast stop >/dev/null; fi
 rm -f "$qa/endpoint.key" "$qa/pg.pass" "$qa/local-ca.key"
}
trap cleanup EXIT
if [ -z "${E_EXISTING_PG_PASSWORD_FILE:-}" ]; then PGPASSWORD="$pw" "$pg/createdb" -h 127.0.0.1 -p 15471 -U e2e mikka_e2e; fi
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj '/CN=Mikka isolated verification CA' -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' -keyout local-ca.key -out ephemeral-ca.pem >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -sha256 -subj '/CN=127.0.0.1' -keyout endpoint.key -out endpoint.csr >/dev/null 2>&1
printf '%s\n' 'subjectAltName=IP:127.0.0.1' 'basicConstraints=critical,CA:FALSE' 'keyUsage=critical,digitalSignature,keyEncipherment' 'extendedKeyUsage=serverAuth' > leaf.ext
openssl x509 -req -in endpoint.csr -CA ephemeral-ca.pem -CAkey local-ca.key -CAcreateserial -days 1 -sha256 -extfile leaf.ext -out endpoint.pem >/dev/null 2>&1
openssl verify -CAfile ephemeral-ca.pem -verify_ip 127.0.0.1 endpoint.pem > cert.verify
model_directory="${E_MODEL_QA_DIR:-$qa}"
if [ -n "${E_ISOLATE_RUNTIME_PREPARE:-}" ]; then
  "$E_ISOLATE_RUNTIME_PREPARE" "$qbase" "$qa"
  test "$model_directory" != "$qa" && test -r "$model_directory/ephemeral-ca.pem"
fi
rm local-ca.key
export NODE_EXTRA_CA_CERTS="$qa/ephemeral-ca.pem" SSL_CERT_FILE="$qa/ephemeral-ca.pem"
git -C fixture/work init --quiet --initial-branch=main
git -C fixture/work -c user.name='Synthetic Fixture' -c user.email='qa@invalid.example' commit --allow-empty -m 'Isolated synthetic worktree' --quiet
git clone --quiet --bare fixture/work fixture/origin.git
export GIT_CONFIG_GLOBAL="$qa/fixture.gitconfig"
git config --file "$GIT_CONFIG_GLOBAL" "url.file://$qa/fixture/origin.git.insteadOf" https://github.com/mikka-e2e/core-loop.git
git config --file "$GIT_CONFIG_GLOBAL" protocol.file.allow always
cd "$project"
echo 'isolated PG17 with no external route'
node --import tsx scripts/setup-e2e-db.mjs > "$qa/setup.log" 2>&1
node scripts/test-accounts/bootstrap.mjs --output "$MIKKA_TEST_ENVIRONMENT_FILE" > "$qa/bootstrap.log" 2>&1
node scripts/test-accounts/cli.mjs inspect > "$qa/pre-inspect.json"
node --input-type=module - <<'JS'
import {apiAliases} from './apps/api/compat-aliases.mjs'
import {writeFileSync} from 'node:fs'
const paths=Object.fromEntries(Object.entries(apiAliases).map(([k,v])=> k==='@'?['@/*',[v+'/*']]:[k,[v]]))
writeFileSync('.cache/e-codex-actual/tsconfig.json',JSON.stringify({extends:'../../tsconfig.json',compilerOptions:{paths}}))
JS
export TSX_TSCONFIG_PATH="$project/.cache/e-codex-actual/tsconfig.json"
launch_model() {
  # An optional immutable installation wrapper selects the service UID. Only
  # model endpoint material is inherited, including the public CA trust root.
  local -a command=("$(command -v node)" "$1")
  if [ -n "${E_MODEL_LAUNCH:-}" ] && [ "$1" != "$harness/relay.mjs" ]; then command=("$E_MODEL_LAUNCH" "${command[@]}"); fi
  exec env -i PATH="$PATH" HOME="${E_MODEL_HOME:-$HOME}" LANG=C.UTF-8 E_CODEX_QA="$model_directory" E_WEIGHT_FILE="$E_WEIGHT_FILE" E_LOOPBACK_KEY="$E_LOOPBACK_KEY" NODE_EXTRA_CA_CERTS="$model_directory/ephemeral-ca.pem" SSL_CERT_FILE="$model_directory/ephemeral-ca.pem" "${command[@]}"
}
launch_model "$harness/provider.mjs" > "$qa/codex-model.log" 2>&1 & codexpid=$!
launch_model "$harness/relay.mjs" > "$qa/relay.log" 2>&1 & relaypid=$!
launch_model "$harness/provider-current.mjs" > "$qa/provider.log" 2>&1 & modelpid=$!
for ((n=0;n<45;n++));do if curl -fsS --noproxy '*' --connect-timeout 1 http://127.0.0.1:3858/health > "$qa/health" 2>/dev/null;then break;fi;kill -0 "$modelpid" || exit 10;sleep 1;done
test "$(cat "$qa/health")" = ready
for ((n=0;n<45;n++));do if curl -fsS --cacert "$qa/ephemeral-ca.pem" --noproxy '*' --connect-timeout 1 https://127.0.0.1:3857/health > "$qa/codex-health" 2>/dev/null;then break;fi;kill -0 "$codexpid" || exit 12;sleep 1;done
test "$(cat "$qa/codex-health")" = ready
node --input-type=module - <<'JS'
import {readCompiledBuild} from './scripts/start-app.mjs'
const b=await readCompiledBuild(process.cwd()); console.log('pre-launch canonical manifest verified',b.testDeploymentSha);
JS
NITRO_SSL_KEY="$(cat "$qa/endpoint.key")" NITRO_SSL_CERT="$(cat "$qa/endpoint.pem")" NITRO_HOST=127.0.0.1 NITRO_PORT=3859 NODE_ENV=production MIKKA_DATA_DIR="$qa/storage" node .output/server/mikka-entry.mjs > "$qa/app.log" 2>&1 & apppid=$!
for ((n=0;n<80;n++));do if curl -fsS --cacert "$qa/ephemeral-ca.pem" --noproxy '*' --connect-timeout 1 https://127.0.0.1:3859/mikka/api/version > "$qa/version.json" 2>/dev/null;then break;fi;kill -0 "$apppid" || exit 11;sleep 1;done
date -u +%FT%TZ > "$qa/start"
rc=0
timeout 680 node --import ./scripts/server-test.mjs --import tsx .cache/e-codex-actual/full-daemon.mts > "$qa/delivery.log" 2>&1 || rc=$?
date -u +%FT%TZ > "$qa/end"; printf '%s\n' "$rc" > "$qa/exit"
exit "$rc"
