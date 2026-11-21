import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { databaseTarget } from '../test-accounts/environment.mjs'

const script = readFileSync(new URL('./bootstrap-local.sh', import.meta.url), 'utf8')
// The script's own URL builder, run as the script runs it.
const builder = script.split('\n').find(line => line.startsWith('db_url()'))

test('bootstrap-local prints database URLs that the test-account helpers accept', () => {
  assert.ok(builder, 'scripts/dev/bootstrap-local.sh defines db_url()')
  const url = execFileSync('bash', ['-c', `PG_PORT=5432; ${builder}; db_url 0123456789abcdef0123456789abcdef`], { encoding: 'utf8' }).trim()
  assert.deepEqual(databaseTarget(url), { host: '127.0.0.1', port: 5432, name: 'mikka_e2e', schema: 'public', user: 'e2e' })
  // The printed line names the password file, never its value.
  assert.match(script, /PRINT_URL="\$\(db_url "\\\$\(cat \$PW_FILE\)"\)"/)
  assert.doesNotMatch(script, /echo "export[^\n]*\$DB_URL/)
})

test('bootstrap runs the existing setup after only a migration helper changes and propagates its failure', t => {
  const directory = mkdtempSync(join(tmpdir(), 'mikka-bootstrap-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const path of ['bin', 'drizzle', 'scripts']) mkdirSync(join(directory, path))
  writeFileSync(join(directory, 'drizzle/0001_initial.sql'), 'SELECT 1;\n')
  writeFileSync(join(directory, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  writeFileSync(join(directory, 'password'), '0123456789abcdef0123456789abcdef')
  // The child command owns migration behavior. This boundary test proves that
  // bootstrap actually reaches it; PostgreSQL/SQL idempotence belongs to the
  // existing migration runner tests, not a second migration implementation here.
  writeFileSync(join(directory, 'scripts/setup-e2e-db.mjs'), `
    import { writeFileSync } from 'node:fs'
    import { value } from './backfill.mjs'
    writeFileSync('observed-migration', value)
  `)
  writeFileSync(join(directory, 'scripts/backfill.mjs'), "export const value = 'before'\n")
  writeFileSync(join(directory, 'bin/pnpm'), '#!/bin/sh\nexec node "$ROOT/scripts/setup-e2e-db.mjs"\n')
  chmodSync(join(directory, 'bin/pnpm'), 0o755)
  // Model only the pre-existing schema-comment cache at the database client
  // boundary, so the regression also demonstrates the old false cache hit.
  writeFileSync(join(directory, 'bin/psql'), `#!/usr/bin/env node
    const { existsSync, readFileSync, writeFileSync } = require('node:fs')
    const path = process.env.ROOT + '/schema-comment'
    const query = process.argv[process.argv.indexOf('-c') + 1]
    if (query.startsWith('SELECT obj_description')) {
      if (existsSync(path)) process.stdout.write(readFileSync(path))
    } else if (query.startsWith('COMMENT ON SCHEMA public IS ')) {
      writeFileSync(path, query.slice(query.indexOf("'") + 1, -1))
    } else process.exit(2)
  `)
  chmodSync(join(directory, 'bin/psql'), 0o755)
  // Execute the production database preparation section, with ordinary shell
  // clients supplied by the fixture. No installation or system service runs.
  const start = script.indexOf('db_url()')
  const end = script.indexOf('# 7. Better Auth', start)
  assert.ok(start >= 0 && end > start)
  const prepare = () => execFileSync('bash', ['-e', '-u', '-o', 'pipefail', '-c',
    'PSQL=(psql); log() { :; }; ' + script.slice(start, end)], {
    env: { ...process.env, PATH: join(directory, 'bin') + ':' + process.env.PATH,
      ROOT: directory, PG_PORT: '5432', PW_FILE: join(directory, 'password') },
    stdio: 'pipe',
  })
  prepare()
  assert.equal(readFileSync(join(directory, 'observed-migration'), 'utf8'), 'before')
  writeFileSync(join(directory, 'scripts/backfill.mjs'), "export const value = 'after'\n")
  prepare()
  assert.equal(readFileSync(join(directory, 'observed-migration'), 'utf8'), 'after')
  writeFileSync(join(directory, 'scripts/backfill.mjs'), "throw new Error('fixture migration failure'); export const value = 'unreachable'\n")
  assert.throws(prepare, error => error.status === 1 && error.stderr.toString().includes('fixture migration failure'))
  assert.equal(readFileSync(join(directory, 'observed-migration'), 'utf8'), 'after')
})
