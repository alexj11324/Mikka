import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { gzipSync } from 'node:zlib'
import { mock, test } from 'node:test'
import type { PoolClient } from 'pg'
import { dbUrl, seedAgent, seedBot, seedIssue, seedProject, seedRun, seedTeam, seedTeamIssue, seedUser, seedPersonalWorkspace, seedWorkspace } from '../../tests/support/workspace-admin-db'

test('project map uses real PostgreSQL and normal HTTP PAT authorization', { skip: !dbUrl, timeout: 180_000 }, async t => {
  // Sample every SQL result on the real app/workspace pools only during the
  // bounded benchmark below. No parameters or row contents enter diagnostics.
  const previousBasePath = process.env.MIKKA_BASE_PATH
  process.env.MIKKA_BASE_PATH = '/mikka'
  t.after(() => { if (previousBasePath === undefined) delete process.env.MIKKA_BASE_PATH; else process.env.MIKKA_BASE_PATH = previousBasePath })
  mock.method(Math, 'random', () => 0)
  const { overrideDeploymentSwitch } = await import('../deployment-switches')
  let measurement: { queries: number; selects: number; bytes: number } | null = null
  const originalLog = console.log
  console.log = (...args: unknown[]) => {
    if (measurement && typeof args[0] === 'string' && args[0].includes('"msg":"db_sample"')) {
      const sample = JSON.parse(args[0]); measurement.queries++; measurement.selects += Number(sample.command === 'SELECT'); measurement.bytes += sample.bytes
      return
    }
    originalLog(...args)
  }
  t.after(() => { console.log = originalLog; overrideDeploymentSwitch('dbEgressSample', undefined) })
  let cachedSessionOwner: string | null = null
  mock.module('@/lib/auth', { namedExports: { MOBILE_APP_ORIGIN: 'mikka://', auth: { api: { getSession: async () => cachedSessionOwner
    ? { user: { id: cachedSessionOwner }, session: { id: 'isolated-cached-session' } } : null } } } })
  const { Pool } = await import('pg')
  const connection = new Pool({ connectionString: dbUrl, max: 3 })
  const { pool } = await import('@/lib/db'), { workspacePool } = await import('@/lib/workspace-db')
  const { createLegacyPersonalAccessToken } = await import('@/lib/tokens/store')
  const { recordProjectDecision } = await import('./decisions')
  const { resolveProjectScope, resolveProjectReadScope } = await import('./scope')
  const { collectMapFacts } = await import('./read-store')
  const { graphPage, projectGraph } = await import('./graph')
  const { mapQuerySchema, MAP_NODE_LIMIT, MAP_SOURCE_LIMIT, MAP_METADATA_BYTES } = await import('./read-contracts')
  const { readMapToken, signMapToken, fingerprint } = await import('./cursor')
  const { mapFactsSql } = await import('./read-sql')
  const { compactMapRowsSql, decodeMapRows } = await import('./read-transport')
  const contracts = await import('./response-contracts')
  const page = await import('../../app/api/projects/[projectId]/map/route')
  const node = await import('../../app/api/projects/[projectId]/map/nodes/[nodeId]/route')
  const path = await import('../../app/api/projects/[projectId]/map/path/route')
  const overview = await import('../../app/api/projects/[projectId]/map/overview/route')
  const source = await import('../../app/api/projects/[projectId]/map/sources/[sourceRef]/route')
  const owner = await seedUser(connection, 'map-reader'), peer = await seedUser(connection, 'map-peer')
  const home = { id: await seedPersonalWorkspace(connection, owner) }
  const other = { id: await seedPersonalWorkspace(connection, peer) }
  const projectId = await seedProject(connection, owner, []), issueId = await seedIssue(connection, owner, home.id)
  await connection.query('UPDATE workspace_projects SET "issueIds"=$2 WHERE id=$1', [projectId, JSON.stringify([issueId])])
  const botId = await seedBot(connection, home.id, owner), agentId = await seedAgent(connection, owner)
  const runId = await seedRun(connection, { userId: owner, agentId, botId, issueId, status: 'running' })
  const hidden = 'PRIVATE_TRANSCRIPT_MUST_NOT_ENTER_MAP_'
  await connection.query(`UPDATE agent_runs SET prompt=$2,report=$3,"agentDefinition"='{"harness":"codex","model":"gpt-6-luna"}' WHERE id=$1`,
    [runId, hidden + 'p'.repeat(120_000), JSON.stringify({ summary: hidden + 'r'.repeat(120_000) })])
  const taskId = randomUUID(), candidateId = randomUUID(), attemptId = randomUUID()
  const factoryFixture = await connection.connect()
  try {
    await factoryFixture.query('BEGIN')
  await factoryFixture.query(`INSERT INTO factory_tasks(id,"userId","botId","issueId","sourceEventId",route,stage,status,revision,"attemptId",reason)
    VALUES($1,$2,$3,$4,$5,'{}','execute','running',1,$6,'fixture')`, [taskId, owner, botId, issueId, randomUUID(), attemptId])
  await factoryFixture.query(`INSERT INTO factory_candidates(id,"taskId","runId",kind,sha,repository,environment,scope)
    VALUES($1,$2,$3,'repository',$4,'fixture/repo','isolated','test')`, [candidateId, taskId, runId, 'a'.repeat(40)])
  await factoryFixture.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"candidateId",reason)
    VALUES($1,$2,'review',1,1,'passed',$3,'verified this exact candidate')`, [attemptId, taskId, candidateId])
    await factoryFixture.query('COMMIT')
  } catch (cause) { await factoryFixture.query('ROLLBACK'); throw cause } finally { factoryFixture.release() }
  const artifactId = randomUUID(), versionId = randomUUID()
  await connection.query(`INSERT INTO artifacts(id,"userId",kind,title,"runId","issueId","workspaceId") VALUES($1,$2,'markdown','结果 report.md',$3,$4,$5)`, [artifactId, owner, runId, issueId, home.id])
  await connection.query(`INSERT INTO artifact_versions(id,"artifactId",version,"storageKey","inlineContent",sha256,size,"authorName")
    VALUES($1,$2,1,'isolated/unused',$3,$4,$5,'fixture')`, [versionId, artifactId, hidden + 'a'.repeat(120_000), 'b'.repeat(64), 120_040])
  const messageId = randomUUID(), original = '真实来源 ' + '甲乙丙丁'.repeat(3000)
  await connection.query('INSERT INTO coordinator_messages(id,"userId","botId",position,message) VALUES($1,$2,$3,0,$4)',
    [messageId, owner, botId, JSON.stringify({ role: 'user', content: original })])
  const recorded = await recordProjectDecision({ kind: 'human', user: owner, workspaceId: home.id }, {
    projectId, workspaceId: home.id, issueId, kind: 'choose', title: 'Keep exact versions', summary: 'Choose immutable evidence',
    reason: 'A later result must not replace the version actually checked', idempotencyKey: randomUUID(),
    options: [{ id: 'versioned', title: 'Versioned', disposition: 'selected' }, { id: 'mutable', title: 'Mutable', disposition: 'rejected', reason: 'Loses history' }],
    selectedOptionId: 'versioned', sources: [{ role: 'evidence', source: { type: 'bot_message', id: messageId } },
      { role: 'branch_work', optionId: 'versioned', source: { type: 'run', id: runId } }],
  })
  const token = await createLegacyPersonalAccessToken(owner, home.id, { name: 'Map HTTP fixture' })
  const otherToken = await createLegacyPersonalAccessToken(peer, other.id, { name: 'Foreign map fixture' })
  const server = createServer(async (incoming, outgoing) => {
    try {
      const request = new Request('http://127.0.0.1' + incoming.url, { headers: Object.fromEntries(Object.entries(incoming.headers)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')) })
      const parts = new URL(request.url).pathname.split('/'), project = parts[parts.indexOf('projects') + 1]
      const context = { params: Promise.resolve({ projectId: project, nodeId: decodeURIComponent(parts.at(-1)!), sourceRef: decodeURIComponent(parts.at(-1)!) }) }
      const response = parts.includes('nodes') ? await node.GET(request, context)
        : parts.includes('sources') ? await source.GET(request, context)
        : parts.at(-1) === 'path' ? await path.GET(request, context)
        : parts.at(-1) === 'overview' ? await overview.GET(request, context) : await page.GET(request, context)
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text())
    } catch (cause) { t.diagnostic(String(cause)); outgoing.writeHead(500); outgoing.end('handler_failed') }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const origin = 'http://127.0.0.1:' + address.port
  t.after(async () => { server.close(); server.closeAllConnections(); await Promise.all([connection.end(), pool.end(), workspacePool.end()]); mock.restoreAll() })
  const base = '/mikka/api/projects/' + projectId + '/map'
  const get = (suffix = '', bearer: string | null = token.token, target = base, workspaceId = home.id) => fetch(origin + target + suffix + (suffix.includes('?') ? '&' : '?') + 'workspaceId=' + workspaceId,
    { headers: bearer ? { authorization: 'Bearer ' + bearer } : {}, signal: AbortSignal.timeout(15_000) })
  const readPage = async () => { const response = await get(); assert.equal(response.status, 200, await response.clone().text()); return response.json() }

  await t.test('lightweight batch reads exclude original bodies and freeze the model; only exact merge evidence accepts a candidate', async () => {
    const scope = await resolveProjectScope(owner, projectId, home.id)
    let calls = 0, bytes = 0
    const measured = { query: async (sql: string, values?: unknown[]) => {
      const result = await connection.query(sql, values); calls++; bytes += Buffer.byteLength(JSON.stringify(result.rows))
      assert.ok(!JSON.stringify(result.rows).includes(hidden)); return result
    } } as Pick<PoolClient, 'query'>
    const facts = await collectMapFacts(measured, scope, true)
    assert.equal(calls, 1, 'metadata and every source authorization share one SQL snapshot'); assert.ok(bytes < 20 * 1024)
    assert.equal(facts.runs[0].modelId, 'gpt-6-luna'); assert.equal(facts.runs[0].outcome, null)
    assert.equal(facts.candidates[0].accepted, false)
    await connection.query(`INSERT INTO factory_merges(id,"taskId","candidateId","userId","eventId","pullRequestUrl",sha,status,source)
      VALUES($1,$2,$3,$4,$5,'https://github.com/fixture/repo/pull/1',$6,'merged','github')`,
      [randomUUID(), taskId, candidateId, owner, randomUUID(), 'a'.repeat(40)])
    assert.equal((await collectMapFacts(connection, scope, true)).candidates[0].accepted, true)
    t.diagnostic(JSON.stringify({ fixture: 'full-read', queries: calls, databaseJsonBytes: bytes }))
  })
  await t.test('all five real HTTP endpoints expose bounded contracts and exact Artifact versions', async () => {
    const response = await get('?limit=2'); assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.match(response.headers.get('etag')!, /^"[a-f0-9]{64}"$/)
    const result = contracts.mapPageResponseSchema.parse(await response.json()); assert.equal(result.nodes.length, 2); assert.equal(result.page.hasMore, true)
    assert.ok(result.page.nextCursor)
    const next = await get('?limit=2&cursor=' + encodeURIComponent(result.page.nextCursor)); assert.equal(next.status, 200)
    assert.ok(!(await next.text()).includes(hidden))
    const detail = await get('/nodes/' + encodeURIComponent('run:' + runId) + '?snapshot=' + encodeURIComponent(result.snapshot.id))
    assert.equal(detail.status, 200)
    const body = contracts.mapNodeResponseSchema.parse(await detail.json())
    assert.deepEqual(body.sections.map((section: { kind: string }) => section.kind), ['tasks', 'decisions', 'artifacts', 'checks', 'conversation_summary', 'threads'])
    assert.equal(body.sections[0].items[0].href, '/mikka?issue=' + issueId)
    assert.equal(body.references.runs.find(value => value.id === runId)?.href, '/mikka?issue=' + issueId + '&thread=' + runId)
    const artifact = body.sections[2].items[0]
    assert.equal(artifact.versionId, versionId)
    assert.equal(artifact.href, '/mikka/api/artifacts/' + artifactId + '/versions/1/download')
    for (const suffix of ['/path?nodeId=' + encodeURIComponent('run:' + runId), '/overview?']) {
      const value = await get(suffix + '&snapshot=' + encodeURIComponent(result.snapshot.id))
      assert.equal(value.status, 200, await value.clone().text())
      ;(suffix.startsWith('/path') ? contracts.mapPathResponseSchema : contracts.mapOverviewResponseSchema).parse(await value.json())
    }
    const refs = body.references.sources as string[]
    const stored = refs.find(ref => ref.startsWith('source:'))!; assert.ok(stored)
    const original = await get('/sources/' + encodeURIComponent(stored)); assert.equal(original.status, 200)
    contracts.mapSourceResponseSchema.parse(await original.json())
  })
  await t.test('container details include their own facts and decision details expose only the public contract', async () => {
    const result = await readPage()
    for (const target of ['project:' + projectId, 'issue:' + issueId, 'decision:' + recorded.decisionId]) {
      const response = await get('/nodes/' + encodeURIComponent(target) + '?snapshot=' + encodeURIComponent(result.snapshot.id))
      assert.equal(response.status, 200, await response.clone().text())
      const body = await response.json()
      const section = (kind: string) => body.sections.find((value: { kind: string }) => value.kind === kind).items
      const decision = section('decisions').find((value: { id: string }) => value.id === recorded.decisionId)
      assert.ok(decision); assert.equal(decision.sourceRefs.length, 2)
      assert.ok(decision.sourceRefs.every((ref: string) => ref.startsWith('source:')))
      for (const internal of ['sources', 'recordedBy', 'decidedBy', 'ownerId', 'payloadHash', 'idempotencyKey'])
        assert.equal(Object.hasOwn(decision, internal), false, internal)
      assert.deepEqual(section('artifacts').map((value: { versionId: string }) => value.versionId), [versionId])
      assert.deepEqual(section('checks').map((value: { candidateId: string }) => value.candidateId), [candidateId])
      assert.deepEqual(body.references.runs.map((value: { id: string }) => value.id), [runId])
      assert.match(response.headers.get('etag')!, /^"[a-f0-9]{64}"$/)
      assert.equal(body.live.ownerId, owner); assert.equal(body.live.workspaceId, home.id)
    }
    const anotherIssue = await seedIssue(connection, owner, home.id)
    const anotherRun = await seedRun(connection, { userId: owner, agentId, botId, issueId: anotherIssue })
    await connection.query('UPDATE workspace_projects SET "issueIds"=$2,revision=revision+1 WHERE id=$1', [projectId, JSON.stringify([issueId, anotherIssue])])
    const current = await readPage()
    for (const target of ['issue:' + issueId, 'run:' + runId, 'candidate:' + candidateId]) {
      const response = await get('/nodes/' + encodeURIComponent(target) + '?snapshot=' + encodeURIComponent(current.snapshot.id))
      assert.equal(response.status, 200, await response.clone().text())
      const body = await response.json()
      assert.ok(!JSON.stringify(body).includes(anotherRun)); assert.ok(!JSON.stringify(body).includes(anotherIssue))
    }
    await connection.query('UPDATE workspace_projects SET "issueIds"=$2,revision=revision+1 WHERE id=$1', [projectId, JSON.stringify([issueId])])
  })
  await t.test('scope metadata rejects oversized project arrays before transferring their complete JSON', async () => {
    await connection.query('UPDATE workspace_projects SET "issueIds"=$2 WHERE id=$1', [projectId, JSON.stringify(Array.from({ length: 101 }, () => randomUUID()))])
    const response = await get(); assert.equal(response.status, 409); assert.equal((await response.json()).code, 'map_scope_conflict')
    await connection.query('UPDATE workspace_projects SET "issueIds"=$2 WHERE id=$1', [projectId, JSON.stringify([issueId])])
  })
  await t.test('batched scope uses immutable tenant ownership despite malformed sync links', async () => {
    const shared = await seedWorkspace(connection, owner, [{ userId: owner, role: 'admin' }, { userId: peer, role: 'member' }])
    const team = await seedTeam(connection, shared.id, owner), foreignTeam = await seedTeam(connection, other.id, peer)
    const unlinked = await seedIssue(connection, owner, home.id)
    // Team links describe synchronization; the bound workspace remains the
    // authorization boundary even when historical links are malformed.
    const workspaceIssue = async (workspaceId: string, teamId: string) => {
      const id = randomUUID()
      await connection.query(`INSERT INTO issues(id,"userId",title,content,status,priority,scope,"linearSyncBlocked","workspaceId","ownershipState")
        VALUES($1,$2,'Scope fixture','{"type":"doc"}','todo','normal','workspace',true,$3,'bound')`, [id, owner, workspaceId])
      await connection.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [id, teamId, workspaceId, owner])
      return id
    }
    const valid = await workspaceIssue(shared.id, team.id), foreign = await workspaceIssue(other.id, foreignTeam.id)
    const mismatched = await workspaceIssue(shared.id, foreignTeam.id), orphan = await workspaceIssue(shared.id, randomUUID())
    const deleted = await workspaceIssue(shared.id, team.id)
    await connection.query('UPDATE issues SET content=$2 WHERE id=$1', [deleted, JSON.stringify({ type: 'doc', attrs: { mikka: { deletedAt: new Date().toISOString() } } })])
    const project = await seedProject(connection, owner, [{ teamId: team.id, workspaceId: shared.id }])
    const candidates = [unlinked, valid, foreign, mismatched, orphan, deleted, valid, 'not-a-uuid', null]
    await connection.query('UPDATE workspace_projects SET "issueIds"=$2 WHERE id=$1', [project, JSON.stringify(candidates)])
    for (const [reader, expected] of [[owner, [valid, mismatched, orphan]], [peer, [valid, mismatched, orphan]]] as const) {
      const original = await resolveProjectScope(reader, project, shared.id)
      const batched = await resolveProjectReadScope(reader, project, shared.id)
      assert.deepEqual([...batched.issueIds].sort(), [...expected].sort())
      assert.deepEqual([...batched.issueIds].sort(), [...original.issueIds].sort())
      assert.equal(batched.personalWorkspace, false)
    }
    const personalProject = await seedProject(connection, owner, [])
    await connection.query('UPDATE workspace_projects SET "issueIds"=$2 WHERE id=$1', [personalProject, JSON.stringify(candidates)])
    const personal = await resolveProjectReadScope(owner, personalProject, home.id)
    assert.deepEqual(personal.issueIds, [unlinked]); assert.equal(personal.personalWorkspace, true)
    await assert.rejects(resolveProjectReadScope(owner, project, home.id), { code: 'PROJECT_NOT_FOUND', status: 404 })
    await connection.query("UPDATE mikka_workspace_members SET status='suspended' WHERE \"workspaceId\"=$1 AND \"userId\"=$2", [shared.id, peer])
    await assert.rejects(resolveProjectReadScope(peer, project, shared.id), { code: 'PROJECT_NOT_FOUND', status: 404 })
    await connection.query('INSERT INTO mikka_team_projects("projectId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [project, foreignTeam.id, other.id, owner])
    await assert.rejects(resolveProjectReadScope(owner, project, shared.id), { code: 'PROJECT_SCOPE_CONFLICT', status: 409 })
    await assert.rejects(resolveProjectReadScope(owner, project, home.id), { code: 'PROJECT_NOT_FOUND', status: 404 })
  })
  await t.test('authorization and cursor errors stay distinct, without leaking cross-workspace existence', async () => {
    const result = await readPage()
    assert.equal((await get('', null)).status, 401)
    assert.equal((await get('', otherToken.token)).status, 404)
    assert.equal((await get('?limit=0')).status, 400)
    assert.equal((await get('?ownerId=forged')).status, 400)
    assert.equal((await get('?cursor=not.a.signature')).status, 400)
    assert.equal((await get('/nodes/' + encodeURIComponent('run:' + runId) + '?snapshot=' + encodeURIComponent(result.snapshot.id), otherToken.token)).status, 404)
    const claims = readMapToken(result.snapshot.id, { userId: owner, workspaceId: home.id, projectId }, ['snapshot'])
    const expired = signMapToken({ ...claims, expiresAt: Date.now() - 1 })
    assert.equal((await get('/overview?snapshot=' + encodeURIComponent(expired))).status, 410)
    assert.equal((await get('/overview?laneLimit=2&snapshot=' + encodeURIComponent(result.snapshot.id))).status, 409)
  })
  await t.test('heartbeat and active report updates do not invalidate a snapshot; Factory revision does', async () => {
    const result = await readPage()
    await connection.query('UPDATE agent_runs SET "leaseExpiresAt"=now()+interval \'2 minutes\',report=$2 WHERE id=$1', [runId, JSON.stringify({ summary: hidden + 'changed stream' })])
    assert.equal((await get('/overview?snapshot=' + encodeURIComponent(result.snapshot.id))).status, 200)
    await connection.query('UPDATE factory_tasks SET revision=revision+1 WHERE id=$1', [taskId])
    const changed = await get('/overview?snapshot=' + encodeURIComponent(result.snapshot.id))
    assert.equal(changed.status, 409); assert.equal((await changed.json()).restart, true)
  })
  await t.test('original text is lazy, bounded and masked before continuation; edits and revoked Bot scope invalidate it', async () => {
    const reference = (await connection.query('SELECT id FROM project_decision_sources WHERE "decisionId"=$1 AND "sourceType"=\'bot_message\'', [recorded.decisionId])).rows[0].id
    const endpoint = '/sources/' + encodeURIComponent('source:' + reference)
    const first = await get(endpoint); assert.equal(first.status, 200)
    const body = await first.json(); assert.equal(body.sourceKind, 'record'); assert.equal(body.page.hasMore, true)
    assert.ok(Buffer.byteLength(JSON.stringify(body.items)) < 17 * 1024)
    const second = await get(endpoint + '?cursor=' + encodeURIComponent(body.page.nextCursor))
    assert.equal(second.status, 200)
    await connection.query('UPDATE coordinator_messages SET message=$2 WHERE id=$1', [messageId, JSON.stringify({ role: 'user', content: original + ' changed' })])
    assert.equal((await get(endpoint + '?cursor=' + encodeURIComponent(body.page.nextCursor))).status, 409)
    await connection.query('UPDATE bots SET "workspaceId"=$2 WHERE id=$1', [botId, other.id])
    assert.equal((await get(endpoint)).status, 404)
    assert.equal((await readPage()).nodes.some((node: { id: string }) => node.id === 'decision:' + recorded.decisionId), false)
    await connection.query('UPDATE bots SET "workspaceId"=$2 WHERE id=$1', [botId, home.id])
  })
  await t.test('a stored source handle also reauthorizes the other private sources of its decision', async () => {
    const otherBot = await seedBot(connection, home.id, owner), extraMessage = randomUUID()
    await connection.query('INSERT INTO coordinator_messages(id,"userId","botId",position,message) VALUES($1,$2,$3,0,$4)',
      [extraMessage, owner, otherBot, JSON.stringify({ role: 'user', content: 'A separately revocable source' })])
    const saved = await recordProjectDecision({ kind: 'human', user: owner, workspaceId: home.id }, {
      projectId, workspaceId: home.id, issueId, kind: 'confirm', title: 'Require all evidence access', summary: 'Retain source boundaries',
      reason: 'Knowing one source id does not authorize the others', idempotencyKey: randomUUID(),
      sources: [{ role: 'evidence', source: { type: 'run', id: runId } }, { role: 'evidence', source: { type: 'bot_message', id: extraMessage } }],
    })
    const stored = (await connection.query(`SELECT id FROM project_decision_sources WHERE "decisionId"=$1 AND "sourceType"='run' LIMIT 1`, [saved.decisionId])).rows[0].id
    const endpoint = '/sources/' + encodeURIComponent('source:' + stored)
    assert.equal((await get(endpoint)).status, 200)
    await connection.query('UPDATE bots SET "workspaceId"=$2 WHERE id=$1', [otherBot, other.id])
    assert.equal((await get(endpoint)).status, 404)
    assert.equal((await get('/sources/' + encodeURIComponent('run:' + runId))).status, 200)
    assert.equal((await readPage()).nodes.some((node: { id: string }) => node.id === 'decision:' + saved.decisionId), false)
  })
  await t.test('run source pages use a stable high-water mark; an oversized original is explicit', async () => {
    for (let seq = 0; seq < 3; seq++) await connection.query('INSERT INTO run_chunks(id,"runId",seq,chunk) VALUES($1,$2,$3,$4)',
      [randomUUID(), runId, seq, JSON.stringify({ type: 'text', text: 'source-' + seq + 'x'.repeat(6000) })])
    const endpoint = '/sources/' + encodeURIComponent('run:' + runId)
    const first = await get(endpoint + '?limit=1'), body = await first.json(); assert.equal(first.status, 200)
    await connection.query('INSERT INTO run_chunks(id,"runId",seq,chunk) VALUES($1,$2,3,$3)', [randomUUID(), runId, JSON.stringify({ type: 'text', text: 'later' })])
    const seen = [...body.items]; let cursor = body.page.nextCursor
    while (cursor) { const next = await get(endpoint + '?limit=1&cursor=' + encodeURIComponent(cursor)); assert.equal(next.status, 200); const page = await next.json(); seen.push(...page.items); cursor = page.page.nextCursor }
    assert.deepEqual(seen.map(item => item.seq), [0, 1, 2]); assert.equal(body.sourceKind, 'run_chunks')
    await connection.query('DELETE FROM run_chunks WHERE "runId"=$1 AND seq=1', [runId])
    assert.equal((await get(endpoint + '?limit=1&cursor=' + encodeURIComponent(body.page.nextCursor))).status, 409)
    const bigRun = await seedRun(connection, { userId: owner, agentId, botId, issueId })
    await connection.query('INSERT INTO run_chunks(id,"runId",seq,chunk) VALUES($1,$2,0,$3)', [randomUUID(), bigRun, JSON.stringify({ text: 'x'.repeat(220 * 1024) })])
    assert.equal((await get('/sources/' + encodeURIComponent('run:' + bigRun))).status, 413)
  })
  await t.test('workspace members see shared status but never another owner private sections or source; suspension is immediate', async () => {
    const shared = await seedWorkspace(connection, owner, [{ userId: owner, role: 'admin' }, { userId: peer, role: 'member' }])
    const team = await seedTeam(connection, shared.id, owner)
    await connection.query('INSERT INTO mikka_team_members("teamId","userId",role) VALUES($1,$2,\'member\')', [team.id, peer])
    const sharedIssue = await seedTeamIssue(connection, shared.id, team.id, owner)
    const { promoteExistingIssueForUser } = await import('../team-issue-promotion')
    const promoted = await promoteExistingIssueForUser(owner, { requestId: randomUUID(), issueId: sharedIssue, revision: 1, teamId: team.id, expectedTeamId: team.id })
    assert.ok('issue' in promoted, JSON.stringify(promoted))
    const sharedProject = await seedProject(connection, owner, [{ teamId: team.id, workspaceId: shared.id }])
    await connection.query('UPDATE workspace_projects SET "issueIds"=$2 WHERE id=$1', [sharedProject, JSON.stringify([sharedIssue])])
    const sharedBot = await seedBot(connection, shared.id, owner)
    const sharedRun = await seedRun(connection, { userId: owner, agentId, botId: sharedBot, issueId: sharedIssue })
    const memberToken = await createLegacyPersonalAccessToken(peer, shared.id, { name: 'Shared map fixture' })
    const target = '/mikka/api/projects/' + sharedProject + '/map'
    const result = await get('', memberToken.token, target, shared.id); assert.equal(result.status, 200)
    const body = await result.json(); assert.ok(body.nodes.some((node: { id: string }) => node.id === 'run:' + sharedRun))
    const detail = await get('/nodes/' + encodeURIComponent('run:' + sharedRun) + '?snapshot=' + encodeURIComponent(body.snapshot.id), memberToken.token, target, shared.id)
    assert.equal(detail.status, 200)
    const sections = (await detail.json()).sections
    for (const section of sections.filter((section: { kind: string }) => section.kind !== 'tasks')) assert.equal(section.items.length, 0)
    assert.equal((await get('/sources/' + encodeURIComponent('run:' + sharedRun), memberToken.token, target, shared.id)).status, 404)
    await connection.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [shared.id, peer])
    // The shared-workspace PAT itself becomes invalid when membership is suspended.
    assert.equal((await get('/overview?snapshot=' + encodeURIComponent(body.snapshot.id), memberToken.token, target, shared.id)).status, 401)
  })
  await t.test('large metadata is rejected in SQL before transferring the original projection', async () => {
    await connection.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,reason)
      SELECT gen_random_uuid(),$1,'review',g,g,'passed',repeat('x',4000) FROM generate_series(100,450) g`, [taskId])
    let transferred = 0
    const measured = { query: async (sql: string, values?: unknown[]) => { const result = await connection.query(sql, values); transferred += Buffer.byteLength(JSON.stringify(result.rows)); return result } } as Pick<PoolClient, 'query'>
    try {
      await assert.rejects(collectMapFacts(measured, await resolveProjectScope(owner, projectId, home.id), true), (error: unknown) => (error as { code: string }).code === 'map_too_large')
      assert.ok(transferred < 20 * 1024)
      assert.equal((await get()).status, 413)
    } finally { await connection.query('DELETE FROM factory_attempts WHERE "taskId"=$1 AND ordinal>=100', [taskId]) }
  })
  await t.test('the full logical projections share one budget even when their compact representation is small', async () => {
    const originalContent = (await connection.query('SELECT content FROM issues WHERE id=$1', [issueId])).rows[0].content
    const content = { type: 'doc', attrs: { mikka: { blockedByIds: Array.from({ length: 17_000 }, () => randomUUID()) } } }
    const batches: { bytes: number; rows: unknown[] | null }[] = []
    const measured = { query: async (sql: string, values?: unknown[]) => {
      const result = await connection.query(sql, values); batches.push(result.rows[0]); return result
    } } as Pick<PoolClient, 'query'>
    try {
      await connection.query('UPDATE issues SET content=$2 WHERE id=$1', [issueId, JSON.stringify(content)])
      await connection.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,reason)
        SELECT gen_random_uuid(),$1,'review',g,g,'passed',repeat('x',4000) FROM generate_series(100,229) g`, [taskId])
      await assert.rejects(collectMapFacts(measured, await resolveProjectReadScope(owner, projectId, home.id), true),
        (error: unknown) => (error as { code: string }).code === 'map_too_large')
      assert.equal(batches.length, 1)
      assert.ok(Number(batches[0].bytes) > MAP_METADATA_BYTES)
      assert.equal(batches[0].rows, null)
    } finally {
      await connection.query('UPDATE issues SET content=$2 WHERE id=$1', [issueId, JSON.stringify(originalContent)])
      await connection.query('DELETE FROM factory_attempts WHERE "taskId"=$1 AND ordinal>=100', [taskId])
    }
  })
  await t.test('real PostgreSQL compact timestamps and JSON key order retain the exact facts fingerprint', async () => {
    const stamps = ['2026-11-05T12:34:56.123456+00:00', '1969-12-31T23:59:59.123456+00:00', '1969-12-31T23:59:59.999999+00:00', '1970-01-01T00:00:00.000001+00:00']
    const { rows: [row] } = await connection.query(`WITH projection_1 AS (
      SELECT $2::uuid AS id,($1::uuid[])[1] AS "issueId",'cancelled'::text AS status,NULL::text AS outcome,
        stamp AS "createdAt",stamp AS "finishedAt",NULL::uuid AS "retryOf",NULL::uuid AS "continuesRunId",
        NULL::uuid AS "threadReplacedBy",'codex'::text AS harness,NULL::text AS "modelId",true AS owned
      FROM unnest($3::timestamptz[]) stamp)
      SELECT (SELECT jsonb_agg(to_jsonb(projection_1) ORDER BY "createdAt",id) FROM projection_1) AS original,
        ${compactMapRowsSql('projection_1', 'runs')} AS compact`, [[issueId], runId, stamps])
    const expected = row.original.map((run: Record<string, unknown>) => ({ ...run,
      createdAt: new Date(String(run.createdAt)).toISOString(), finishedAt: new Date(String(run.finishedAt)).toISOString() }))
    const decoded = decodeMapRows(row.compact, 'runs', [issueId], MAP_NODE_LIMIT)
    assert.deepEqual(decoded, expected)
    assert.equal(JSON.stringify(decoded), JSON.stringify(expected))
    assert.equal(fingerprint(decoded), fingerprint(expected))
  })
  await t.test('100 issues and 399/899 runs keep exact 500/1000-node cold reads small without dropping global facts', async () => {
    const shared = await seedWorkspace(connection, owner, [{ userId: owner, role: 'admin' }])
    const team = await seedTeam(connection, shared.id, owner)
    const project = await seedProject(connection, owner, [{ teamId: team.id, workspaceId: shared.id }])
    const bot = await seedBot(connection, shared.id, owner), ids = Array.from({ length: 100 }, () => randomUUID())
    await connection.query(`INSERT INTO issues(id,"userId",title,content,status,priority,scope,"linearSyncBlocked","createdAt","workspaceId","ownershipState")
      SELECT id,$2,'Synthetic load fixture '||lpad(n::text,3,'0')||' — no provider execution','{"type":"doc"}'::jsonb,
        'canceled','normal','workspace',true,'2026-10-28T19:56:34.123456Z'::timestamptz+n*interval '1 millisecond',$3,'bound'
      FROM unnest($1::uuid[]) WITH ORDINALITY AS fixture(id,n)`, [ids, owner, shared.id])
    await connection.query(`INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId")
      SELECT unnest($1::uuid[]),$2,$3,$4`, [ids, team.id, shared.id, owner])
    await connection.query('UPDATE workspace_projects SET "issueIds"=$2 WHERE id=$1', [project, JSON.stringify(ids)])
    const appendRuns = (from: number, to: number) => connection.query(`INSERT INTO agent_runs(id,"userId","agentId","botId","issueId",status,"createdAt","finishedAt")
      SELECT gen_random_uuid(),$1,$2,$3,($4::uuid[])[((n-1)%100)+1],'cancelled',
        '2026-10-28T19:56:34.123456Z'::timestamptz+n*interval '1 millisecond',
        '2026-10-28T19:56:34.123456Z'::timestamptz+n*interval '1 millisecond'
      FROM generate_series($5::integer,$6::integer) n`, [owner, agentId, bot, ids, from, to])
    await appendRuns(1,399)
    for (const totalRuns of [399,899]) {
      if (totalRuns === 899) await appendRuns(400,899)
      const nodes = totalRuns + 101
      const scope = await resolveProjectReadScope(owner, project, shared.id)
      const values = [scope.issueIds, scope.userId, scope.workspaceId, MAP_NODE_LIMIT + 1, MAP_SOURCE_LIMIT + 1, false, scope.projectId, MAP_METADATA_BYTES]
      const uncompressed = await connection.query(mapFactsSql(false), values)
      let collectorQueries = 0, collectorBytes = 0, logicalBytes = 0
      const measured = { query: async (sql: string, bound?: unknown[]) => {
        const result = await connection.query(sql, bound); collectorQueries++; collectorBytes += Buffer.byteLength(JSON.stringify(result.rows))
        logicalBytes += Number(result.rows[0].bytes); return result
      } } as Pick<PoolClient, 'query'>
      const facts = await collectMapFacts(measured, scope, false), original = uncompressed.rows[0]
      const expected = { ...facts,
        issues: original.rows[0].map((issue: Record<string, unknown>) => ({ ...issue, createdAt: new Date(String(issue.createdAt)).toISOString() })),
        runs: original.rows[1].map((run: Record<string, unknown>) => ({ ...run, createdAt: new Date(String(run.createdAt)).toISOString(),
          finishedAt: run.finishedAt ? new Date(String(run.finishedAt)).toISOString() : null })),
      }
      assert.deepEqual(facts, expected)
      assert.equal(JSON.stringify(facts), JSON.stringify(expected)); assert.equal(fingerprint(facts), fingerprint(expected))
      assert.equal(logicalBytes, Number(original.bytes)); assert.equal(collectorQueries, 1)
      assert.equal(facts.issues.length, 100); assert.equal(facts.runs.length, totalRuns); assert.equal(projectGraph(facts).nodes.length, nodes)
      assert.ok(collectorBytes < (totalRuns === 399 ? 50 : 85) * 1024, `compact collector returned ${collectorBytes} bytes`)
      t.diagnostic(JSON.stringify({ fixture: 'isolated-exact-production-layout', issues: 100, runs: totalRuns, nodes,
        uncompressedSingleStatementBytes: Buffer.byteLength(JSON.stringify(uncompressed.rows)), compactSingleStatementBytes: collectorBytes,
        unchangedLogicalBytes: logicalBytes, statements: collectorQueries }))

      // The session resolver is stubbed to model the independently observed zero-
      // query cookie-cache hit. PAT authorization remains exercised below. Enable
      // real secret reads here so the HTTP count includes production's mask path.
      const previousKey = process.env.WORKSPACE_SECRETS_KEY
      try {
        process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('base64')
        cachedSessionOwner = owner; measurement = { queries: 0, selects: 0, bytes: 0 }; overrideDeploymentSwitch('dbEgressSample', true)
        const response = await get('', null, '/mikka/api/projects/' + project + '/map', shared.id), body = await response.json()
        assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.page.matchedCount, nodes)
        assert.equal(measurement.queries, 8); assert.equal(measurement.selects, 8)
        assert.ok(measurement.bytes <= (nodes === 500 ? 80 * 1024 : 100_000), `cached-session path returned ${measurement.bytes} DB JSON bytes`)
        t.diagnostic(JSON.stringify({ fixture: 'isolated-exact-production-layout-http', issues: 100, runs: totalRuns, nodes, ...measurement,
          auth: 'cached session resolver stub; no cookie parsing measured', masking: 'enabled, two real database reads',
          includes: 'fresh pre/post workspace and issue ACL, live revision, all graph facts, masking', excludes: 'PostgreSQL wire framing and production network' }))
      } finally {
        cachedSessionOwner = null; measurement = null; overrideDeploymentSwitch('dbEgressSample', undefined)
        if (previousKey === undefined) delete process.env.WORKSPACE_SECRETS_KEY; else process.env.WORKSPACE_SECRETS_KEY = previousKey
      }
    }
  })
  await t.test('500/1000 executions have fixed query count and measured per-read KB', async () => {
    for (const count of [500, 1000]) {
      const project = await seedProject(connection, owner, []), issue = await seedIssue(connection, owner, home.id)
      await connection.query('UPDATE workspace_projects SET "issueIds"=$2 WHERE id=$1', [project, JSON.stringify([issue])])
      await connection.query(`INSERT INTO agent_runs(id,"userId","agentId","issueId",status,prompt,report,"agentDefinition","createdAt")
        SELECT gen_random_uuid(),$1,$2,$3,'succeeded',repeat('p',8192),jsonb_build_object('summary',repeat('r',8192)),
          '{"harness":"codex","model":"gpt-6-luna"}'::jsonb,now()+g*interval '1 millisecond' FROM generate_series(1,$4) g`, [owner, agentId, issue, count])
      const scope = await resolveProjectScope(owner, project, home.id), times: number[] = []
      let queryCount = 0, dbBytes = 0, result
      const measured = { query: async (sql: string, values?: unknown[]) => { const value = await connection.query(sql, values); queryCount++; dbBytes += Buffer.byteLength(JSON.stringify(value.rows)); return value } } as Pick<PoolClient, 'query'>
      for (let repeat = 0; repeat < 10; repeat++) {
        queryCount = 0; dbBytes = 0
        const started = performance.now(), facts = await collectMapFacts(measured, scope, true)
        result = graphPage(projectGraph(facts), mapQuerySchema.parse({ workspaceId: home.id }))
        times.push(performance.now() - started)
      }
      assert.equal(queryCount, 1, 'one complete metadata snapshot'); assert.equal(result!.nodes.length, 50)
      const raw = JSON.stringify(result)
      assert.ok(gzipSync(raw).byteLength < 150 * 1024)
      const legacy = (await connection.query('SELECT sum(octet_length(prompt)+octet_length(report::text))::int AS bytes FROM agent_runs WHERE "issueId"=$1', [issue])).rows[0].bytes
      t.diagnostic(JSON.stringify({ fixture: 'isolated-map-read', runs: count, nodes: count + 2, queries: queryCount, databaseJsonBytes: dbBytes,
        pageBytes: Buffer.byteLength(raw), gzipBytes: gzipSync(raw).byteLength,
        p95Ms: times.sort((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1], legacyPromptReportBytes: legacy }))
      const representativeRun = (await connection.query('SELECT id FROM agent_runs WHERE "issueId"=$1 ORDER BY id LIMIT 1', [issue])).rows[0].id
      await connection.query(`INSERT INTO run_chunks(id,"runId",seq,chunk) SELECT gen_random_uuid(),$1,g,
        jsonb_build_object('type','text','text',repeat('bounded source ',400)) FROM generate_series(0,2) g`, [representativeRun])
      const target = '/mikka/api/projects/' + project + '/map'
      const warm = await get('', token.token, target); assert.equal(warm.status, 200)
      const first = await warm.json(), snapshot = encodeURIComponent(first.snapshot.id)
      const endpoints = [
        ['page', ''], ['next_page', '?cursor=' + encodeURIComponent(first.page.nextCursor)],
        ['filtered_page', '?q=codex'], ['node', '/nodes/' + encodeURIComponent('run:' + representativeRun) + '?snapshot=' + snapshot],
        ['path', '/path?nodeId=' + encodeURIComponent('run:' + representativeRun) + '&snapshot=' + snapshot],
        ['overview', '/overview?snapshot=' + snapshot], ['source', '/sources/' + encodeURIComponent('run:' + representativeRun) + '?limit=2'],
      ]
      for (const [operation, suffix] of endpoints) {
        const durations: number[] = [], reads: number[] = [], selects: number[] = [], transfer: number[] = []
        let httpBytes = 0, gzipBytes = 0
        for (let repeat = 0; repeat < 10; repeat++) {
          measurement = { queries: 0, selects: 0, bytes: 0 }
          overrideDeploymentSwitch('dbEgressSample', true)
          const started = performance.now()
          try {
            const response = await get(suffix, token.token, target), text = await response.text()
            assert.equal(response.status, 200, text); assert.ok(measurement.selects > 0)
            if (operation !== 'source') assert.ok(measurement.selects <= 12, `${operation} used ${measurement.selects} SELECTs`)
            durations.push(performance.now() - started); reads.push(measurement.queries); selects.push(measurement.selects); transfer.push(measurement.bytes)
            httpBytes = Buffer.byteLength(text); gzipBytes = gzipSync(text).byteLength
          } finally { measurement = null; overrideDeploymentSwitch('dbEgressSample', undefined) }
        }
        assert.ok(Math.max(...transfer) < 1024 * 1024 + 32 * 1024)
        if (operation === 'page') assert.ok(gzipBytes <= 150 * 1024)
        const sorted = durations.sort((a, b) => a - b)
        t.diagnostic(JSON.stringify({ fixture: 'isolated-full-http', runs: count, nodes: count + 2, operation, samples: durations.length,
          statements: Math.max(...reads), selects: Math.max(...selects), databaseJsonBytes: Math.max(...transfer),
          httpBytes, gzipBytes, p50Ms: sorted[4], p95Ms: sorted[9], includes: 'PAT, current workspace/project/task ACL, revision, facts and source reads',
          excludes: 'PostgreSQL wire framing and production network' }))
      }

    }
  })
  await t.test('a verified deleted execution retains an unavailable source without granting another reader', async () => {
    const reference = (await connection.query('SELECT id FROM project_decision_sources WHERE "decisionId"=$1 AND "sourceType"=\'run\'', [recorded.decisionId])).rows[0].id
    await connection.query('DELETE FROM agent_runs WHERE id=$1', [runId])
    const response = await get('/sources/' + encodeURIComponent('source:' + reference)); assert.equal(response.status, 200)
    const body = await response.json(); assert.equal(body.availability, 'unavailable'); assert.equal(body.locator, null); assert.deepEqual(body.items, [])
    assert.equal((await get('/sources/' + encodeURIComponent('source:' + reference), otherToken.token)).status, 404)
  })
})
