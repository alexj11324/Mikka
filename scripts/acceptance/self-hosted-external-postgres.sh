#!/usr/bin/env bash
# Use the CI job's disposable local PG17 as a separately administered database.
# The customer installation itself contains only the unmodified published app service.
set -euo pipefail
: "${GITHUB_ACTIONS:?requires the disposable image CI job}"
: "${POSTGRES_PASSWORD:?requires the generated CI credential}"
: "${MIKKA_IMAGE:?requires the image built by this CI job}"
: "${GITHUB_SHA:?requires the exact revision being tested}"
docker compose up -d --wait --wait-timeout 120 postgres
db_container=$(docker compose ps -q postgres)
umask 077
installation=$(mktemp -d)
project=mikka-external-ci
network=${project}_default
compose=(docker compose --env-file "$installation/.env" -p "$project" -f "$installation/docker-compose.neon.yml")
cleanup() {
  docker network disconnect "$network" "$db_container" >/dev/null 2>&1 || true
  "${compose[@]}" down --volumes --remove-orphans >/dev/null
  rm -rf -- "$installation"
}
cp docker-compose.neon.yml "$installation/"
driver=postgresql
cat > "$installation/.env" <<VARS
MIKKA_IMAGE=$MIKKA_IMAGE
MIKKA_PORT=3097
BETTER_AUTH_URL=http://localhost:3097
MIKKA_DATABASE_URL=$driver://mikka_external_query:$POSTGRES_PASSWORD@pooled:6432/external_fixture
MIKKA_DATABASE_URL_UNPOOLED=$driver://mikka:$POSTGRES_PASSWORD@direct/external_fixture?application_name=mikka-direct
VARS
trap cleanup EXIT

# Deliberately give only the direct role DDL authority. Migration over the
# ordinary query URL fails even though both addresses reach the same PG17.
docker exec "$db_container" createdb -U mikka external_fixture
docker exec -i "$db_container" psql -X -q -U mikka -d external_fixture \
  -v ON_ERROR_STOP=1 -v fixture_password="$POSTGRES_PASSWORD" <<'SQL'
CREATE ROLE mikka_external_query LOGIN PASSWORD :'fixture_password';
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mikka_external_query;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO mikka_external_query;
SQL

# Only this already-checked disposable PostgreSQL container is modified.
# Exercise transaction pooling on a distinct port while the direct role owns
# DDL. Keep pooler auth material inside the disposable container.
docker exec -u root "$db_container" apk add --no-cache pgbouncer >/dev/null
docker exec -i -u postgres "$db_container" sh -eu <<'POOL'
umask 077
dir=/tmp/mikka-external-pool
mkdir "$dir"
printf '"mikka_external_query" "%s"\n' "$POSTGRES_PASSWORD" > "$dir/users"
cat > "$dir/config" <<'CONFIG'
[databases]
external_fixture = host=127.0.0.1 port=5432 dbname=external_fixture
[pgbouncer]
listen_addr = *
listen_port = 6432
unix_socket_dir = /tmp/mikka-external-pool
auth_type = plain
auth_file = /tmp/mikka-external-pool/users
admin_users = mikka_external_query
pool_mode = transaction
logfile = /tmp/mikka-external-pool/log
pidfile = /tmp/mikka-external-pool/pid
CONFIG
pgbouncer -d "$dir/config"
POOL

"${compose[@]}" create app
docker network connect --alias pooled --alias direct "$network" "$db_container"
"${compose[@]}" up -d --wait --wait-timeout 240
test "$("${compose[@]}" ps --services --status running)" = app
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
const response = await fetch('http://localhost:3097/mikka/api/server', { signal: AbortSignal.timeout(10_000) })
assert.equal(response.status, 200)
const server = await response.json()
assert.equal(server.kind, 'mikka-server')
assert.equal(server.status.database, 'ready')
assert.equal(server.version, process.env.GITHUB_SHA)
console.log(JSON.stringify({ revision: server.version, database: server.status.database, services: ['app'] }))
JS
# Confirm ordinary SQL really connected through the restricted query role.
test "$(docker exec "$db_container" psql -XAtq -U mikka -d external_fixture \
  -c "SELECT EXISTS (SELECT FROM pg_stat_activity WHERE datname=current_database() AND usename='mikka_external_query')")" = t

# SHOW STATS is served by PgBouncer, not by ordinary PostgreSQL. It proves
# the external app sent queries through the transaction pool.
stats=$(docker exec -u postgres "$db_container" sh -eu -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -p 6432 -U mikka_external_query -d pgbouncer -Atc "SHOW STATS"')
awk -F'|' '$1 == "external_fixture" && $3+0 > 0 { found=1 } END { exit !found }' <<< "$stats" ||
  { echo SELF_HOSTED_POOLED_QUERIES_MISSING; exit 1; }
echo 'External Compose accepted on isolated PostgreSQL 17 with a direct DDL role and transaction-pooled application queries.'
