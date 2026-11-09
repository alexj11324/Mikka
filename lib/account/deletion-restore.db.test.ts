import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { auditDigest } from '@/lib/audit/integrity'
import { dbUrl, seedIssue, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { applyAccountDeletionManifest, exportAccountDeletionManifest, requestAccountDeletion, resumeAccountDeletion } from './deletion-jobs'

test('current deletion journal replays only into explicit isolated restore targets before exposure', { skip: !dbUrl }, async t => {
  const source = new Pool({ connectionString: dbUrl, max: 5 }), scope = `deletion_restore_${randomUUID().replaceAll('-', '')}`
  await source.query(`CREATE SCHEMA "${scope}"`)
  const restored = new Pool({ connectionString: dbUrl, options: `-c search_path=${scope},public`, max: 5 })
  t.after(async () => { await restored.end(); await source.query(`DROP SCHEMA "${scope}" CASCADE`); await source.end() })
  // A small old-backup fixture, with real PostgreSQL table definitions. The operations acceptance
  // separately owns a real pg_dump/restore drill; this tests the account replay adapter's boundaries.
  const tables = ['user', 'bots', 'coordinator_bots', 'agents', 'agent_runs', 'run_messages', 'session_mailboxes', 'factory_tasks', 'artifacts', 'artifact_versions', 'run_captures', 'run_capture_posters', 'user_avatars', 'issues', 'issue_documents', 'issue_versions', 'issue_members', 'conversations', 'conversation_members', 'user_facts',
    'mikka_workspaces', 'mikka_workspace_members', 'mikka_workspace_invitations', 'mikka_teams', 'mikka_team_members', 'mikka_team_issues', 'mikka_team_projects', 'team_issue_create_receipts', 'team_issue_promotion_receipts', 'workspace_projects', 'workspace_project_events']
  for (const table of tables) await restored.query(`CREATE TABLE "${scope}"."${table}" (LIKE public."${table}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`)
  for (const migration of ['20261031050731_account_deletion_jobs.sql', '20261031050732_workspace_deletion_guards.sql', '20261031050737_account_deletion_warnings.sql']) await restored.query(await readFile(new URL(`../../drizzle/${migration}`, import.meta.url), 'utf8'))
  const user = await seedUser(source, 'restore-deleted'), ws = await seedWorkspace(source, user, [{ userId: user, role: 'admin' }]), untouched = await seedUser(source, 'restore-untouched')

  const retainedWorkspace = await seedWorkspace(source, untouched, [{ userId: untouched, role: 'admin' }, { userId: user, role: 'member' }])
  const personalTask = await seedIssue(source, user, ws.id)
  const sharedTask = await seedIssue(source, user, retainedWorkspace.id), contributedTask = await seedIssue(source, untouched, retainedWorkspace.id)
  const backupOnlyTask = await seedIssue(source, user, retainedWorkspace.id)
  const pendingTask = randomUUID(), taskIds = [personalTask, sharedTask, contributedTask, pendingTask, backupOnlyTask]
  await source.query('INSERT INTO issues(id,"userId",title,content,status,priority) VALUES($1,$2,\'Unresolved backup task\',\'{"type":"doc"}\',\'todo\',\'normal\')', [pendingTask, user])
  for (const issueId of taskIds) {
    await source.query('INSERT INTO issue_documents("issueId","userId",state) VALUES($1,$2,$3)', [issueId, user, `history-${issueId}`])
    await source.query(`INSERT INTO issue_versions(id,"issueId","userId",revision,title,content,status,priority)
      SELECT $1,id,$2,revision,title,content,status,priority FROM issues WHERE id=$3`, [randomUUID(), user, issueId])
    await source.query('INSERT INTO issue_members("issueId","userId","memberId") SELECT id,"userId",$2 FROM issues WHERE id=$1', [issueId, user])
  }

  await restored.query('INSERT INTO "user" SELECT * FROM public."user" WHERE id=ANY($1::text[])', [[user, untouched]])
  await restored.query('INSERT INTO mikka_workspaces SELECT * FROM public.mikka_workspaces WHERE id=ANY($1::uuid[])', [[ws.id, retainedWorkspace.id]])
  await restored.query('INSERT INTO mikka_workspace_members SELECT * FROM public.mikka_workspace_members WHERE "workspaceId"=ANY($1::uuid[])', [[ws.id, retainedWorkspace.id]])
  await restored.query('INSERT INTO issues SELECT * FROM public.issues WHERE id=ANY($1::uuid[])', [taskIds])
  for (const table of ['issue_documents', 'issue_versions', 'issue_members']) await restored.query(`INSERT INTO ${table} SELECT * FROM public.${table} WHERE "issueId"=ANY($1::uuid[])`, [taskIds])
  // The backup predates the membership removal; the current journal must still
  // remove that old access while retaining the immutable Shared task ownership.
  const beforeReplay = {
    tasks: (await restored.query('SELECT id,"userId","workspaceId","ownershipState",content FROM issues WHERE id=ANY($1::uuid[]) ORDER BY id', [taskIds])).rows,
    documents: (await restored.query('SELECT * FROM issue_documents WHERE "issueId"=ANY($1::uuid[]) ORDER BY "issueId"', [taskIds])).rows,
    versions: (await restored.query('SELECT * FROM issue_versions WHERE "issueId"=ANY($1::uuid[]) ORDER BY "issueId"', [taskIds])).rows,
  }
  // This task existed in the old dump but is absent from the independently kept current journal.
  for (const table of ['issue_documents', 'issue_versions', 'issue_members']) await source.query(`DELETE FROM ${table} WHERE "issueId"=$1`, [backupOnlyTask])
  await source.query('DELETE FROM issues WHERE id=$1', [backupOnlyTask])
  await source.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [retainedWorkspace.id, user])
  const key = `${user}/old-backup-file.png`
  await restored.query('INSERT INTO account_storage_retirements("userId","storageKey") VALUES($1,$2)', [user, key])
  const options = { mainPool: source, workspacePool: source, externalCleanup: async () => [] as string[] }
  const request = await requestAccountDeletion(user, `${user}@example.invalid`, randomUUID(), options)
  assert.ok(request.ok)
  const pending = await exportAccountDeletionManifest(options)
  const pendingBody = { ...pending, jobs: pending.jobs.filter(job => job.id === request.id) }
  const { digest: _pendingDigest, ...pendingValue } = pendingBody
  pendingBody.digest = auditDigest(pendingValue)
  await assert.rejects(applyAccountDeletionManifest(pendingBody, { mainPool: restored, workspacePool: restored }), /accountDeletionManifestHasPendingJobs/)
  assert.equal((await resumeAccountDeletion(request.id, options)).stage, 'completed')
  const current = await exportAccountDeletionManifest(options)
  const { digest: _sourceDigest, ...body } = current
  body.jobs = body.jobs.filter(job => job.id === request.id)
  const manifest = JSON.parse(JSON.stringify({ ...body, digest: auditDigest(body) }))
  const keptTaskIds = [sharedTask, contributedTask, pendingTask].sort()
  const restoredKeptTaskIds = [...keptTaskIds, backupOnlyTask].sort()
  assert.deepEqual(manifest.jobs[0].plan.keptIssueIds, keptTaskIds)
  assert.deepEqual(manifest.jobs[0].plan.shared, [], 'the source creator already left this Shared workspace')
  const removed: string[] = []
  await assert.rejects(applyAccountDeletionManifest({ ...manifest, digest: '0'.repeat(64) }, { mainPool: restored, workspacePool: restored }), /accountDeletionManifestInvalid/)
  await assert.rejects(applyAccountDeletionManifest(manifest, { mainPool: restored, workspacePool: restored, deleteObject: async object => { removed.push(object); throw new Error('object unavailable') } }), /accountDeletionRestoreCleanupPending/)
  assert.equal((await restored.query('SELECT stage FROM account_deletion_jobs WHERE id=$1', [request.id])).rows[0].stage, 'storage_pending')
  assert.deepEqual(await applyAccountDeletionManifest(manifest, { mainPool: restored, workspacePool: restored, deleteObject: async object => { removed.push(object) } }), { applied: 1 })
  assert.deepEqual(removed, [key, key], 'reapplying a manifest must retain object references whose DB pointers are already deleted')
  assert.equal((await restored.query('SELECT count(*)::int n FROM "user" WHERE id=$1', [user])).rows[0].n, 0)
  assert.equal((await restored.query('SELECT count(*)::int n FROM mikka_workspaces WHERE id=$1', [ws.id])).rows[0].n, 0)
  assert.equal((await restored.query('SELECT count(*)::int n FROM "user" WHERE id=$1', [untouched])).rows[0].n, 1)
  assert.equal((await source.query('SELECT count(*)::int n FROM "user" WHERE id=$1', [untouched])).rows[0].n, 1, 'ambient source pool was not used by replay')
  await assert.rejects(restored.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [user, `${user}@example.invalid`]), /account_deletion_pending/)

  await t.test('restore replay preserves the frozen ungrouped Shared and pending task contribution set', async () => {
    const expectedTasks = beforeReplay.tasks.filter(row => row.id !== personalTask)
    assert.deepEqual((await restored.query('SELECT id,"userId","workspaceId","ownershipState",content FROM issues WHERE id=ANY($1::uuid[]) ORDER BY id', [taskIds])).rows, expectedTasks)
    assert.deepEqual(expectedTasks.map(row => row.id), restoredKeptTaskIds)
    for (const [table, rows] of [['issue_documents', beforeReplay.documents], ['issue_versions', beforeReplay.versions]] as const) {
      const sql = `SELECT * FROM ${table} WHERE "issueId"=ANY($1::uuid[]) ORDER BY "issueId"`
      assert.deepEqual((await restored.query(sql, [taskIds])).rows, rows.filter(row => row.issueId !== personalTask))
      assert.equal((await restored.query(sql, [taskIds])).rowCount, 4)
    }
    assert.equal((await restored.query('SELECT count(*)::int n FROM mikka_workspace_members WHERE "userId"=$1', [user])).rows[0].n, 0, 'old backup membership is revoked')
    assert.equal((await restored.query('SELECT count(*)::int n FROM issue_members WHERE "memberId"=$1', [user])).rows[0].n, 0)
    assert.equal((await restored.query('SELECT count(*)::int n FROM mikka_workspaces WHERE id=$1', [retainedWorkspace.id])).rows[0].n, 1)
    assert.deepEqual((await restored.query('SELECT plan FROM account_deletion_jobs WHERE id=$1', [request.id])).rows[0].plan.keptIssueIds, restoredKeptTaskIds, 'object failure retry retains the backup-only Task decision')
    assert.deepEqual(await applyAccountDeletionManifest(manifest, { mainPool: restored, workspacePool: restored, deleteObject: async object => { removed.push(object) } }), { applied: 1 })
    assert.deepEqual(removed, [key, key], 'a completed replay does not repeat committed object cleanup')
    assert.deepEqual((await restored.query('SELECT id FROM issues WHERE id=ANY($1::uuid[]) ORDER BY id', [taskIds])).rows.map(row => row.id), restoredKeptTaskIds)
    assert.deepEqual((await restored.query('SELECT plan FROM account_deletion_jobs WHERE id=$1', [request.id])).rows[0].plan.keptIssueIds, restoredKeptTaskIds)
  })
})
