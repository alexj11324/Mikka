import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
