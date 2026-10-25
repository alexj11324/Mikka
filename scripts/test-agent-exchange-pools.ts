import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { Pool } from 'pg'
import { groupDirectory } from '../lib/group-conversations-directory'
import { handleGroup } from '../lib/group-conversations-store'
import { withGroupWorkerAuthority } from '../lib/group-worker-authority'
import { withExchangeReadAuthority } from '../lib/conversation-exchange-authority'

async function main() {
  const connectionString = process.env.EXCHANGE_TEST_DATABASE_URL
  if (!connectionString) throw new Error('EXCHANGE_TEST_DATABASE_URL required')
  const target = new URL(connectionString)
  if (target.hostname !== '127.0.0.1' || target.pathname !== '/mikka_exchange') throw new Error('Only dedicated synthetic PG allowed')
  if (process.env.EXCHANGE_REQUIRE_CLEAN === '1') execFileSync('git', ['diff', '--exit-code', 'HEAD'])
  // The actual production limits and acquisition timeouts. Separate pools even
  // when fixtures share one database; the authorization transactions are real.
  const app = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 10000 })
  const workspace = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 10000 })
  const observer = new Pool({ connectionString, max: 1 })
  const owner = `pool-owner-${randomUUID()}`, workspaceId = randomUUID(), deviceId = randomUUID(), tokenId = randomUUID()
  const mixedWorkers = process.env.EXCHANGE_POOL_MIXED_WORKERS === '1'
  let armed = false, reached!: () => void, release!: () => void
  const writerAtDirectory = new Promise<void>(resolve => { reached = resolve })
  const allowWriterDirectory = new Promise<void>(resolve => { release = resolve })
  const directory = groupDirectory({
    async activeUsers(id, ids) {
      if (armed) { reached(); await allowWriterDirectory }
      return (await workspace.query(`SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=ANY($2::text[]) AND status='active'`, [id, ids])).rows.map(r => r.userId)
    },
    async ownedAgents() { return [] },
  })
  const request = { userId: owner, method: 'GET' as const, resource: 'messages' as const, origin: null, host: 'localhost:3110' }
  let report: Record<string, unknown> = {}
  try {
    await workspace.query(`INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,'Synthetic pool owner','pool@example.invalid','member','active')`, [workspaceId, owner])
    await app.query(`INSERT INTO devices (id,"ownerId",name) VALUES ($1,$2,'Synthetic pool device')`, [deviceId, owner])
    await app.query(`INSERT INTO device_tokens (id,"userId",name,"tokenHash") VALUES ($1,$2,'Synthetic pool token',$3)`, [tokenId, owner, randomUUID()])
    const created = await handleGroup(app, directory, { ...request, resource: 'conversations', method: 'POST', body: JSON.stringify({ workspaceId, title: 'Retained pool regression' }) })
    assert.equal(created.status, 201)
    const id = (created.body as { id: string }).id
    armed = true
    // Pause only the adapter boundary, AFTER the actual writer holds the app
    // connection and source row lock and BEFORE its actual workspace borrow.
    const writer = handleGroup(app, directory, { ...request, id, method: 'POST', body: '{"body":"Synthetic pool regression"}' })
    await writerAtDirectory
    const readers = Array.from({ length: 5 }, (_, index) => mixedWorkers && index % 2 === 1
      ? withGroupWorkerAuthority(workspace, { userId: owner, tokenId }, deviceId, d => handleGroup(app, d, { ...request, id }))
      : withExchangeReadAuthority(workspace, d => handleGroup(app, d, { ...request, id })))
    let sourceWaiters = 0
    for (let i = 0; i < 200; i++) {
      sourceWaiters = (await observer.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM conversations WHERE id=%'`)).rowCount ?? 0
      if (sourceWaiters >= 4 && app.waitingCount === 1) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(sourceWaiters, 4, 'four real readers wait for the actual writer source lock')
    assert.equal(app.waitingCount, 1, 'the fifth reader waits for a production-sized app pool')
    const before = { sourceWaiters, appBorrowWaiters: app.waitingCount, workspaceIdle: workspace.idleCount, workspaceTotal: workspace.totalCount }
    const started = performance.now()
    release()
    await new Promise(resolve => setTimeout(resolve, 100))
    const workspaceBorrowWaiters = workspace.waitingCount
    const outcomes = await Promise.allSettled([writer, ...readers])
    const elapsedMs = Math.round(performance.now() - started)
    const results = outcomes.map(r => r.status === 'fulfilled' ? { status: r.value.status } : { error: (r.reason as Error).message })
    report = { sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), max: 5, mixedWorkers, connectionTimeoutMillis: 10000, before, workspaceBorrowWaiters, elapsedMs, results, retained: true }
    if (process.env.EXCHANGE_EXPECT_POOL_CYCLE === '1') {
      assert.equal(workspaceBorrowWaiters, 1)
      assert.ok(results.some(r => 'error' in r), 'old order must actually cause a failed request')
      assert.ok(elapsedMs >= 9000, 'observed actual pool timeout, not an offline model')
      console.log('REPRODUCED actual PG production-sized connection-pool cycle', JSON.stringify(report))
    } else {
      assert.equal(workspaceBorrowWaiters, 0)
      assert.deepEqual(results.map(r => r.status), [201, 200, 200, 200, 200, 200])
      assert.ok(elapsedMs < 5000, 'requests finish without waiting for the ten-second acquisition timeout')
      await app.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', [tokenId])
      const denied = await withGroupWorkerAuthority(workspace, { userId: owner, tokenId }, deviceId, d => handleGroup(app, d, { ...request, id }))
      assert.equal(denied.status, 403, 'same-transaction device revocation guard remains enabled')
      report.revokedDeviceDenied = true
      console.log('PASS actual PG max5: one writer + five mixed readers, no resource-order cycle', JSON.stringify(report))
    }
  } finally {
    release?.()
    await writeFile(process.env.EXCHANGE_POOL_EVIDENCE_PATH ?? '/tmp/110-pool-evidence.json', JSON.stringify(report, null, 2))
    await Promise.all([app.end(), workspace.end(), observer.end()])
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
