import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('approval DB runner validates every target before constructing a database client', () => {
  const directory = mkdtempSync(join(tmpdir(), 'approval-db-guard-'))
  try {
    // Exercise the actual entrypoint while making database access impossible.
    const source = readFileSync(new URL('./test-agent-tool-approval-db.mjs', import.meta.url), 'utf8')
      .replace(/from (['"])pg\1/, "from './pg.mjs'")
      .replace("'../tests/helpers/e2e-target.mjs'", JSON.stringify(new URL('../tests/helpers/e2e-target.mjs', import.meta.url).href))
    writeFileSync(join(directory, 'runner.mjs'), source)
    writeFileSync(join(directory, 'pg.mjs'), 'export default { Client: class { constructor() { throw Error("DATABASE_CLIENT_REQUESTED") } } }')
    const run = overrides => {
      const database = 'postgres://test:disposable@localhost:6543/approval_local_e2e'
      return spawnSync(process.execPath, [join(directory, 'runner.mjs'), 'lib/agent-tool-approval/store.db.test.ts', 'lib/agent-tool-approval/http.db.test.mts'], {
        env: { ...process.env, CI: '', GITHUB_ACTIONS: '', E2E_DATABASE_URL: database, MIKKA_DATABASE_URL: database, DATABASE_URL: database, ORVILO_DATABASE_URL: '', ...overrides },
        encoding: 'utf8',
      })
    }
    const valid = run({})
    assert.notEqual(valid.status, 0)
    assert.match(valid.stderr, /DATABASE_CLIENT_REQUESTED/, 'local mode needs no CI variables, fixed port or fixed database name')
    for (const value of [
      'postgresql://test:disposable@127.0.0.1:5432/mikka_e2e',
      'postgres://test:disposable@[::1]:6543/approval_local_e2e',
    ]) assert.match(run({ E2E_DATABASE_URL: value, MIKKA_DATABASE_URL: value, DATABASE_URL: value }).stderr, /DATABASE_CLIENT_REQUESTED/)
    for (const overrides of [
      { E2E_DATABASE_URL: '' },
      { MIKKA_DATABASE_URL: '' },
      { DATABASE_URL: 'postgres://localhost/other_e2e' },
      { ORVILO_DATABASE_URL: 'postgres://localhost/production' },
      ...[
        'postgres://db.internal/mikka_e2e',
        'postgres://127.0.0.1/production',
        'postgres://127.0.0.1/mikka_e2e?host=production.internal',
        'https://127.0.0.1/mikka_e2e',
      ].map(value => ({ E2E_DATABASE_URL: value, MIKKA_DATABASE_URL: value, DATABASE_URL: value })),
    ]) {
      const rejected = run(overrides)
      assert.notEqual(rejected.status, 0)
      assert.match(rejected.stderr, /Requires the same disposable loopback/)
      assert.doesNotMatch(rejected.stderr, /DATABASE_CLIENT_REQUESTED/)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
