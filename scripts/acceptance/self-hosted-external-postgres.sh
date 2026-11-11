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
MIKKA_DATABASE_URL=$driver://mikka_external_query:$POSTGRES_PASSWORD@pooled/external_fixture
MIKKA_DATABASE_URL_UNPOOLED=$driver://mikka:$POSTGRES_PASSWORD@direct/external_fixture
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
