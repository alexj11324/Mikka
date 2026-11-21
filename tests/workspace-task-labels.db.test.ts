import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { withActivitySession } from './fixtures/activity-runtime.mjs'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'
import type { CreateOnlyCommand } from '../lib/task-create-command'
import type { WorkspaceTaskLabel } from '@mikka/protocol/task-labels'

test('workspace task label HTTP management and real task writers preserve tenant, role and reference boundaries', { skip: !dbUrl }, async t => {
  const [{ db, pool }, { workspacePool }, collection, item, merge, actions, tasks] = await Promise.all([
    import('../lib/db'), import('../lib/workspace-db'), import('../app/api/workspaces/[workspaceId]/task-labels/route'),
    import('../app/api/workspaces/[workspaceId]/task-labels/[labelId]/route'),
    import('../app/api/workspaces/[workspaceId]/task-labels/[labelId]/merge/route'),
    import('../app/actions/issue-metadata'), import('../app/actions/issues'),
  ])
  pool.options.max = 1
  workspacePool.options.max = 1
  const users: string[] = [], workspaces: string[] = []
  t.after(async () => {
    try {
      await pool.query('DELETE FROM issue_versions WHERE "userId"=ANY($1::text[])', [users])
      await pool.query('DELETE FROM issues WHERE "userId"=ANY($1::text[])', [users])
      await pool.query('DELETE FROM workspace_issue_labels WHERE workspace_id=ANY($1::uuid[])', [workspaces])
      await workspacePool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [workspaces])
      await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [users])
    } finally {
      await (await import('../lib/builtin-gateway/runtime')).builtinGateway()?.stop()
      await Promise.all([pool.end(), workspacePool.end()])
    }
  })
  const owner = await seedUser(pool, 'labels-admin'), member = await seedUser(pool, 'labels-member'), outsider = await seedUser(pool, 'labels-outsider')
  users.push(owner, member, outsider)
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  const other = await seedWorkspace(pool, outsider, [{ userId: outsider, role: 'admin' }])
  workspaces.push(workspace.id, other.id)
  const as = <T>(userId: string, work: () => Promise<T>, workspaceId = workspace.id) => withActivitySession(userId, work, workspaceId)
  const context = (labelId: string = randomUUID(), workspaceId = workspace.id) => ({ params: Promise.resolve({ labelId, workspaceId }) })
  const request = (method = 'GET', body?: unknown, origin = 'https://mikka.test') => new Request(`https://mikka.test/api/workspaces/${workspace.id}/task-labels`, {
    method, headers: { origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const create = async (name: string, color: WorkspaceTaskLabel['color'], userId = owner, workspaceId = workspace.id): Promise<WorkspaceTaskLabel> => {
    const response = await as(userId, () => collection.POST(request('POST', { name, color }), context(undefined, workspaceId)), workspaceId)
    assert.equal(response.status, 200)
    return (await response.json()).label
  }
  const bug = await create('Bug', 'red'), review = await create('Review', 'blue'), foreign = await create('Foreign', 'green', outsider, other.id)

  await t.test('every new method rechecks identity, workspace, admin role, same-origin and exact input', async () => {
    const operations = () => [
      collection.GET(request(), context()), item.GET(request(), context(bug.id)),
      collection.POST(request('POST', { name: 'Denied', color: 'gray' }), context()),
      item.PATCH(request('PATCH', { color: 'gray' }), context(bug.id)), item.DELETE(request('DELETE'), context(bug.id)),
      merge.POST(request('POST', { targetId: review.id }), context(bug.id)),
    ]
    for (const response of await Promise.all(operations())) assert.equal(response.status, 403)
    for (const response of await as(outsider, () => Promise.all(operations()))) assert.equal(response.status, 403)
    const memberResults = await as(member, () => Promise.all(operations()))
    assert.deepEqual(memberResults.map(result => result.status), [200, 200, 403, 403, 403, 403])
    assert.equal((await memberResults[0].json()).canManage, false)
    assert.equal((await as(owner, () => item.GET(request(), context(foreign.id)))).status, 404)
    assert.equal((await as(owner, () => item.PATCH(request('PATCH', { color: 'gray' }), context(foreign.id)))).status, 404)
    assert.equal((await as(owner, () => item.DELETE(request('DELETE'), context(foreign.id)))).status, 404)
    assert.equal((await as(owner, () => merge.POST(request('POST', { targetId: foreign.id }), context(bug.id)))).status, 404)
    assert.equal((await as(owner, () => merge.POST(request('POST', { targetId: bug.id }), context(bug.id)))).status, 400)
    for (const body of [{ name: 'New', color: 'orange' }, { name: 'New', color: 'red', workspaceId: other.id }, { name: ' ', color: 'red' }])
      assert.equal((await as(owner, () => collection.POST(request('POST', body), context()))).status, 400)
    assert.equal((await as(owner, () => collection.POST(request('POST', { name: 'BUG', color: 'blue' }), context()))).status, 409)
    assert.equal((await as(owner, () => item.PATCH(request('PATCH', {}), context(bug.id)))).status, 400)
    assert.equal((await as(owner, () => item.PATCH(request('PATCH', { color: 'blue' }, 'https://other.test'), context(bug.id)))).status, 403)
    await workspacePool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace.id, owner])
    for (const response of await as(owner, () => Promise.all(operations()))) assert.equal(response.status, 403)
    await workspacePool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace.id, owner])
    const { readWorkspaceTaskLabels } = await import('../lib/task-labels/store')
    const { tokenWorkspace } = await import('../lib/tokens/principal')
    const pinned = { id: owner, [tokenWorkspace]: other.id }
    await assert.rejects(readWorkspaceTaskLabels(pinned, workspace.id), /workspaceAccessDenied/)
    const { Pool } = await import('pg')
    const concurrent = new Pool({ connectionString: dbUrl, max: 1 })
    try {
      await concurrent.query('BEGIN')
      await concurrent.query('SELECT id FROM workspace_issue_labels WHERE id=$1 FOR SHARE', [bug.id])
      const conflicted = await as(owner, () => item.PATCH(request('PATCH', { color: 'gray' }), context(bug.id)))
      assert.equal(conflicted.status, 409)
      assert.equal((await conflicted.json()).error.detail, 'changed')
    } finally { await concurrent.query('ROLLBACK'); await concurrent.end() }
  })

  const command = (labelIds: string[], extra: Partial<CreateOnlyCommand> = {}): CreateOnlyCommand => ({ version: 1, intent: 'create_only', requestId: randomUUID(), workspaceId: workspace.id,
    title: 'Labelled task', content: { type: 'doc' }, status: 'todo', priority: 'normal', labelIds, ...extra })
  const createTask = async (userId: string, labelIds: string[], extra: Partial<CreateOnlyCommand> = {}) => {
    const result = await as(userId, () => tasks.createTaskOnly(command(labelIds, extra)))
    assert.ok('taskId' in result, JSON.stringify(result))
    return result.taskId!
  }
  const privateTask = await createTask(owner, [bug.id, review.id], { access: { kind: 'members', memberIds: [] } })
  const memberTask = await createTask(member, [bug.id])
  const taskRow = async (id: string) => (await pool.query('SELECT revision,content,title FROM issues WHERE id=$1', [id])).rows[0]
  const refs = async (id: string) => (await pool.query('SELECT label_id FROM issue_label_refs WHERE issue_id=$1 ORDER BY position', [id])).rows.map(row => row.label_id)

  await t.test('members select existing IDs; private tasks, foreign IDs and legacy name creation are refused without partial writes', async () => {
    assert.deepEqual(await refs(privateTask), [bug.id, review.id])
    const before = await taskRow(privateTask)
    const edit = (userId: string, patch: Parameters<typeof actions.updateIssueMetadata>[0]['patch']) =>
      as(userId, () => actions.updateIssueMetadata({ id: privateTask, revision: before.revision, patch }))
    assert.ok((await edit(member, { labelIds: [] })).error)
    assert.ok((await edit(outsider, { labelIds: [] })).error)
    for (const patch of [{ labelIds: [foreign.id] }, { labelIds: [randomUUID()] }, { labels: [{ name: 'Unregistered', color: 'red' as const }] },
      { labelIds: [bug.id], labels: [{ name: 'Bug', color: 'red' as const }] }]) assert.ok((await edit(owner, patch)).error)
    assert.deepEqual(await taskRow(privateTask), before)
    assert.deepEqual(await refs(privateTask), [bug.id, review.id])
    await assert.rejects(pool.query(`UPDATE issues SET content=jsonb_set(content,'{attrs,mikka,labelIds}',$2::jsonb) WHERE id=$1`, [privateTask, JSON.stringify([foreign.id])]),
      { code: '23514', constraint: 'issue_labels_workspace_reference' })
    for (const tenant of [workspace.id, other.id])
      await assert.rejects(pool.query('INSERT INTO issue_label_refs(issue_id,workspace_id,label_id,position) VALUES($1,$2,$3,0)', [privateTask, tenant, foreign.id]), { code: '23503' })
    assert.deepEqual(await taskRow(privateTask), before)
    const oldClient = await edit(owner, { labels: [{ name: 'bUG', color: 'gray' }] })
    assert.ok('issue' in oldClient)
    assert.deepEqual(oldClient.issue!.metadata.labels, [{ name: 'Bug', color: 'red' }])
    assert.deepEqual(oldClient.issue!.metadata.labelIds, [bug.id])
    const options = await as(member, () => actions.getNewTaskOptions(workspace.id))
    assert.ok(options.labelRecords.some(label => label.id === review.id), 'an unused registry label is selectable')
    const taskOptions = await as(owner, () => actions.getIssuePropertyOptions(privateTask))
    assert.deepEqual(taskOptions.labelRecords, options.labelRecords)
    const { rows: countBefore } = await pool.query('SELECT count(*)::int n FROM issues WHERE "userId"=$1', [member])
    const invalid = command([foreign.id])
    assert.ok((await as(member, () => tasks.createTaskOnly(invalid))).error)
    assert.deepEqual((await pool.query('SELECT count(*)::int n FROM issues WHERE "userId"=$1', [member])).rows, countBefore)
    assert.equal((await pool.query('SELECT 1 FROM task_creation_receipts WHERE "requestId"=$1', [invalid.requestId])).rowCount, 0)
    assert.equal((await pool.query('SELECT 1 FROM workspace_issue_labels WHERE name=\'Unregistered\'')).rowCount, 0)
  })

  await t.test('MCP and Linear compatibility names resolve local IDs and cannot create entities or override their color', async () => {
    const { actAs } = await import('../lib/acting-user')
    const { tokenWorkspace } = await import('../lib/tokens/principal')
    const mcp = await import('../lib/mcp/actions')
    const scoped = <T>(work: () => Promise<T>) => actAs({ id: owner, [tokenWorkspace]: workspace.id }, work)
    const before = await taskRow(privateTask)
    assert.deepEqual(await scoped(() => mcp.updateIssue(owner, { issueId: privateTask, title: 'Must not save', labels: ['Unregistered'] })), { error: 'issueMetadataInvalid' })
    assert.deepEqual(await taskRow(privateTask), before)
    const count = (await pool.query('SELECT count(*)::int n FROM issues WHERE "userId"=$1', [owner])).rows
    assert.deepEqual(await scoped(() => mcp.createIssue(owner, { title: 'Must not create', labels: ['Unregistered'] })), { error: 'issueMetadataInvalid' })
    assert.deepEqual((await pool.query('SELECT count(*)::int n FROM issues WHERE "userId"=$1', [owner])).rows, count)
    const created = await scoped(() => mcp.createIssue(owner, { title: 'Create with workspace labels', labels: ['Review', 'BUG'] }))
    assert.ok('id' in created)
    assert.deepEqual(await refs(created.id), [review.id, bug.id])
    assert.ok('id' in await scoped(() => mcp.updateIssue(owner, { issueId: privateTask, labels: ['Review', 'BUG'] })))
    assert.deepEqual(await refs(privateTask), [review.id, bug.id])
    const { linearTeamSyncs } = await import('../lib/db/schema')
    const { createAppIssueFromLinear, applyLinearIssueToApp, LinearSyncConflictError } = await import('../lib/linear-sync/issue-sync')
    const [binding] = await db.insert(linearTeamSyncs).values({ id: randomUUID(), ownerId: owner, workspaceId: workspace.id,
      linearTeamId: randomUUID(), linearTeamKey: 'LBL', linearTeamName: 'Labels' }).returning()
    const remote = { id: randomUUID(), identifier: 'LBL-1', title: 'Imported task', description: '', dueDate: null, priority: 0,
      url: 'https://example.invalid/linear', updatedAt: new Date().toISOString(), state: null,
      team: { id: binding.linearTeamId, key: binding.linearTeamKey, name: binding.linearTeamName }, assignee: null, labels: [{ id: 'provider-label', name: 'BUG', color: '#000000' }] }
    const imported = await createAppIssueFromLinear(binding, remote)
    assert.ok(imported)
    assert.deepEqual(await refs(imported.id), [bug.id])
    assert.deepEqual((await taskRow(imported.id)).content.attrs.mikka.labels, [{ name: 'Bug', color: 'red' }])
    await assert.rejects(createAppIssueFromLinear(binding, { ...remote, id: randomUUID(), labels: [{ id: 'unknown', name: 'Unregistered', color: null }] }), LinearSyncConflictError)
    const importedBefore = await taskRow(imported.id)
    await assert.rejects(applyLinearIssueToApp(binding, { ...remote, updatedAt: new Date(Date.now() + 60_000).toISOString(), title: 'Must not apply', labels: [{ id: 'unknown', name: 'Unregistered', color: null }] }, true), LinearSyncConflictError)
    assert.deepEqual(await taskRow(imported.id), importedBefore)
  })

  await t.test('rename, merge and deletion atomically update task references, display snapshots and new history without rewriting old versions', async () => {
    const before = await taskRow(privateTask)
    const history = (await pool.query('SELECT revision,content FROM issue_versions WHERE "issueId"=$1 ORDER BY revision', [privateTask])).rows
    const renamed = await as(owner, () => item.PATCH(request('PATCH', { name: 'Defect', color: 'yellow' }), context(bug.id)))
    assert.equal(renamed.status, 200)
    assert.deepEqual(await refs(privateTask), [review.id, bug.id])
    let row = await taskRow(privateTask)
    assert.equal(row.revision, before.revision + 1)
    assert.deepEqual(row.content.attrs.mikka.labels, [{ name: 'Review', color: 'blue' }, { name: 'Defect', color: 'yellow' }])
    assert.deepEqual((await pool.query('SELECT revision,content FROM issue_versions WHERE "issueId"=$1 AND revision<=$2 ORDER BY revision', [privateTask, before.revision])).rows, history)
    const merged = await as(owner, () => merge.POST(request('POST', { targetId: review.id }), context(bug.id)))
    assert.equal(merged.status, 200)
    assert.deepEqual(await refs(privateTask), [review.id])
    assert.deepEqual(await refs(memberTask), [review.id])
    assert.equal((await pool.query('SELECT 1 FROM workspace_issue_labels WHERE id=$1', [bug.id])).rowCount, 0)
    assert.equal((await as(owner, () => item.DELETE(request('DELETE'), context(review.id)))).status, 200)
    assert.deepEqual(await refs(privateTask), [])
    assert.deepEqual(await refs(memberTask), [])
    row = await taskRow(privateTask)
    assert.deepEqual(row.content.attrs.mikka.labels, [])
    assert.deepEqual(row.content.attrs.mikka.labelIds, [])
    assert.equal((await pool.query('SELECT 1 FROM issue_label_refs WHERE workspace_id=$1', [workspace.id])).rowCount, 0)
    assert.equal((await pool.query('SELECT 1 FROM workspace_issue_labels WHERE id=$1', [foreign.id])).rowCount, 1)
  })

  await t.test('migration backfills existing free labels deterministically, preserves unscoped history and is repeatable after later deletes', async () => {
    const sql = await readFile(new URL('../drizzle/20261120190715_workspace_task_labels.sql', import.meta.url), 'utf8')
    const client = await pool.connect()
    const schema = `label_upgrade_${randomUUID().replaceAll('-', '')}`
    const first = randomUUID(), second = randomUUID(), historical = randomUUID(), foreignTask = randomUUID()
    const document = (name: string, color: string) => ({ type: 'doc', attrs: { mikka: { number: 1, labels: [{ name, color }] } }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep the document' }] }] })
    try {
      await client.query(`CREATE SCHEMA "${schema}"`)
      await client.query(`SET search_path TO "${schema}",public`)
      // The real migrated task shape, without triggers: this migration adds no
      // task columns. This is the pre-label data boundary, not a replacement writer.
      await client.query('CREATE TABLE issues (LIKE public.issues INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING GENERATED); ALTER TABLE issues ADD PRIMARY KEY(id)')
      for (const [id, tenant, name, color, created] of [[first, workspace.id, 'Bug', 'red', '2026-01-01'], [second, workspace.id, 'BUG', 'blue', '2026-01-02'],
        [historical, null, 'Unscoped', 'green', '2026-01-01'], [foreignTask, other.id, 'Bug', 'violet', '2026-01-01']]) {
        await client.query('INSERT INTO issues(id,"userId","workspaceId","ownershipState",title,content,status,priority,"createdAt") VALUES($1,$2,$3,CASE WHEN $3::uuid IS NULL THEN \'pending\' ELSE \'bound\' END,\'Task\',$4,\'todo\',\'normal\',$5)',
          [id, owner, tenant, JSON.stringify(document(name!, color!)), created])
      }
      const historicalBefore = (await client.query('SELECT * FROM issues WHERE id=$1', [historical])).rows
      await client.query(sql)
      const rows = (await client.query('SELECT workspace_id,name,color FROM workspace_issue_labels ORDER BY workspace_id')).rows
      assert.deepEqual(rows.find(row => row.workspace_id === workspace.id), { workspace_id: workspace.id, name: 'Bug', color: 'red' })
      assert.deepEqual(rows.find(row => row.workspace_id === other.id), { workspace_id: other.id, name: 'Bug', color: 'violet' })
      assert.equal(rows.length, 2)
      assert.equal((await client.query('SELECT count(DISTINCT label_id)::int n FROM issue_label_refs WHERE issue_id=ANY($1::uuid[])', [[first, second]])).rows[0].n, 1)
      assert.deepEqual((await client.query('SELECT * FROM issues WHERE id=$1', [historical])).rows, historicalBefore)
      const snapshot = async () => ({ tasks: (await client.query('SELECT * FROM issues ORDER BY id')).rows,
        labels: (await client.query('SELECT * FROM workspace_issue_labels ORDER BY id')).rows, refs: (await client.query('SELECT * FROM issue_label_refs ORDER BY issue_id,label_id')).rows })
      const once = await snapshot()
      await client.query(sql)
      assert.deepEqual(await snapshot(), once)
      await client.query(`UPDATE issues SET content=jsonb_set(jsonb_set(content,'{attrs,mikka,labelIds}','[]'),'{attrs,mikka,labels}','[]') WHERE "workspaceId"=$1`, [workspace.id])
      await client.query('DELETE FROM workspace_issue_labels WHERE workspace_id=$1', [workspace.id])
      await client.query(sql)
      assert.equal((await client.query('SELECT 1 FROM workspace_issue_labels WHERE workspace_id=$1', [workspace.id])).rowCount, 0, 'replay does not resurrect a deleted label')
    } finally {
      await client.query('SET search_path TO public')
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      client.release()
    }
  })
})
