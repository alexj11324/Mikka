import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'

// Run the production wake boundary with only its scheduler replaced. The
// existing consumer seam avoids a model or Coordinator runtime; both database
// transactions, commit observation and resource authorization remain real.
const jobs: Promise<unknown>[] = []
const scheduler = mock.module(new URL('../lib/background.ts', import.meta.url).href, { namedExports: {
  afterJob: (_label: string, work: () => unknown) => {
    const pending = Promise.resolve(work())
    void pending.catch(() => {})
    jobs.push(pending)
  },
} })
let fixture: Pool
let application: typeof import('../lib/db/request-scope')
let workspace: typeof import('../lib/workspace-db')
let resources: typeof import('../lib/project-resources/store')
let coordinator: typeof import('../lib/coordinator/wake-after-commit')
before(async () => {
  if (!dbUrl) return
  fixture = new Pool({ connectionString: dbUrl, max: 3 })
  application = await import('../lib/db/request-scope')
  workspace = await import('../lib/workspace-db')
  resources = await import('../lib/project-resources/store')
  coordinator = await import('../lib/coordinator/wake-after-commit')
})
after(async () => {
  scheduler.restore()
  if (fixture) await Promise.all([fixture.end(), application.pool.end(), workspace.workspacePool.end()])
})

test('an APP commit wake owns a fresh Workspace transaction until its consumer completes', { skip: !dbUrl, timeout: 30_000 }, async () => {
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  let ownerKey: object | null = null, consumerKey: object | null = null
  let ownerPid = 0, consumerPid = 0, acquisitions = 0
  let results: PromiseSettledResult<unknown>[] = []
  const acquired = () => { acquisitions++ }
  workspace.workspacePool.on('acquire', acquired)
  coordinator.coordinatorWakeTransport.wake = async () => workspace.workspaceDb.transaction(async tx => {
    consumerKey = workspace.workspaceTransactionKey()
    consumerPid = Number((await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0].pid)
    await workspace.workspaceDb.transaction(async nested => {
      assert.equal(workspace.workspaceTransactionKey(), consumerKey, 'nested consumer work keeps its own transaction')
      assert.equal(Number((await nested.execute(sql`select pg_backend_pid() as pid`)).rows[0].pid), consumerPid)
    })
    started.resolve()
    await finish.promise
    await tx.execute(sql`select 1`)
  })
  const client = await application.pool.connect()
  try {
    await workspace.workspaceDb.transaction(async outer => {
      ownerPid = Number((await outer.execute(sql`select pg_backend_pid() as pid`)).rows[0].pid)
      await workspace.workspaceDb.transaction(async () => {
        ownerKey = workspace.workspaceTransactionKey()
        await application.withDatabaseClient(client, async () => {
          await client.query('BEGIN')
          coordinator.wakeCoordinatorAfterCommit(client, 'background-boundary-fixture')
          await client.query('COMMIT')
          await started.promise
        })
      })
      // Releasing the owner's savepoint must not invalidate its consumer.
      finish.resolve()
      results = await Promise.allSettled(jobs)
      assert.equal(workspace.workspaceTransactionKey(), ownerKey, 'the caller keeps its original scope')
    })
  } finally {
    finish.resolve()
    await Promise.allSettled(jobs)
    delete coordinator.coordinatorWakeTransport.wake
    workspace.workspacePool.off('acquire', acquired)
    client.release()
  }
  assert.ok(ownerKey)
  assert.ok(consumerKey)
  assert.notEqual(consumerKey, ownerKey)
  assert.notEqual(consumerPid, ownerPid)
  assert.deepEqual(results.map(result => result.status), ['fulfilled'])
  assert.equal(acquisitions, 2, 'the owner and consumer use one checkout each, including their nested work')
})

test('independent work cannot borrow a live Project resource lease and rechecks its own authority', { skip: !dbUrl, timeout: 30_000 }, async () => {
  const owner = await seedUser(fixture, 'background-resource-owner')
  const suspended = await seedUser(fixture, 'background-resource-suspended')
  const tenant = await seedWorkspace(fixture, owner, [{ userId: owner, role: 'admin' }, { userId: suspended, role: 'member', status: 'suspended' }])
  const other = await seedWorkspace(fixture, owner, [{ userId: owner, role: 'admin' }])
  const { tokenWorkspace } = await import('../lib/tokens/principal')
  await resources.withProjectResourceLease(owner, tenant.id, async parentTx => {
    const parentKey = workspace.workspaceTransactionKey()
    resources.requireProjectResourceLease(owner, tenant.id)
    await application.withoutDatabaseClient(async () => {
      assert.throws(() => resources.requireProjectResourceLease(owner, tenant.id), /projectEnvironmentUnavailable/)
      await assert.rejects(resources.withProjectResourceLease(owner, tenant.id, async () => {
        assert.fail('an independent APP continuation cannot borrow its parent resource transaction')
      }, true), /projectEnvironmentUnavailable/)
      await assert.rejects(resources.withProjectResourceLease(suspended, tenant.id, async () => {
        assert.fail('a suspended member cannot open an independent resource lease')
      }), /workspaceAccessDenied/)
      await assert.rejects(resources.withProjectResourceLease({ id: owner, [tokenWorkspace]: other.id }, tenant.id, async () => {
        assert.fail('an independent resource lease cannot escape its token Workspace')
      }), /workspaceAccessDenied/)
      await resources.withProjectResourceLease(owner, tenant.id, async childTx => {
        assert.notEqual(childTx, parentTx)
        assert.notEqual(workspace.workspaceTransactionKey(), parentKey)
        resources.requireProjectResourceLease(owner, tenant.id)
        await resources.withProjectResourceLease(owner, tenant.id, async nestedTx => {
          assert.equal(nestedTx, childTx, 'composed work borrows its own resource lease')
        }, true)
      })
      assert.throws(() => resources.requireProjectResourceLease(owner, tenant.id), /projectEnvironmentUnavailable/)
    })
    assert.equal(workspace.workspaceTransactionKey(), parentKey)
    resources.requireProjectResourceLease(owner, tenant.id)
    await resources.withProjectResourceLease(owner, tenant.id, async tx => { assert.equal(tx, parentTx) }, true)
  })
})
