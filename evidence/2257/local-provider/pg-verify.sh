#!/usr/bin/env bash
set -euo pipefail
umask 077
harness="$1"
project="$2"
qa="$3"
export E_CODEX_QA="$qa"
export E_CLI_BINARY="$4" E_WEIGHT_FILE="$5"
export E_RUN_SOURCE="$(git -C "$project" rev-parse HEAD)" E_CODEX_VERSION="$("$E_CLI_BINARY" --version)"
export E_CLI_BINARY_SHA="$(sha256sum "$E_CLI_BINARY" | cut -d' ' -f1)" E_WEIGHT_SHA="$(sha256sum "$E_WEIGHT_FILE" | cut -d' ' -f1)"
test "$E_CLI_BINARY_SHA" = 399ff69c431c066e40de318fba45c2b07f45a76b19939d247ee4828fc70c4215
test "$E_WEIGHT_SHA" = 2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d
pg=/usr/lib/postgresql/17/bin
"$pg/postgres" --version | grep -E '^postgres \(PostgreSQL\) 17\.'
export E_LOOPBACK_KEY="$(openssl rand -hex 24)"
export BETTER_AUTH_SECRET="$(openssl rand -hex 32)" BETTER_AUTH_URL=http://127.0.0.1:3859 MIKKA_EDITION=community
pw="$(openssl rand -hex 28)"
export E2E_DATABASE_URL="postgresql://e2e:$pw@127.0.0.1:5432/mikka_e2e"
export DATABASE_URL="$E2E_DATABASE_URL" MIKKA_DATABASE_URL="$E2E_DATABASE_URL" REQUIRE_DB=1
cd "$qa"
printf '%s\n' "$pw" > pg.pass
"$pg/initdb" -D db -A scram-sha-256 -U e2e --pwfile=pg.pass --encoding=UTF8 > pg-init.log
"$pg/pg_ctl" -D db -l "$qa/pg.log" -o "-p 5432 -h 127.0.0.1 -c unix_socket_directories='' -c shared_buffers=32MB" -w start
modelpid=''
cleanup() { if [ -n "$modelpid" ];then kill "$modelpid" 2>/dev/null || true;fi; "$pg/pg_ctl" -D "$qa/db" -w -m fast stop >/dev/null; rm -f "$qa/endpoint.key" "$qa/pg.pass"; }
trap cleanup EXIT
PGPASSWORD="$pw" "$pg/createdb" -h 127.0.0.1 -p 5432 -U e2e mikka_e2e
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj '/CN=Mikka isolated verification CA' -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' -keyout local-ca.key -out ephemeral-ca.pem >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -sha256 -subj '/CN=127.0.0.1' -keyout endpoint.key -out endpoint.csr >/dev/null 2>&1
printf '%s\n' 'subjectAltName=IP:127.0.0.1' 'basicConstraints=critical,CA:FALSE' 'keyUsage=critical,digitalSignature,keyEncipherment' 'extendedKeyUsage=serverAuth' > leaf.ext
openssl x509 -req -in endpoint.csr -CA ephemeral-ca.pem -CAkey local-ca.key -CAcreateserial -days 1 -sha256 -extfile leaf.ext -out endpoint.pem >/dev/null 2>&1
openssl verify -CAfile ephemeral-ca.pem -verify_ip 127.0.0.1 endpoint.pem > cert.verify
rm local-ca.key
mkdir -p fixture/work fixture/home
git -C fixture/work init --quiet
git -C fixture/work -c user.name='Synthetic Fixture' -c user.email='qa@invalid.example' commit --allow-empty -m 'Isolated synthetic worktree' --quiet
cd "$project"
node --experimental-strip-types scripts/setup-e2e-db.mjs > "$qa/setup.log" 2>&1
node --input-type=module - <<'JS'
import {apiAliases} from './apps/api/compat-aliases.mjs'
import {writeFileSync} from 'node:fs'
const paths=Object.fromEntries(Object.entries(apiAliases).map(([k,v])=> k==='@'?['@/*',[v+'/*']]:[k,[v]]))
writeFileSync('.cache/e-codex-actual/tsconfig.json',JSON.stringify({extends:'../../tsconfig.json',compilerOptions:{paths}}))
JS
export TSX_TSCONFIG_PATH="$project/.cache/e-codex-actual/tsconfig.json"
node "$harness/provider.mjs" > "$qa/provider.log" 2>&1 & modelpid=$!
for ((n=0;n<90;n++));do curl -fsS --cacert "$qa/ephemeral-ca.pem" --noproxy '*' --connect-timeout 1 https://127.0.0.1:3857/health > "$qa/health" 2>/dev/null && break;kill -0 "$modelpid" || exit 10;sleep 1;done
test "$(cat "$qa/health")" = ready
date -u +%FT%TZ > "$qa/start"
rc=0
node --import tsx .cache/e-codex-actual/observe-queue.mts > "$qa/observer.log" 2>&1 & observer=$!
E_TEST_VERSIONS=1 E_AFTER_RUN=1 timeout 250 node --import ./scripts/server-test.mjs --import tsx .cache/e-codex-actual/delivery.mts > "$qa/delivery.log" 2>&1 || rc=$?
kill -TERM "$observer" 2>/dev/null || true
wait "$observer" || true
date -u +%FT%TZ > "$qa/end"
printf '%s\n' "$rc" > "$qa/exit"
if [ "$rc" -ne 0 ] && [ ! -f "$qa/delivery.json" ];then sed -E 's/(postgres(ql)?|https?):\/\/[^ )]+/[endpoint]/g; s/([A-Za-z0-9_-]){40,}/[digest]/g' "$qa/delivery.log" | tail -18 > "$qa/setup-diagnostic.txt";fi
exit "$rc"
