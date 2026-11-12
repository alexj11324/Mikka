import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
// Framework/session plumbing only; all writers, membership, stores and ACLs below are real.
import './fixtures/activity-runtime.mjs'
import { dbUrl, seedAgent, seedBot, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('Task responsibility: actual actions, MCP compatibility, tenant denial and live membership projection', { skip: !dbUrl, timeout: 120_000 }, async t => {
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { actAs } = await import('../lib/acting-user')
  const { agentActor } = await import('../lib/activity-actor')
  const { tokenWorkspace } = await import('../lib/tokens/principal')
  const { updateIssueMetadata } = await import('../app/actions/issue-metadata')
  const { getIssue, moveIssue, pollIssues } = await import('../app/actions/issues')
  const { updateIssue } = await import('../lib/mcp/actions')
  const { getIssue: readToolIssue, listIssues: listToolIssues } = await import('../lib/mcp/tools')
  const { AgentProfileStore } = await import('../lib/factory/agent-profile-store')
  const { readIssueMetadata } = await import('../lib/issue-metadata')
  const owner = await seedUser(pool, 'responsibility-owner'), member = await seedUser(pool, 'responsibility-member'), foreign = await seedUser(pool, 'responsibility-foreign')
  const alpha = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  const beta = await seedWorkspace(pool, foreign, [{ userId: foreign, role: 'admin' }, { userId: owner, role: 'member' }])
  const taskId = await seedIssue(pool, owner, alpha.id, { registered: true })
  const taskIds: string[] = [taskId]
  const ownAgent = await seedAgent(pool, owner), foreignAgent = await seedAgent(pool, foreign)
  const ownBot = await seedBot(pool, alpha.id, owner), foreignBot = await seedBot(pool, beta.id, owner)
  const profiles = new AgentProfileStore(pool)
  const ownProfile = await profiles.create({ ownerId: owner, workspaceId: alpha.id }, { name: 'Task responsibility profile' })
  const foreignProfile = await profiles.create({ ownerId: owner, workspaceId: beta.id }, { name: 'Another workspace profile' })
  const scoped = <T>(work: () => Promise<T>, workspaceId = alpha.id) => actAs({ id: owner, [tokenWorkspace]: workspaceId }, work)
  const row = async () => (await pool.query('SELECT id,content,revision,"updatedAt" FROM issues WHERE id=$1', [taskId])).rows[0]
  const save = async (patch: Parameters<typeof updateIssueMetadata>[0]['patch'], extra: { inviteEmail?: string } = {}) => {
    const current = await row()
    return scoped(() => updateIssueMetadata({ id: taskId, revision: current.revision, patch, ...extra }))
  }
  const snapshot = async () => ({
    issue: await row(),
    versions: (await pool.query('SELECT id,revision,content,actor_type,actor_id FROM issue_versions WHERE "issueId"=$1 ORDER BY revision,id', [taskId])).rows,
    members: (await pool.query('SELECT * FROM issue_members WHERE "issueId"=$1 ORDER BY "memberId"', [taskId])).rows,
    approvals: (await pool.query('SELECT id FROM factory_approvals WHERE "userId"=$1 ORDER BY id', [owner])).rows,
  })
  const unchanged = async (work: () => Promise<unknown>, code: string) => {
    const before = await snapshot()
    const result = await work() as { error?: string }
    assert.equal(result.error, code, JSON.stringify(result))
    assert.deepEqual(await snapshot(), before, 'refusal changes no task, history, invitation or approval')
  }
  try {
    await t.test('Board unblocks and moves a Task in the same revision read by Task detail', async () => {
      const flag = await save({ block: { blocked: true, runId: null } })
      assert.ok('issue' in flag && flag.issue, JSON.stringify(flag))
      const revision = flag.issue.revision
      const status = flag.issue.status === 'done' ? 'todo' : 'done'
      const block = { blocked: false, runId: null }
      const move = () => scoped(() => moveIssue({ id: taskId, revision, status, block }))
      const moved = await move()
      assert.ok('issue' in moved && moved.issue, JSON.stringify(moved))
      assert.equal(moved.issue.revision, revision + 1)
      const detail = await scoped(() => getIssue(taskId))
      assert.ok('issue' in detail && detail.issue)
      assert.equal(detail.issue.status, status)
      assert.deepEqual(detail.issue.metadata.block, block)
      const history = await pool.query('SELECT revision,status,content FROM issue_versions WHERE "issueId"=$1 AND revision>$2', [taskId, revision])
      assert.equal(history.rowCount, 1)
      assert.equal(history.rows[0].status, status)
      assert.deepEqual(readIssueMetadata(history.rows[0].content).block, block)
      await unchanged(move, 'issueStale')
    })

    await t.test('human assignee and Agent Delegate coexist through the real metadata action', async () => {
      const result = await save({ assignee: { kind: 'member', id: member }, delegate: { kind: 'agent', id: ownAgent } })
      assert.ok('issue' in result && result.issue, JSON.stringify(result))
      assert.equal(result.issue.metadata.assignee?.id, member)
      assert.equal(result.issue.metadata.assignee?.kind, 'member')
      assert.equal(result.issue.metadata.delegate?.id, ownAgent)
      const stored = readIssueMetadata((await row()).content)
      assert.equal(stored.assignee?.id, member)
      assert.equal(stored.delegate?.id, ownAgent)
      const toolView = await scoped(() => readToolIssue(owner, taskId))
      assert.equal(toolView?.identifier, result.issue.identifier)
      assert.equal(toolView?.assignee?.id, member)
      assert.equal(toolView?.delegate?.id, ownAgent)
      assert.equal((await scoped(() => listToolIssues(owner, {}))).find(task => task.id === taskId)?.identifier, result.issue.identifier)
    })

    await t.test('legacy MCP assignment and clearing affect delegation only', async () => {
      const assigned = await scoped(() => updateIssue(owner, { issueId: taskId, assigneeAgentId: ownAgent }, agentActor(ownAgent)))
      assert.ok('id' in assigned, JSON.stringify(assigned))
      assert.equal(assigned.assignee, 'responsibility-member')
      assert.equal(assigned.delegate?.id, ownAgent)
      const cleared = await scoped(() => updateIssue(owner, { issueId: taskId, assigneeAgentId: null }, agentActor(ownAgent)))
      assert.ok('id' in cleared, JSON.stringify(cleared))
      assert.equal(cleared.assignee, 'responsibility-member')
      assert.equal(cleared.delegate, null)
      assert.equal(readIssueMetadata((await row()).content).assignee?.id, member)
      const current = await row()
      const legacy = await actAs({ id: owner, [tokenWorkspace]: alpha.id }, () => updateIssueMetadata({ id: taskId, revision: current.revision, patch: { assignee: { kind: 'agent', id: ownAgent } } }), agentActor(ownAgent))
      assert.ok('issue' in legacy && legacy.issue)
      assert.equal(legacy.issue.metadata.assignee?.id, member)
      assert.equal(legacy.issue.metadata.delegate?.id, ownAgent)
      await unchanged(() => save({ assignee: { kind: 'agent', id: ownAgent } }), 'issueMetadataInvalid')
    })

    await t.test('foreign references and a PAT pinned to another Workspace leave zero mutations', async () => {
      for (const delegate of [{ kind: 'agent' as const, id: foreignAgent }, { kind: 'bot' as const, id: foreignBot }, { kind: 'profile' as const, id: foreignProfile.id }]) {
        await unchanged(() => save({ assignee: { kind: 'member', id: owner }, delegate }), 'agentNotFound')
      }
      await unchanged(() => save({ delegate: { kind: 'bot', id: foreignBot } }, { inviteEmail: `${member}@example.invalid` }), 'agentNotFound')
      await unchanged(async () => {
        const current = await row()
        return scoped(() => updateIssueMetadata({ id: taskId, revision: current.revision, patch: { delegate: { kind: 'agent', id: ownAgent } } }), beta.id)
      }, 'issueNotFound')
      await unchanged(() => save({ assignee: { kind: 'member', id: foreign } }), 'issueNotFound')
    })

    await t.test('same-Workspace Bot, Profile and the immutable default Profile are valid independent delegates', async () => {
      for (const delegate of [{ kind: 'bot' as const, id: ownBot }, { kind: 'profile' as const, id: ownProfile.id }, { kind: 'profile' as const, id: 'default' }]) {
        const result = await save({ delegate })
        assert.ok('issue' in result && result.issue, JSON.stringify(result))
        assert.equal(result.issue.metadata.assignee?.id, member)
        assert.equal(result.issue.metadata.delegate?.id, delegate.id)
      }
    })

    await t.test('suspension invalidates detail and an unchanged-list cursor without rewriting history', async () => {
      const before = await snapshot()
      const listed = await scoped(() => pollIssues())
      assert.equal(listed.items?.find(task => task.id === taskId)?.metadata.assignee?.id, member)
      await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [alpha.id, member])
      const polled = await scoped(() => pollIssues(listed.version, listed.positions))
      assert.notEqual(polled.version, listed.version)
      assert.equal(polled.items?.find(task => task.id === taskId)?.metadata.assignee, null)
      const detail = await scoped(() => getIssue(taskId))
      assert.ok('issue' in detail && detail.issue)
      assert.equal(detail.issue.metadata.assignee, null)
      assert.equal((await scoped(() => readToolIssue(owner, taskId)))?.assignee, null)
      assert.deepEqual(await snapshot(), before)
      await unchanged(() => save({ assignee: { kind: 'member', id: member } }), 'issueNotFound')
      await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [alpha.id, member])
    })

    await t.test('a Delegate reference does not authorize the human approval transport', async () => {
      const assigned = await save({ delegate: { kind: 'agent', id: ownAgent } })
      assert.ok('issue' in assigned && assigned.issue)
      const { factoryApprovals } = await import('../lib/factory/server')
      const { handleFactoryApproval } = await import('../lib/factory/approval-http')
      const before = await snapshot()
      const request = await handleFactoryApproval(factoryApprovals, {
        actor: { userId: owner, sessionId: randomUUID() }, authorization: `Bearer delegated-${ownAgent}`,
        method: 'POST', taskId: randomUUID(), origin: 'https://mikka.example.invalid', url: 'https://mikka.example.invalid/api/factory/tasks/fixture/approval',
        body: { operation: 'approve', input: { delegate: { kind: 'agent', id: ownAgent } } },
      })
      assert.deepEqual(request, { status: 401, body: { error: 'factoryHumanRequired' } })
      assert.deepEqual(await snapshot(), before)
    })

    await t.test('copying a peer task never imports that peer private execution delegate', async () => {
      const { createLinkedIssue } = await import('../app/actions/issue-operations')
      const current = await row()
      const duplicated = await actAs({ id: member, [tokenWorkspace]: alpha.id }, () => createLinkedIssue({ id: taskId, revision: current.revision, kind: 'duplicate' }))
      assert.ok('issue' in duplicated && duplicated.issue, JSON.stringify(duplicated))
      taskIds.push(duplicated.issue.id)
      assert.equal(duplicated.issue.userId, member)
      assert.equal(duplicated.issue.metadata.assignee, null)
      assert.equal(duplicated.issue.metadata.delegate, null)
      assert.equal(readIssueMetadata((await row()).content).delegate?.id, ownAgent)
    })
  } finally {
    await pool.query('DELETE FROM issue_versions WHERE "issueId"=ANY($1::uuid[])', [taskIds])
    await pool.query('DELETE FROM issue_members WHERE "issueId"=ANY($1::uuid[])', [taskIds])
    await pool.query('DELETE FROM issues WHERE id=ANY($1::uuid[])', [taskIds])
    await pool.query('DELETE FROM factory_agent_profile_versions WHERE "ownerId"=$1', [owner])
    await pool.query('DELETE FROM factory_agent_profiles WHERE "ownerId"=$1', [owner])
    await pool.query('DELETE FROM bots WHERE id=ANY($1::uuid[])', [[ownBot, foreignBot]])
    await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [[ownAgent, foreignAgent]])
    await pool.query('DELETE FROM workspace_task_identifier_counters WHERE "workspaceId"=ANY($1::uuid[])', [[alpha.id, beta.id]])
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=ANY($1::uuid[])', [[alpha.id, beta.id]])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [[alpha.id, beta.id]])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[owner, member, foreign]])
    await Promise.all([pool.end(), workspacePool.end()])
  }
})
