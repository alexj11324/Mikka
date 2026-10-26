#!/usr/bin/env bash
set -euo pipefail
# This bootstrap is used only before any test in a disposable Actions service.
# pg_catalog is implicitly searched even by strict single-schema test pools.
# Installing only extension objects there keeps public/business tables out of
# fixture search paths. Production SQL, extension placement and pools are untouched.
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true ]]
[[ "${PG_FIXTURE_CONTAINER:-}" =~ ^[a-f0-9]{64}$ ]]
image=$(docker inspect --format '{{.Config.Image}}' "$PG_FIXTURE_CONTAINER")
[[ "$image" == postgres:17 || "$image" == postgres:17-alpine ]]
docker exec "$PG_FIXTURE_CONTAINER" sh -eu -c '
  user=${POSTGRES_USER:-postgres}
  version=$(psql -X -U "$user" -d template1 -Atc "SHOW server_version_num")
  case "$version" in 17????) ;; *) exit 1 ;; esac
  psql -X -U "$user" -d template1 -Atc "SELECT datname FROM pg_database WHERE datallowconn ORDER BY datname" |
  while IFS= read -r database; do
    psql -X -v ON_ERROR_STOP=1 -U "$user" -d "$database" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA pg_catalog"
    namespace=$(psql -X -U "$user" -d "$database" -Atc "SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname=\$\$pg_trgm\$\$")
    [ "$namespace" = pg_catalog ]
    printf "isolated fixture extension: database=%s server=%s schema=%s\n" "$database" "$version" "$namespace"
  done
'
