import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { copyFileSync, mkdtempSync, openSync, closeSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const updater = fileURLToPath(new URL('../self-hosted-update.mjs', import.meta.url))
const composeFile = fileURLToPath(new URL('../../docker-compose.yml', import.meta.url))

test('host updater backs up live rows and restores them into an independent PG17 database', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mikka-backup-'))
  const env = { ...process.env, COMPOSE_PROJECT_NAME: 'mikka-backup-' + randomUUID(),
    COMPOSE_FILE: 'docker-compose.yml', POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
    MIKKA_UPDATE_STATE_DIR: join(cwd, 'backups'), MIKKA_UPDATE_COMPOSE_FILE: 'docker-compose.yml' }
  const compose = (args, options = {}) => execFileSync('docker', ['compose', '-f', 'docker-compose.yml', ...args], {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options
  }).trim()
  const postgres = (...args) => compose(['exec', '-T', 'postgres', ...args])
  const sql = (db, statement) => postgres('psql', '-U', 'mikka', '-d', db, '-XAt', '-v', 'ON_ERROR_STOP=1', '-c', statement)
  try {
    copyFileSync(composeFile, join(cwd, 'docker-compose.yml'))
    compose(['up', '-d', '--wait', '--wait-timeout', '120', 'postgres'])
    assert.match(sql('mikka', 'SHOW server_version'), /^17\./)
    const marker = randomUUID()
    sql('mikka', "CREATE TABLE backup_probe(id uuid PRIMARY KEY); INSERT INTO backup_probe VALUES ('" + marker + "')")
    const { status, archive } = JSON.parse(execFileSync(process.execPath, [updater, 'backup'], { cwd, env, encoding: 'utf8' }))
    assert.equal(status, 'restore-verified')
    assert.equal(statSync(archive).mode & 0o777, 0o600)
    sql('mikka', 'DELETE FROM backup_probe')
    postgres('createdb', '-U', 'mikka', '-T', 'template0', 'independent_restore')
    const input = openSync(archive, 'r')
    try {
      compose(['exec', '-T', 'postgres', 'pg_restore', '-U', 'mikka', '--exit-on-error', '-d', 'independent_restore'],
        { stdio: [input, 'pipe', 'pipe'] })
    } finally { closeSync(input) }
    assert.equal(sql('independent_restore', 'SELECT id FROM backup_probe'), marker)
    assert.equal(sql('mikka', 'SELECT count(*) FROM backup_probe'), '0')
    assert.equal(sql('postgres', "SELECT count(*) FROM pg_database WHERE datname ~ '^mikka_verify_'"), '0')
  } finally {
    try { compose(['down', '--volumes', '--remove-orphans']) }
    finally { rmSync(cwd, { recursive: true, force: true }) }
  }
})
