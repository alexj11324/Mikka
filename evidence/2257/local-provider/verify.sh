set -euo pipefail
umask 077
qa="$3"
project="$2"
export E_CODEX_QA="$qa" E_RUN_SOURCE="$(git -C "$project" rev-parse HEAD)"
export E_CLI_BINARY="$4" E_WEIGHT_FILE="$5"
export E_CLI_BINARY_SHA="$(sha256sum "$E_CLI_BINARY" | cut -d' ' -f1)" E_WEIGHT_SHA="$(sha256sum "$E_WEIGHT_FILE" | cut -d' ' -f1)"
test "$E_CLI_BINARY_SHA" = 399ff69c431c066e40de318fba45c2b07f45a76b19939d247ee4828fc70c4215
test "$E_WEIGHT_SHA" = 2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d
export E_CODEX_VERSION="$("$E_CLI_BINARY" --version)" E_LOOPBACK_KEY="$(openssl rand -hex 24)"
cd "$qa"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj '/CN=Mikka E2262 isolated verification CA' -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' -keyout local-ca.key -out ephemeral-ca.pem >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -sha256 -subj '/CN=127.0.0.1' -keyout endpoint.key -out endpoint.csr >/dev/null 2>&1
echo -e 'subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth' > leaf.ext
openssl x509 -req -in endpoint.csr -CA ephemeral-ca.pem -CAkey local-ca.key -CAcreateserial -days 1 -sha256 -extfile leaf.ext -out endpoint.pem >/dev/null 2>&1
openssl verify -CAfile ephemeral-ca.pem -verify_ip 127.0.0.1 endpoint.pem > cert.verify
rm local-ca.key
mkdir -p fixture/work fixture/home; git -C fixture/work init --quiet
git -C fixture/work -c user.name='Synthetic Fixture' -c user.email='qa@invalid.example' commit --allow-empty -m 'Synthetic QA fixture' --quiet
node "$1/provider.mjs" >provider.log 2>&1 & modelpid=$!
trap 'kill "$modelpid" 2>/dev/null || :; rm -f "$qa/endpoint.key";' EXIT
for ((n=0;n<90;n++));do curl -fsS --cacert ephemeral-ca.pem --noproxy '*' --connect-timeout 1 https://127.0.0.1:3857/health > health 2>/dev/null && break; kill -0 "$modelpid" || exit 10;sleep 1;done
test "$(cat health)" = ready
cd "$project"
date -u +%FT%TZ > "$qa/start"
export E_LOOPBACK_KEY
rc=0
timeout 240 node --import tsx .cache/e-codex-actual/adapter.mts > "$qa/adapter.log" 2>&1 || rc=$?
date -u +%FT%TZ > "$qa/end"
printf '%s\n' "$rc" > "$qa/exit"
exit "$rc"
