import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
// Framework/session plumbing only; every writer, store and ACL below is real.
import './fixtures/activity-runtime.mjs'
import { dbUrl, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'

/**
 * The task page's property panel, as data: which of Capy's `PATCH /issues/:code`
 * fields this codebase can actually persist and show. This file is a
 * characterization test — it asserts today's behaviour, including the parts the
 * panel cannot reach, so a later change that closes a gap has to move a test
 * rather than silently disagree with one.
 *
 * Capy's update payload (backlog/20261111/rea/data/routes.json):
 *   title, description, status, stateId, priority, dueAt, assignee, assignees,
 *   parentCode, visibility, labelIds, threadOrder, files
 */
test('Task property panel: which Capy update fields round-trip through this codebase', { skip: !dbUrl, timeout: 120_000 }, async t => {
  const { pool } = await import('../lib/db')
  const { actAs } = await import('../lib/acting-user')
  const { tokenWorkspace } = await import('../lib/tokens/principal')
  const { updateIssueMetadata } = await import('../app/actions/issue-metadata')
  const { getIssue } = await import('../app/actions/issues')
  const { updateIssueRelation } = await import('../app/actions/issue-operations')
  const { readIssueMetadata } = await import('../lib/issue-metadata')

  const owner = await seedUser(pool, 'properties-owner')
  const peer = await seedUser(pool, 'properties-peer')
  const alpha = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: peer, role: 'member' }])
  const taskId = await seedIssue(pool, owner, alpha.id)
  const otherTaskId = await seedIssue(pool, owner, alpha.id)
  const scoped = <T>(work: () => Promise<T>) => actAs({ id: owner, [tokenWorkspace]: alpha.id }, work)
  const row = async (id = taskId) => (await pool.query('SELECT id,revision,content,status,priority FROM issues WHERE id=$1', [id])).rows[0]
  const save = async (patch: Parameters<typeof updateIssueMetadata>[0]['patch']) => {
    const current = await row()
    return scoped(() => updateIssueMetadata({ id: taskId, revision: current.revision, patch }))
  }
  // What a person sees after a reload: one fresh read of the stored task.
  const reread = async () => {
    const result = await scoped(() => getIssue(taskId))
    assert.ok('issue' in result && result.issue, JSON.stringify(result))
    return result.issue
  }
  const stored = async () => readIssueMetadata((await row()).content)

  await t.test('dueDate round-trips and survives a reload', async () => {
    const saved = await save({ dueDate: '2026-12-31' })
    assert.ok('issue' in saved && saved.issue, JSON.stringify(saved))
    assert.equal((await stored()).dueDate, '2026-12-31')
    assert.equal((await reread()).metadata.dueDate, '2026-12-31')
    // Clearing it is a real write, not an omitted key.
    const cleared = await save({ dueDate: null })
    assert.ok('issue' in cleared && cleared.issue, JSON.stringify(cleared))
    assert.equal((await stored()).dueDate, null)
    assert.equal((await reread()).metadata.dueDate, null)
  })

  await t.test('labels round-trip and survive a reload', async () => {
    const saved = await save({ labels: [{ name: 'regression', color: 'red' }, { name: 'ui', color: 'blue' }] })
    assert.ok('issue' in saved && saved.issue, JSON.stringify(saved))
    assert.deepEqual((await reread()).metadata.labels.map(label => label.name).sort(), ['regression', 'ui'])
    const cleared = await save({ labels: [] })
    assert.ok('issue' in cleared && cleared.issue, JSON.stringify(cleared))
    assert.deepEqual((await reread()).metadata.labels, [])
  })

  await t.test('assignee round-trips and survives a reload', async () => {
    const saved = await save({ assignee: { kind: 'member', id: peer } })
    assert.ok('issue' in saved && saved.issue, JSON.stringify(saved))
    assert.equal((await reread()).metadata.assignee?.id, peer)
    const cleared = await save({ assignee: null })
    assert.ok('issue' in cleared && cleared.issue, JSON.stringify(cleared))
    assert.equal((await reread()).metadata.assignee, null)
  })

  await t.test('estimate round-trips and survives a reload', async () => {
    const saved = await save({ estimate: 5 })
    assert.ok('issue' in saved && saved.issue, JSON.stringify(saved))
    assert.equal((await reread()).metadata.estimate, 5)
    const cleared = await save({ estimate: null })
    assert.ok('issue' in cleared && cleared.issue, JSON.stringify(cleared))
    assert.equal((await reread()).metadata.estimate, null)
  })

  await t.test('parent is set and cleared through the relation action, not the metadata patch', async () => {
    const current = await row()
    const linked = await scoped(() => updateIssueRelation({ id: taskId, revision: current.revision, targetId: otherTaskId, kind: 'parent' }))
    assert.ok('issue' in linked && linked.issue, JSON.stringify(linked))
    assert.equal((await stored()).parentId, otherTaskId)
    assert.equal((await reread()).metadata.parentId, otherTaskId)

    const afterLink = await row()
    const removed = await scoped(() => updateIssueRelation({ id: taskId, revision: afterLink.revision, targetId: null, kind: 'parent', remove: true }))
    assert.ok('issue' in removed && removed.issue, JSON.stringify(removed))
    assert.equal((await stored()).parentId, null)
    assert.equal((await reread()).metadata.parentId, null)
  })

  await t.test('the metadata patch refuses the fields it does not own', async () => {
    // .strict(): an unknown key is a refusal, never a silent no-op that would
    // make a dead control look like a working one.
    for (const unknown of [{ threadOrder: 3 }, { assignees: [peer] }, { stateId: randomUUID() }, { visibility: 'shared' }]) {
      const current = await row()
      const result = await scoped(() => updateIssueMetadata({ id: taskId, revision: current.revision, patch: unknown as never }))
      assert.equal((result as { error?: string }).error, 'issueMetadataInvalid', `${Object.keys(unknown)[0]} is refused`)
      assert.equal((await row()).revision, current.revision, `${Object.keys(unknown)[0]} writes nothing`)
    }
  })

  await t.test('a stale revision still loses the optimistic lock', async () => {
    const current = await row()
    const saved = await scoped(() => updateIssueMetadata({ id: taskId, revision: current.revision, patch: { dueDate: '2027-01-15' } }))
    assert.ok('issue' in saved && saved.issue, JSON.stringify(saved))
    // The same revision again, now one behind.
    const stale = await scoped(() => updateIssueMetadata({ id: taskId, revision: current.revision, patch: { dueDate: '2027-02-20' } }))
    assert.equal((stale as { error?: string }).error, 'issueOutdated')
    assert.equal((await stored()).dueDate, '2027-01-15', 'the stale write changed nothing')
  })
})
