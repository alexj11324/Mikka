import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import test from 'node:test'
import './fixtures/activity-runtime.mjs'
import { dbUrl, seedPersonalWorkspace, seedUser, seedWorkspace } from './support/workspace-admin-db'
import type { LinearIssueSnapshot } from '../lib/linear-sync/client'

/** Actual synchronization writers, tracked PostgreSQL constraints and a local
 * GraphQL receiver. No provider account, application/WS ACL or writer is mocked. */
test('Linear responsibility respects current Workspace members, holds incoming leases and preserves history', { skip: !dbUrl, timeout: 120_000 }, async t => {
  const { db, pool } = await import('../lib/db')
  const { workspaceDb, workspacePool } = await import('../lib/workspace-db')
  const { linearTeamSyncs } = await import('../lib/db/schema')
  const { createAppIssueFromLinear, applyLinearIssueToApp, syncAppIssueToLinear } = await import('../lib/linear-sync/issue-sync')
  const { readIssueMetadata, withIssueMetadata } = await import('../lib/issue-metadata')
  const { seal } = await import('../lib/linear-sync/crypto')
  const originalFetch = globalThis.fetch
  const originalEncryptionKey = process.env.LINEAR_TOKEN_ENCRYPTION_KEY
  const people: string[] = []
  let receiver: Server | undefined
  t.after(async () => {
    globalThis.fetch = originalFetch
    if (originalEncryptionKey === undefined) delete process.env.LINEAR_TOKEN_ENCRYPTION_KEY
    else process.env.LINEAR_TOKEN_ENCRYPTION_KEY = originalEncryptionKey
    receiver?.closeAllConnections()
    if (receiver?.listening) await new Promise<void>((resolve, reject) => receiver!.close(error => error ? reject(error) : resolve()))
    try {
      await pool.query('DELETE FROM linear_issue_links WHERE "ownerId"=ANY($1::text[])', [people])
      await pool.query('DELETE FROM issue_documents WHERE "userId"=ANY($1::text[])', [people])
      await pool.query('DELETE FROM issue_versions WHERE "userId"=ANY($1::text[])', [people])
      await pool.query('DELETE FROM issue_members WHERE "userId"=ANY($1::text[])', [people])
      await pool.query('DELETE FROM issues WHERE "userId"=ANY($1::text[])', [people])
      await pool.query('DELETE FROM linear_issue_detachments WHERE "ownerId"=ANY($1::text[])', [people])
      await pool.query('DELETE FROM linear_team_syncs WHERE "ownerId"=ANY($1::text[])', [people])
      await pool.query('DELETE FROM workspace_task_identifier_counters WHERE "workspaceId" IN (SELECT id FROM mikka_workspaces WHERE "userId"=ANY($1::text[]))', [people])
      await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId" IN (SELECT id FROM mikka_workspaces WHERE "userId"=ANY($1::text[]))', [people])
      await pool.query('DELETE FROM mikka_workspaces WHERE "userId"=ANY($1::text[])', [people])
      await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [people])
    } finally { await Promise.all([pool.end(), workspacePool.end()]) }
  })
  const user = async (label: string) => {
    const id = await seedUser(pool, label)
    people.push(id)
    return id
  }
  const owner = await user('linear-responsibility-owner'), member = await user('linear-responsibility-member'), foreign = await user('linear-responsibility-foreign')
  const alpha = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  await seedWorkspace(pool, foreign, [{ userId: foreign, role: 'admin' }])
  const [team] = await db.insert(linearTeamSyncs).values({ id: randomUUID(), ownerId: owner, workspaceId: alpha.id, linearTeamId: randomUUID(), linearTeamKey: 'LRA', linearTeamName: 'Responsibility fixture' }).returning()
  const remote = (assignee: string | null, binding = team): LinearIssueSnapshot => ({
    id: randomUUID(), identifier: `LRA-${Math.floor(Math.random() * 1_000_000) + 1}`, title: 'Linear responsibility fixture', description: '',
    dueDate: null, priority: 0, url: 'https://example.invalid/linear-responsibility', updatedAt: '2020-01-01T00:00:00.000Z', state: null,
    team: { id: binding.linearTeamId, key: binding.linearTeamKey, name: binding.linearTeamName },
    assignee: assignee ? { id: `remote-${assignee}`, name: assignee, email: `${assignee}@example.invalid` } : null, labels: [],
  })
  const metadata = async (id: string) => readIssueMetadata((await pool.query('SELECT content FROM issues WHERE id=$1', [id])).rows[0].content)
  const history = async (id: string) => (await pool.query('SELECT id,revision,content,actor_type,actor_id FROM issue_versions WHERE "issueId"=$1 ORDER BY revision,id', [id])).rows
  const setStatus = (status: string) => pool.query('UPDATE mikka_workspace_members SET status=$1 WHERE "workspaceId"=$2 AND "userId"=$3', [status, alpha.id, member])
  let incomingClock = Date.now()
  const nextIncomingTime = () => {
    // force preserves the real stale-provider fence: each incoming update
    // must be newer than both the saved provider version and the local row.
    incomingClock = Math.max(incomingClock + 1, Date.now() + 60_000)
    return new Date(incomingClock).toISOString()
  }
  const firstRemote = remote(member)
  const imported = await createAppIssueFromLinear(team, firstRemote)
  assert.ok(imported)

  await t.test('new shared imports may assign any active member without an old issue invitation', async () => {
    assert.equal((await metadata(imported.id)).assignee?.id, member)
    assert.equal((await pool.query('SELECT count(*)::int n FROM issue_members WHERE "issueId"=$1', [imported.id])).rows[0].n, 0)
    assert.equal((await history(imported.id))[0].actor_id, 'linear')
  })

  await t.test('suspended, removed and another Workspace members cannot be imported as the human assignee', async () => {
    const originalVersions = await history(imported.id)
    await pool.query('INSERT INTO issue_members ("issueId","userId","memberId") VALUES ($1,$2,$3)', [imported.id, owner, foreign])
    try {
      for (const status of ['suspended', 'removed']) {
        await setStatus(status)
        const saved = await applyLinearIssueToApp(team, { ...firstRemote, updatedAt: nextIncomingTime(), title: `Remote ${status}` }, true)
        assert.ok(saved)
        assert.equal(saved.title, `Remote ${status}`, 'the remote version must pass the real stale-snapshot fence')
        assert.equal(readIssueMetadata(saved.content).assignee, null)
        const fresh = await createAppIssueFromLinear(team, remote(member))
        assert.ok(fresh)
        assert.equal(readIssueMetadata(fresh.content).assignee, null)
      }
    } finally { await setStatus('active') }
    const crossWorkspace = { ...firstRemote, updatedAt: nextIncomingTime(), assignee: remote(foreign).assignee, title: 'Foreign assignee' }
    const saved = await applyLinearIssueToApp(team, crossWorkspace, true)
    assert.ok(saved)
    assert.equal(readIssueMetadata(saved.content).assignee, null, 'a legacy issue invitation does not grant Workspace membership')
    const fresh = await createAppIssueFromLinear(team, remote(foreign))
    assert.ok(fresh)
    assert.equal(readIssueMetadata(fresh.content).assignee, null)
    assert.deepEqual((await history(imported.id)).slice(0, originalVersions.length), originalVersions)
  })

  await t.test('a corrupt extra membership cannot assign a peer inside a personal Workspace', async () => {
    const personalId = await seedPersonalWorkspace(pool, owner)
    const insertPeer = 'INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,\'member\',\'active\')'
    await assert.rejects(pool.query(insertPeer, [personalId, member, `${member}@example.invalid`]), {
      code: '23514', message: 'personal workspace admits only its owner',
    })
    const [personalTeam] = await db.insert(linearTeamSyncs).values({ id: randomUUID(), ownerId: owner, workspaceId: personalId, linearTeamId: randomUUID(), linearTeamKey: 'LRP', linearTeamName: 'Personal fixture' }).returning()
    await workspaceDb.transaction(async () => {
      // Keep the old active corrupt row to exercise the Personal read fence,
      // rather than making it suspended and testing only the status filter.
      // This copy is private to the held real Workspace connection; no public
      // guard is disabled, and the real guard is attached after legacy seeding.
      await workspacePool.query('SET LOCAL search_path=pg_temp,public')
      await workspacePool.query('CREATE TEMP TABLE mikka_workspace_members (LIKE public.mikka_workspace_members INCLUDING ALL) ON COMMIT DROP')
      await workspacePool.query('INSERT INTO pg_temp.mikka_workspace_members SELECT * FROM public.mikka_workspace_members WHERE "workspaceId"=ANY($1::uuid[])', [[personalId, alpha.id]])
      await workspacePool.query(insertPeer, [personalId, member, `${member}@example.invalid`])
      await workspacePool.query(`CREATE TRIGGER mikka_personal_membership_guard BEFORE INSERT OR UPDATE ON pg_temp.mikka_workspace_members
        FOR EACH ROW EXECUTE FUNCTION public.mikka_guard_personal_membership()`)
      const guarded = (text: string, values: unknown[]) => workspaceDb.transaction(() => workspacePool.query(text, values))
      await assert.rejects(guarded(insertPeer, [personalId, foreign, `${foreign}@example.invalid`]), {
        code: '23514', message: 'personal workspace admits only its owner',
      })
      await assert.rejects(guarded('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [personalId, member]), {
        code: '23514', message: 'personal workspace admits only its owner',
      })
      assert.equal((await workspacePool.query('SELECT status FROM pg_temp.mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [personalId, member])).rows[0].status, 'active')
      // A real import sees a Team membership present only in this connection.
      // This proves the assignee lookup did not silently use the public pool.
      assert.equal((await pool.query('SELECT count(*)::int n FROM public.mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [alpha.id, foreign])).rows[0].n, 0)
      await workspacePool.query(insertPeer, [alpha.id, foreign, `${foreign}@example.invalid`])
      const pinned = await createAppIssueFromLinear(team, remote(foreign))
      assert.ok(pinned)
      assert.equal(readIssueMetadata(pinned.content).assignee?.id, foreign)
      // The outer lease must also see revocation on that same connection.
      await workspacePool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [personalId, owner])
      await assert.rejects(createAppIssueFromLinear(personalTeam, remote(owner, personalTeam)), { code: 'workspaceAccessDenied' })
      await workspacePool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [personalId, owner])
      const peer = await createAppIssueFromLinear(personalTeam, remote(member, personalTeam))
      assert.ok(peer)
      assert.equal(readIssueMetadata(peer.content).assignee, null)
      const own = await createAppIssueFromLinear(personalTeam, remote(owner, personalTeam))
      assert.ok(own)
      assert.equal(readIssueMetadata(own.content).assignee?.id, owner)
    })
    assert.equal((await pool.query('SELECT count(*)::int n FROM public.mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=ANY($2::text[])', [personalId, [member, foreign]])).rows[0].n, 0,
      'the historical fixture must not add any public Personal membership')
  })

  await t.test('incoming synchronization keeps the target membership locked until the APP write commits', async () => {
    await setStatus('active')
    const blocker = await pool.connect()
    let pending: ReturnType<typeof applyLinearIssueToApp> | undefined
    try {
      await blocker.query('BEGIN')
      const pid = (await blocker.query('SELECT pg_backend_pid()::int pid')).rows[0].pid
      await blocker.query('SELECT id FROM issues WHERE id=$1 FOR UPDATE', [imported.id])
      pending = applyLinearIssueToApp(team, { ...firstRemote, updatedAt: nextIncomingTime(), title: 'Lease protected assignment' }, true)
      const deadline = Date.now() + 8_000
      while (!(await pool.query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0].blocked) {
        assert.ok(Date.now() < deadline, 'the real incoming APP transaction must reach the held issue lock')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      const revoke = await workspacePool.connect()
      try {
        await revoke.query('BEGIN')
        await revoke.query("SET LOCAL lock_timeout='150ms'")
        await assert.rejects(revoke.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [alpha.id, member]), { code: '55P03' })
      } finally { await revoke.query('ROLLBACK'); revoke.release() }
      await blocker.query('COMMIT')
      const saved = await pending
      assert.ok(saved)
      assert.equal(saved.title, 'Lease protected assignment')
      assert.equal(readIssueMetadata(saved.content).assignee?.id, member)
      const before = await history(imported.id)
      await setStatus('suspended')
      assert.deepEqual(await history(imported.id), before, 'revocation does not rewrite stored historical versions')
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
      await pending
      await setStatus('active')
    }
  })

  process.env.LINEAR_TOKEN_ENCRYPTION_KEY = '2'.repeat(64)
  const providerToken = 'synthetic-linear-responsibility-token'
  await pool.query('INSERT INTO linear_connections ("userId","linearUserId","organizationId","organizationName","accessToken","refreshToken","expiresAt") VALUES ($1,\'fixture-user\',\'fixture-org\',\'Fixture\',$2,$3,now()+interval \'1 day\')', [owner, seal(providerToken), seal('synthetic-unused-refresh')])
  await setStatus('active')
  const outgoingRemote = remote(member)
  const outgoing = await createAppIssueFromLinear(team, outgoingRemote)
  assert.ok(outgoing)
  let provider = { ...outgoingRemote, assignee: null as LinearIssueSnapshot['assignee'] }
  const updates: Record<string, unknown>[] = [], receiverErrors: unknown[] = []
  let userLookups = 0
  let onUserLookup: (() => Promise<unknown>) | undefined
  receiver = createServer((request, response) => {
    void (async () => {
      assert.equal(request.headers.authorization, `Bearer ${providerToken}`)
      let body = ''
      for await (const part of request) body += part
      const { query, variables } = JSON.parse(body)
      response.setHeader('content-type', 'application/json')
      const reply = (data: unknown) => response.end(JSON.stringify({ data }))
      if (query.includes('query MikkaLinearTeams')) return reply({ teams: { nodes: [{ ...provider.team, states: { nodes: [] } }], pageInfo: { hasNextPage: false, endCursor: null } } })
      if (query.includes('query MikkaLinearIssue(')) {
        assert.equal(variables.id, provider.id)
        return reply({ issue: { ...provider, labels: { nodes: provider.labels } } })
      }
      if (query.includes('query MikkaLinearUsers')) {
        userLookups++
        const hook = onUserLookup
        onUserLookup = undefined
        await hook?.()
        return reply({ users: { nodes: [outgoingRemote.assignee], pageInfo: { hasNextPage: false, endCursor: null } } })
      }
      assert.ok(query.includes('mutation MikkaLinearUpdateIssue'), 'only the actual issue sync GraphQL operations are allowed')
      assert.equal(variables.id, provider.id)
      updates.push(structuredClone(variables.input))
      if (Object.hasOwn(variables.input, 'assigneeId')) provider.assignee = variables.input.assigneeId === null ? null : outgoingRemote.assignee
      provider = { ...provider, ...('title' in variables.input ? { title: variables.input.title } : {}), updatedAt: new Date().toISOString() }
      return reply({ issueUpdate: { success: true, issue: { updatedAt: provider.updatedAt } } })
    })().catch(error => { receiverErrors.push(error); response.statusCode = 500; response.end(JSON.stringify({ errors: [{ message: 'fixture rejected request' }] })) })
  })
  await new Promise<void>(resolve => receiver!.listen(0, '127.0.0.1', resolve))
  const address = receiver.address() as { port: number }
  globalThis.fetch = (async (input, init) => {
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    assert.equal(target.origin, 'https://api.linear.app')
    assert.equal(target.pathname, '/graphql')
    return originalFetch(`http://127.0.0.1:${address.port}/graphql`, init)
  }) as typeof fetch

  await t.test('outbound sync maps active people and clears suspended/removed people without changing local history', async () => {
    const before = { metadata: await metadata(outgoing.id), history: await history(outgoing.id) }
    assert.ok(await syncAppIssueToLinear(outgoing.id))
    assert.equal(updates.at(-1)?.assigneeId, outgoingRemote.assignee?.id)
    assert.ok(userLookups > 0)
    try {
      for (const status of ['suspended', 'removed']) {
        await setStatus(status)
        provider.assignee = outgoingRemote.assignee
        const lookupsBefore = userLookups
        const writesBefore = updates.length
        assert.ok(await syncAppIssueToLinear(outgoing.id))
        assert.equal(updates.length, writesBefore + 1)
        assert.equal(updates.at(-1)?.assigneeId, null)
        assert.equal(userLookups, lookupsBefore, 'revoked membership is rejected before disclosing its email to the provider lookup')
      }
    } finally { await setStatus('active') }
    assert.deepEqual({ metadata: await metadata(outgoing.id), history: await history(outgoing.id) }, before)
  })

  await t.test('membership revoked during the provider user lookup cannot be reassigned by that stale lookup', async () => {
    provider.assignee = outgoingRemote.assignee
    const before = { metadata: await metadata(outgoing.id), history: await history(outgoing.id) }
    const lookupsBefore = userLookups
    const writesBefore = updates.length
    onUserLookup = () => setStatus('suspended')
    try {
      assert.ok(await syncAppIssueToLinear(outgoing.id))
      assert.equal(userLookups, lookupsBefore + 1)
      assert.equal(updates.length, writesBefore + 1)
      assert.equal(updates.at(-1)?.assigneeId, null)
      assert.deepEqual({ metadata: await metadata(outgoing.id), history: await history(outgoing.id) }, before)
    } finally { onUserLookup = undefined; await setStatus('active') }
  })

  await t.test('historical metadata referencing a member of another Workspace is never sent as its assignee', async () => {
    const stored = (await pool.query('SELECT content FROM issues WHERE id=$1', [outgoing.id])).rows[0].content
    const foreignContent = withIssueMetadata(stored, { ...readIssueMetadata(stored), assignee: { kind: 'member', id: foreign, name: 'Historical other tenant', image: null } })
    await pool.query('UPDATE issues SET content=$2::jsonb WHERE id=$1', [outgoing.id, JSON.stringify(foreignContent)])
    provider.assignee = outgoingRemote.assignee
    const lookupsBefore = userLookups
    const writesBefore = updates.length
    assert.ok(await syncAppIssueToLinear(outgoing.id))
    assert.equal(userLookups, lookupsBefore)
    assert.equal(updates.length, writesBefore + 1)
    assert.equal(updates.at(-1)?.assigneeId, null)
    assert.deepEqual((await pool.query('SELECT content FROM issues WHERE id=$1', [outgoing.id])).rows[0].content, foreignContent)
    assert.deepEqual(receiverErrors, [])
  })
})
