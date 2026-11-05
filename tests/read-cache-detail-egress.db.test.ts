import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { measured, readMetrics } from './helpers/read-metrics'
import { mergeList } from '../lib/list-poll'
import { mergeChat } from '../lib/coordinator/chat-poll'
import { withActivitySession } from './fixtures/activity-runtime.mjs'
import type { ActionResult } from '../lib/action-result'

const enabled = disposableDatabase()
if (process.env.REQUIRE_DB === '1' && !enabled) throw new Error('Detail cache regression requires a disposable loopback *_e2e database')
function successful<T>(result: ActionResult<T>): T {
  assert.equal(result.error, undefined)
  return result as T
}

test('detail and activity revalidate current access while returning only changed content and history summaries', { skip: !enabled }, async t => {
  const { pool } = await import('../lib/db')
  const { actAs } = await import('../lib/acting-user')
  const { getIssue, saveIssue, listIssueVersions, pollIssue, pollIssueVersionSummaries, promoteIssueToTeam } = await import('../app/actions/issues')
  const { syncCoordinatorChat } = await import('../app/actions/coordinator')
  const owner = `detail-cache-${randomUUID()}`, stranger = `detail-stranger-${randomUUID()}`
  const workspaceId = randomUUID(), teamId = randomUUID(), botId = randomUUID()
  const read = <T>(work: () => Promise<T>) => actAs(owner, work)
  const readChat = (...args: Parameters<typeof syncCoordinatorChat>): ReturnType<typeof syncCoordinatorChat> => withActivitySession(stranger, () => syncCoordinatorChat(...args), workspaceId)
  const content = { type: 'doc', content: Array.from({ length: 70 }, (_, index) => ({ type: 'paragraph', content: [{ type: 'text', text: `Paragraph ${index}: ${'private history body '.repeat(20)}` }] })) }
  try {
    for (const id of [owner, stranger]) await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [id, `${id}@example.invalid`])
    const saved = successful(await read(() => saveIssue({ title: 'Cached task', content, status: 'todo', priority: 'normal' })))
    assert.ok(saved.issue)
    const id = saved.issue.id
    // Fifty realistic description revisions: activity needs status/metadata,
    // while the explicit history dialog needs the complete older documents.
    for (let revision = 2; revision <= 50; revision++) await pool.query('insert into issue_versions(id,"issueId","userId",revision,title,content,status,priority,actor_type,actor_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$3)',
      [randomUUID(), id, owner, revision, `Revision ${revision}`, JSON.stringify(content), revision % 2 ? 'todo' : 'review', 'normal', 'user'])
    await pool.query('update issues set revision=50 where id=$1', [id])
    await read(() => getIssue(id)) // connection startup and setup are outside measurement

    const legacy = await measured(() => read(async () => ({ detail: await getIssue(id), history: await listIssueVersions(id) })))
    const cold = await measured(() => read(async () => ({ detail: successful(await pollIssue(id)), history: successful(await pollIssueVersionSummaries(id)) })))
    const detail = cold.value.detail, history = cold.value.history
    assert.ok(detail.issue && history.snapshot && !('unchanged' in history.snapshot))
    const snapshot = history.snapshot
    assert.equal(snapshot.items.length, 50)
    assert.ok(snapshot.items.every(version => !version.content.content), 'activity summaries contain no historical document body')
    assert.equal(detail.issue.content.content?.[0].content?.[0].text, content.content[0].content[0].text)
    assert.ok(cold.resultBytes * 5 < legacy.resultBytes, `cold summary path ${cold.resultBytes} JSON bytes vs legacy ${legacy.resultBytes}`)

    const conditional = () => read(async () => ({ detail: successful(await pollIssue(id, detail.version)), history: successful(await pollIssueVersionSummaries(id, snapshot.version, snapshot.positions)) }))
    const warm = await measured(conditional)
    assert.equal(warm.value.detail.unchanged, true)
    assert.ok('unchanged' in warm.value.history.snapshot)
    assert.ok(warm.resultBytes * 5 < legacy.resultBytes)
    const restored = await measured(conditional)
    assert.equal(restored.value.detail.unchanged, true)

    // A metadata write without touching updatedAt is still observed.
    await pool.query('update issues set title=$2 where id=$1', [id, 'Renamed without timestamp'])
    const changed = await measured(() => read(async () => successful(await pollIssue(id, detail.version))))
    assert.equal(changed.value.issue?.title, 'Renamed without timestamp')
    assert.notEqual(changed.value.version, detail.version)
    // A description write at the same revision also changes the fingerprint.
    const changedBody = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Changed body without a clock or revision' }] }] }
    await pool.query('update issues set content=$2 where id=$1', [id, JSON.stringify(changedBody)])
    const bodyChanged = successful(await read(() => pollIssue(id, changed.value.version)))
    assert.deepEqual(bodyChanged.issue?.content, changedBody)
    assert.notEqual(bodyChanged.version, changed.value.version)

    const newVersion = randomUUID()
    await pool.query('insert into issue_versions(id,"issueId","userId",revision,title,content,status,priority,actor_type,actor_id) values($1,$2,$3,51,$4,$5,$6,$7,$8,$3)',
      [newVersion, id, owner, 'Newest activity', JSON.stringify(changedBody), 'done', 'normal', 'user'])
    await pool.query('update issues set revision=51 where id=$1', [id])
    const delta = await measured(() => read(async () => successful(await pollIssueVersionSummaries(id, snapshot.version, snapshot.positions))))
    assert.ok(delta.value.snapshot && !('unchanged' in delta.value.snapshot))
    const changedHistory = delta.value.snapshot
    assert.equal(changedHistory.delta, true)
    assert.deepEqual(changedHistory.items.map(row => row.id), [newVersion])
    const combined = mergeList(snapshot.items, changedHistory)
    assert.equal(combined.length, 50, 'the oldest row leaves the fifty-version window')
    assert.equal(combined[0].id, newVersion)
    assert.ok(!combined.some(row => row.revision === 1))
    const fullSummary = successful(await read(() => pollIssueVersionSummaries(id)))
    assert.ok(fullSummary.snapshot && !('unchanged' in fullSummary.snapshot))
    assert.deepEqual(combined, fullSummary.snapshot.items)

    await pool.query('update "user" set name=$2 where id=$1', [owner, 'Renamed activity actor'])
    const actorChanged = successful(await read(() => pollIssueVersionSummaries(id, changedHistory.version, changedHistory.positions)))
    assert.ok(actorChanged.snapshot && !('unchanged' in actorChanged.snapshot))
    assert.equal(actorChanged.snapshot.items[0].actor?.name, 'Renamed activity actor', 'profile-dependent summaries invalidate without a new version')

    assert.equal((await actAs(stranger, () => pollIssue(id, bodyChanged.version))).error, 'issueNotFound')
    assert.equal((await actAs(stranger, () => pollIssueVersionSummaries(id, snapshot.version, snapshot.positions))).error, 'issueNotFound')
    // A previously authorized workspace membership is checked again, even with
    // valid cursors. Legacy issue_members never grant workspace task access.
    await pool.query('insert into mikka_workspaces(id,"userId",name) values($1,$2,$3)', [workspaceId, owner, 'Detail cache fixture'])
    for (const userId of [owner, stranger]) await pool.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$2,$3,$4)',
      [workspaceId, userId, `${userId}@example.invalid`, userId === owner ? 'admin' : 'member'])
    await pool.query('insert into mikka_teams(id,"workspaceId","userId",name,identifier) values($1,$2,$3,$4,$5)', [teamId, workspaceId, owner, 'Cache fixture', 'CACHE'])
    // The real human promotion writes the team receipt and passes the database
    // scope guard; a fixture must not bypass the same authorization boundary.
    const promotion = await withActivitySession(owner, () => promoteIssueToTeam({ requestId: randomUUID(), issueId: id, revision: 51, teamId, expectedTeamId: null }), workspaceId)
    assert.ok('issue' in promotion && promotion.issue, JSON.stringify(promotion))
    assert.equal(promotion.issue.scope, 'workspace')
    const shared = successful(await actAs(stranger, () => pollIssue(id)))
    assert.ok(shared.issue)
    const sharedHistory = successful(await actAs(stranger, () => pollIssueVersionSummaries(id)))
    assert.ok(sharedHistory.snapshot && !('unchanged' in sharedHistory.snapshot))
    const sharedSnapshot = sharedHistory.snapshot
    await pool.query('insert into bots(id,"ownerId","workspaceId",name) values($1,$2,$3,$4)', [botId, stranger, workspaceId, 'Citation cache fixture'])
    await pool.query('insert into coordinator_messages(id,"userId","botId",position,message) values($1,$2,$3,1,$4)',
      [randomUUID(), stranger, botId, JSON.stringify({ role: 'assistant', content: `Read [[issue:${id}]]` })])
    const chat = successful(await readChat(botId))
    assert.ok(chat.chat && !('unchanged' in chat.chat))
    const previousChat = chat.chat
    assert.equal(previousChat.sources[id]?.kind, 'issue')
    const continuation = { ...previousChat.continuation!, sourceIds: [id], artifactIds: [] }
    await pool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [workspaceId, stranger])
    assert.equal((await actAs(stranger, () => pollIssue(id, shared.version))).error, 'issueNotFound')
    assert.equal((await actAs(stranger, () => pollIssueVersionSummaries(id, sharedSnapshot.version, sharedSnapshot.positions))).error, 'issueNotFound')
    const revokedChat = successful(await readChat(botId, previousChat.version, continuation))
    assert.ok(revokedChat.chat && 'unchanged' in revokedChat.chat, 'the conversation itself did not change')
    assert.deepEqual(revokedChat.chat.metadata?.sources, {}, 'an unchanged message version cannot retain a revoked task title')
    assert.deepEqual(mergeChat(previousChat, revokedChat.chat)?.sources, {})
    assert.equal((await syncCoordinatorChat(botId)).error, 'authRequired', 'expected auth failures survive the Server Action boundary')
    await pool.query('delete from bots where id=$1', [botId])
    assert.equal((await readChat(botId, previousChat.version, continuation)).error, 'botNotFound')

    await pool.query('update issues set content=jsonb_set(content,\'{attrs}\',$2::jsonb) where id=$1', [id, JSON.stringify({ mikka: { deletedAt: new Date().toISOString() } })])
    const deletion = await measured(() => read(async () => ({ detail: await pollIssue(id, bodyChanged.version), history: await pollIssueVersionSummaries(id, snapshot.version, snapshot.positions) })))
    assert.equal(deletion.value.detail.error, 'issueNotFound')
    assert.equal(deletion.value.history.error, 'issueNotFound')
    t.diagnostic(JSON.stringify({ event: 'read_cache_measurement', surface: 'task-detail-and-activity', scope: 'data-read-path_not_page_http', historyRows: 50,
      legacyReload: readMetrics(legacy), cold: readMetrics(cold), warmKnown: readMetrics(warm), reloadRestored: readMetrics(restored), oneRowDelta: readMetrics(delta), detailChange: readMetrics(changed), deletion: readMetrics(deletion) }))
  } finally {
    await pool.query('delete from coordinator_messages where "userId"=$1', [stranger])
    await pool.query('delete from bots where id=$1', [botId])
    await pool.query('delete from team_issue_promotion_receipts where "ownerId"=$1', [owner])
    await pool.query('delete from team_issue_promotions where "ownerId"=$1', [owner])
    await pool.query('delete from mikka_team_issues where "teamId"=$1', [teamId])
    await pool.query('delete from mikka_teams where id=$1', [teamId])
    await pool.query('delete from mikka_workspace_members where "workspaceId"=$1', [workspaceId])
    await pool.query('delete from mikka_workspaces where id=$1', [workspaceId])
    await pool.query('delete from issue_versions where "userId"=$1', [owner])
    await pool.query('delete from issue_documents where "userId"=$1', [owner])
    await pool.query('delete from issues where "userId"=$1', [owner])
    await pool.query('delete from "user" where id=any($1::text[])', [[owner, stranger]])
  }
})
