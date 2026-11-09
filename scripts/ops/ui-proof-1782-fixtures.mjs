import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

// All attempts are already ended, and share the base fixture's disabled device.
// They do not dispatch work or contact a model/provider.
export const CASES = Object.freeze([
  { key: 'waiting', title: 'Confirm the review direction', taskStatus: 'doing', runStatus: 'succeeded', outcome: 'needs_input', group: 'pending', state: 'waiting' },
  { key: 'blocked', title: 'Access is blocked', taskStatus: 'doing', runStatus: 'succeeded', outcome: 'blocked', group: 'pending', state: 'blocked' },
  { key: 'failed', title: 'The check needs repair', taskStatus: 'doing', runStatus: 'failed', outcome: 'failed', group: 'pending', state: 'failed' },
  { key: 'open', title: 'Follow-up remains open', taskStatus: 'doing', runStatus: 'succeeded', outcome: 'done', group: 'todo', state: 'todo' },
  { key: 'done', title: 'The completed task', taskStatus: 'done', runStatus: 'succeeded', outcome: 'done', group: 'done', state: 'done' },
])

const quote = value => `"${value.replaceAll('"', '""')}"`

export async function extendFixtures(scope, base) {
  const owner = scope.owner.userId
  const workspace = base.workspace
  const rows = CASES.map(value => ({ ...value, id: value.key === 'open' ? base.issue : randomUUID(),
    run: value.key === 'open' ? base.run : randomUUID(), version: value.key === 'open' ? base.version : randomUUID(),
    chunk: value.key === 'open' ? base.chunk : randomUUID(), identifier: null }))
  const added = rows.filter(row => row.key !== 'open')
  const delegationVersion = randomUUID()
  const project = { id: randomUUID(), name: 'Review project', revision: 1 }
  const resources = [
    ...added.flatMap(row => [['issues', row.id], ['issue_versions', row.version], ['team_issues', row.id], ['agent_runs', row.run], ['run_chunks', row.chunk]]),
    ['issue_versions', delegationVersion],
  ]
  // Reserve every fresh key through the existing lease/absence checks first.
  for (const [type, id] of resources) await scope.recordResource({ type, id, ownerId: owner })
  async function transaction(work) {
    await scope.assertActive()
    return scope.pool.transaction(async client => {
      await scope.pool.current(client, scope.lease)
      const result = await work(client)
      await scope.pool.current(client, scope.lease)
      return result
    })
  }
  async function insert(client, table, values) {
    const entries = Object.entries(values)
    await client.query(`INSERT INTO public.${quote(table)} (${entries.map(([key]) => quote(key)).join(',')}) VALUES (${entries.map((_, index) => `$${index + 1}`).join(',')})`, entries.map(([, value]) => value))
  }
  let seeded = false
  async function cleanup() {
    await transaction(async client => {
      const existing = (await client.query('SELECT id,"workspaceId","userId",revision,name FROM public.workspace_projects WHERE id=$1 FOR UPDATE', [project.id])).rows
      if (existing.length) {
        assert.equal(existing.length, 1)
        assert.deepEqual(existing[0], { id: project.id, workspaceId: workspace, userId: owner, revision: project.revision, name: project.name })
        // The read-only editor and refused stale write cannot create children.
        for (const table of ['workspace_project_events', 'workspace_project_tasks', 'workspace_project_members']) {
          assert.equal((await client.query(`SELECT count(*)::int AS count FROM public.${quote(table)} WHERE "projectId"=$1`, [project.id])).rows[0].count, 0, 'UI_PROOF_UNEXPECTED_PROJECT_CHILD')
        }
        assert.equal((await client.query('DELETE FROM public.workspace_projects WHERE id=$1 AND "workspaceId"=$2 AND "userId"=$3 AND revision=$4', [project.id, workspace, owner, project.revision])).rowCount, 1)
      }
      const ids = added.map(row => row.id), runs = added.map(row => row.run)
      // Only fresh reserved identifiers in this leased Workspace are targets.
      for (const [table, key, values] of [
        ['run_chunks', 'runId', runs], ['agent_runs', 'id', runs],
        ['issue_versions', 'id', [delegationVersion]], ['issue_versions', 'issueId', ids],
        ['issue_documents', 'issueId', ids], ['mikka_team_issues', 'issueId', ids], ['issues', 'id', ids],
      ]) await client.query(`DELETE FROM public.${quote(table)} WHERE ${quote(key)}::text=ANY($1::text[])`, [values])
    })
    for (const [type, id] of resources) await scope.markResourceCleaned({ type, id })
    return { additionalTasks: added.length, additionalRuns: added.length, additionalProjects: 1, cleaned: true }
  }
  try {
    await transaction(async client => {
      const originals = (await client.query('SELECT id,"userId","workspaceId",content FROM public.issues WHERE id=$1 AND "userId"=$2 AND "workspaceId"=$3 FOR UPDATE', [base.issue, owner, workspace])).rows
      assert.equal(originals.length, 1, 'UI_PROOF_BASE_TASK_MISSING')
      const content = structuredClone(originals[0].content)
      assert.equal(content.attrs.mikka.assignee.kind, 'member')
      assert.equal(content.attrs.mikka.assignee.id, owner)
      content.attrs.mikka.delegate = null
      const open = rows.find(row => row.key === 'open')
      const first = new Date(Date.parse(base.epoch) + 60_000).toISOString()
      const delegated = new Date(Date.parse(base.epoch) + 120_000).toISOString()
      await client.query('UPDATE public.issues SET title=$4,status=$5,content=$6,revision=2,"updatedAt"=$7 WHERE id=$1 AND "userId"=$2 AND "workspaceId"=$3',
        [open.id, owner, workspace, open.title, open.taskStatus, JSON.stringify({ ...content, attrs: { ...content.attrs, mikka: { ...content.attrs.mikka, delegate: { kind: 'bot', id: base.bot, name: base.botName, image: null } } } }), delegated])
      await client.query('UPDATE public.issue_versions SET title=$3,status=$4,content=$5 WHERE id=$1 AND "issueId"=$2', [base.version, open.id, open.title, open.taskStatus, JSON.stringify(content)])
      const current = (await client.query('SELECT content FROM public.issues WHERE id=$1', [open.id])).rows[0].content
      await insert(client, 'issue_versions', { id: delegationVersion, issueId: open.id, userId: owner, revision: 2, title: open.title, content: JSON.stringify(current), status: open.taskStatus, priority: 'normal', actor_type: 'user', actor_id: owner, createdAt: delegated })
      for (const row of added) {
        await insert(client, 'issues', { id: row.id, userId: owner, workspaceId: workspace, ownershipState: 'bound', title: row.title, content: JSON.stringify(content), status: row.taskStatus, priority: 'normal', scope: 'workspace', scopeSetBy: 'user', linearSyncBlocked: true, createdAt: first, updatedAt: first })
        await insert(client, 'issue_versions', { id: row.version, issueId: row.id, userId: owner, revision: 1, title: row.title, content: JSON.stringify(content), status: row.taskStatus, priority: 'normal', actor_type: 'user', actor_id: owner, createdAt: first })
        await insert(client, 'mikka_team_issues', { issueId: row.id, teamId: base.team, workspaceId: workspace, userId: owner, createdAt: first })
        await insert(client, 'agent_runs', { id: row.run, userId: owner, workspaceId: workspace, issueId: row.id, agentId: base.agent, botId: base.bot, deviceId: base.device,
          status: row.runStatus, kind: 'implement', prompt: 'Isolated visual acceptance fixture. No execution is dispatched.', lastReply: row.title, lastReplyPart: 'proof-answer', lastReplyAt: first,
          outcome: row.outcome, outcomeDecidedBy: 'decision', outcomeAt: first, startedAt: first, finishedAt: first, createdAt: first, updatedAt: first })
        await insert(client, 'run_chunks', { id: row.chunk, runId: row.run, seq: 1, chunk: JSON.stringify({ type: 'text-delta', id: 'proof-answer', delta: row.title }), createdAt: first })
      }
      const tasks = (await client.query('SELECT id,"issuedIdentifier",status,"ownershipState","workspaceId","userId" FROM public.issues WHERE id=ANY($1::uuid[]) ORDER BY id', [rows.map(row => row.id)])).rows
      assert.equal(tasks.length, 5, 'UI_PROOF_TASK_COUNT')
      for (const task of tasks) {
        const row = rows.find(row => row.id === task.id)
        assert.equal(task.userId, owner); assert.equal(task.workspaceId, workspace); assert.equal(task.ownershipState, 'bound'); assert.equal(task.status, row.taskStatus)
        assert.match(task.issuedIdentifier, /\S/)
        row.identifier = task.issuedIdentifier
      }
      const ended = (await client.query('SELECT id,status,outcome,"finishedAt" FROM public.agent_runs WHERE id=ANY($1::uuid[])', [rows.map(row => row.run)])).rows
      assert.equal(ended.length, 5)
      for (const run of ended) {
        const row = rows.find(row => row.run === run.id)
        assert.equal(run.status, row.runStatus); assert.equal(run.outcome, row.outcome); assert.ok(run.finishedAt)
      }
      assert.equal((await client.query('SELECT enabled FROM public.devices WHERE id=$1 AND "ownerId"=$2', [base.device, owner])).rows[0]?.enabled, false)
      assert.equal((await client.query('SELECT count(*)::int AS count FROM public.workspace_projects WHERE "workspaceId"=$1', [workspace])).rows[0].count, 0)
      assert.equal((await client.query('SELECT id FROM public.workspace_projects WHERE id=$1', [project.id])).rowCount, 0)
      // The already reserved, fresh Workspace owns this one synthetic Project.
      // This inserts no run, membership, relationship or external resource.
      await insert(client, 'workspace_projects', { id: project.id, workspaceId: workspace, userId: owner,
        name: project.name, summary: '', description: 'Local production-build visual acceptance.', status: 'planned', priority: 'normal', lead: '', team: 'Workspace',
        startDate: '', targetDate: '', properties: JSON.stringify({ color: 'green', members: [], labels: [], dependencyIds: [], milestones: [] }), issueIds: '[]', revision: 1,
        createdAt: first, updatedAt: first })
    })
    seeded = true
    base.issueTitle = rows.find(row => row.key === 'open').title
    return { rows, project, cleanup,
      advanceProjectRevision: () => transaction(async client => {
        // A real concurrent revision in the local fixture creates a stale form.
        // No HTTP response, component, auth or schema is replaced.
        const result = await client.query('UPDATE public.workspace_projects SET revision=revision+1,"updatedAt"=clock_timestamp() WHERE id=$1 AND "workspaceId"=$2 AND "userId"=$3 AND revision=$4 AND name=$5 RETURNING revision', [project.id, workspace, owner, project.revision, project.name])
        assert.equal(result.rowCount, 1, 'UI_PROOF_PROJECT_REVISION_MISMATCH')
        project.revision = result.rows[0].revision
        return project.revision
      }),
      assertProjectUnchanged: () => transaction(async client => {
        const result = (await client.query('SELECT id,"userId",revision,name FROM public.workspace_projects WHERE "workspaceId"=$1', [workspace])).rows
        assert.deepEqual(result, [{ id: project.id, userId: owner, revision: project.revision, name: project.name }], 'UI_PROOF_UNEXPECTED_PROJECT_WRITE')
        return true
      }),
    }
  } catch (error) {
    if (!seeded) await cleanup().catch(cleanupError => { error.addedCleanupFailure = cleanupError.name })
    throw error
  }
}
