import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { protectCiCredentialPools } from './ci-github-token.mjs'

const localTarget = 'postgresql://postgres@127.0.0.1:55432/mikka_e2e'
if (process.env.ISSUE1503_LOCAL_PG_URL !== localTarget) throw new Error('issue1503_local_pg_target_required')

test('real local PG enforces per-client read-only transactions and closes every protected session', async () => {
  const control = new Pool({ connectionString: localTarget, max: 1, connectionTimeoutMillis: 5000 })
  const app = new Pool({ connectionString: localTarget, max: 2, connectionTimeoutMillis: 5000 })
  const workspace = new Pool({ connectionString: localTarget, max: 1, connectionTimeoutMillis: 5000 })
  const table = '"issue1503_ci_ro_' + randomBytes(6).toString('hex') + '"'
  const borrowed = new Set(), pids = []
  let madeTable = false, ended = false
  try {
    const identity = (await control.query("SELECT current_database() AS db, host(inet_server_addr()) AS host, current_setting('server_version') AS version")).rows[0]
    assert.equal(identity.db, 'mikka_e2e'); assert.equal(identity.host, '127.0.0.1')
    await control.query('CREATE TABLE ' + table + ' (id integer PRIMARY KEY)')
    madeTable = true
    await control.query('INSERT INTO ' + table + ' VALUES (1)')
    assert.equal(Number((await control.query('SELECT count(*) AS n FROM ' + table)).rows[0].n), 1)
    const healthy = protectCiCredentialPools(app, workspace)

    const first = await app.connect(); borrowed.add(first)
    const firstRead = (await first.query('SELECT pg_backend_pid() AS pid, current_setting(\'transaction_read_only\') AS ro, (SELECT count(*) FROM ' + table + ') AS n')).rows[0]
    assert.equal(firstRead.ro, 'on'); assert.equal(Number(firstRead.n), 1); pids.push(firstRead.pid)
    first.release(); borrowed.delete(first)
    const reused = await app.connect(); borrowed.add(reused)
    assert.equal(reused, first)
    assert.equal((await reused.query('SELECT current_setting(\'transaction_read_only\') AS ro')).rows[0].ro, 'on')
    const next = await app.connect(); borrowed.add(next)
    assert.notEqual(next, first)
    const nextRead = (await next.query('SELECT pg_backend_pid() AS pid, current_setting(\'transaction_read_only\') AS ro')).rows[0]
    assert.equal(nextRead.ro, 'on'); pids.push(nextRead.pid)
    const other = await workspace.connect(); borrowed.add(other)
    const otherRead = (await other.query('SELECT pg_backend_pid() AS pid, current_setting(\'transaction_read_only\') AS ro')).rows[0]
    assert.equal(otherRead.ro, 'on'); pids.push(otherRead.pid)
    assert.equal(new Set(pids).size, 3); healthy()

    let writeError
    await assert.rejects(reused.query('INSERT INTO ' + table + ' VALUES (2)'), e => {
      writeError = e
      return e.code === '25006'
    })
    await assert.rejects(reused.query('SELECT 1'), e => e.code === '25P02')
    reused.release(); borrowed.delete(reused)
    assert.equal(Number((await next.query('SELECT count(*) AS n FROM ' + table)).rows[0].n), 1)
    assert.throws(healthy, e => e.message === 'issue1503_ci_auth_runtime_failed' && e.cause === writeError)
    for (const client of borrowed) client.release()
    borrowed.clear()
    await Promise.all([app.end(), workspace.end()]); ended = true
    const stillConnected = Number((await control.query('SELECT count(*) AS n FROM pg_stat_activity WHERE pid = ANY($1::int[])', [pids])).rows[0].n)
    assert.equal(stillConnected, 0)
    assert.equal(Number((await control.query('SELECT count(*) AS n FROM ' + table)).rows[0].n), 1)

    const used = new Pool({ connectionString: localTarget, max: 1, connectionTimeoutMillis: 5000 })
    const unused = new Pool({ connectionString: localTarget, max: 1, connectionTimeoutMillis: 5000 })
    try {
      await used.query('SELECT 1')
      assert.throws(() => protectCiCredentialPools(used, unused), /^Error: issue1503_ci_auth_runtime_failed$/)
      assert.equal(Object.hasOwn(unused.options, 'verify'), false)
    } finally { await Promise.all([used.end(), unused.end()]) }
    console.log(JSON.stringify({ phase: 'local_ci_readonly_pool_regression', pgVersion: identity.version,
      unprotectedWriteSucceeded: true, firstReuseAndNewClientReadsPassed: true, protectedClients: pids.length,
      protectedWriteSqlstate: writeError.code, abortedReadSqlstate: '25P02', healthyOtherClientDidNotBypassFailure: true,
      protectedSessionsAfterClose: stillConnected, fixtureRowsAfterRejectedWrite: 1, usedPoolRejected: true }))
  } finally {
    for (const client of borrowed) client.release()
    if (!ended) await Promise.allSettled([app.end(), workspace.end()])
    if (madeTable) await control.query('DROP TABLE ' + table)
    await control.end()
  }
})
