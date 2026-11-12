import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import type { ApiSession } from '../api-auth'
import { tokenWorkspace } from '../tokens/principal'
import { dbUrl, seedUser, seedWorkspace, seedBot, seedAgent, seedTeam } from '../../tests/support/workspace-admin-db'
import { dropTestDatabase } from '../../tests/support/drop-test-database'
import { orderMigrations } from '../../scripts/migration-order.mjs'

test('review capabilities follow real team relation changes and their transaction boundary', { skip: !dbUrl, timeout: 120_000 }, async t => {
  assert.ok(dbUrl)
  const admin = new Pool({ connectionString: dbUrl, max: 1 })
  const database = `review_team_${randomUUID().replaceAll('-', '')}_e2e`
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
  const url = new URL(dbUrl); url.pathname = `/${database}`
  const pool = new Pool({ connectionString: url.toString(), max: 8 })
  const saved = { E2E_DATABASE_URL: process.env.E2E_DATABASE_URL, MIKKA_DATABASE_URL: process.env.MIKKA_DATABASE_URL, DATABASE_URL: process.env.DATABASE_URL }
  let appPool: Pool | undefined, workspacePool: Pool | undefined
  t.after(async () => {
    await dropTestDatabase(admin, database, pool, appPool, workspacePool)
    assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount, 0)
    await admin.end()
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  })
  const migrations = new URL('../../drizzle/', import.meta.url)
  for (const file of orderMigrations((await readdir(migrations)).filter(file => file.endsWith('.sql')))) await pool.query(await readFile(new URL(file, migrations), 'utf8'))
  Object.assign(process.env, { E2E_DATABASE_URL: url.toString(), MIKKA_DATABASE_URL: url.toString(), DATABASE_URL: url.toString() })
  // Run real after() work at the request boundary. Bare Node otherwise starts
  // unrelated Live membership readers inside the gateway's exclusive lock probe.
  const next = await import('next/server')
  const afterResponse: Array<() => unknown> = []
  t.mock.module('next/server', { namedExports: { ...next, after: (work: () => unknown) => { afterResponse.push(work) } } })
  t.afterEach(async () => { await Promise.all(afterResponse.splice(0).map(work => work())) })
  // Framework translation and audit request metadata are outside this SQL
  // regression. Session rows, membership, issue access, action authorization
  // and transactions are real; actAs uses the existing verified-actor path.
  t.mock.module('next-intl/server', { namedExports: { getTranslations: async () => Object.assign((key: string) => key, { has: () => false }), getLocale: async () => 'en' } })
  t.mock.module('next/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set() {}, delete() {} }) } })
  const { resolveTaskReviewAuthority: resolve, ReviewAuthorityError } = await import('./review-authority')
  const { beginReviewSession, readReviewSession, closeReviewSession, drainRevokedReviewSessions, reviewSessionTransport } = await import('./review-sessions')
  const { actAs } = await import('../acting-user')
  const { setIssueTeam } = await import('../../app/actions/team-relations')
  const { promoteExistingIssueForUser } = await import('../team-issue-promotion')
  appPool = (await import('../db')).pool; workspacePool = (await import('../workspace-db')).workspacePool
  let external = 0
  t.mock.method(globalThis, 'fetch', async () => { external++; throw new Error('Unexpected external request') })
  const owner = await seedUser(pool, 'review-relation-owner')
  const { id: workspaceA } = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const { id: workspaceB } = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const { id: teamA } = await seedTeam(pool, workspaceA, owner), { id: teamB } = await seedTeam(pool, workspaceB, owner)
  const botId = await seedBot(pool, workspaceA, owner), agentId = await seedAgent(pool, owner)
  const credentialId = randomUUID()
  await pool.query('INSERT INTO "session"(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES($1,$2,$1,now()+interval \'1 hour\',now(),now())', [credentialId, owner])
  const session: ApiSession = { user: { id: owner, name: owner, email: `${owner}@example.invalid`, image: null }, session: { id: credentialId } }
  const fixture = async (linked = false, home = { workspaceId: workspaceA, botId, teamId: teamA }) => {
    const taskId = randomUUID(), runId = randomUUID(), deviceId = randomUUID(), repoId = randomUUID(), tokenId = randomUUID()
    const sandboxId = `synthetic-review-${randomUUID()}`, remoteKey = 'v2/github.com/mikka-ci/review-team-fixture'
    await pool.query('INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority,scope) VALUES($1,$2,$3,\'Review team fixture\',\'{"type":"doc"}\',\'doing\',\'normal\',\'personal\')', [taskId, owner, home.workspaceId])
    if (linked) await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [taskId, home.teamId, home.workspaceId, owner])
    await pool.query('INSERT INTO devices(id,"ownerId",name,kind,enabled,"lastSeenAt") VALUES($1,$2,\'Review fixture\',\'cloud\',true,now())', [deviceId, owner])
    await pool.query('INSERT INTO device_repos(id,"deviceId","userId","repoPath","remoteUrl") VALUES($1,$2,$3,$4,\'https://github.com/mikka-ci/review-team-fixture.git\')', [repoId, deviceId, owner, remoteKey])
    await pool.query('INSERT INTO device_tokens(id,"userId","tokenHash","boundDeviceId","boundWorkspaceId","expiresAt") VALUES($1::uuid,$2,$1::text,$3,$4,now()+interval \'1 hour\')', [tokenId, owner, deviceId, home.workspaceId])
    const definition = { executionIdentity: { workspaceId: home.workspaceId }, repositoryAdmission: { workspaceId: home.workspaceId,
      userId: owner, issueId: taskId, deviceId, agentId, remoteKey } }
    await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","botId","deviceId","deviceRepoId","deviceTokenId",
      "agentDefinition","machineAuthority",status,"worktreePath","startedAt","finishedAt","sessionId",report)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true,'succeeded',$10,now()-interval '1 minute',now(),'native-review-fixture',$11)`,
    [runId, owner, taskId, agentId, home.botId, deviceId, repoId, tokenId, JSON.stringify(definition), `/home/user/.mikka/worktrees/${runId}`,
      JSON.stringify({ safePoint: { session: 'exited', observedAt: new Date().toISOString() } })])
    await pool.query('INSERT INTO computer_run_bindings("runId","botId","workspaceId","ownerId") VALUES($1,$2,$3,$4)', [runId, home.botId, home.workspaceId, owner])
    await pool.query(`INSERT INTO thread_machines("runId","workspaceId","ownerId","sandboxId","snapshotId","operationId",state,"deviceId","issueId","repoId","botId",epoch,lifecycle)
      VALUES($1,$2,$3,$4,'synthetic',$5,'running',$6,$7,$8,$9,1,'{"phase":"review_resumed"}')`, [runId, home.workspaceId, owner, sandboxId, randomUUID(), deviceId, taskId, repoId, home.botId])
    return { taskId, runId, sandboxId, workspaceId: home.workspaceId }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const grant = (f: Fixture) => resolve(pool, workspacePool!, session, f.taskId, {}, async (authority, client) => ({ authority,
    lease: await beginReviewSession(authority, { kind: 'terminal' }, client) }))
  const leaseRow = async (id: string) => (await pool.query('SELECT * FROM coding_review_sessions WHERE id=$1', [id])).rows[0]
  const expectedLinks = new Map<string, string | null>()
  const expectedMembers = new Map<string, string | null>()
  const failClose = new Set<string>()
  const closeIds: string[] = []
  const probeErrors: unknown[] = []
  t.afterEach(() => {
    if (probeErrors.length) throw new AggregateError(probeErrors.splice(0), 'Review close SQL observation failed')
  })
  let priorLockProbe = Promise.resolve()
  t.mock.method(reviewSessionTransport, 'close', async (...[target, ids, _expiresAt, kind]: Parameters<typeof reviewSessionTransport.close>) => {
    assert.equal(kind, 'terminal')
    const rows = await pool.query('SELECT "taskId","revokedAt","sandboxId" FROM coding_review_sessions WHERE id=ANY($1::uuid[])', [ids])
    assert.equal(rows.rowCount, ids.length); assert.ok(rows.rows.every(row => row.revokedAt))
    assert.ok(rows.rows.every(row => row.sandboxId === target.sandboxId))
    const taskId = rows.rows[0].taskId as string
    if (expectedLinks.has(taskId)) {
      const link = (await workspacePool!.query('SELECT "workspaceId" FROM mikka_team_issues WHERE "issueId"=$1', [taskId])).rows[0]
      assert.equal(link?.workspaceId ?? null, expectedLinks.get(taskId), 'the relation outcome is committed before gateway IO')
    }
    // Several independent gateway ACKs are intentionally concurrent. Only
    // their test probes take this exclusive, database-wide relation lock.
    const lockProbe = priorLockProbe.then(async () => {
      const scope = await workspacePool!.connect(), machine = await pool.connect()
      try {
        await scope.query('BEGIN'); await machine.query('BEGIN')
        assert.equal((await scope.query("SELECT pg_try_advisory_xact_lock(hashtextextended('mikka-team-relations',0)) AS acquired")).rows[0].acquired, true,
          'gateway close does not hold the global Workspace relation lock')
        await scope.query('SELECT id FROM mikka_workspaces WHERE id=$1 FOR UPDATE NOWAIT', [target.workspaceId])
        const member = (await scope.query('SELECT status FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 FOR UPDATE NOWAIT', [target.workspaceId, target.ownerId])).rows[0]
        if (expectedMembers.has(target.workspaceId)) assert.equal(member?.status ?? null, expectedMembers.get(target.workspaceId), 'membership outcome committed before gateway IO')
        await machine.query('SELECT "runId" FROM thread_machines WHERE "runId"=$1 FOR UPDATE NOWAIT', [target.runId])
      } catch (error) {
        probeErrors.push(error)
        throw error
      } finally {
        await scope.query('ROLLBACK'); scope.release()
        await machine.query('ROLLBACK'); machine.release()
      }
    })
    priorLockProbe = lockProbe.catch(() => {})
    await lockProbe
    if (ids.some(id => failClose.has(id))) throw new Error('synthetic close acknowledgement unavailable')
    closeIds.push(...ids)
  })
  const change = (f: Fixture, teamId: string | null, expectedTeamId: string | null) => actAs({ id: owner, [tokenWorkspace]: f.workspaceId },
    () => setIssueTeam({ issueId: f.taskId, teamId, expectedTeamId }))

  await t.test('attaching a foreign Workspace is rejected without changing Task tenancy or its existing capability', async () => {
    const f = await fixture(), current = await grant(f)
    assert.equal((await change(f, teamB, null)).ok, false)
    assert.equal((await pool.query('SELECT "workspaceId" FROM issues WHERE id=$1', [f.taskId])).rows[0].workspaceId, workspaceA)
    assert.equal((await pool.query('SELECT 1 FROM mikka_team_issues WHERE "issueId"=$1', [f.taskId])).rowCount, 0)
    assert.equal(closeIds.includes(current.lease.id), false)
    assert.deepEqual(await readReviewSession(current.authority, { kind: 'terminal' }, pool), current.lease)
    assert.equal((await resolve(pool, workspacePool!, session, f.taskId)).workspaceId, workspaceA)
    await closeReviewSession(current.authority, { kind: 'terminal', id: current.lease.id }, pool)
  })
  await t.test('attaching a Team in the stored Workspace closes the completed Run capability before returning', async () => {
    const f = await fixture(), current = await grant(f)
    expectedLinks.set(f.taskId, workspaceA)
    assert.equal((await change(f, teamA, null)).ok, true)
    assert.ok(closeIds.includes(current.lease.id)); assert.equal(await leaseRow(current.lease.id), undefined)
    assert.equal((await pool.query('SELECT "workspaceId" FROM issues WHERE id=$1', [f.taskId])).rows[0].workspaceId, workspaceA)
    assert.equal((await resolve(pool, workspacePool!, session, f.taskId)).workspaceId, workspaceA)
  })
  await t.test('a no-op relation preserves review, while actual detach closes only its captured lease', async () => {
    const f = await fixture(true), current = await grant(f)
    assert.equal((await change(f, teamA, teamA)).ok, true)
    assert.deepEqual(await readReviewSession(current.authority, { kind: 'terminal' }, pool), current.lease)
    assert.equal(closeIds.includes(current.lease.id), false)
    expectedLinks.set(f.taskId, null)
    assert.equal((await change(f, null, teamA)).ok, true)
    assert.ok(closeIds.includes(current.lease.id)); assert.equal(await leaseRow(current.lease.id), undefined)
    const later = await grant(f)
    assert.notEqual(later.lease.id, current.lease.id)
    await drainRevokedReviewSessions(pool, [current.lease.id])
    assert.deepEqual(await readReviewSession(later.authority, { kind: 'terminal' }, pool), later.lease)
    await closeReviewSession(later.authority, { kind: 'terminal', id: later.lease.id }, pool)
  })
  for (const linked of [false, true]) await t.test(`a concurrent ${linked ? 'detach' : 'empty-link attach'} waits for the real grant and then revokes it`, async () => {
    const f = await fixture(linked)
    expectedLinks.set(f.taskId, linked ? null : workspaceA)
    let changed: ReturnType<typeof change> | undefined
    const current = await resolve(pool, workspacePool!, session, f.taskId, {}, async (authority, client) => {
      const lease = await beginReviewSession(authority, { kind: 'terminal' }, client)
      const writer = await workspacePool!.connect()
      try {
        await writer.query('BEGIN')
        assert.equal((await writer.query("SELECT pg_try_advisory_xact_lock(hashtextextended('mikka-team-relations',0)) AS acquired")).rows[0].acquired, false,
          'even an absent link is covered by the grant shared lock')
      } finally { await writer.query('ROLLBACK'); writer.release() }
      changed = change(f, linked ? null : teamA, linked ? teamA : null)
      // Start the actual writer while the grant retains both databases' locks.
      // The writer cannot commit before this callback releases the shared fence.
      const outcome = await Promise.race([changed.then(() => 'committed'), new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 25))])
      assert.equal(outcome, 'blocked')
      return { authority, lease }
    })
    assert.ok(changed); assert.equal((await changed).ok, true)
    assert.ok(closeIds.includes(current.lease.id)); assert.equal(await leaseRow(current.lease.id), undefined)
  })

  await pool.query('CREATE TABLE review_scope_faults("taskId" uuid PRIMARY KEY,"rejectLink" boolean NOT NULL DEFAULT false,"rejectScope" boolean NOT NULL DEFAULT false)')
  await pool.query(`CREATE FUNCTION review_reject_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF EXISTS(SELECT 1 FROM review_scope_faults WHERE "taskId"=NEW."issueId" AND "rejectLink") THEN RAISE EXCEPTION 'synthetic relation failure'; END IF;
    RETURN NEW; END $$`)
  await pool.query('CREATE TRIGGER review_reject_link BEFORE INSERT OR UPDATE ON mikka_team_issues FOR EACH ROW EXECUTE FUNCTION review_reject_link()')
  await pool.query(`CREATE FUNCTION review_reject_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.revision>OLD.revision AND EXISTS(SELECT 1 FROM review_scope_faults WHERE "taskId"=NEW.id AND "rejectScope") THEN RAISE EXCEPTION 'synthetic promotion failure'; END IF;
    RETURN NEW; END $$`)
  await pool.query('CREATE TRIGGER review_reject_scope BEFORE UPDATE ON issues FOR EACH ROW EXECUTE FUNCTION review_reject_scope()')
  await t.test('a failed relation write still drains its durable fence outside the rolled-back transaction', async () => {
    const f = await fixture(), current = await grant(f)
    await pool.query('INSERT INTO review_scope_faults("taskId","rejectLink") VALUES($1,true)', [f.taskId])
    expectedLinks.set(f.taskId, null)
    await assert.rejects(change(f, teamA, null), (error: unknown) => error instanceof Error
      && error.cause instanceof Error && error.cause.message === 'synthetic relation failure'
      && 'code' in error.cause && error.cause.code === 'P0001')
    assert.ok(closeIds.includes(current.lease.id)); assert.equal(await leaseRow(current.lease.id), undefined)
    const later = await grant(f)
    await closeReviewSession(later.authority, { kind: 'terminal', id: later.lease.id }, pool)
  })
  await t.test('a two-stage promotion closes old review even when the second APP write fails', async () => {
    const f = await fixture(), current = await grant(f)
    await pool.query('INSERT INTO review_scope_faults("taskId","rejectScope") VALUES($1,true)', [f.taskId])
    expectedLinks.set(f.taskId, workspaceA)
    const result = await promoteExistingIssueForUser(owner, { requestId: randomUUID(), issueId: f.taskId, revision: 1, teamId: teamA, expectedTeamId: null })
    assert.equal('error' in result ? result.error : null, 'teamIssueOutcomeUnknown')
    assert.equal((await pool.query('SELECT scope FROM issues WHERE id=$1', [f.taskId])).rows[0].scope, 'personal')
    assert.ok(closeIds.includes(current.lease.id)); assert.equal(await leaseRow(current.lease.id), undefined)
    // A grouping write does not move the immutable tenant. Its old lease was
    // closed, but the still-authorized owner may explicitly open a fresh one.
    assert.equal((await resolve(pool, workspacePool!, session, f.taskId)).workspaceId, workspaceA)
    const later = await grant(f)
    assert.notEqual(later.lease.id, current.lease.id)
    await closeReviewSession(later.authority, { kind: 'terminal', id: later.lease.id }, pool)
  })
  await t.test('the second promotion stage commits its exact fence before the scope write can fail', async () => {
    const f = await fixture(true), current = await grant(f)
    // The sequence survives the deliberate rollback. Its trigger runs before
    // review_reject_scope and sees the PostgreSQL transaction that wrote the fence.
    await pool.query(`CREATE SEQUENCE observed_committed_fence;
      CREATE FUNCTION observe_committed_fence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF EXISTS(SELECT 1 FROM coding_review_sessions s WHERE s."taskId"=NEW.id AND s."revokedAt" IS NOT NULL
          AND pg_xact_status(s.xmin::text::xid8)='committed') THEN PERFORM nextval('observed_committed_fence'); END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER observe_committed_fence BEFORE UPDATE ON issues FOR EACH ROW WHEN (NEW.revision>OLD.revision)
      EXECUTE FUNCTION observe_committed_fence()`)
    await pool.query('INSERT INTO review_scope_faults("taskId","rejectScope") VALUES($1,true)', [f.taskId])
    expectedLinks.set(f.taskId, workspaceA)
    const result = await promoteExistingIssueForUser(owner, { requestId: randomUUID(), issueId: f.taskId, revision: 1, teamId: teamA, expectedTeamId: teamA })
    assert.equal('error' in result ? result.error : null, 'teamIssueOutcomeUnknown')
    assert.equal((await pool.query('SELECT scope FROM issues WHERE id=$1', [f.taskId])).rows[0].scope, 'personal')
    assert.equal((await pool.query('SELECT is_called FROM observed_committed_fence')).rows[0].is_called, true)
    assert.ok(closeIds.includes(current.lease.id))
    assert.equal(await leaseRow(current.lease.id), undefined)
    const later = await grant(f)
    assert.notEqual(later.lease.id, current.lease.id)
    await closeReviewSession(later.authority, { kind: 'terminal', id: later.lease.id }, pool)
  })
  const administrativeFixture = async (linked = false) => {
    const adminId = await seedUser(pool, 'review-admin')
    const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: adminId, role: 'admin' }])
    const team = await seedTeam(pool, workspace.id, owner)
    const runtimeBot = await seedBot(pool, workspace.id, owner)
    const f = await fixture(linked, { workspaceId: workspace.id, botId: runtimeBot, teamId: team.id })
    return { ...f, adminId, workspace, team }
  }
  await t.test('member removal fences under authority locks and closes after those locks release', async () => {
    const { removeMember } = await import('../workspace-admin/members')
    const f = await administrativeFixture(), current = await grant(f)
    expectedMembers.set(f.workspace.id, null)
    assert.equal((await removeMember(f.adminId, f.workspace.id, owner)).removed, true)
    assert.ok(closeIds.includes(current.lease.id)); assert.equal(await leaseRow(current.lease.id), undefined)
    await assert.rejects(resolve(pool, workspacePool!, session, f.taskId), error => error instanceof ReviewAuthorityError && error.status === 404)
    assert.equal((await pool.query('SELECT status FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceA, owner])).rows[0].status, 'active')
  })
  await t.test('the real suspension action closes review after the membership change commits', async () => {
    const { updateWorkspaceMember } = await import('../../app/actions/workspace')
    const f = await administrativeFixture(), current = await grant(f)
    expectedMembers.set(f.workspace.id, 'suspended')
    const result = await actAs(f.adminId, () => updateWorkspaceMember({ workspaceId: f.workspace.id, userId: owner, role: 'member', status: 'suspended' }))
    assert.equal(result.ok, true)
    assert.ok(closeIds.includes(current.lease.id)); assert.equal(await leaseRow(current.lease.id), undefined)
    await assert.rejects(resolve(pool, workspacePool!, session, f.taskId), error => error instanceof ReviewAuthorityError && error.status === 404)
  })
  await t.test('referenced Team deletion is refused; explicit grouping removal drains its capability and preserves Task history', async () => {
    const { deleteTeamData, removeTeamGroupingData } = await import('../workspace-admin/teams')
    const { WorkspaceError } = await import('../workspace-access')
    const f = await administrativeFixture(true), current = await grant(f)
    await assert.rejects(deleteTeamData(f.adminId, f.team.id, f.team.name), error => error instanceof WorkspaceError && error.message === 'teamDeleteReferenced')
    assert.equal(closeIds.includes(current.lease.id), false)
    assert.deepEqual(await readReviewSession(current.authority, { kind: 'terminal' }, pool), current.lease)
    expectedLinks.set(f.taskId, null)
    assert.equal((await removeTeamGroupingData(f.adminId, f.team.id, f.team.name)).removed.tasks, 1)
    assert.ok(closeIds.includes(current.lease.id)); assert.equal(await leaseRow(current.lease.id), undefined)
    assert.equal((await pool.query('SELECT "workspaceId" FROM issues WHERE id=$1', [f.taskId])).rows[0].workspaceId, f.workspace.id)
    assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE id=$1 AND "issueId"=$2', [f.runId, f.taskId])).rowCount, 1)
    assert.equal((await resolve(pool, workspacePool!, session, f.taskId)).workspaceId, f.workspace.id)
  })
  await t.test('workspace deletion retains a failed close target through generic row deletion until exact ACK', async () => {
    const { deleteWorkspaceData } = await import('../workspace-admin/general')
    const { workspaceDeletionStatements } = await import('../workspace-rows')
    const { deletionStatements } = await import('../account/delete')
    const { threadMachineProvider } = await import('../cloud-computer/thread-machines')
    const f = await administrativeFixture(true), current = await grant(f), killed: string[] = []
    assert.equal((await workspaceDeletionStatements(pool, f.workspace.id)).some(row => row.table === 'coding_review_sessions'), false)
    assert.equal((await deletionStatements(pool, owner, { shared: [f.workspace.id], solo: [], keptIssueIds: [] })).some(row => row.table === 'coding_review_sessions'), false)
    const kill = t.mock.method(threadMachineProvider, 'kill', async (sandboxId: string) => { killed.push(sandboxId); throw new Error('synthetic kill acknowledgement unavailable') })
    failClose.add(current.lease.id); expectedLinks.set(f.taskId, null); expectedMembers.set(f.workspace.id, null)
    try {
      const result = await deleteWorkspaceData(f.adminId, f.workspace.id, f.workspace.name)
      assert.equal(result.deleted.tasks, 1)
    } finally { kill.mock.restore() }
    assert.deepEqual(killed, [f.sandboxId])
    assert.equal((await pool.query('SELECT id FROM mikka_workspaces WHERE id=$1', [f.workspace.id])).rowCount, 0)
    assert.equal((await pool.query('SELECT "runId" FROM thread_machines WHERE "runId"=$1', [f.runId])).rowCount, 0)
    const pending = await leaseRow(current.lease.id)
    assert.ok(pending.revokedAt); assert.ok(pending.retryAt); assert.equal(pending.sandboxId, f.sandboxId)
    assert.equal(pending.runId, f.runId); assert.equal(closeIds.includes(current.lease.id), false)
    failClose.delete(current.lease.id)
    assert.deepEqual(await drainRevokedReviewSessions(pool, [current.lease.id]), { closed: 1, pending: 0 })
    assert.ok(closeIds.includes(current.lease.id)); assert.equal(await leaseRow(current.lease.id), undefined)
  })
  await t.test('account runtime cleanup stays blocked until the final review close ACK', async () => {
    const { cleanupAccountRuntimes } = await import('../account/runtime-cleanup')
    const f = await administrativeFixture(), current = await grant(f)
    const sibling = await grant(await administrativeFixture())
    failClose.add(current.lease.id)
    const cleanup = () => cleanupAccountRuntimes(owner, pool, async (database, actor, runId) => {
      assert.equal(actor.userId, owner)
      // Provider boundary: its successful kill leaves no live VM mapping.
      await database.query('UPDATE thread_machines SET state=\'ended\',"sandboxId"=NULL WHERE "runId"=$1 AND "ownerId"=$2', [runId, actor.userId])
    }, async () => [], async () => ({ killed: 0, pending: 0 }))
    assert.deepEqual(await cleanup(), ['review_capability_close_pending'])
    assert.ok((await leaseRow(current.lease.id)).revokedAt)
    assert.ok(closeIds.includes(sibling.lease.id))
    assert.equal(await leaseRow(sibling.lease.id), undefined)
    assert.equal((await pool.query('SELECT id FROM "user" WHERE id=$1', [owner])).rowCount, 1)
    failClose.delete(current.lease.id)
    assert.deepEqual(await cleanup(), [])
    assert.ok(closeIds.includes(current.lease.id)); assert.equal(await leaseRow(current.lease.id), undefined)
  })
  assert.equal(external, 0)
})
