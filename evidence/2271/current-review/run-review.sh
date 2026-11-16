#!/usr/bin/env bash
set -eu
umask 077
qbase="$1"
project="$qbase/product"
harness="$qbase/harness"
qa="$qbase/run/case"
mkdir -m 700 -p "$qa"/fixture/{work,home} "$HOME" "$qa/private"
export E_CODEX_QA="$qa" E_CLI_BINARY="$qbase/material/claude" E_WEIGHT_FILE="$qbase/material/model.gguf"
export E_RUN_SOURCE="$(git -C "$project" rev-parse HEAD)" E_CODEX_VERSION="$("$E_CLI_BINARY" --version)"
export E_CLI_BINARY_SHA="$(sha256sum "$E_CLI_BINARY" | cut -d' ' -f1)" E_WEIGHT_SHA="$(sha256sum "$E_WEIGHT_FILE" | cut -d' ' -f1)"
test "$E_CLI_BINARY_SHA" = 4d704a8aecbe038affa3000f498ae17c1b4f753add8facb8764120affc99b658
test "$E_WEIGHT_SHA" = 2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d
pgroot=/usr
pg="$pgroot/lib/postgresql/17/bin"
"$pg/postgres" --version > "$qa/pg.version"
export MIKKA_MODEL_KEY_LOOPBACK=1 E_FACTORY_CATALOG=1
export WORKSPACE_SECRETS_KEY="$(openssl rand -hex 32)" E_LOOPBACK_KEY="$(openssl rand -hex 24)"
export BETTER_AUTH_SECRET="$(openssl rand -hex 32)" BETTER_AUTH_URL=https://127.0.0.1:3859 MIKKA_EDITION=community
pw="$(openssl rand -hex 28)"
export E2E_DATABASE_URL="postgresql://e2e:$pw@127.0.0.1:15471/mikka_e2e"
export DATABASE_URL="$E2E_DATABASE_URL" MIKKA_DATABASE_URL="$E2E_DATABASE_URL" REQUIRE_DB=1
export E2E_BASE_URL="$BETTER_AUTH_URL" MIKKA_TEST_ENVIRONMENT_FILE="$qa/private/environment.json" MIKKA_TEST_DEPLOYMENT_SHA="$E_RUN_SOURCE" MIKKA_LOCAL_TEST_ACCOUNTS=1
export MIKKA_DEV_SKIP_ENV_FILES=1 NODE_NO_WARNINGS=1 WORKFLOW_TARGET_WORLD=local
cd "$qa"
printf '%s\n' "$pw" > pg.pass
"$pg/initdb" -D db -L "$pgroot/share/postgresql/17" -A scram-sha-256 -U e2e --pwfile=pg.pass --locale=C --encoding=UTF8 > pg-init.log 2>&1
"$pg/pg_ctl" -D db -l "$qa/pg.log" -o "-p 15471 -h 127.0.0.1 -c unix_socket_directories='' -c shared_buffers=32MB -c dynamic_library_path='$pgroot/lib/postgresql/17/lib'" -w start
modelpid=''; apppid=''
function cleanup() {
 set +e
 for p in "$apppid" "$modelpid";do if [ -n "$p" ];then kill "$p" 2>/dev/null;fi;done
 "$pg/pg_ctl" -D "$qa/db" -w -m fast stop >/dev/null
 rm -f "$qa/endpoint.key" "$qa/pg.pass" "$qa/local-ca.key"
}
trap cleanup EXIT
PGPASSWORD="$pw" "$pg/createdb" -h 127.0.0.1 -p 15471 -U e2e mikka_e2e
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj '/CN=Mikka isolated verification CA' -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' -keyout local-ca.key -out ephemeral-ca.pem >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -sha256 -subj '/CN=127.0.0.1' -keyout endpoint.key -out endpoint.csr >/dev/null 2>&1
printf '%s\n' 'subjectAltName=IP:127.0.0.1' 'basicConstraints=critical,CA:FALSE' 'keyUsage=critical,digitalSignature,keyEncipherment' 'extendedKeyUsage=serverAuth' > leaf.ext
openssl x509 -req -in endpoint.csr -CA ephemeral-ca.pem -CAkey local-ca.key -CAcreateserial -days 1 -sha256 -extfile leaf.ext -out endpoint.pem >/dev/null 2>&1
openssl verify -CAfile ephemeral-ca.pem -verify_ip 127.0.0.1 endpoint.pem > cert.verify
rm local-ca.key
export NODE_EXTRA_CA_CERTS="$qa/ephemeral-ca.pem" SSL_CERT_FILE="$qa/ephemeral-ca.pem"
git -C fixture/work init --quiet
git -C fixture/work -c user.name='Synthetic Fixture' -c user.email='qa@invalid.example' commit --allow-empty -m 'Isolated synthetic worktree' --quiet
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
node "$harness/provider-current.mjs" > "$qa/provider.log" 2>&1 & modelpid=$!
for ((n=0;n<45;n++));do if curl -fsS --noproxy '*' --connect-timeout 1 http://127.0.0.1:3858/health > "$qa/health" 2>/dev/null;then break;fi;kill -0 "$modelpid" || exit 10;sleep 1;done
test "$(cat "$qa/health")" = ready
node --input-type=module - <<'JS'
import {readCompiledBuild} from './scripts/start-app.mjs'
const b=await readCompiledBuild(process.cwd()); console.log('pre-launch canonical manifest verified',b.testDeploymentSha);
JS
NITRO_SSL_KEY="$(cat "$qa/endpoint.key")" NITRO_SSL_CERT="$(cat "$qa/endpoint.pem")" NITRO_HOST=127.0.0.1 NITRO_PORT=3859 NODE_ENV=production MIKKA_DATA_DIR="$qa/storage" node .output/server/mikka-entry.mjs > "$qa/app.log" 2>&1 & apppid=$!
for ((n=0;n<80;n++));do if curl -fsS --cacert "$qa/ephemeral-ca.pem" --noproxy '*' --connect-timeout 1 https://127.0.0.1:3859/mikka/api/version > "$qa/version.json" 2>/dev/null;then break;fi;kill -0 "$apppid" || exit 11;sleep 1;done
date -u +%FT%TZ > "$qa/start"
rc=0
timeout 320 node --import ./scripts/server-test.mjs --import tsx .cache/e-codex-actual/work-independent-review.mts > "$qa/delivery.log" 2>&1 || rc=$?
date -u +%FT%TZ > "$qa/end"; printf '%s\n' "$rc" > "$qa/exit"
exit "$rc"
