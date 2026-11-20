// Agents and Bots read and message each other (decision 2026-11-19-2200),
// against a real PostgreSQL: a Bot, a run, a teammate's token and a service key
// each reach another person's thread, artifact, Bot and Drive only through the
// resource ACL of their own Workspace. Cross-tenant grants never apply.
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedBot, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { isolateCoordinatorWakes } from '../../tests/support/coordinator-wake'

mock.module(new URL('../coordinator/decide.ts', import.meta.url).href, { namedExports: { invokeDecision: async () => null } })

test('interop reads, sends and Drive follow the ACL of the caller\'s own Workspace', { skip: !dbUrl, timeout: 120_000 }, async t => {
  const wakes = await isolateCoordinatorWakes(t)
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const { pool: appPool } = await import('../db')
  const { workspacePool } = await import('../workspace-db')
  const users: string[] = []
  t.after(async () => {
    await wakes.flush()
    await pool.query('DELETE FROM coordinator_events WHERE "userId"=ANY($1)', [users])
    await pool.query('DELETE FROM drive_volumes WHERE "workspaceId" IN (SELECT "workspaceId" FROM mikka_workspace_members WHERE "userId"=ANY($1))', [users])
    await pool.query('DELETE FROM artifacts WHERE "userId"=ANY($1)', [users])
    await pool.query('DELETE FROM agent_runs WHERE "userId"=ANY($1)', [users])
    await pool.query('DELETE FROM agents WHERE "userId"=ANY($1)', [users])
    await pool.query('DELETE FROM bots WHERE "ownerId"=ANY($1)', [users])
    await pool.query('DELETE FROM issues WHERE "userId"=ANY($1)', [users])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const { runInteropTool } = await import('./tools')
  const { botPrincipal, runPrincipal } = await import('./principal')

  const owner = await seedUser(pool, 'interop-owner'), teammate = await seedUser(pool, 'interop-teammate'), outsider = await seedUser(pool, 'interop-outsider')
  users.push(owner, teammate, outsider)
  const team = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: teammate, role: 'member' }])
  const other = await seedWorkspace(pool, outsider, [{ userId: outsider, role: 'admin' }])
  const ownerBot = await seedBot(pool, team.id, owner), teammateBot = await seedBot(pool, team.id, teammate), outsiderBot = await seedBot(pool, other.id, outsider)
  const agent = randomUUID(), issue = randomUUID(), thread = randomUUID(), teammateRun = randomUUID(), artifact = randomUUID()
  await pool.query('INSERT INTO agents(id,"userId",harness,name) VALUES($1,$2,\'codex\',\'Interop agent\')', [agent, owner])
  await pool.query(`INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority) VALUES($1,$2,$3,'Interop task','{"type":"doc"}','todo','normal')`, [issue, owner, team.id])
  await pool.query(`INSERT INTO agent_runs(id,"userId","agentId","workspaceId","issueId",status,report) VALUES($1,$2,$3,$4,$5,'succeeded',$6)`,
    [thread, owner, agent, team.id, issue, JSON.stringify({ summary: 'Shipped the parser' })])
  await pool.query('INSERT INTO run_chunks(id,"runId",seq,chunk) VALUES(gen_random_uuid(),$1,1,$2),(gen_random_uuid(),$1,2,$3)', [thread,
    JSON.stringify({ type: 'text-delta', delta: 'Parser ' }), JSON.stringify({ type: 'text-delta', delta: 'done.' })])
  const teammateAgent = randomUUID()
  await pool.query('INSERT INTO agents(id,"userId",harness,name) VALUES($1,$2,\'codex\',\'Teammate agent\')', [teammateAgent, teammate])
  await pool.query(`INSERT INTO agent_runs(id,"userId","agentId","workspaceId",status) VALUES($1,$2,$3,$4,'running')`, [teammateRun, teammate, teammateAgent, team.id])
  await pool.query(`INSERT INTO artifacts(id,"userId","workspaceId","runId","issueId",kind,title,"latestVersion") VALUES($1,$2,$3,$4,$5,'markdown','Design',1)`, [artifact, owner, team.id, thread, issue])
  await pool.query(`INSERT INTO artifact_versions(id,"artifactId",version,"storageKey","inlineContent",sha256,size,"authorName") VALUES($1,$2,1,'inline','# Design',$3,8,'Owner')`,
    [randomUUID(), artifact, createHash('sha256').update('# Design').digest('hex')])
  const grant = (kind: string, id: string, subjectKind: string, subjectId: string, capabilities: string[]) => pool.query(
    `INSERT INTO resource_access_grants("resourceKind","resourceId","subjectKind","subjectId",capabilities) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT DO NOTHING`, [kind, id, subjectKind, subjectId, capabilities])

  const asTeammateBot = await botPrincipal(teammate, teammateBot)
  const asOutsiderBot = await botPrincipal(outsider, outsiderBot)
  const asTeammate = { kind: 'account' as const, userId: teammate, workspaceId: team.id }
  const notFound = { error: 'interop_not_found' }

  await t.test('a private thread is refused until the Bot or its owner holds a grant', async () => {
    assert.deepEqual(await runInteropTool(asTeammateBot, 'read_thread_messages', { runId: thread }), notFound)
    assert.deepEqual(await runInteropTool(asTeammate, 'read_thread_messages', { runId: thread }), notFound)
    const roots = async () => (await runInteropTool(asTeammateBot, 'list_threads', {}) as { threads: { rootRunId: string }[] }).threads.map(row => row.rootRunId)
    // The Bot's owner's own thread is listed; the owner's private one is not.
    assert.deepEqual(await roots(), [teammateRun])
    await grant('thread', thread, 'bot', teammateBot, ['canReadContent'])
    const read = await runInteropTool(asTeammateBot, 'read_thread_messages', { runId: thread }) as { rootRunId: string; attempts: { summary: string; agentText: string }[] }
    assert.equal(read.rootRunId, thread)
    assert.equal(read.attempts[0]!.summary, 'Shipped the parser')
    assert.equal(read.attempts[0]!.agentText, 'Parser done.')
    assert.deepEqual((await roots()).sort(), [thread, teammateRun].sort())
    // A Bot's grant is the Bot's own: its owner reading directly is still refused.
    assert.deepEqual(await runInteropTool(asTeammate, 'read_thread_messages', { runId: thread }), notFound)
    // canReadContent never lets the Bot steer the thread.
    assert.deepEqual(await runInteropTool(asTeammateBot, 'send_to_thread', { runId: thread, text: 'hello', key: 'k1' }), notFound)
  })

  await t.test('a grant naming another tenant\'s resource never applies', async () => {
    await grant('thread', thread, 'bot', outsiderBot, ['canReadContent', 'canSteer'])
    await grant('artifact', artifact, 'bot', outsiderBot, ['canReadContent'])
    assert.deepEqual(await runInteropTool(asOutsiderBot, 'read_thread_messages', { runId: thread }), notFound)
    assert.deepEqual(await runInteropTool(asOutsiderBot, 'read_artifact', { artifactId: artifact }), notFound)
    assert.deepEqual(await runInteropTool(asOutsiderBot, 'send_to_thread', { runId: thread, text: 'x', key: 'k2' }), notFound)
    assert.deepEqual(await runInteropTool(asOutsiderBot, 'list_artifacts', {}), { artifacts: [] })
    assert.deepEqual(await runInteropTool(asOutsiderBot, 'drive_list', { scope: 'thread', scopeId: thread }), notFound)
  })

  await t.test('artifacts: a run reads only what its owner or its own grant allows', async () => {
    const asRun = await runPrincipal(teammate, teammateRun)
    assert.deepEqual(await runInteropTool(asRun, 'read_artifact', { artifactId: artifact }), notFound)
    // The thread grant above belongs to the Bot, not to this run.
    await grant('artifact', artifact, 'run', teammateRun, ['canReadContent'])
    const read = await runInteropTool(asRun, 'read_artifact', { artifactId: artifact }) as { content: string; version: number }
    assert.equal(read.content, '# Design')
    assert.equal(read.version, 1)
  })

  await t.test('a removed member\'s Bot reads nothing, whatever it was granted', async () => {
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [team.id, teammate])
    try {
      assert.deepEqual(await runInteropTool(asTeammateBot, 'read_thread_messages', { runId: thread }), notFound)
    } finally {
      await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [team.id, teammate])
    }
  })

  await t.test('send_to_bot needs canSteer, wakes the Bot owner once and is idempotent', async () => {
    const send = { botId: ownerBot, text: 'Please review the parser', key: 'review-1' }
    assert.deepEqual(await runInteropTool(asTeammateBot, 'send_to_bot', send), notFound)
    await grant('bot', ownerBot, 'bot', teammateBot, ['canSteer'])
    const first = await runInteropTool(asTeammateBot, 'send_to_bot', send) as { eventId: string; duplicate: boolean }
    assert.equal(first.duplicate, false)
    const again = await runInteropTool(asTeammateBot, 'send_to_bot', send) as { eventId: string; duplicate: boolean }
    assert.deepEqual(again, { eventId: first.eventId, duplicate: true })
    const { rows: [event] } = await pool.query('SELECT "userId","botId",kind,tier,payload FROM coordinator_events WHERE id=$1', [first.eventId])
    assert.equal(event.userId, owner)
    assert.equal(event.botId, ownerBot)
    // Peer text is runtime evidence, never the owner's own message.
    assert.equal(event.kind, 'run_report')
    assert.equal(event.tier, 'result')
    assert.deepEqual(event.payload.from, { kind: 'bot', id: teammateBot })
    assert.ok(wakes.calls.includes(owner))
    // canSteer on the Bot is not read access to its owner's chat.
    assert.deepEqual(await runInteropTool(asTeammateBot, 'read_bot_chat', { botId: ownerBot }), notFound)
  })

  await t.test('Drive: a Bot shares its own folder by version; others need the ACL', async () => {
    const listed = await runInteropTool(asTeammateBot, 'drive_list', { scope: 'bot', scopeId: teammateBot }) as { volume: null; volumes: unknown[] }
    assert.deepEqual([listed.volume, listed.volumes], [null, []])
    const conflict = await runInteropTool(asTeammateBot, 'drive_write', { scope: 'bot', scopeId: teammateBot, path: 'notes.md', content: 'v1', expectedDigest: 'f'.repeat(64), mutationId: 'write-0001' }) as { error: string; headDigest: string }
    assert.equal(conflict.error, 'interop_drive_conflict')
    const head = conflict.headDigest
    const written = await runInteropTool(asTeammateBot, 'drive_write', { scope: 'bot', scopeId: teammateBot, path: 'notes.md', content: 'v1', expectedDigest: head, mutationId: 'write-0002' }) as { headDigest: string; replayed: boolean; volumeId: string }
    assert.equal(written.replayed, false)
    const replay = await runInteropTool(asTeammateBot, 'drive_write', { scope: 'bot', scopeId: teammateBot, path: 'notes.md', content: 'v1', expectedDigest: head, mutationId: 'write-0002' }) as { replayed: boolean }
    assert.equal(replay.replayed, true)
    // A stale writer is refused with the head to re-read, and nothing changes.
    const stale = await runInteropTool(asTeammateBot, 'drive_write', { scope: 'bot', scopeId: teammateBot, path: 'notes.md', content: 'v2', expectedDigest: head, mutationId: 'write-0003' }) as { error: string; headDigest: string; paths: string[] }
    assert.deepEqual([stale.error, stale.headDigest, stale.paths], ['interop_drive_conflict', written.headDigest, ['notes.md']])
    const file = await runInteropTool(asTeammateBot, 'drive_read', { scope: 'bot', scopeId: teammateBot, path: 'notes.md' }) as { content: string; headDigest: string }
    assert.deepEqual([file.content, file.headDigest], ['v1', written.headDigest])
    const { rows: [volume] } = await pool.query('SELECT "ownerId","driveScope" FROM drive_volumes WHERE id=$1', [written.volumeId])
    assert.deepEqual(volume, { ownerId: `drive-scope:${team.id}:bot:${teammateBot}`, driveScope: 'bot' })

    const asOwnerBot = await botPrincipal(owner, ownerBot)
    assert.deepEqual(await runInteropTool(asOwnerBot, 'drive_read', { scope: 'bot', scopeId: teammateBot, path: 'notes.md' }), notFound)
    await grant('bot', teammateBot, 'bot', ownerBot, ['canReadContent'])
    assert.equal((await runInteropTool(asOwnerBot, 'drive_read', { scope: 'bot', scopeId: teammateBot, path: 'notes.md' }) as { content: string }).content, 'v1')
    assert.deepEqual(await runInteropTool(asOwnerBot, 'drive_write', { scope: 'bot', scopeId: teammateBot, path: 'notes.md', content: 'v2', expectedDigest: written.headDigest, mutationId: 'write-0004' }), notFound)
    assert.deepEqual(await runInteropTool(asOutsiderBot, 'drive_read', { scope: 'bot', scopeId: teammateBot, path: 'notes.md' }), notFound)
  })

  await t.test('Drive: the thread folder follows the thread ACL and the workspace folder is team-only', async () => {
    // The Bot holds canReadContent on the thread from the first subtest: it can list, not write.
    const listed = await runInteropTool(asTeammateBot, 'drive_list', { scope: 'thread', scopeId: thread }) as { scopeId: string }
    assert.equal(listed.scopeId, thread)
    assert.deepEqual(await runInteropTool(asTeammateBot, 'drive_write', { scope: 'thread', scopeId: thread, path: 'a.txt', content: 'x', expectedDigest: 'f'.repeat(64), mutationId: 'thread-0001' }), notFound)
    const team = await runInteropTool(asTeammateBot, 'drive_list', { scope: 'workspace' }) as { scope: string }
    assert.equal(team.scope, 'workspace')
    const { seedFixtureWorkspace } = await import('../../tests/helpers/task-workspace')
    const personal = await seedFixtureWorkspace(pool, outsider, 'personal')
    const personalBot = await seedBot(pool, personal, outsider)
    assert.deepEqual(await runInteropTool(await botPrincipal(outsider, personalBot), 'drive_list', { scope: 'workspace' }), notFound)
  })

  await t.test('a service key acts only through its own grants, never membership', async () => {
    const serviceId = randomUUID()
    const asService = { kind: 'service' as const, serviceId, workspaceId: team.id }
    assert.deepEqual(await runInteropTool(asService, 'read_artifact', { artifactId: artifact }), notFound)
    await grant('artifact', artifact, 'service', serviceId, ['canReadContent'])
    assert.equal((await runInteropTool(asService, 'read_artifact', { artifactId: artifact }) as { content: string }).content, '# Design')
    // Ancestors still bind the tenant, but a grant on the artifact is not one on its thread.
    assert.deepEqual(await runInteropTool(asService, 'read_thread_messages', { runId: thread }), notFound)
    assert.deepEqual(await runInteropTool(asService, 'drive_list', { scope: 'workspace' }), notFound)
  })

  await t.test('/api/v1: a PAT needs the route scope; an mksvc_ key authenticates only its service', async () => {
    const { createPersonalAccessToken } = await import('../tokens/store')
    const threads = await import('../../app/api/v1/threads/route')
    const artifactRoute = await import('../../app/api/v1/artifacts/[artifactId]/route')
    const readOnly = await createPersonalAccessToken(teammate, team.id, { name: 'interop read', scopes: ['artifacts:read'] })
    const call = (token: string) => threads.GET(new Request('http://localhost/mikka/api/v1/threads', { headers: { authorization: `Bearer ${token}` } }))
    const refused = await call(readOnly.token)
    assert.equal(refused.status, 403)
    assert.deepEqual(await refused.json(), { error: 'interop_scope_required' })
    const scoped = await createPersonalAccessToken(teammate, team.id, { name: 'interop threads', scopes: ['threads:read'] })
    const ok = await call(scoped.token)
    assert.equal(ok.status, 200)
    const rootsOf = async (response: Response) => ((await response.json()) as { threads: { rootRunId: string }[] }).threads.map(row => row.rootRunId)
    assert.deepEqual(await rootsOf(ok), [teammateRun])
    await grant('thread', thread, 'account', teammate, ['canReadContent'])
    assert.deepEqual((await rootsOf(await call(scoped.token))).sort(), [thread, teammateRun].sort())
    assert.equal((await threads.GET(new Request('http://localhost/mikka/api/v1/threads'))).status, 401)

    const token = `mksvc_${randomBytes(32).toString('base64url')}`
    const serviceId = randomUUID()
    await pool.query(`INSERT INTO mikka_workspace_service_identities(id,"workspaceId",name,"createdBy","requestId","initialName","credentialHash")
      VALUES($1,$2,'Interop service',$3,$4,'Interop service',$5)`, [serviceId, team.id, owner, randomUUID(), createHash('sha256').update(token).digest('hex')])
    const read = () => artifactRoute.GET(new Request(`http://localhost/mikka/api/v1/artifacts/${artifact}`, { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({ artifactId: artifact }) })
    assert.equal((await read()).status, 404)
    await grant('artifact', artifact, 'service', serviceId, ['canReadContent'])
    const served = await read()
    assert.equal(served.status, 200)
    assert.equal(((await served.json()) as { content: string }).content, '# Design')
    await pool.query('UPDATE mikka_workspace_service_identities SET enabled=false WHERE id=$1', [serviceId])
    assert.equal((await read()).status, 401)
  })

  await t.test('a run mirrors its own thread and the team folder; a Bot thread adds its Bot', async () => {
    const { driveSyncScopes } = await import('./drive')
    const scopes = await driveSyncScopes(await runPrincipal(teammate, teammateRun))
    assert.deepEqual(scopes, [{ scope: 'thread', scopeId: teammateRun, write: true }, { scope: 'workspace', scopeId: team.id, write: true }])
    const botRun = randomUUID()
    await pool.query(`INSERT INTO agent_runs(id,"userId","agentId","workspaceId","botId",status) VALUES($1,$2,$3,$4,$5,'running')`, [botRun, teammate, teammateAgent, team.id, teammateBot])
    assert.deepEqual((await driveSyncScopes(await runPrincipal(teammate, botRun))).map(row => row.scope), ['thread', 'bot', 'workspace'])
    await assert.rejects(driveSyncScopes(asTeammateBot), { code: 'interop_invalid_request' })
  })

  await t.test('/api/v1/grants: only the owner creates; an admin lists and revokes; subjects stay in the tenant', async () => {
    const { createPersonalAccessToken } = await import('../tokens/store')
    const collection = await import('../../app/api/v1/grants/[kind]/[resourceId]/route')
    const single = await import('../../app/api/v1/grants/[kind]/[resourceId]/[subjectKind]/[subjectId]/route')
    const admin = await seedUser(pool, 'interop-admin')
    users.push(admin)
    await pool.query(`INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,'admin','active')`, [team.id, admin, `${admin}@example.invalid`])
    const token = async (userId: string, workspaceId: string, scopes: string[]) => (await createPersonalAccessToken(userId, workspaceId, { name: 'grants', scopes })).token
    const ownerToken = await token(owner, team.id, ['grants:read', 'grants:write'])
    const teammateToken = await token(teammate, team.id, ['grants:read', 'grants:write'])
    const adminToken = await token(admin, team.id, ['grants:read', 'grants:write'])
    const readOnly = await token(owner, team.id, ['grants:read'])
    const outsiderToken = await token(outsider, other.id, ['grants:read', 'grants:write'])
    const params = { kind: 'thread', resourceId: thread }
    const put = (bearer: string, body: unknown) => collection.PUT(new Request('http://localhost/mikka/api/v1/grants/thread/' + thread, {
      method: 'PUT', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve(params) })
    const list = (bearer: string) => collection.GET(new Request('http://localhost/mikka/api/v1/grants/thread/' + thread, { headers: { authorization: `Bearer ${bearer}` } }), { params: Promise.resolve(params) })
    const revoke = (bearer: string, subjectKind: string, subjectId: string) => single.DELETE(new Request('http://localhost/x', { method: 'DELETE', headers: { authorization: `Bearer ${bearer}` } }),
      { params: Promise.resolve({ ...params, subjectKind, subjectId }) })
    // The admin's own Bot: the admin holds no grant on the thread, so the Bot inherits nothing.
    const newBot = await seedBot(pool, team.id, admin)
    const asNewBot = await botPrincipal(admin, newBot)
    const grant = { subjectKind: 'bot', subjectId: newBot, capabilities: ['canReadContent'] }
    assert.deepEqual(await runInteropTool(asNewBot, 'read_thread_messages', { runId: thread }), notFound)

    assert.equal((await put(readOnly, grant)).status, 403, 'grants:write is required')
    assert.equal((await put(teammateToken, grant)).status, 404, 'a teammate cannot share the owner\'s thread')
    assert.equal((await put(adminToken, grant)).status, 404, 'an admin cannot share content')
    assert.equal((await put(outsiderToken, grant)).status, 404, 'another tenant cannot name this thread')
    assert.equal((await put(ownerToken, { ...grant, subjectId: outsiderBot })).status, 400, 'a subject from another tenant is refused')
    assert.equal((await put(ownerToken, { ...grant, capabilities: ['canManageAccess'] })).status, 400, 'only sharing capabilities')
    const created = await put(ownerToken, grant)
    assert.equal(created.status, 200)
    assert.deepEqual(((await created.json()) as { grant: { capabilities: string[] } }).grant.capabilities, ['canReadContent'])
    assert.equal((await runInteropTool(asNewBot, 'read_thread_messages', { runId: thread }) as { rootRunId: string }).rootRunId, thread)

    assert.equal((await list(teammateToken)).status, 404)
    const listed = await list(adminToken)
    assert.equal(listed.status, 200)
    const subjects = ((await listed.json()) as { grants: { subjectKind: string; subjectId: string }[] }).grants
    assert.ok(subjects.some(row => row.subjectKind === 'bot' && row.subjectId === newBot))
    assert.ok(subjects.every(row => row.subjectKind !== 'account'), 'account grants stay with the share UI')

    assert.equal((await revoke(teammateToken, 'bot', newBot)).status, 404)
    const revoked = await revoke(adminToken, 'bot', newBot)
    assert.deepEqual([revoked.status, await revoked.json()], [200, { revoked: true }])
    assert.deepEqual(await runInteropTool(asNewBot, 'read_thread_messages', { runId: thread }), notFound)
    const { rows: [event] } = await pool.query(`SELECT "actorId",source,action FROM resource_access_events WHERE "resourceKind"='thread' AND "resourceId"=$1
      AND detail->>'subjectId'=$2 ORDER BY "createdAt" DESC LIMIT 1`, [thread, newBot])
    assert.deepEqual(event, { actorId: admin, source: 'agent_access_revoke', action: 'grant_delete' })
  })
})
