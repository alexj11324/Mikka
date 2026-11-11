import { seedFixtureWorkspace } from './helpers/task-workspace'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { Pool } from 'pg'
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

async function warmIdentifierPools(pools: { app: Pool; workspace: Pool }) {
  const capacity = Object.entries(pools).map(([name, database]) => {
    const { max, connectionTimeoutMillis } = database.options
    assert.ok(Number.isInteger(max) && max > 0, `${name} pool has a bounded configured capacity`)
    assert.ok(typeof connectionTimeoutMillis === 'number' && Number.isFinite(connectionTimeoutMillis) && connectionTimeoutMillis > 0,
      `${name} pool bounds every checkout`)
    return { name, database, max }
  })
  // Hold every slot until all checkouts and probes settle. Releasing one early
  // lets a later checkout reuse it without initializing the remaining slots.
  const acquired = await Promise.allSettled(capacity.flatMap(({ database, max }) =>
    Array.from({ length: max }, async () => database.connect())))
  const clients = acquired.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  let ready = false
  try {
    const failures = acquired.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Identifier pool checkout failed')
    const probe = { text: 'SELECT 1', query_timeout: 10_000 }
    const queried = await Promise.allSettled(clients.map(async client => client.query(probe)))
    const queryFailures = queried.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (queryFailures.length) throw new AggregateError(queryFailures, 'Identifier pool startup probe failed')
    ready = true
    return Object.fromEntries(capacity.map(({ name, max }) => [name, max]))
  } finally {
    for (const client of clients) client.release(!ready)
  }
}

test('detail and activity revalidate current access while returning only changed content and history summaries', { skip: !enabled }, async t => {
  const { db, pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { actAs } = await import('../lib/acting-user')
  const { getIssue, saveIssue, listIssueVersions, pollIssue, pollIssueVersionSummaries, promoteIssueToTeam } = await import('../app/actions/issues')
  const { syncCoordinatorChat } = await import('../app/actions/coordinator')
  const { getIssueTeam, setIssueTeam } = await import('../app/actions/team-relations')
  const owner = `detail-cache-${randomUUID()}`, stranger = `detail-stranger-${randomUUID()}`
  const workspaceId = randomUUID(), personalWorkspaceId = randomUUID(), teamId = randomUUID(), botId = randomUUID()
  const read = <T>(work: () => Promise<T>) => withActivitySession(owner, () => actAs(owner, work), personalWorkspaceId) as Promise<T>
  const readShared = <T>(work: () => Promise<T>) => withActivitySession(stranger, () => actAs(stranger, work), workspaceId) as Promise<T>
  const readChat = (...args: Parameters<typeof syncCoordinatorChat>): ReturnType<typeof syncCoordinatorChat> => withActivitySession(stranger, () => syncCoordinatorChat(...args), workspaceId)
  const content = { type: 'doc', content: Array.from({ length: 70 }, (_, index) => ({ type: 'paragraph', content: [{ type: 'text', text: `Paragraph ${index}: ${'private history body '.repeat(20)}` }] })) }
  try {
    for (const id of [owner, stranger]) await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [id, `${id}@example.invalid`])
    await seedFixtureWorkspace(pool, owner, 'personal', personalWorkspaceId)
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
    // The database keeps the task's number when a write leaves it out.
    assert.deepEqual(bodyChanged.issue?.content?.content, changedBody.content)
    assert.equal((bodyChanged.issue?.content as { attrs?: { mikka?: { number?: number } } } | undefined)?.attrs?.mikka?.number, 1)
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
    assert.equal(combined.length, 51, 'the creation stays beside the fifty-version window')
    assert.ok(combined.some(version => version.revision === 1))
    assert.equal(combined[0].id, newVersion)
    const fullSummary = successful(await read(() => pollIssueVersionSummaries(id)))
    assert.ok(fullSummary.snapshot && !('unchanged' in fullSummary.snapshot))
    assert.deepEqual(combined, fullSummary.snapshot.items)

    await pool.query('update "user" set name=$2 where id=$1', [owner, 'Renamed activity actor'])
    const actorChanged = successful(await read(() => pollIssueVersionSummaries(id, changedHistory.version, changedHistory.positions)))
    assert.ok(actorChanged.snapshot && !('unchanged' in actorChanged.snapshot))
    assert.equal(actorChanged.snapshot.items[0].actor?.name, 'Renamed activity actor', 'profile-dependent summaries invalidate without a new version')

    await pool.query('insert into issue_versions(id,"issueId","userId",revision,title,content,status,priority) values($1,$2,$3,52,$4,$5,$6,$7)',
      [randomUUID(), id, owner, 'Another change', JSON.stringify(changedBody), 'done', 'normal'])
    const paged = successful(await read(() => pollIssueVersionSummaries(id, changedHistory.version, changedHistory.positions)))
    assert.ok(paged.snapshot && !('unchanged' in paged.snapshot))
    const window = mergeList(combined, paged.snapshot)
    assert.equal(window.length, 51)
    assert.equal(window.at(-1)?.revision, 1)
    assert.ok(!window.some(row => row.revision === 2))

    assert.equal((await actAs(stranger, () => pollIssue(id, bodyChanged.version))).error, 'issueNotFound')
    assert.equal((await actAs(stranger, () => pollIssueVersionSummaries(id, snapshot.version, snapshot.positions))).error, 'issueNotFound')
    // A previously authorized workspace membership is checked again, even with
    // valid cursors. Legacy issue_members never grant workspace task access.
    await pool.query('insert into mikka_workspaces(id,"userId",name) values($1,$2,$3)', [workspaceId, owner, 'Detail cache fixture'])
    for (const userId of [owner, stranger]) await pool.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$2,$3,$4)',
      [workspaceId, userId, `${userId}@example.invalid`, userId === owner ? 'admin' : 'member'])
    await pool.query('insert into mikka_teams(id,"workspaceId","userId",name,identifier) values($1,$2,$3,$4,$5)', [teamId, workspaceId, owner, 'Cache fixture', 'CACHE'])
    const transfer = await read(() => promoteIssueToTeam({ requestId: randomUUID(), issueId: id, revision: 51, teamId, expectedTeamId: null }))
    assert.equal(transfer.error, 'teamIssueAccessDenied', 'team metadata cannot transfer the existing personal task')
    assert.equal((await pool.query('select "workspaceId" from issues where id=$1', [id])).rows[0].workspaceId, personalWorkspaceId)
    const createdShared = successful(await withActivitySession(owner, () => saveIssue({ title: 'Shared cached task', content, status: 'todo', priority: 'normal' }), workspaceId))
    assert.ok(createdShared.issue)
    const sharedId = createdShared.issue.id
    const promotion = await withActivitySession(owner, () => promoteIssueToTeam({ requestId: randomUUID(), issueId: sharedId, revision: 1, teamId, expectedTeamId: null }), workspaceId)
    assert.ok('issue' in promotion && promotion.issue, JSON.stringify(promotion))
    assert.equal(promotion.issue.workspaceId, workspaceId)
    const shared = successful(await readShared(() => pollIssue(sharedId)))
    assert.ok(shared.issue)
    const sharedHistory = successful(await readShared(() => pollIssueVersionSummaries(sharedId)))
    assert.ok(sharedHistory.snapshot && !('unchanged' in sharedHistory.snapshot))
    const sharedSnapshot = sharedHistory.snapshot
    await pool.query('insert into bots(id,"ownerId","workspaceId",name) values($1,$2,$3,$4)', [botId, stranger, workspaceId, 'Citation cache fixture'])
    await pool.query('insert into coordinator_messages(id,"userId","botId",position,message) values($1,$2,$3,1,$4)',
      [randomUUID(), stranger, botId, JSON.stringify({ role: 'assistant', content: `Read [[issue:${sharedId}]]` })])
    const chat = successful(await readChat(botId))
    assert.ok(chat.chat && !('unchanged' in chat.chat))
    const previousChat = chat.chat
    assert.equal(previousChat.sources[sharedId]?.kind, 'issue')
    const continuation = { ...previousChat.continuation!, sourceIds: [sharedId], artifactIds: [] }
    // Removing a citation source refreshes metadata even when no chat message changes.
    await pool.query('update issues set content=jsonb_set(content,\'{attrs}\',$2::jsonb) where id=$1', [sharedId, JSON.stringify({ mikka: { deletedAt: new Date().toISOString() } })])
    const deletedChat = successful(await readChat(botId, previousChat.version, continuation))
    assert.ok(deletedChat.chat && 'unchanged' in deletedChat.chat)
    assert.deepEqual(deletedChat.chat.metadata?.sources, {})
    assert.deepEqual(mergeChat(previousChat, deletedChat.chat)?.sources, {})
    await pool.query('update issues set content=$2 where id=$1', [sharedId, JSON.stringify(createdShared.issue.content)])
    await pool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [workspaceId, stranger])
    assert.equal((await readShared(() => pollIssue(sharedId, shared.version))).error, 'issueNotFound')
    assert.equal((await readShared(() => pollIssueVersionSummaries(sharedId, sharedSnapshot.version, sharedSnapshot.positions))).error, 'issueNotFound')
    assert.equal((await readChat(botId, previousChat.version, continuation)).error, 'botNotFound', 'revoked workspace membership denies the chat and its cached citations')
    assert.equal((await syncCoordinatorChat(botId)).error, 'authRequired', 'expected auth failures survive the Server Action boundary')
    await pool.query('delete from bots where id=$1', [botId])
    assert.equal((await readChat(botId, previousChat.version, continuation)).error, 'botNotFound')

    await t.test('unlinked workspace details keep immutable identity and recheck membership after relinking', async t => {
      const id = sharedId
      const identifier = createdShared.issue.identifier
      assert.ok(identifier)
      const { listIssueConnections } = await import('../app/actions/issue-operations')
      const { citationSources } = await import('../lib/coordinator/store')
      const { runAction } = await import('../lib/action-error')
      // Team links only name this already-bound shared task. The Personal task
      // above remains a separate control; unlinking never transfers ownership.
      const readWorkspace = <T>(work: () => Promise<T>) => withActivitySession(owner, () => actAs(owner, work), workspaceId) as Promise<T>
      const sharedNumber = successful(await readWorkspace(() => getIssue(id))).issue.metadata.number
      assert.equal(sharedNumber, 2, 'the shared task keeps its owner-allocated number')
      const warmCitationPool = async (teamState: 'linked' | 'unlinked' | 'revoked') => {
        // A single shape read can finish one concurrent query before the next
        // acquires its client. It does not guarantee a fully warm pool: a later
        // shape may still open a connection inside a steady-state budget.
        // Hold the existing APP pool's full capacity until all checkouts finish;
        // keep every startup byte in a separate, visible measurement.
        const capacity = pool.options.max
        assert.equal(capacity, 5, 'use the existing APP pool capacity, never change its configuration')
        const warmup = await measured(async () => {
          const acquired = await Promise.allSettled(Array.from({ length: capacity }, () => pool.connect()))
          const clients = acquired.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
          try {
            for (const result of acquired) if (result.status === 'rejected') throw result.reason
            return { capacity, clients: new Set(clients).size }
          } finally {
            for (const client of clients) client.release()
          }
        })
        assert.equal(warmup.value.clients, capacity, 'each held checkout must use a distinct real connection')
        assert.equal(warmup.statements, 0, 'pool startup issues no application SQL')
        t.diagnostic(JSON.stringify({ event: 'identifier_pool_warmup', teamState,
          scope: 'connection_startup_before_steady_state_budget', ...warmup.value, ...readMetrics(warmup) }))
      }
      const citationAgent = randomUUID(), citationRun = randomUUID()
      await pool.query('insert into agents(id,"userId",name,harness) values($1,$2,$3,$4)', [citationAgent, owner, 'Citation control', 'codex'])
      await pool.query('insert into agent_runs(id,"userId","issueId","agentId",status,prompt,"agentDefinition","workspaceId") values($1,$2,$3,$4,$5,$6,$7,$8)',
        [citationRun, owner, id, citationAgent, 'succeeded', 'Citation control', JSON.stringify({ harness: 'codex', executionIdentity: { requester: owner, executionPrincipal: owner, outputOwner: owner, workspaceId } }), workspaceId])
      const issueCite = `[[issue:${id}]]`, runCite = `[[run:${citationRun}]]`
      await readWorkspace(() => listIssueConnections(id))
      // Initialize both exact read shapes and both real pools before recording
      // their steady-state budgets. Keep the warm-up socket costs visible,
      // including any new connections opened by concurrent run and team reads.
      const linkedPoolsWarm = await measured(() => warmIdentifierPools({ app: pool, workspace: workspacePool }))
      const linkedDirectWarm = await measured(() => readWorkspace(() => citationSources(owner, [issueCite])))
      const linkedRunWarm = await measured(() => readWorkspace(() => citationSources(owner, [runCite])))
      t.diagnostic(JSON.stringify({ event: 'identifier_reader_warmup', teamState: 'linked',
        scope: 'data-read-path_including_connection_startup', poolCapacity: linkedPoolsWarm.value,
        poolStartup: readMetrics(linkedPoolsWarm), directCitation: readMetrics(linkedDirectWarm),
        runOnlyCitation: readMetrics(linkedRunWarm) }))
      const linkedConnections = await measured(() => readWorkspace(() => listIssueConnections(id)))
      const linkedCitation = await measured(() => readWorkspace(() => citationSources(owner, [issueCite])))
      const linkedRunCitation = await measured(() => readWorkspace(() => citationSources(owner, [runCite])))
      const removed = await withActivitySession(owner, () => setIssueTeam({ issueId: id, teamId: null, expectedTeamId: teamId }), workspaceId)
      assert.equal(removed.ok, true)
      assert.equal((await pool.query('select "workspaceId" from issues where id=$1', [id])).rows[0].workspaceId, workspaceId, 'removing the Team link preserves the Task tenant')
      await pool.query('insert into issue_prefixes ("userId",prefix) values ($1,$2),($3,$4)', [owner, 'READ', stranger, 'OTHR'])
      const personal = successful(await read(() => saveIssue({ title: 'Personal read control', content: { type: 'doc' }, status: 'todo', priority: 'normal' }))).issue
      const strangerWorkspace = await seedFixtureWorkspace(pool, stranger, 'personal')
      const readOtherPersonal = <T>(work: () => Promise<T>) => withActivitySession(stranger, () => actAs(stranger, work), strangerWorkspace) as Promise<T>
      const otherPersonal = successful(await readOtherPersonal(() => saveIssue({ title: 'Other prefix control', content: { type: 'doc' }, status: 'todo', priority: 'normal' }))).issue
      assert.ok(personal && otherPersonal)
      assert.equal((successful(await readOtherPersonal(() => getIssue(otherPersonal.id)))).issue.identifier, otherPersonal.identifier)
      assert.match(otherPersonal.identifier ?? '', /^OTHR-\d+$/)
      // Warm both paths before measuring; both use the same owner and have no
      // team link. Both retain current tenant authorization and Project projection.
      await read(() => getIssue(personal.id))
      const ownerView = successful(await readWorkspace(() => getIssue(id))).issue
      assert.equal(ownerView.scope, 'workspace')
      assert.equal(ownerView.identifier, identifier)
      // The write response also calls issueView without a known team map.
      // Compare the same-owner, no-link controls through the real save action.
      const personalSave = await measured(() => read(async () => successful(await saveIssue({
        id: personal.id, revision: personal.revision, title: personal.title, content: personal.content,
        status: personal.status, priority: personal.priority,
      }))))
      const unlinkedSave = await measured(() => readWorkspace(async () => successful(await saveIssue({
        id, revision: ownerView.revision, title: ownerView.title, content: ownerView.content,
        status: ownerView.status, priority: ownerView.priority,
      }))))
      await t.test('default issueView in saveIssue reuses the selected immutable identifier', () => {
        assert.equal(unlinkedSave.value.issue?.identifier, identifier)
        assert.equal(unlinkedSave.value.issue?.scope, 'workspace')
        assert.equal(unlinkedSave.value.issue?.linearTargetVerified, false)
        assert.deepEqual(unlinkedSave.value.issue?.content, ownerView.content, 'identifier resolution does not rewrite the task body')
        assert.ok(unlinkedSave.statements <= personalSave.statements + 1,
          `default issueView statements ${unlinkedSave.statements} vs personal ${personalSave.statements} plus one existing workspace verification read`)
      })
      const unlinkedPoolsWarm = await measured(() => warmIdentifierPools({ app: pool, workspace: workspacePool }))
      const unlinkedDirectWarm = await measured(() => readWorkspace(() => citationSources(owner, [issueCite])))
      const unlinkedRunWarm = await measured(() => readWorkspace(() => citationSources(owner, [runCite])))
      t.diagnostic(JSON.stringify({ event: 'identifier_reader_warmup', teamState: 'unlinked',
        scope: 'data-read-path_including_connection_startup', poolCapacity: unlinkedPoolsWarm.value,
        poolStartup: readMetrics(unlinkedPoolsWarm), directCitation: readMetrics(unlinkedDirectWarm),
        runOnlyCitation: readMetrics(unlinkedRunWarm) }))
      const unlinkedConnections = await measured(() => readWorkspace(() => listIssueConnections(id)))
      const unlinkedCitation = await measured(() => readWorkspace(() => citationSources(owner, [issueCite])))
      const unlinkedRunCitation = await measured(() => readWorkspace(() => citationSources(owner, [runCite])))

      // Frozen same-fixture measurements on main 3c32675c: a changed linked
      // control cannot make an upstream SQL/payload regression pass. The Task
      // review hint adds a bounded boolean column (and its correlated SQL) to
      // the citation reads; statement counts are unchanged. `issueLatestRun`
      // now also carries stopReason, so the chat can tell a run that ended on
      // a question from one the judge moved on: +13 written (the projection
      // text) and +6 read (the extra null element) on each citation read. The
      // connection reads keep their old numbers: the history budget absorbs it.
      const originalIdentifierReadMetrics = {
        linkedConnections: { statements: 14, read: 3490, written: 5497 },
        unlinkedConnections: { statements: 14, read: 3192, written: 5346 },
        linkedCitation: { statements: 4, read: 1194, written: 1947 },
        unlinkedCitation: { statements: 5, read: 1409, written: 2270 },
        linkedRunCitation: { statements: 9, read: 3157, written: 6581 },
        unlinkedRunCitation: { statements: 10, read: 2714, written: 6910 },
      } as const
      for (const [label, result, statementLimit] of [
        ['linkedConnections', linkedConnections, 14],
        ['unlinkedConnections', unlinkedConnections, 13],
        ['linkedCitation', linkedCitation, 4],
        ['unlinkedCitation', unlinkedCitation, 4],
        ['linkedRunCitation', linkedRunCitation, 9],
        ['unlinkedRunCitation', unlinkedRunCitation, 9],
      ] as const) {
        await t.test(label + ' stays within the frozen statement and total-wire budget', () => {
          const before = originalIdentifierReadMetrics[label]
          const total = result.bytes + result.bytesWritten
          const originalTotal = before.read + before.written
          t.diagnostic(JSON.stringify({ event: 'read_cache_measurement', surface: 'identifier-reader-fixed-baseline',
            reader: label, scope: 'data-read-path_not_page_http', original: before, current: readMetrics(result) }))
          assert.ok(result.statements <= statementLimit,
            label + ' statements ' + result.statements + ' exceed ' + statementLimit + ' (old ' + before.statements + ')')
          assert.ok(total <= originalTotal,
            label + ' total socket bytes ' + total + ' exceed frozen old ' + originalTotal
              + ' (read ' + result.bytes + ', written ' + result.bytesWritten + ')')
        })
      }
      await t.test('connection identifiers reuse immutable values in the existing metadata query', () => {
        const connection = unlinkedConnections.value.find(row => row.id === id)
        assert.ok(connection)
        assert.equal(connection.identifier, identifier)
        assert.ok(connection.createdAt instanceof Date, 'connection timestamps retain their Date shape')
        assert.deepEqual(connection.metadata, unlinkedSave.value.issue?.metadata, 'connection metadata retains every original field')
        assert.equal(connection.scopeVersion, unlinkedSave.value.issue?.scopeVersion)
      })
      await t.test('direct and run-only citations keep the linked read budget and private input boundary', async () => {
        const citation = unlinkedCitation.value[id], run = unlinkedRunCitation.value[citationRun]
        assert.ok(citation?.kind === 'issue')
        assert.ok(run?.kind === 'run')
        assert.equal(citation.identifier, identifier)
        assert.equal(run.issue?.identifier, identifier)
        assert.doesNotMatch(JSON.stringify([unlinkedConnections.value, unlinkedCitation.value, unlinkedRunCitation.value]), /prefixInput|__mikkaIdentifierPrefix|identifierTeams?|@example\.invalid/)
        const { issuesForUser } = await import('../lib/issues-for-user')
        const defaults = await issuesForUser(owner, [id], false, db, { withoutBody: true })
        assert.ok(defaults.has(id))
        assert.equal(Object.hasOwn(defaults.get(id)!, 'prefixInput'), false, 'default readers retain their original object shape')
      })
      await t.test('an authorized Linear import verifies its target until the link is removed', async () => {
        const { linearTeamSyncs } = await import('../lib/db/schema')
        const { createAppIssueFromLinear } = await import('../lib/linear-sync/issue-sync')
        const [sync] = await db.insert(linearTeamSyncs).values({ id: randomUUID(), ownerId: owner,
          workspaceId, linearTeamId: randomUUID(), linearTeamKey: 'ALIS', linearTeamName: 'Verified read fixture', active: true }).returning()
        const imported = await createAppIssueFromLinear(sync, { id: randomUUID(), identifier: 'ALIS-1',
          title: 'Verified read fixture', description: '', dueDate: null, priority: 0, url: 'https://example.invalid/fixture',
          updatedAt: new Date().toISOString(), state: null, team: { id: sync.linearTeamId, key: sync.linearTeamKey, name: sync.linearTeamName },
          assignee: null, labels: [] })
        assert.ok(imported)
        const verified = successful(await readWorkspace(() => pollIssue(imported.id)))
        assert.equal(verified.issue?.linearTargetVerified, true)
        assert.equal(verified.issue?.scope, 'workspace')
        assert.equal(verified.issue?.identifier, imported.issuedIdentifier)
        assert.ok(verified.issue?.identifier?.startsWith(`W${workspaceId.replaceAll('-', '').slice(0, 12).toUpperCase()}-`))
        await pool.query('delete from linear_issue_links where "issueId"=$1 and "ownerId"=$2', [imported.id, owner])
        const removed = successful(await readWorkspace(() => pollIssue(imported.id, verified.version)))
        assert.equal(removed.issue?.linearTargetVerified, false)
        assert.equal(removed.issue?.identifier, verified.issue?.identifier)
        assert.notEqual(removed.version, verified.version)
      })
      const personalGet = await measured(() => read(() => getIssue(personal.id)))
      const unlinkedGet = await measured(() => readWorkspace(() => getIssue(id)))
      assert.equal(successful(unlinkedGet.value).issue.identifier, identifier)
      await t.test('unlinked getIssue keeps its existing verification-read budget', () => {
        assert.ok(unlinkedGet.statements <= personalGet.statements + 1,
          'an unlinked workspace detail stays within the existing verification budget without a repeated empty team read')
      })
      const personalCold = await measured(() => read(async () => successful(await pollIssue(personal.id))))
      const unlinkedCold = await measured(() => readWorkspace(async () => successful(await pollIssue(id))))
      assert.equal(unlinkedCold.value.issue?.identifier, identifier)
      await t.test('unlinked cold poll keeps its existing verification-read budget', () => {
        assert.ok(unlinkedCold.statements <= personalCold.statements + 1)
      })
      const personalWarm = await measured(() => read(async () => successful(await pollIssue(personal.id, personalCold.value.version))))
      const unlinkedWarm = await measured(() => readWorkspace(async () => successful(await pollIssue(id, unlinkedCold.value.version))))
      assert.equal(personalWarm.value.unchanged, true)
      assert.equal(unlinkedWarm.value.unchanged, true)
      await t.test('unlinked warm poll keeps its existing verification-read budget', () => {
        assert.ok(unlinkedWarm.statements <= personalWarm.statements + 1)
      })
      await pool.query('update issue_prefixes set prefix=$2 where "userId"=$1', [owner, 'NEXT'])
      const renamed = successful(await readWorkspace(() => pollIssue(id, unlinkedCold.value.version)))
      assert.equal(renamed.unchanged, true, 'an owner prefix setting does not rename an already issued Task')
      assert.equal(renamed.version, unlinkedCold.value.version)
      assert.equal(successful(await readWorkspace(() => getIssue(id))).issue.identifier, identifier)
      assert.equal((await readShared(() => getIssue(id))).error, 'issueNotFound')
      assert.equal((await readShared(() => pollIssue(id, renamed.version))).error, 'issueNotFound')
      assert.equal(await readWorkspace(() => getIssueTeam(id)), null)
      const linked = await readWorkspace(() => setIssueTeam({ issueId: id, teamId, expectedTeamId: null }))
      assert.equal(linked.ok, true)
      assert.equal(await readWorkspace(() => getIssueTeam(id)), teamId, 'an empty grouping result is never retained across operations')
      const relinked = successful(await readWorkspace(() => pollIssue(id, renamed.version)))
      assert.equal(relinked.unchanged, true, 'a grouping-only change does not change the Task identity or detail DTO')
      assert.equal(relinked.version, renamed.version)
      assert.equal((await readWorkspace(() => listIssueConnections(id))).find(row => row.id === id)?.identifier, identifier,
        'a connection read retains the issued Task identity after its grouping changes')
      const relinkedSources = await readWorkspace(() => citationSources(owner, [issueCite, runCite]))
      const relinkedTask = relinkedSources[id], relinkedRun = relinkedSources[citationRun]
      assert.ok(relinkedTask?.kind === 'issue' && relinkedRun?.kind === 'run')
      assert.equal(relinkedTask.identifier, identifier)
      assert.equal(relinkedRun.issue?.identifier, identifier)
      // A creator loses this shared task with their current membership. The
      // issued identifier and cached detail/citation cursors grant no authority.
      const beforeRevocation = (await pool.query('select "issuedIdentifier",content from issues where id=$1', [id])).rows[0]
      await pool.query('update mikka_workspace_members set status=$3 where "workspaceId"=$1 and "userId"=$2', [workspaceId, owner, 'suspended'])
      assert.equal((await readWorkspace(() => getIssue(id))).error, 'issueNotFound')
      assert.equal((await readWorkspace(() => pollIssue(id, relinked.version))).error, 'issueNotFound')
      await warmCitationPool('revoked')
      const revokedDirectWarm = await measured(() => readWorkspace(() => citationSources(owner, [issueCite])))
      const revokedRunWarm = await measured(() => readWorkspace(() => citationSources(owner, [runCite])))
      t.diagnostic(JSON.stringify({ event: 'identifier_reader_warmup', teamState: 'revoked',
        scope: 'data-read-path_including_connection_startup', directCitation: readMetrics(revokedDirectWarm),
        runOnlyCitation: readMetrics(revokedRunWarm) }))
      const revokedConnections = await measured(() => readWorkspace(() => runAction(() => listIssueConnections(id))))
      const revokedCitation = await measured(() => readWorkspace(() => citationSources(owner, [issueCite])))
      const revokedRunCitation = await measured(() => readWorkspace(() => citationSources(owner, [runCite])))
      await t.test('revoked owners lose connections and both citation readers without rewriting history', () => {
        t.diagnostic(JSON.stringify({ event: 'read_cache_measurement', surface: 'revoked-owner-identifier-readers',
          scope: 'data-read-path_not_page_http', connections: readMetrics(revokedConnections),
          directCitation: readMetrics(revokedCitation), runOnlyCitation: readMetrics(revokedRunCitation) }))
        assert.deepEqual(revokedConnections.value, { error: 'issueNotFound', params: undefined })
        assert.deepEqual(revokedCitation.value, {})
        assert.deepEqual(revokedRunCitation.value, {})
        assert.doesNotMatch(JSON.stringify([revokedConnections.value, revokedCitation.value, revokedRunCitation.value]),
          /prefixInput|__mikkaIdentifierPrefix|identifierTeams?|@example\.invalid/)
      })
      assert.deepEqual((await pool.query('select "issuedIdentifier",content from issues where id=$1', [id])).rows[0], beforeRevocation)
      // Captured on the same fixture against old main 3c32675c; these are
      // actual revoked-owner measurements, not inferred from the linked case.
      // Two features add bytes here, each already measured on its own branch:
      // `issueLatestRun` now carries stopReason (+13 written, the projection
      // text, from the chat reply-actions change), and the canonical citation
      // projection adds 55 bytes through `run`, `codingReview` and
      // `issuedIdentifier` while its statement count stays at 3. The frozen
      // budget follows the sum of both increments over the original 2106.
      for (const [label, result, statementLimit, originalTotal] of [
        ['revokedConnections', revokedConnections, 12, 7464],
        ['revokedCitation', revokedCitation, 3, 2174],
        ['revokedRunCitation', revokedRunCitation, 7, 7700],
      ] as const) {
        await t.test(label + ' stays within its frozen old-source budget', () => {
          assert.ok(result.statements <= statementLimit,
            label + ' statements ' + result.statements + ' exceed frozen old ' + statementLimit)
          assert.ok(result.bytes + result.bytesWritten <= originalTotal,
            label + ' total socket bytes ' + (result.bytes + result.bytesWritten) + ' exceed frozen old ' + originalTotal)
        })
      }
      await pool.query('update mikka_workspace_members set status=$3 where "workspaceId"=$1 and "userId"=$2', [workspaceId, owner, 'active'])
      t.diagnostic(JSON.stringify({ event: 'read_cache_measurement', surface: 'unlinked-task-detail', scope: 'data-read-path_not_page_http',
        personalSave: readMetrics(personalSave), unlinkedSave: readMetrics(unlinkedSave),
        linkedConnections: readMetrics(linkedConnections), unlinkedConnections: readMetrics(unlinkedConnections),
        linkedCitation: readMetrics(linkedCitation), unlinkedCitation: readMetrics(unlinkedCitation),
        linkedRunCitation: readMetrics(linkedRunCitation), unlinkedRunCitation: readMetrics(unlinkedRunCitation),
        personalGet: readMetrics(personalGet), unlinkedGet: readMetrics(unlinkedGet), personalCold: readMetrics(personalCold),
        unlinkedCold: readMetrics(unlinkedCold), personalWarm: readMetrics(personalWarm), unlinkedWarm: readMetrics(unlinkedWarm) }))
    })

    await t.test('copying a subtree preserves source tasks and allocates distinct numbered copies', async t => {
      const { createLinkedIssue, listIssueConnections } = await import('../app/actions/issue-operations')
      const parent = successful(await read(() => saveIssue({
        title: 'Copy fixture root', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Copy body' }] }] },
        status: 'todo', priority: 'normal',
      }))).issue
      assert.ok(parent)
      const child = successful(await read(() => createLinkedIssue({
        id: parent.id, revision: parent.revision, kind: 'child', title: 'Copy fixture child',
      }))).issue
      assert.ok(child)
      const sourceParent = successful(await read(() => getIssue(parent.id))).issue
      const sourceChild = successful(await read(() => getIssue(child.id))).issue
      assert.equal(sourceChild.metadata.parentId, sourceParent.id)
      const copied = await measured(() => read(() => createLinkedIssue({
        id: sourceParent.id, revision: sourceParent.revision, kind: 'duplicate', includeSubissues: true,
      })))
      t.diagnostic(JSON.stringify({ event: 'read_cache_measurement', surface: 'copy-subtree',
        scope: 'data-read-path_not_page_http', copy: readMetrics(copied) }))
      const copy = successful(copied.value).issue
      assert.ok(copy)
      assert.ok(typeof copy.identifier === 'string' && copy.identifier.length > 0)
      assert.deepEqual(copy.content.content, sourceParent.content.content, 'copy retains the original description body')
      const copiedChildren = (await read(() => listIssueConnections(copy.id))).filter(row => row.metadata.parentId === copy.id)
      assert.equal(copiedChildren.length, 1, 'the child is copied beneath the new root')
      const copiedChild = copiedChildren[0]
      assert.equal(new Set([sourceParent.id, sourceChild.id, copy.id, copiedChild.id]).size, 4)
      assert.equal(copy.metadata.parentId, null)
      assert.equal(copiedChild.metadata.parentId, copy.id)
      const numbers = [copy.metadata.number, copiedChild.metadata.number]
      assert.ok(numbers.every(number => typeof number === 'number' && Number.isInteger(number) && number > 0))
      assert.equal(new Set(numbers).size, 2)
      assert.ok(numbers.every(number => number !== sourceParent.metadata.number && number !== sourceChild.metadata.number))
      for (const original of [sourceParent, sourceChild]) {
        const after = successful(await read(() => getIssue(original.id))).issue
        assert.equal(after.title, original.title)
        assert.equal(after.revision, original.revision)
        assert.equal(after.scope, original.scope)
        assert.equal(after.scopeVersion, original.scopeVersion)
        assert.equal(after.status, original.status)
        assert.equal(after.priority, original.priority)
        assert.deepEqual(after.content, original.content)
        assert.deepEqual(after.metadata, original.metadata)
      }
      await t.test('copying a subtree stays within its frozen old-source budget', () => {
        assert.ok(copied.statements <= 30,
          'copy-subtree statements ' + copied.statements + ' exceed frozen old 30')
        assert.ok(copied.bytes + copied.bytesWritten <= 25158,
          'copy-subtree total socket bytes ' + (copied.bytes + copied.bytesWritten) + ' exceed frozen old 25158')
      })
    })

    await pool.query('update issues set content=jsonb_set(content,\'{attrs}\',$2::jsonb) where id=$1', [id, JSON.stringify({ mikka: { deletedAt: new Date().toISOString() } })])
    const deletion = await measured(() => read(async () => ({ detail: await pollIssue(id, bodyChanged.version), history: await pollIssueVersionSummaries(id, snapshot.version, snapshot.positions) })))
    assert.equal(deletion.value.detail.error, 'issueNotFound')
    assert.equal(deletion.value.history.error, 'issueNotFound')
    t.diagnostic(JSON.stringify({ event: 'read_cache_measurement', surface: 'task-detail-and-activity', scope: 'data-read-path_not_page_http', historyRows: 50,
      legacyReload: readMetrics(legacy), cold: readMetrics(cold), warmKnown: readMetrics(warm), reloadRestored: readMetrics(restored), oneRowDelta: readMetrics(delta), detailChange: readMetrics(changed), deletion: readMetrics(deletion) }))
  } finally {
    await pool.query('delete from agent_runs where "userId"=any($1::text[])', [[owner, stranger]])
    await pool.query('delete from agents where "userId"=any($1::text[])', [[owner, stranger]])
    await pool.query('delete from linear_issue_links where "ownerId"=any($1::text[])', [[owner, stranger]])
    await pool.query('delete from linear_team_syncs where "ownerId"=any($1::text[])', [[owner, stranger]])
    await pool.query('delete from coordinator_messages where "userId"=$1', [stranger])
    await pool.query('delete from bots where id=$1', [botId])
    await pool.query('delete from team_issue_promotion_receipts where "ownerId"=$1', [owner])
    await pool.query('delete from team_issue_promotions where "ownerId"=$1', [owner])
    await pool.query('delete from mikka_team_issues where "teamId"=$1', [teamId])
    await pool.query('delete from mikka_teams where id=$1', [teamId])
    await pool.query('delete from mikka_workspace_members where "workspaceId"=$1', [workspaceId])
    await pool.query('delete from mikka_workspaces where id=$1', [workspaceId])
    await pool.query('delete from issue_versions where "userId"=any($1::text[])', [[owner, stranger]])
    await pool.query('delete from issue_documents where "userId"=any($1::text[])', [[owner, stranger]])
    await pool.query('delete from issues where "userId"=any($1::text[])', [[owner, stranger]])
    await pool.query('delete from issue_prefixes where "userId"=any($1::text[])', [[owner, stranger]])
    await pool.query('delete from "user" where id=any($1::text[])', [[owner, stranger]])
  }
})

test('chat readers advertise the authorized bot tenant for live delivery', { skip: !enabled }, async t => {
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { getCoordinatorChat, syncCoordinatorChat } = await import('../app/actions/coordinator')
  const { botChatTargets } = await import('../lib/live/chats')
  const owner = `chat-scope-owner-${randomUUID()}`, peer = `chat-scope-peer-${randomUUID()}`
  const home = randomUUID(), team = randomUUID(), peerHome = randomUUID()
  const teamBot = randomUUID(), personalBot = randomUUID(), peerBot = randomUUID()
  const users = [owner, peer], workspaces = [home, team, peerHome], botIds = [teamBot, personalBot, peerBot]
  const read = <T>(userId: string, workspaceId: string, work: () => Promise<T>) =>
    withActivitySession(userId, work, workspaceId)
  try {
    for (const id of users) await pool.query(
      'insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())',
      [id, `${id}@example.invalid`],
    )
    await seedFixtureWorkspace(workspacePool, owner, 'personal', home)
    await seedFixtureWorkspace(workspacePool, owner, 'team', team)
    await seedFixtureWorkspace(workspacePool, peer, 'personal', peerHome)
    await workspacePool.query(
      'insert into mikka_workspace_members("workspaceId","userId",name,email,role,status) values($1,$2,$2,$3,\'member\',\'active\')',
      [team, peer, `${peer}@example.invalid`],
    )
    for (const [id, userId, workspaceId] of [[teamBot, owner, team], [personalBot, owner, home], [peerBot, peer, team]]) {
      await pool.query('insert into bots(id,"ownerId","workspaceId",name) values($1,$2,$3,\'Chat scope fixture\')', [id, userId, workspaceId])
      await pool.query('insert into coordinator_messages(id,"userId","botId",position,message) values($1,$2,$3,1,$4)',
        [randomUUID(), userId, id, JSON.stringify({ role: 'assistant', content: 'Committed fixture reply' })])
    }

    await t.test('team full, cold and unchanged reads match the writer and never the personal home', async () => {
      const [writer] = await botChatTargets(pool, workspacePool, owner, teamBot)
      assert.deepEqual(writer.scope, { ownerId: owner, workspaceId: team })
      const full = await read(owner, team, () => getCoordinatorChat(teamBot))
      const cold = successful(await read(owner, team, () => syncCoordinatorChat(teamBot))).chat
      assert.ok(!('unchanged' in cold))
      assert.ok(cold.version)
      const unchanged = successful(await read(owner, team, () => syncCoordinatorChat(teamBot, cold.version))).chat
      assert.equal('unchanged' in unchanged && unchanged.unchanged, true)
      for (const chat of [full, cold, unchanged]) {
        assert.deepEqual({ ownerId: chat.live?.ownerId, workspaceId: chat.live?.workspaceId }, writer.scope)
        assert.notEqual(chat.live?.workspaceId, home)
      }
    })

    await t.test('a personal bot retains its own authorized personal channel', async () => {
      const [writer] = await botChatTargets(pool, workspacePool, owner, personalBot)
      assert.deepEqual(writer.scope, { ownerId: owner, workspaceId: home })
      const full = await read(owner, home, () => getCoordinatorChat(personalBot))
      const incremental = successful(await read(owner, home, () => syncCoordinatorChat(personalBot))).chat
      for (const chat of [full, incremental]) {
        assert.deepEqual({ ownerId: chat.live?.ownerId, workspaceId: chat.live?.workspaceId }, writer.scope)
      }
    })

    await t.test('wrong workspace and another owner cannot obtain chat or live metadata', async () => {
      for (const [userId, workspaceId, botId] of [[owner, home, teamBot], [peer, team, teamBot], [owner, team, peerBot]]) {
        const denied = await read(userId, workspaceId, () => syncCoordinatorChat(botId))
        assert.ok(denied.error)
        assert.equal('chat' in denied, false)
        await assert.rejects(() => read(userId, workspaceId, () => getCoordinatorChat(botId)))
      }
      assert.deepEqual(await botChatTargets(pool, workspacePool, peer, teamBot), [])
    })

    await t.test('membership revocation also rejects a previously valid chat version', async () => {
      const before = successful(await read(owner, team, () => syncCoordinatorChat(teamBot))).chat
      assert.ok(before.version)
      await workspacePool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [team, owner])
      const denied = await read(owner, team, () => syncCoordinatorChat(teamBot, before.version))
      assert.ok(denied.error)
      assert.equal('chat' in denied, false)
      await assert.rejects(() => read(owner, team, () => getCoordinatorChat(teamBot)))
      assert.deepEqual(await botChatTargets(pool, workspacePool, owner, teamBot), [])
    })
  } finally {
    await pool.query('delete from coordinator_messages where "botId"=any($1::uuid[])', [botIds])
    await pool.query('delete from bots where id=any($1::uuid[])', [botIds])
    await workspacePool.query('delete from mikka_workspace_members where "workspaceId"=any($1::uuid[])', [workspaces])
    await workspacePool.query('delete from mikka_workspaces where id=any($1::uuid[])', [workspaces])
    await pool.query('delete from "user" where id=any($1::text[])', [users])
  }
})
