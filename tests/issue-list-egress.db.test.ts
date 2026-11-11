import { seedFixtureWorkspace } from './helpers/task-workspace'
import { withActivitySession } from './fixtures/activity-runtime.mjs'
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
  const workspaceId = randomUUID(), personalWorkspace = randomUUID(), teamId = randomUUID(), requestId = randomUUID()
  const read = <T>(work: () => Promise<T>) => withActivitySession(owner, () => actAs(owner, work), personalWorkspace) as Promise<T>
  // 30 tasks of about 10 KB each, with a nested checklist (2 of 3 checked).
  const item = (checked: boolean, nested?: JSONContent[]): JSONContent => ({ type: 'taskItem', attrs: { checked }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'taskItem step' }] }, ...(nested ?? [])] })
  const content = (index: number): JSONContent => ({ type: 'doc', content: [
    ...Array.from({ length: 30 }, (_, line) => ({ type: 'paragraph', content: [{ type: 'text', text: `Task ${index}, line ${line}: ${'words '.repeat(50)}` }] })),
    { type: 'taskList', content: [item(true, [{ type: 'taskList', content: [item(false)] }]), item(true)] },
  ] })
  try {
    await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [owner, `${owner}@example.invalid`])
    await seedFixtureWorkspace(pool, owner, 'personal', personalWorkspace)
    const ids: string[] = []
    for (let index = 0; index < 30; index++) {
      const saved = await read(() => saveIssue({ title: `Task ${index}`, content: content(index), status: 'todo', priority: 'normal' }))
      assert.ok('issue' in saved && saved.issue, JSON.stringify(saved))
      ids.push(saved.issue.id)
    }
    const first = (await pool.query('select revision from issues where id=$1', [ids[0]])).rows[0].revision
    const estimated = await read(() => updateIssueMetadata({ id: ids[0], revision: first, patch: { estimate: 5 } }))
    assert.ok('issue' in estimated && estimated.issue, JSON.stringify(estimated))

    // Initialize the personal workspace and warm its connections outside measurement.
    await read(() => listIssues())
    const list = await measured(() => read(() => listIssues()))
    assert.equal(list.value.length, 30)
    const expected = issueChecklist(content(0))
    assert.deepEqual(expected, { total: 3, checked: 2, percentage: 67 })
    for (const row of list.value) assert.deepEqual(row.checklist, expected)
    assert.equal(list.value.find(row => row.id === ids[0])?.metadata.estimate, 5)
    assert.equal('content' in list.value[0], false)

    const cold = await measured(() => read(() => pollIssues()))
    const snapshot = cold.value
    assert.ok(snapshot.items)
    const quiet = await measured(() => read(() => pollIssues(snapshot.version)))
    assert.ok('unchanged' in quiet.value && quiet.value.unchanged)
    assert.equal(quiet.value.items, undefined)
    assert.ok(quiet.bytes < list.bytes / 2, `unchanged ${quiet.bytes} B vs full ${list.bytes} B`)
    const restored = await measured(() => read(() => pollIssues(snapshot.version, snapshot.positions)))
    assert.ok('unchanged' in restored.value && restored.value.unchanged)
    await pool.query('update issues set title=$2 where id=$1', [ids[0], 'Renamed without a clock change'])
    const delta = await measured(() => read(() => pollIssues(snapshot.version, snapshot.positions)))
    assert.equal(delta.value.delta, true)
    assert.deepEqual(delta.value.items?.map(row => row.id), [ids[0]], 'only the changed projection is read')
    const changed = await read(() => pollIssues(snapshot.version))
    assert.ok(changed.items?.some(row => row.title === 'Renamed without a clock change'))
    assert.deepEqual(mergeList(snapshot.items!, delta.value), changed.items)
    assert.notEqual(changed.version, snapshot.version)
    await pool.query('update "user" set image=$2 where id=$1', [owner, 'https://example.invalid/changed-avatar.png'])
    assert.notEqual((await read(() => pollIssues(changed.version))).version, changed.version, 'profile changes invalidate the list too')
    await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [peer, `${peer}@example.invalid`])
    const foreign = await actAs(peer, () => pollIssues(changed.version, changed.positions))
    assert.deepEqual(foreign.items, [], 'another identity cannot reuse an owner snapshot to obtain private tasks')
    assert.notEqual(foreign.version, changed.version)

    // ids[10]: parent ids[0], blocked by ids[12], related to ids[13], duplicate of ids[16]; ids[14] is its child, it blocks ids[15].
    const relate = async (id: string, targetId: string, kind: 'parent' | 'blockedBy' | 'related' | 'duplicate') => {
      const revision = (await pool.query('select revision from issues where id=$1', [id])).rows[0].revision
      const result = await read(() => updateIssueRelation({ id, revision, targetId, kind }))
      assert.ok('issue' in result, JSON.stringify(result))
    }
    await relate(ids[10], ids[0], 'parent')
    await relate(ids[10], ids[12], 'blockedBy')
    await relate(ids[10], ids[13], 'related')
    await relate(ids[10], ids[16], 'duplicate')
    await relate(ids[14], ids[10], 'parent')
    await relate(ids[15], ids[10], 'blockedBy')
    await relate(ids[17], ids[18], 'related')
    const relations = await measured(() => read(() => listIssueConnections(ids[10])))
    // The rows the relations panel and subtasks use, picked from every task the owner has (listIssues reads them all).
    const everything = await read(() => listIssues())
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
    const unrelated = await read(() => listIssueConnections(ids[19]))
    assert.deepEqual(unrelated.map(row => row.id), [ids[19]], 'a task with no links reads only itself')

    const bodies = (await pool.query('select sum(length(content::text))::int n from issues where "userId"=$1', [owner])).rows[0].n
    t.diagnostic(JSON.stringify({ tasks: 30, bodyBytes: bodies, listIssuesDbBytes: list.bytes, listIssueConnectionsDbBytes: relations.bytes }))
    // Reading every body would cost at least `bodies` bytes.
    assert.ok(list.bytes < bodies / 5, `listIssues read ${list.bytes} B for ${bodies} B of bodies`)
    assert.ok(relations.bytes < bodies / 5, `listIssueConnections read ${relations.bytes} B for ${bodies} B of bodies`)
    // 7 of the owner's 30 tasks: well under the whole list's metadata.
    assert.ok(relations.bytes < list.bytes, `listIssueConnections read ${relations.bytes} B, the whole list ${list.bytes} B`)
    const { promoteExistingIssueForUser } = await import('../lib/team-issue-promotion')
    await pool.query('insert into mikka_workspaces(id,"userId",name) values($1,$2,$3)', [workspaceId, owner, 'Egress visibility fixture'])
    await pool.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$2,$3,$4)', [workspaceId, peer, `${peer}@example.invalid`, 'member'])
    await pool.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$2,$3,$4)', [workspaceId, owner, `${owner}@example.invalid`, 'admin'])
    await pool.query('insert into mikka_teams(id,"workspaceId","userId",name,identifier) values($1,$2,$3,$4,$5)', [teamId, workspaceId, owner, 'Fixture team', 'EGRESS'])
    const promotion = await promoteExistingIssueForUser(owner, { requestId, issueId: ids[1], revision: 1, teamId, expectedTeamId: null })
    assert.ok('error' in promotion)
    assert.equal(promotion.error, 'teamIssueAccessDenied', 'team promotion cannot move a task to another workspace')
    assert.equal((await pool.query('select "workspaceId" from issues where id=$1', [ids[1]])).rows[0].workspaceId, personalWorkspace)
    assert.equal((await pool.query('select count(*)::int n from team_issue_promotion_receipts where "requestId"=$1', [requestId])).rows[0].n, 0)
    const createdShared = await withActivitySession(owner, () => saveIssue({ title: 'Shared list task', content: content(30), status: 'todo', priority: 'normal' }), workspaceId)
    assert.ok('issue' in createdShared && createdShared.issue)
    const shared = await withActivitySession(peer, () => actAs(peer, () => pollIssues()), workspaceId)
    assert.deepEqual(shared.items?.map(row => row.id), [createdShared.issue.id])
    assert.equal(shared.items?.length, 1)
    await pool.query('update mikka_workspace_members set status=$3 where "workspaceId"=$1 and "userId"=$2', [workspaceId, peer, 'suspended'])
    const revoked = await withActivitySession(peer, () => actAs(peer, () => pollIssues(shared.version, shared.positions)), workspaceId)
    assert.deepEqual(revoked.items, [], 'revocation clears the formerly shared row')
    assert.deepEqual(mergeList(shared.items!, revoked), [], 'the authoritative manifest removes the revoked cached task')
    assert.notEqual(revoked.version, shared.version, 'revocation cannot return an unchanged snapshot')
    const beforeDelete = await read(() => pollIssues())
    await pool.query('delete from issue_versions where "issueId"=$1', [ids[0]])
    await pool.query('delete from issue_documents where "issueId"=$1', [ids[0]])
    await pool.query('delete from issues where id=$1', [ids[0]])
    const deletion = await measured(() => read(() => pollIssues(beforeDelete.version, beforeDelete.positions)))
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
    const personalWorkspace = await seedFixtureWorkspace(pool, peer)
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
      await pool.query('insert into issues(id,"userId",title,content,status,priority,scope,"workspaceId","ownershipState") values($1,$2,$3,$4,$5,$6,$7,$8,\'bound\')',
        [id, owner, 'Task ' + index, content, 'todo', 'normal', 'workspace', workspaces[group]])
      await pool.query('insert into mikka_team_issues("issueId","teamId","workspaceId","userId") values($1,$2,$3,$4)',
        [id, group === 0 ? teams[index % 2] : teams[2], workspaces[group], owner])
    }
    for (const [id, scope] of [[personal, 'personal'], [unlinked, 'workspace'], [outside, 'workspace']]) {
      ids.push(id)
      await pool.query('insert into issues(id,"userId",title,content,status,priority,scope,"workspaceId","ownershipState") values($1,$2,$3,$4,$5,$6,$7,$8,\'bound\')',
        [id, peer, id, content, 'todo', 'normal', scope, id === personal ? personalWorkspace : id === unlinked ? workspaces[0] : workspaces[2]])
    }
    // An owned task can retain a link after the owner's membership is gone.
    // It must not reappear as an unlinked task in another workspace.
    await pool.query('insert into mikka_team_issues("issueId","teamId","workspaceId","userId") values($1,$2,$3,$4)',
      [outside, teams[3], workspaces[2], peer])

    await inWorkspace(workspaces[0], () => pollIssues()) // warm connections, outside the byte budget
    const full = await measured(() => inWorkspace(workspaces[0], () => pollIssues()))
    assert.deepEqual(full.value.items?.map(row => row.id).sort(), [...firstWorkspace, unlinked].sort())
    assert.ok(full.value.items?.filter(row => firstWorkspace.includes(row.id)).every(row => teams.slice(0, 2).includes(row.teamId!)))
    const issuedUnlinked = (await pool.query('select "issuedIdentifier" from issues where id=$1', [unlinked])).rows[0].issuedIdentifier
    assert.match(issuedUnlinked, /^W[0-9A-F]{12}-[1-9][0-9]*$/, 'an ungrouped shared Task has a Workspace-issued identity')
    assert.equal(full.value.items?.find(row => row.id === unlinked)?.identifier, issuedUnlinked)
    const quiet = await measured(() => inWorkspace(workspaces[0], () => pollIssues(full.value.version)))
    assert.ok('unchanged' in quiet.value && quiet.value.unchanged)
    assert.equal(quiet.value.items, undefined)
    t.diagnostic(JSON.stringify({ linkedTasks: 80, fullWorkspaceListBytes: full.bytes, unchangedWorkspaceListBytes: quiet.bytes }))

    // Team keys are aliases. Renaming a grouping cannot change already issued
    // Task identities or resend otherwise unchanged list rows.
    await pool.query('update mikka_teams set identifier=$2 where id=$1', [teams[0], 'RENAMED'])
    const renamed = await measured(() => inWorkspace(workspaces[0], () => pollIssues(full.value.version, full.value.positions)))
    assert.equal(renamed.value.version, full.value.version)
    assert.ok('unchanged' in renamed.value && renamed.value.unchanged)
    assert.deepEqual((await inWorkspace(workspaces[0], () => pollIssues())).items, full.value.items)
    await pool.query('update mikka_teams set identifier=$2 where id=$1', [teams[0], 'EG0'])

    // A re-created Team relation gets a new historical alias number. The
    // canonical Task identity and current grouping remain the same.
    const changedNumberId = firstWorkspace[0]
    const oldNumber = (await pool.query('select number from mikka_team_issues where "issueId"=$1', [changedNumberId])).rows[0].number
    await pool.query('delete from mikka_team_issues where "issueId"=$1', [changedNumberId])
    await pool.query('insert into mikka_team_issues("issueId","teamId","workspaceId","userId") values($1,$2,$3,$4)', [changedNumberId, teams[0], workspaces[0], owner])
    assert.notEqual((await pool.query('select number from mikka_team_issues where "issueId"=$1', [changedNumberId])).rows[0].number, oldNumber)
    const renumbered = await inWorkspace(workspaces[0], () => pollIssues(full.value.version, full.value.positions))
    assert.ok('unchanged' in renumbered && renumbered.unchanged)
    assert.equal((await inWorkspace(workspaces[0], () => pollIssues())).items?.find(row => row.id === changedNumberId)?.identifier, full.value.items?.find(row => row.id === changedNumberId)?.identifier)
    t.diagnostic(JSON.stringify({ event: 'task_number_list_measurement', cold: readMetrics(full), unchanged: readMetrics(quiet), teamRename: readMetrics(renamed) }))

    const switched = await inWorkspace(workspaces[1], () => pollIssues(full.value.version))
    assert.deepEqual(switched.items?.map(row => row.id).sort(), secondWorkspace.slice().sort())
    assert.notEqual(switched.version, full.value.version)
    const tokenRows = await withActivitySession(peer, () => actAs({ id: peer, [tokenWorkspace]: workspaces[0] },
      () => listWorkspaceIssues(workspaces[0])), workspaces[0]) as Awaited<ReturnType<typeof listWorkspaceIssues>>
    assert.deepEqual(tokenRows.map(row => row.id).sort(), [...firstWorkspace, unlinked].sort(), 'workspace tokens include only tasks bound to their tenant, including tasks without a Team')

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
    assert.ok(!('unchanged' in corrected), 'a concurrent relation edit is not acknowledged unseen')
    assert.equal(corrected.items?.find(row => row.id === firstWorkspace[2])?.teamId, teams[1])

    // Identifier metadata keeps the same ACL and ordered page boundary even
    // when a workspace has more than one 128-link page.
    const { issueTeamScope } = await import('../lib/issue-team-access')
    const extraIds = Array.from({ length: 70 }, () => randomUUID())
    ids.push(...extraIds)
    await pool.query('insert into issues(id,"userId",title,content,status,priority,scope,"workspaceId","ownershipState") select id,$2,$3,$4,$5,$6,$7,$8,\'bound\' from unnest($1::uuid[]) id',
      [extraIds, owner, 'Paging fixture', content, 'todo', 'normal', 'workspace', workspaces[0]])
    await pool.query('insert into mikka_team_issues("issueId","teamId","workspaceId","userId") select id,$2,$3,$4 from unnest($1::uuid[]) id',
      [extraIds, teams[0], workspaces[0], owner])
    const plainLinks = await issueTeamScope(peer)
    const numberedLinks = await issueTeamScope(peer, [], { withTaskNumbers: true })
    assert.equal(numberedLinks.length, 150)
    assert.deepEqual(numberedLinks.map(({ key: _key, number: _number, ...link }) => link), plainLinks,
      'number metadata preserves every authorized link and its ordering across pages')
    assert.ok(numberedLinks.every(link => /^EG[012]$/.test(link.key ?? '') && Number.isSafeInteger(link.number) && link.number! > 0))
    await pool.query('delete from mikka_team_issues where "issueId"=any($1::uuid[])', [extraIds])
    await pool.query('delete from issues where id=any($1::uuid[])', [extraIds])

    await pool.query('update mikka_team_issues set "teamId"=$2 where "issueId"=$1', [firstWorkspace[0], teams[1]])
    const moved = await inWorkspace(workspaces[0], () => pollIssues(full.value.version))
    assert.notEqual(moved.version, full.value.version, 'a relation change invalidates the snapshot')
    assert.equal(moved.items?.find(row => row.id === firstWorkspace[0])?.teamId, teams[1])
    await pool.query('update mikka_workspace_members set status=$3 where "workspaceId"=$1 and "userId"=$2', [workspaces[0], peer, 'suspended'])
    const revoked = await inWorkspace(workspaces[0], () => pollIssues(moved.version))
    assert.ok(revoked.items?.every(row => !firstWorkspace.includes(row.id)), 'the next request drops access immediately')
    assert.notEqual(revoked.version, moved.version)
    await pool.query('update mikka_workspace_members set status=$3 where "workspaceId"=$1 and "userId"=$2', [workspaces[0], peer, 'active'])
    assert.deepEqual((await inWorkspace(workspaces[0], () => pollIssues())).items?.map(row => row.id).sort(), [...firstWorkspace, unlinked].sort())

    // The list needs team identity and links, never long team descriptions.
    // Budgets include both PostgreSQL pools and every returned protocol byte.
    // Stay below the pre-number-metadata baseline (46 KB cold, 12.4 KB warm).
    assert.ok(full.bytes < 44_000, 'full workspace list exceeded 44 KB: ' + full.bytes)
    assert.ok(quiet.bytes < 12_000, 'unchanged workspace list exceeded 12 KB: ' + quiet.bytes)
  } finally {
    await pool.query('delete from mikka_team_issues where "issueId"=any($1::uuid[])', [ids])
    await pool.query('delete from issues where id=any($1::uuid[])', [ids])
    await pool.query('delete from mikka_teams where id=any($1::uuid[])', [teams])
    await pool.query('delete from mikka_workspace_members where "workspaceId"=any($1::uuid[])', [workspaces])
    await pool.query('delete from mikka_workspaces where id=any($1::uuid[])', [workspaces])
    await pool.query('delete from "user" where id=any($1::text[])', [people])
  }
})

test('singleton teams with long keys retain their task-list traffic budget', { skip: !enabled }, async t => {
  const { pool } = await import('../lib/db')
  const { actAs } = await import('../lib/acting-user')
  const { pollIssues } = await import('../app/actions/issues')
  const { withActivitySession } = await import('./fixtures/activity-runtime.mjs')
  const owner = 'singleton-owner-' + randomUUID(), peer = 'singleton-peer-' + randomUUID()
  const workspace = randomUUID(), teams = Array.from({ length: 20 }, () => randomUUID())
  const ids = teams.map(() => randomUUID())
  const read = (version?: string) => withActivitySession(peer, () => actAs(peer, () => pollIssues(version)), workspace) as Promise<Awaited<ReturnType<typeof pollIssues>>>
  try {
    for (const user of [owner, peer]) await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,true,now(),now())', [user, user + '@example.invalid'])
    await pool.query('insert into mikka_workspaces(id,"userId",name) values($1,$2,$3)', [workspace, owner, 'Singleton traffic fixture'])
    for (const user of [owner, peer]) await pool.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$2,$3,$4)', [workspace, user, user + '@example.invalid', user === owner ? 'admin' : 'member'])
    for (const [index, team] of teams.entries()) {
      const key = 'TEAM' + String(index).padStart(8, '0')
      await pool.query('insert into mikka_teams(id,"workspaceId","userId",name,identifier) values($1,$2,$3,$4,$5)', [team, workspace, owner, key, key])
      await pool.query('insert into issues(id,"userId",title,content,status,priority,scope,"workspaceId","ownershipState") values($1,$2,$3,$4,$5,$6,$7,$8,\'bound\')', [ids[index], owner, 'Task ' + index, '{"type":"doc","content":[]}', 'todo', 'normal', 'workspace', workspace])
      await pool.query('insert into mikka_team_issues("issueId","teamId","workspaceId","userId") values($1,$2,$3,$4)', [ids[index], team, workspace, owner])
    }
    await read()
    const cold = await measured(() => read())
    assert.equal(cold.value.items?.length, 20)
    const unchanged = await measured(() => read(cold.value.version))
    assert.ok('unchanged' in unchanged.value && unchanged.value.unchanged)
    t.diagnostic(JSON.stringify({ event: 'task_number_singleton_measurement', teams: 20, keyLength: 12, cold: readMetrics(cold), unchanged: readMetrics(unchanged) }))
    // This shape has no repeated team UUID to amortize identifier metadata.
    // The original two-column links cost 15.9 KB cold and 5.17 KB unchanged.
    assert.ok(cold.bytes < 15_000, 'singleton-team list exceeded 15 KB: ' + cold.bytes)
    assert.ok(unchanged.bytes < 5_000, 'unchanged singleton-team list exceeded 5 KB: ' + unchanged.bytes)
  } finally {
    await pool.query('delete from mikka_team_issues where "issueId"=any($1::uuid[])', [ids])
    await pool.query('delete from issues where id=any($1::uuid[])', [ids])
    await pool.query('delete from mikka_teams where id=any($1::uuid[])', [teams])
    await pool.query('delete from mikka_workspace_members where "workspaceId"=$1', [workspace])
    await pool.query('delete from mikka_workspaces where id=$1', [workspace])
    await pool.query('delete from "user" where id=any($1::text[])', [[owner, peer]])
  }
})
