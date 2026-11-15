#!/usr/bin/env bash
set -euo pipefail
umask 077
source_dir=$1
work=$2
cd "$source_dir"
source_sha=$(git rev-parse HEAD)
test "$source_sha" = 8c41e536ecea6bae39149b7dc6a3c4d559c69d03
test "$(git rev-parse 'HEAD^{tree}')" = 36da2ecc2e517a9ceeeb27a0ced0f4fdd0ef3b40
export PATH="/usr/lib/postgresql/17/bin:$PATH"
export PGHOST=127.0.0.1 PGPORT=5468 PGUSER=qa
PGPASSWORD=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
export PGPASSWORD
export BETTER_AUTH_SECRET="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
export BETTER_AUTH_URL=http://127.0.0.1:3834 NODE_ENV=test MIKKA_TEST_DEPLOYMENT_SHA="$source_sha" REQUIRE_DB=1 CI=true
printf '%s' "$PGPASSWORD" > "$work/pg-password"
initdb -U qa -A scram-sha-256 -D "$work/data" --pwfile="$work/pg-password" >/dev/null
pg_ctl -D "$work/data" -l "$work/postgres.log" -o "-p 5468 -h 127.0.0.1 -c unix_socket_directories=''" -w start >/dev/null
trap 'pg_ctl -D "$work/data" -m fast -w stop >/dev/null' EXIT
test "$(psql -qAt -d postgres -c 'select current_setting('\''server_version_num'\'')::integer / 10000')" = 17
printf 'Source %s tree %s; PostgreSQL 17; isolated loopback; exact group reconciliation, commit and rollback tests\n' "$source_sha" "$(git rev-parse 'HEAD^{tree}')"
for mode in disabled builtin; do
  db="e_group_${mode}_e2e"
  createdb "$db"
  export E2E_DATABASE_URL="postgresql://qa:$PGPASSWORD@127.0.0.1:5468/$db"
  export DATABASE_URL="$E2E_DATABASE_URL" MIKKA_DATABASE_URL="$E2E_DATABASE_URL"
  if [ "$mode" = builtin ]; then
    export MIKKA_EDITION=community
  else
    export MIKKA_EDITION=cloud
  fi
  export EXPECTED_GATEWAY="$mode"
  node --import tsx --input-type=module - <<'JS'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const req=createRequire(import.meta.url)
const {liveGatewayConfig}=req('./lib/live/scope.ts')
assert.equal(liveGatewayConfig(process.env)?.mode ?? 'disabled', process.env.EXPECTED_GATEWAY)
JS
  node --experimental-strip-types scripts/setup-e2e-db.mjs > "$work/setup-$mode.log" 2>&1 || { echo "isolated migration failed: $mode"; exit 1; }
  printf 'Start %s %s\n' "$mode" "$(date -u +%FT%TZ)"
  flag=0
  node --experimental-test-module-mocks --import ./scripts/server-test.mjs --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap lib/coordinator/group-factory.db.test.ts lib/db/commit-effects.test.ts lib/db/request-scope-live.db.test.ts > "$work/$mode.tap" 2>&1 || flag=$?
  grep -E '^[[:space:]]*(not ok|ok) [0-9]+ - |^# (tests|pass|fail|skipped|duration_ms) ' "$work/$mode.tap" | sed -E 's/(password|token|secret)=[^[:space:]]+/[redacted]/Ig'
  test "$flag" = 0
  grep -qx '# skipped 0' "$work/$mode.tap"
  grep -q '^# pass [1-9]' "$work/$mode.tap"
  printf 'Complete %s %s\n' "$mode" "$(date -u +%FT%TZ)"
done
