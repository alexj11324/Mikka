import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { dbUrl, seedIssue, seedProject, seedProjectTasks, seedTeam, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('Project resource admission lease survives nested queue return until the APP owner commits', { skip: !dbUrl, timeout: 60_000 }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 5 })
  const { pool: applicationPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { withDatabaseClient } = await import('../lib/db/request-scope')
  const { withProjectExecution, withProjectResourceLease, requireProjectResourceLease, assertFrozenProjectExecution, assertProjectExecutionTarget, saveWorkspaceRepositoryPolicy } = await import('../lib/project-resources/store')
  t.after(async () => { await Promise.all([pool.end(), applicationPool.end(), workspacePool.end()]) })
  const owner = await seedUser(pool, 'resource-lease')
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const team = await seedTeam(pool, workspace.id, owner)
  const project = await seedProject(pool, owner, [{ teamId: team.id, workspaceId: workspace.id }])
  const task = await seedIssue(pool, owner, workspace.id)
  await seedProjectTasks(pool, project, [task])
  const input = { userId: owner, workspaceId: workspace.id, issueId: task, repositoryKey: 'v2/github.com/alex/project', baseBranch: 'main', runtime: 'local' as const, harness: 'codex' }
  const exclusiveAvailable = async (key: string) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      return (await client.query<{ available: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS available', [key])).rows[0].available
    } finally { await client.query('ROLLBACK'); client.release() }
  }
  const heldBy = async (pid: number, key: string) => (await pool.query<{ held: boolean }>(`
    SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=$1 AND granted
      AND classid=((hashtextextended($2,0)>>32)&4294967295)::oid
      AND objid=(hashtextextended($2,0)&4294967295)::oid AND objsubid=1) AS held`, [pid, key])).rows[0].held
  let afterLease: (() => void) | undefined
  let authorityPid = 0
  await withProjectResourceLease(owner, workspace.id, async tx => {
    authorityPid = Number((await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0].pid)
    afterLease = AsyncLocalStorage.bind(() => requireProjectResourceLease(owner, workspace.id))
    const application = await pool.connect()
    try {
      await application.query('BEGIN')
      await application.query('SELECT id FROM issues WHERE id=$1 FOR UPDATE', [task])
      const snapshot = await withProjectExecution(input, async snapshot => snapshot, true)
      await assert.rejects(saveWorkspaceRepositoryPolicy(owner, { workspaceId: workspace.id, revision: 0, mode: 'inherit', repositoryKeys: [] }), /projectResourceConflict/, 'configuration writes cannot upgrade a live shared admission lease')
      assert.equal(snapshot.projectId, project)
      assert.equal(await exclusiveAvailable('mikka-team-relations'), false)
      assert.equal(await heldBy(authorityPid, 'mikka-team-relations'), true)
      assert.equal(await exclusiveAvailable(`project-resources:${workspace.id}`), false)
      assertProjectExecutionTarget(snapshot, { userId: owner, workspaceId: workspace.id, repositoryKey: input.repositoryKey, runtime: 'local', harness: 'codex' })
      assert.throws(() => assertProjectExecutionTarget(snapshot, { userId: owner, workspaceId: workspace.id, repositoryKey: 'v2/github.com/alex/other', runtime: 'local', harness: 'codex' }), /projectRepositoryDenied/)
      assert.throws(() => assertFrozenProjectExecution({ ...snapshot, baseBranch: 'different' }, snapshot), /projectRepositoryDenied/)
      await application.query('COMMIT')
      assert.equal(await exclusiveAvailable('mikka-team-relations'), false, 'the outer authority remains active through COMMIT')
    } finally { await application.query('ROLLBACK'); application.release() }
  })
  // Other test processes may legitimately hold this global shared lock. Check
  // this authority's backend, while the unique Workspace lock is uncontended.
  assert.equal(await heldBy(authorityPid, 'mikka-team-relations'), false)
  assert.equal(await exclusiveAvailable(`project-resources:${workspace.id}`), true)
  assert.throws(() => afterLease!(), /projectEnvironmentUnavailable/, 'a retained async context cannot reuse expired authority')
  await assert.rejects(withProjectExecution(input, async snapshot => snapshot, true), /projectEnvironmentUnavailable/, 'an existing APP transaction must have acquired its resource lease at its outer boundary')
  const ambient = await pool.connect()
  try {
    await assert.rejects(withDatabaseClient(ambient, () => withProjectExecution(input, async snapshot => snapshot)), /projectEnvironmentUnavailable/, 'ambient APP clients cannot silently invert the lease order when an explicit existing argument was omitted')
  } finally { ambient.release() }

  let signalSecond!: () => void
  const secondEntered = new Promise<void>(resolve => { signalSecond = resolve })
  await Promise.all([
    withProjectResourceLease(owner, workspace.id, async () => { await secondEntered }),
    withProjectResourceLease(owner, workspace.id, async () => { signalSecond() }),
  ])
})
