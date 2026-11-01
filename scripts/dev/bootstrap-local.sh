#!/usr/bin/env bash
# One-step local setup for a cloud Linux session (docs/local-bootstrap.md):
# PostgreSQL 17 on 127.0.0.1:5432 with mikka_e2e migrated (PGDG, no Docker), Node as in .node-version,
# pnpm install --frozen-lockfile, bubblewrap/socat/ripgrep, and Playwright on
# the container's own Chromium. Idempotent: a second run only checks.
# Prints one line of exports for the session; it holds no secret.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="${MIKKA_DEV_HOME:-/var/lib/mikka-dev}"
PGDATA_DIR="${MIKKA_PGDATA:-$STATE/pg17}"
# 5432: the port the DB suites and test-account helpers assume.
PG_PORT="${MIKKA_PG_PORT:-5432}"
PG_BIN=/usr/lib/postgresql/17/bin
# The Node version CI uses: .node-version (a major like 24, or an exact 24.22.2), else 24.
NODE_WANT="$(tr -d ' v\n\r' < "$ROOT/.node-version" 2>/dev/null || true)"; NODE_WANT="${NODE_WANT:-24}"
NODE_MAJOR="${NODE_WANT%%.*}"
PW_CHROMIUM=/opt/pw-browsers/chromium
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"
log() { printf 'bootstrap: %s\n' "$*" >&2; }
$SUDO mkdir -p "$STATE"; $SUDO chmod 755 "$STATE"

apt_missing() { local p missing=(); for p in "$@"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done; echo "${missing[@]:-}"; }
APT_UPDATED=""
apt_install() {
  [ -n "$APT_UPDATED" ] || { $SUDO apt-get update -qq; APT_UPDATED=1; }
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq "$@" >/dev/null
}

# 1. PostgreSQL 17 from the PGDG apt repository (https://www.postgresql.org/download/linux/ubuntu/).
if [ ! -x "$PG_BIN/pg_ctl" ]; then
  log "installing PostgreSQL 17 (PGDG)"
  # Our own cluster below; the package's default cluster is not wanted.
  $SUDO mkdir -p /etc/postgresql-common
  echo 'create_main_cluster = false' | $SUDO tee /etc/postgresql-common/createcluster.conf >/dev/null
  apt_install postgresql-common ca-certificates
  $SUDO /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y >/dev/null
  APT_UPDATED=""; apt_install postgresql-17
fi
# Run the server as postgres when root (initdb refuses root), else as this user.
as_pg() { if [ "$(id -u)" -eq 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
if [ ! -s "$PGDATA_DIR/PG_VERSION" ]; then
  log "creating cluster in $PGDATA_DIR"
  $SUDO mkdir -p "$PGDATA_DIR"
  [ "$(id -u)" -ne 0 ] || chown postgres:postgres "$PGDATA_DIR"
  # Loopback only, trust auth: a disposable test database with no password to print.
  as_pg "'$PG_BIN/initdb' -D '$PGDATA_DIR' -U postgres --auth=trust >/dev/null"
fi
# Already running on another port (an earlier default): restart it on this one.
if as_pg "'$PG_BIN/pg_ctl' -D '$PGDATA_DIR' status" >/dev/null 2>&1 && [ "$(sed -n 4p "$PGDATA_DIR/postmaster.pid")" != "$PG_PORT" ]; then
  log "moving PostgreSQL 17 to port $PG_PORT"
  as_pg "'$PG_BIN/pg_ctl' -D '$PGDATA_DIR' -w -m fast stop" >/dev/null
fi
if ! as_pg "'$PG_BIN/pg_ctl' -D '$PGDATA_DIR' status" >/dev/null 2>&1; then
  if (exec 3<>"/dev/tcp/127.0.0.1/$PG_PORT") 2>/dev/null; then
    log "127.0.0.1:$PG_PORT is taken by another server; stop it (or set MIKKA_PG_PORT) and run again"; exit 1
  fi
  log "starting PostgreSQL 17 on 127.0.0.1:$PG_PORT"
  as_pg "'$PG_BIN/pg_ctl' -D '$PGDATA_DIR' -l '$PGDATA_DIR/server.log' -w -o \"-h 127.0.0.1 -p $PG_PORT -k /tmp\" start" >/dev/null
fi
PSQL=("$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U postgres -qAt)
"${PSQL[@]}" -c "SELECT 1 FROM pg_roles WHERE rolname='e2e'" | grep -q 1 || "${PSQL[@]}" -c "CREATE ROLE e2e LOGIN SUPERUSER"
# A generated password for the disposable role, kept in a file only this user reads: URLs that
# carry one pass scripts/test-accounts' databaseTarget, and the printed line names the file, not the value.
PW_FILE="$STATE/e2e-password"
if [ ! -s "$PW_FILE" ]; then
  ( umask 077; od -An -tx1 -N16 /dev/urandom | tr -d ' \n' | $SUDO tee "$PW_FILE" >/dev/null )
  [ -z "$SUDO" ] || $SUDO chown "$(id -u):$(id -g)" "$PW_FILE"
  "${PSQL[@]}" -c "ALTER ROLE e2e PASSWORD '$(cat "$PW_FILE")'" >/dev/null
fi
"${PSQL[@]}" -c "SELECT 1 FROM pg_database WHERE datname='mikka_e2e'" | grep -q 1 || "${PSQL[@]}" -c "CREATE DATABASE mikka_e2e OWNER e2e"

# 2. Node at NODE_WANT, as CI's setup-node, from nodejs.org with its checksum.
# A major matches any of its releases; an exact version only itself.
node_matches() { local v; v="$("$1" -p process.versions.node 2>/dev/null)" || return 1; [ "$v" = "$NODE_WANT" ] || [ "${v%%.*}" = "$NODE_WANT" ]; }
NODE_DIR=""
if command -v node >/dev/null && node_matches node; then
  NODE_DIR="$(dirname "$(command -v node)")"
elif [ -x "/opt/node$NODE_MAJOR/bin/node" ] && node_matches "/opt/node$NODE_MAJOR/bin/node"; then
  # The cloud image ships /opt/node24 behind /opt/node22 on PATH.
  NODE_DIR="/opt/node$NODE_MAJOR/bin"
else
  case "$NODE_WANT" in *.*) GLOB="node-v$NODE_WANT-*" ;; *) GLOB="node-v$NODE_MAJOR.*" ;; esac
  NODE_DIR="$(ls -d "$STATE"/$GLOB/bin 2>/dev/null | sort -V | tail -1 || true)"
  if [ -z "$NODE_DIR" ]; then
    case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) log "unsupported CPU $(uname -m)"; exit 1 ;; esac
    case "$NODE_WANT" in *.*) BASE="https://nodejs.org/dist/v$NODE_WANT" ;; *) BASE="https://nodejs.org/dist/latest-v$NODE_MAJOR.x" ;; esac
    TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
    curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
    FILE="$(grep -o "node-v$NODE_MAJOR\.[0-9.]*-linux-$ARCH\.tar\.xz" "$TMP/SHASUMS256.txt" | head -1)"
    log "installing $FILE"
    curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
    (cd "$TMP" && grep " $FILE\$" SHASUMS256.txt | sha256sum -c - >/dev/null)
    $SUDO tar -xJf "$TMP/$FILE" -C "$STATE"
    NODE_DIR="$STATE/${FILE%.tar.xz}/bin"
  fi
fi
export PATH="$NODE_DIR:$PATH"

# 3. pnpm at package.json's packageManager through Corepack, then a frozen install when the lockfile or Node changed.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
[ -x "$NODE_DIR/pnpm" ] && "$NODE_DIR/pnpm" --version >/dev/null 2>&1 || $SUDO env PATH="$PATH" corepack enable pnpm --install-directory "$NODE_DIR"
STAMP="$(cat "$ROOT/pnpm-lock.yaml" "$ROOT/package.json" | sha256sum | cut -c1-16)-node$(node -v)"
if [ ! -d "$ROOT/node_modules" ] || [ "$(cat "$ROOT/node_modules/.mikka-bootstrap" 2>/dev/null)" != "$STAMP" ]; then
  log "pnpm install --frozen-lockfile"
  (cd "$ROOT" && pnpm install --frozen-lockfile --reporter=silent)
  echo "$STAMP" > "$ROOT/node_modules/.mikka-bootstrap"
fi

# 4. What the daemon's sandbox tests and agents need.
MISSING="$(apt_missing bubblewrap socat ripgrep)"
if [ -n "$MISSING" ]; then log "installing $MISSING"; apt_install $MISSING; fi

# 5. Playwright on the container's own Chromium, never `playwright install`
# (launchOptions.executablePath, https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-executable-path).
PW_EXPORTS=""
if [ -e "$PW_CHROMIUM" ]; then
  PW_EXPORTS=" PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers MIKKA_CHROMIUM_EXECUTABLE_PATH=$(readlink -f "$PW_CHROMIUM")"
fi

# 6. Every tracked migration on mikka_e2e (scripts/setup-e2e-db.mjs runs scripts/migrate.mjs, then the auth tables).
db_url() { echo "postgresql://e2e:$1@127.0.0.1:$PG_PORT/mikka_e2e"; }
DB_URL="$(db_url "$(cat "$PW_FILE")")"
PRINT_URL="$(db_url "\$(cat $PW_FILE)")"
MIGRATIONS="$( (ls "$ROOT/drizzle"/*.sql; cat "$ROOT/scripts/setup-e2e-db.mjs" "$ROOT/pnpm-lock.yaml") | sha256sum | cut -c1-16)"
if [ "$("${PSQL[@]}" -d mikka_e2e -c "SELECT obj_description('public'::regnamespace)" 2>/dev/null)" != "mikka-bootstrap $MIGRATIONS" ]; then
  log "migrating mikka_e2e"
  (cd "$ROOT" && E2E_DATABASE_URL="$DB_URL" MIKKA_DATABASE_URL="$DB_URL" DATABASE_URL="$DB_URL" pnpm -s test:e2e:setup >/dev/null)
  "${PSQL[@]}" -d mikka_e2e -c "COMMENT ON SCHEMA public IS 'mikka-bootstrap $MIGRATIONS'"
fi

log "ready"
# Local registration limits (also the fallback in lib/abuse/signup.ts): every local signup shares one IP,
# so the production default of 5 an hour turns browser tests into 429s.
echo "export PATH=$NODE_DIR:\$PATH E2E_DATABASE_URL=$PRINT_URL MIKKA_DATABASE_URL=$PRINT_URL DATABASE_URL=$PRINT_URL MIKKA_TEST_DB_PORT=$PG_PORT MIKKA_LOCAL_TEST_ACCOUNTS=1$PW_EXPORTS"
