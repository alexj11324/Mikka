import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { JSONContent } from '@tiptap/core'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { measured, readMetrics } from './helpers/read-metrics'
import { mergeList } from '../lib/list-poll'

// Only a disposable loopback *_e2e database is admissible; required in CI.
const required = process.env.REQUIRE_DB === '1'
const enabled = disposableDatabase()
if (required && !enabled) throw new Error('Issue list DB test requires a loopback *_e2e database')

test('the task list and a task\'s relations read metadata and checklist counts, not every body', { skip: !enabled }, async t => {
  const { pool } = await import('../lib/db')
  const { actAs } = await import('../lib/acting-user')
  const { saveIssue, listIssues, pollIssues } = await import('../app/actions/issues')
  const { listIssueConnections, updateIssueRelation } = await import('../app/actions/issue-operations')
  const { updateIssueMetadata } = await import('../app/actions/issue-metadata')
  const { issueChecklist } = await import('../lib/issue-checklist')
  const owner = `issue-list-${randomUUID()}`
  const peer = `issue-list-peer-${randomUUID()}`
  const workspaceId = randomUUID(), teamId = randomUUID(), requestId = randomUUID()
  // 30 tasks of about 10 KB each, with a nested checklist (2 of 3 checked).
  const item = (checked: boolean, nested?: JSONContent[]): JSONContent => ({ type: 'taskItem', attrs: { checked }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'taskItem step' }] }, ...(nested ?? [])] })
  const content = (index: number): JSONContent => ({ type: 'doc', content: [
    ...Array.from({ length: 30 }, (_, line) => ({ type: 'paragraph', content: [{ type: 'text', text: `Task ${index}, line ${line}: ${'words '.repeat(50)}` }] })),
    { type: 'taskList', content: [item(true, [{ type: 'taskList', content: [item(false)] }]), item(true)] },
  ] })
  try {
    await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [owner, `${owner}@example.invalid`])
    const ids: string[] = []
    for (let index = 0; index < 30; index++) {
      const saved = await actAs(owner, () => saveIssue({ title: `Task ${index}`, content: content(index), status: 'todo', priority: 'normal' }))
      assert.ok('issue' in saved && saved.issue, JSON.stringify(saved))
      ids.push(saved.issue.id)
    }
    const first = (await pool.query('select revision from issues where id=$1', [ids[0]])).rows[0].revision
    const estimated = await actAs(owner, () => updateIssueMetadata({ id: ids[0], revision: first, patch: { estimate: 5 } }))
    assert.ok('issue' in estimated && estimated.issue, JSON.stringify(estimated))

    const list = await measured(() => actAs(owner, () => listIssues()))
    assert.equal(list.value.length, 30)
    const expected = issueChecklist(content(0))
    assert.deepEqual(expected, { total: 3, checked: 2, percentage: 67 })
    for (const row of list.value) assert.deepEqual(row.checklist, expected)
    assert.equal(list.value.find(row => row.id === ids[0])?.metadata.estimate, 5)
    assert.equal('content' in list.value[0], false)

    const cold = await measured(() => actAs(owner, () => pollIssues()))
    const snapshot = cold.value
    assert.ok(snapshot.items)
    const quiet = await measured(() => actAs(owner, () => pollIssues(snapshot.version)))
    assert.equal(quiet.value.unchanged, true)
    assert.equal(quiet.value.items, undefined)
    assert.ok(quiet.bytes < list.bytes / 2, `unchanged ${quiet.bytes} B vs full ${list.bytes} B`)
    const restored = await measured(() => actAs(owner, () => pollIssues(snapshot.version, snapshot.positions)))
    assert.equal(restored.value.unchanged, true)
    await pool.query('update issues set title=$2 where id=$1', [ids[0], 'Renamed without a clock change'])
    const delta = await measured(() => actAs(owner, () => pollIssues(snapshot.version, snapshot.positions)))
    assert.equal(delta.value.delta, true)
    assert.deepEqual(delta.value.items?.map(row => row.id), [ids[0]], 'only the changed projection is read')
    const changed = await actAs(owner, () => pollIssues(snapshot.version))
    assert.ok(changed.items?.some(row => row.title === 'Renamed without a clock change'))
    assert.deepEqual(mergeList(snapshot.items!, delta.value), changed.items)
    assert.notEqual(changed.version, snapshot.version)
    await pool.query('update "user" set image=$2 where id=$1', [owner, 'https://example.invalid/changed-avatar.png'])
    assert.notEqual((await actAs(owner, () => pollIssues(changed.version))).version, changed.version, 'profile changes invalidate the list too')
    await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [peer, `${peer}@example.invalid`])
    const foreign = await actAs(peer, () => pollIssues(changed.version, changed.positions))
    assert.deepEqual(foreign.items, [], 'another identity cannot reuse an owner snapshot to obtain private tasks')
    assert.notEqual(foreign.version, changed.version)

    // ids[10]: parent ids[0], blocked by ids[12], related to ids[13], duplicate of ids[16]; ids[14] is its child, it blocks ids[15].
    const relate = async (id: string, targetId: string, kind: 'parent' | 'blockedBy' | 'related' | 'duplicate') => {
      const revision = (await pool.query('select revision from issues where id=$1', [id])).rows[0].revision
      const result = await actAs(owner, () => updateIssueRelation({ id, revision, targetId, kind }))
      assert.ok('issue' in result, JSON.stringify(result))
    }
    await relate(ids[10], ids[0], 'parent')
    await relate(ids[10], ids[12], 'blockedBy')
    await relate(ids[10], ids[13], 'related')
    await relate(ids[10], ids[16], 'duplicate')
    await relate(ids[14], ids[10], 'parent')
    await relate(ids[15], ids[10], 'blockedBy')
    await relate(ids[17], ids[18], 'related')
    const relations = await measured(() => actAs(owner, () => listIssueConnections(ids[10])))
    // The rows the relations panel and subtasks use, picked from every task the owner has (listIssues reads them all).
    const everything = await actAs(owner, () => listIssues())
    const current = everything.find(row => row.id === ids[10])!.metadata
    const linked = everything.filter(row => row.id === ids[10] || row.id === current.parentId || row.id === current.duplicateOfId || current.blockedByIds.includes(row.id) || current.relatedIds.includes(row.id)
      || row.metadata.parentId === ids[10] || row.metadata.blockedByIds.includes(ids[10]) || row.metadata.relatedIds.includes(ids[10]))
    assert.deepEqual(relations.value.map(row => row.id).sort(), [ids[0], ids[10], ids[12], ids[13], ids[14], ids[15], ids[16]].sort())
    assert.deepEqual(relations.value.map(row => row.id).sort(), linked.map(row => row.id).sort(), 'exactly the tasks the panel shows')
    for (const row of relations.value) {
      const listed = everything.find(item => item.id === row.id)!
      assert.deepEqual({ metadata: row.metadata, identifier: row.identifier, title: row.title, status: row.status }, { metadata: listed.metadata, identifier: listed.identifier, title: listed.title, status: listed.status })
    }
    assert.equal(relations.value.find(row => row.id === ids[0])?.metadata.estimate, 5)
    const unrelated = await actAs(owner, () => listIssueConnections(ids[19]))
    assert.deepEqual(unrelated.map(row => row.id), [ids[19]], 'a task with no links reads only itself')

    const bodies = (await pool.query('select sum(length(content::text))::int n from issues where "userId"=$1', [owner])).rows[0].n
    t.diagnostic(JSON.stringify({ tasks: 30, bodyBytes: bodies, listIssuesDbBytes: list.bytes, listIssueConnectionsDbBytes: relations.bytes }))
    // Reading every body would cost at least `bodies` bytes.
    assert.ok(list.bytes < bodies / 5, `listIssues read ${list.bytes} B for ${bodies} B of bodies`)
    assert.ok(relations.bytes < bodies / 5, `listIssueConnections read ${relations.bytes} B for ${bodies} B of bodies`)
    // 7 of the owner's 30 tasks: well under the whole list's metadata.
    assert.ok(relations.bytes < list.bytes, `listIssueConnections read ${relations.bytes} B, the whole list ${list.bytes} B`)
    const { withActivitySession } = await import('./fixtures/activity-runtime.mjs')
    const { promoteExistingIssueForUser } = await import('../lib/team-issue-promotion')
    await pool.query('insert into mikka_workspaces(id,"userId",name) values($1,$2,$3)', [workspaceId, owner, 'Egress visibility fixture'])
    await pool.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$2,$3,$4)', [workspaceId, peer, `${peer}@example.invalid`, 'member'])
    await pool.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$2,$3,$4)', [workspaceId, owner, `${owner}@example.invalid`, 'admin'])
    await pool.query('insert into mikka_teams(id,"workspaceId","userId",name,identifier) values($1,$2,$3,$4,$5)', [teamId, workspaceId, owner, 'Fixture team', 'EGRESS'])
    const promotion = await promoteExistingIssueForUser(owner, { requestId, issueId: ids[1], revision: 1, teamId, expectedTeamId: null })
    assert.ok('issue' in promotion, JSON.stringify(promotion))
    const shared = await withActivitySession(peer, () => actAs(peer, () => pollIssues()), workspaceId)
    assert.equal(shared.items?.length, 1)
    await pool.query('update mikka_workspace_members set status=$3 where "workspaceId"=$1 and "userId"=$2', [workspaceId, peer, 'suspended'])
    const revoked = await withActivitySession(peer, () => actAs(peer, () => pollIssues(shared.version, shared.positions)), workspaceId)
    assert.deepEqual(revoked.items, [], 'revocation falls back to the personal workspace and clears the formerly shared row')
    assert.deepEqual(mergeList(shared.items!, revoked), [], 'the authoritative manifest removes the revoked cached task')
    assert.notEqual(revoked.version, shared.version, 'revocation cannot return an unchanged snapshot')
    const beforeDelete = await actAs(owner, () => pollIssues())
    await pool.query('delete from issue_versions where "issueId"=$1', [ids[0]])
    await pool.query('delete from issue_documents where "issueId"=$1', [ids[0]])
    await pool.query('delete from issues where id=$1', [ids[0]])
    const deletion = await measured(() => actAs(owner, () => pollIssues(beforeDelete.version, beforeDelete.positions)))
    assert.equal(deletion.value.items?.length, 0, 'deletion needs no unchanged task payloads')
    assert.equal(mergeList(beforeDelete.items!, deletion.value).length, beforeDelete.items!.length - 1, 'deletion invalidates the snapshot even without updating another task')
    t.diagnostic(JSON.stringify({ event: 'read_cache_measurement', surface: 'task-list', scope: 'data-read-path_not_page_http', fixtureRows: 30,
      legacyReload: readMetrics(list), cold: readMetrics(cold), warmKnown: readMetrics(quiet), reloadRestored: readMetrics(restored), oneRowDelta: readMetrics(delta), deletion: readMetrics(deletion) }))
  } finally {
    await pool.query('delete from team_issue_promotion_receipts where "requestId"=$1', [requestId])
    await pool.query('delete from team_issue_promotions where "requestId"=$1', [requestId])
    await pool.query('delete from mikka_team_issues where "teamId"=$1', [teamId])
    await pool.query('delete from mikka_teams where id=$1', [teamId])
    await pool.query('delete from mikka_workspace_members where "workspaceId"=$1', [workspaceId])
    await pool.query('delete from mikka_workspaces where id=$1', [workspaceId])
    await pool.query('delete from issue_versions where "userId"=$1', [owner])
    await pool.query('delete from issue_documents where "userId"=$1', [owner])
    await pool.query('delete from issues where "userId"=$1', [owner])
    await pool.query('delete from "user" where id=ANY($1::text[])', [[owner, peer]])
  }
})

test('workspace task polls keep permission reads bounded and recheck the next request', { skip: !enabled }, async t => {
  const { pool } = await import('../lib/db')
  const { actAs } = await import('../lib/acting-user')
  const { pollIssues, listWorkspaceIssues } = await import('../app/actions/issues')
  const { withActivitySession } = await import('./fixtures/activity-runtime.mjs')
  const { tokenWorkspace } = await import('../lib/tokens/principal')
  const suffix = randomUUID()
  const owner = 'scope-owner-' + suffix, peer = 'scope-peer-' + suffix, outsider = 'scope-outsider-' + suffix
  const people = [owner, peer, outsider]
  const workspaces = [randomUUID(), randomUUID(), randomUUID()]
  const teams: string[] = Array.from({ length: 44 }, () => randomUUID())
  const ids: string[] = [], firstWorkspace: string[] = [], secondWorkspace: string[] = []
  const personal = randomUUID(), unlinked = randomUUID(), outside = randomUUID()
  const content = JSON.stringify({ type: 'doc', content: [] })
  const inWorkspace = <T>(workspace: string, work: () => Promise<T>): Promise<T> =>
    withActivitySession(peer, () => actAs(peer, work), workspace) as Promise<T>
  try {
    for (const person of people) await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,true,now(),now())', [person, person + '@example.invalid'])
    for (const [index, workspace] of workspaces.entries()) {
      const userId = index === 2 ? outsider : owner
      await pool.query('insert into mikka_workspaces(id,"userId",name) values($1,$2,$3)', [workspace, userId, 'List scope ' + index])
      await pool.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$2,$3,$4)', [workspace, userId, userId + '@example.invalid', 'admin'])
      if (index < 2) await pool.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$2,$3,$4)', [workspace, peer, peer + '@example.invalid', 'member'])
    }
    for (const [index, team] of teams.entries()) {
      const workspace = workspaces[index < 2 || index >= 4 ? 0 : index - 1]
      await pool.query('insert into mikka_teams(id,"workspaceId","userId",name,identifier,description) values($1,$2,$3,$4,$5,$6)',
        [team, workspace, index === 3 ? outsider : owner, 'List team ' + index, 'EG' + index, 'Team description unused by the task list. '.repeat(14).slice(0, 500)])
    }
    for (let index = 0; index < 80; index++) {
      const id = randomUUID(), group = index < 60 ? 0 : 1
      ids.push(id); (group === 0 ? firstWorkspace : secondWorkspace).push(id)
      await pool.query('insert into issues(id,"userId",title,content,status,priority,scope) values($1,$2,$3,$4,$5,$6,$7)',
        [id, owner, 'Task ' + index, content, 'todo', 'normal', 'workspace'])
      await pool.query('insert into mikka_team_issues("issueId","teamId","workspaceId","userId") values($1,$2,$3,$4)',
        [id, group === 0 ? teams[index % 2] : teams[2], workspaces[group], owner])
    }
    for (const [id, scope] of [[personal, 'personal'], [unlinked, 'workspace'], [outside, 'workspace']]) {
      ids.push(id)
      await pool.query('insert into issues(id,"userId",title,content,status,priority,scope) values($1,$2,$3,$4,$5,$6,$7)',
        [id, peer, id, content, 'todo', 'normal', scope])
    }
    // An owned task can retain a link after the owner's membership is gone.
    // It must not reappear as an unlinked task in another workspace.
    await pool.query('insert into mikka_team_issues("issueId","teamId","workspaceId","userId") values($1,$2,$3,$4)',
      [outside, teams[3], workspaces[2], peer])

    await inWorkspace(workspaces[0], () => pollIssues()) // warm connections, outside the byte budget
    const full = await measured(() => inWorkspace(workspaces[0], () => pollIssues()))
    assert.deepEqual(full.value.items?.map(row => row.id).sort(), [...firstWorkspace, personal, unlinked].sort())
    assert.ok(full.value.items?.filter(row => firstWorkspace.includes(row.id)).every(row => teams.slice(0, 2).includes(row.teamId!)))
    const quiet = await measured(() => inWorkspace(workspaces[0], () => pollIssues(full.value.version)))
    assert.equal(quiet.value.unchanged, true)
    assert.equal(quiet.value.items, undefined)
    t.diagnostic(JSON.stringify({ linkedTasks: 80, fullWorkspaceListBytes: full.bytes, unchangedWorkspaceListBytes: quiet.bytes }))

    const switched = await inWorkspace(workspaces[1], () => pollIssues(full.value.version))
    assert.deepEqual(switched.items?.map(row => row.id).sort(), [...secondWorkspace, personal, unlinked].sort())
    assert.notEqual(switched.version, full.value.version)
    const tokenRows = await withActivitySession(peer, () => actAs({ id: peer, [tokenWorkspace]: workspaces[0] },
      () => listWorkspaceIssues(workspaces[0])), workspaces[0]) as Awaited<ReturnType<typeof listWorkspaceIssues>>
    assert.deepEqual(tokenRows.map(row => row.id).sort(), firstWorkspace.slice().sort(), 'workspace tokens retain their tenant boundary')

    // Move one relation after its rows are read, before the action continues.
    // A reused link must never be acknowledged with a later relation version.
    const { workspacePool } = await import('../lib/workspace-db')
    const originalQuery = workspacePool.query
    let movedDuringRead = false
    workspacePool.query = ((...args: unknown[]) => {
      const statement = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text ?? ''
      const result: Promise<unknown> = Reflect.apply(originalQuery, workspacePool, args)
      if (!movedDuringRead && statement.includes('from "mikka_team_issues"') && !statement.includes('md5(')) {
        movedDuringRead = true
        return result.then(async rows => {
          await pool.query('update mikka_team_issues set "teamId"=$2 where "issueId"=$1', [firstWorkspace[2], teams[1]])
          return rows
        })
      }
      return result
    }) as typeof workspacePool.query
    let raced: Awaited<ReturnType<typeof pollIssues>>
    try {
      raced = await inWorkspace(workspaces[0], () => pollIssues())
    } finally {
      workspacePool.query = originalQuery
    }
    assert.equal(movedDuringRead, true, 'the concurrent relation edit was exercised')
    const corrected = await inWorkspace(workspaces[0], () => pollIssues(raced.version))
    assert.notEqual(corrected.unchanged, true, 'a concurrent relation edit is not acknowledged unseen')
    assert.equal(corrected.items?.find(row => row.id === firstWorkspace[2])?.teamId, teams[1])

    await pool.query('update mikka_team_issues set "teamId"=$2 where "issueId"=$1', [firstWorkspace[0], teams[1]])
    const moved = await inWorkspace(workspaces[0], () => pollIssues(full.value.version))
    assert.notEqual(moved.version, full.value.version, 'a relation change invalidates the snapshot')
    assert.equal(moved.items?.find(row => row.id === firstWorkspace[0])?.teamId, teams[1])
    await pool.query('update mikka_workspace_members set status=$3 where "workspaceId"=$1 and "userId"=$2', [workspaces[0], peer, 'suspended'])
    const revoked = await inWorkspace(workspaces[0], () => pollIssues(moved.version))
    assert.ok(revoked.items?.every(row => !firstWorkspace.includes(row.id)), 'the next request drops access immediately')
    assert.notEqual(revoked.version, moved.version)
    await pool.query('update mikka_workspace_members set status=$3 where "workspaceId"=$1 and "userId"=$2', [workspaces[0], peer, 'active'])
    assert.deepEqual((await inWorkspace(workspaces[0], () => pollIssues())).items?.map(row => row.id).sort(), [...firstWorkspace, personal, unlinked].sort())

    // The list needs team identity and links, never long team descriptions.
    // Budgets include both PostgreSQL pools and every returned protocol byte.
    assert.ok(full.bytes < 64_000, 'full workspace list exceeded 64 KB: ' + full.bytes)
    assert.ok(quiet.bytes < 20_000, 'unchanged workspace list exceeded 20 KB: ' + quiet.bytes)
  } finally {
    await pool.query('delete from mikka_team_issues where "issueId"=any($1::uuid[])', [ids])
    await pool.query('delete from issues where id=any($1::uuid[])', [ids])
    await pool.query('delete from mikka_teams where id=any($1::uuid[])', [teams])
    await pool.query('delete from mikka_workspace_members where "workspaceId"=any($1::uuid[])', [workspaces])
    await pool.query('delete from mikka_workspaces where id=any($1::uuid[])', [workspaces])
    await pool.query('delete from "user" where id=any($1::text[])', [people])
  }
})
