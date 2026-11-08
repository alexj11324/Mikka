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

test('task review: current owner, session, tenant and immutable physical checkout', { skip: !dbUrl, timeout: 120_000 }, async t => {
  assert.ok(dbUrl)
  const admin = new Pool({ connectionString: dbUrl, max: 1 })
  const database = `review_authority_${randomUUID().replaceAll('-', '')}_e2e`
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
  const { resolveTaskReviewAuthority: resolve, ReviewAuthorityError } = await import('./review-authority')
  appPool = (await import('../db')).pool; workspacePool = (await import('../workspace-db')).workspacePool
  // No provider, model or gateway participates in a control-plane scope read.
  let external = 0
  t.mock.method(globalThis, 'fetch', async () => { external++; throw new Error('Unexpected external request') })
  const account = async (id: string): Promise<ApiSession> => {
    const sessionId = randomUUID()
    await pool.query('INSERT INTO "session"(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES($1,$2,$1,now()+interval \'1 hour\',now(),now())', [sessionId, id])
    return { user: { id, name: id, email: `${id}@example.invalid`, image: null }, session: { id: sessionId } }
  }
  const fixture = async () => {
    const userId = await seedUser(pool, 'review-owner'), peerId = await seedUser(pool, 'review-peer'), strangerId = await seedUser(pool, 'review-other')
    const { id: workspaceId } = await seedWorkspace(pool, userId, [{ userId, role: 'admin' }, { userId: peerId, role: 'member' }])
    const { id: otherWorkspaceId } = await seedWorkspace(pool, userId, [{ userId, role: 'admin' }])
    const { id: teamId } = await seedTeam(pool, workspaceId, userId)
    await pool.query('INSERT INTO mikka_team_members("teamId","userId",role) VALUES($1,$2,\'member\')', [teamId, peerId])
    const taskId = randomUUID()
    await pool.query('INSERT INTO issues(id,"userId",title,content,status,priority,scope) VALUES($1,$2,\'Review fixture\',\'{"type":"doc"}\',\'doing\',\'normal\',\'workspace\')', [taskId, userId])
    await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [taskId, teamId, workspaceId, userId])
    const botId = await seedBot(pool, workspaceId, userId), agentId = await seedAgent(pool, userId)
    const deviceId = randomUUID(), repoId = randomUUID(), deviceTokenId = randomUUID(), runId = randomUUID()
    const remoteKey = 'v2/github.com/mikka-ci/review-fixture', sandboxId = `synthetic-${randomUUID()}`, worktreePath = `/home/user/.mikka/worktrees/${runId}`
    await pool.query('INSERT INTO devices(id,"ownerId",name,kind,enabled,"lastSeenAt") VALUES($1,$2,\'Review fixture\',\'cloud\',true,now())', [deviceId, userId])
    await pool.query('INSERT INTO device_repos(id,"deviceId","userId","repoPath","remoteUrl") VALUES($1,$2,$3,$4,\'https://github.com/mikka-ci/review-fixture.git\')', [repoId, deviceId, userId, remoteKey])
    await pool.query('INSERT INTO device_tokens(id,"userId","tokenHash","boundDeviceId","boundWorkspaceId","expiresAt") VALUES($1::uuid,$2,$1::text,$3,$4,now()+interval \'1 hour\')', [deviceTokenId, userId, deviceId, workspaceId])
    const definition = { executionIdentity: { workspaceId }, repositoryAdmission: { workspaceId, userId, issueId: taskId, deviceId, agentId, remoteKey } }
    await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","botId","deviceId","deviceRepoId","deviceTokenId","agentDefinition",
      "machineAuthority",status,"worktreePath","leaseExpiresAt","startedAt","sessionId")
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true,'running',$10,now()+interval '5 minutes',now()-interval '1 minute','native-fixture')`,
    [runId, userId, taskId, agentId, botId, deviceId, repoId, deviceTokenId, JSON.stringify(definition), worktreePath])
    await pool.query('INSERT INTO computer_run_bindings("runId","botId","workspaceId","ownerId") VALUES($1,$2,$3,$4)', [runId, botId, workspaceId, userId])
    await pool.query(`INSERT INTO thread_machines("runId","workspaceId","ownerId","sandboxId","snapshotId","operationId",state,"deviceId","issueId","repoId","botId",epoch)
      VALUES($1,$2,$3,$4,'synthetic', $5,'running',$6,$7,$8,$9,1)`, [runId, workspaceId, userId, sandboxId, randomUUID(), deviceId, taskId, repoId, botId])
    return { userId, peerId, strangerId, workspaceId, otherWorkspaceId, taskId, botId, agentId, deviceId, repoId, deviceTokenId, runId, remoteKey, sandboxId, worktreePath,
      session: await account(userId), peer: await account(peerId), stranger: await account(strangerId) }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const read = (f: Fixture, session = f.session, expected = {}) => resolve(pool, pool, session, f.taskId, expected)
  const refused = (operation: Promise<unknown>, status: number, code?: string) => assert.rejects(operation, error => error instanceof ReviewAuthorityError && error.status === status && (!code || error.code === code))

  await t.test('owner gets the actual latest Run, never a caller-provided sandbox', async () => {
    const f = await fixture(), authority = await read(f)
    assert.deepEqual([authority.taskId, authority.runId, authority.workspaceId, authority.sandboxId, authority.deviceId, authority.repoId],
      [f.taskId, f.runId, f.workspaceId, f.sandboxId, f.deviceId, f.repoId])
    assert.equal(authority.worktreePath, f.worktreePath)
    assert.equal(authority.repoPath, f.remoteKey)
    assert.equal(authority.nativeExitedProof, false)
    assert.match(authority.bindingId, /^[a-f0-9]{64}$/)
    assert.equal(authority.credential.id, f.session.session.id)
    assert.equal('token' in authority, false)
  })
  await t.test('Team visibility is not shell/preview ownership', async () => {
    const f = await fixture()
    await refused(read(f, f.peer), 403, 'not_owner_terminal')
    await refused(read(f, f.stranger), 404, 'review_not_found')
  })
  await t.test('changing the human assignee grants no access to the old owner machine', async () => {
    const f = await fixture()
    await pool.query('UPDATE issues SET content=$2 WHERE id=$1', [f.taskId, JSON.stringify({ type: 'doc', attrs: { mikka: { assignee: { kind: 'member', id: f.peerId, name: 'peer', image: null } } } })])
    await refused(read(f), 403, 'not_owner_terminal')
    await refused(read(f, f.peer), 403, 'not_owner_terminal')
  })
  await t.test('session revocation and expiry defeat a previously authorized object', async () => {
    const f = await fixture(); await read(f)
    await pool.query('DELETE FROM "session" WHERE id=$1', [f.session.session.id])
    await refused(read(f), 401, 'review_auth_required')
    f.session = await account(f.userId)
    await pool.query('UPDATE "session" SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [f.session.session.id])
    await refused(read(f), 401)
  })
  await t.test('an explicit workspace cannot cross tenants even for a member of both', async () => {
    const f = await fixture()
    assert.equal((await read(f, f.session, { workspaceId: f.workspaceId })).workspaceId, f.workspaceId)
    await refused(read(f, f.session, { workspaceId: f.otherWorkspaceId }), 403, 'review_scope_denied')
  })
  await t.test('workspace PAT cannot switch tenant and revocation is fresh', async () => {
    const f = await fixture(), id = randomUUID()
    await pool.query('INSERT INTO personal_access_tokens(id,"userId","workspaceId",name,"tokenHash",hint) VALUES($1,$2,$3,\'Review fixture\',$4,\'test\')', [id, f.userId, f.workspaceId, id.replaceAll('-', '').repeat(2)])
    const session: ApiSession = { user: { ...f.session.user, [tokenWorkspace]: f.workspaceId }, session: { id: `pat:${id}` }, tokenWorkspaceId: f.workspaceId }
    assert.equal((await read(f, session)).credential.kind, 'pat')
    const other: ApiSession = { ...session, user: { ...session.user, [tokenWorkspace]: f.otherWorkspaceId }, tokenWorkspaceId: f.otherWorkspaceId }
    await refused(read(f, other), 404)
    await pool.query('UPDATE personal_access_tokens SET "revokedAt"=now() WHERE id=$1', [id])
    await refused(read(f, session), 401)
  })
  await t.test('suspension and a moved Team link revoke both transports', async () => {
    const f = await fixture(); await read(f)
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [f.workspaceId, f.userId])
    await refused(read(f), 403)
    await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [f.workspaceId, f.userId])
    await pool.query('UPDATE mikka_team_issues SET "workspaceId"=$2 WHERE "issueId"=$1', [f.taskId, f.otherWorkspaceId])
    await refused(read(f), 403)
  })
  const mutations: Array<[string, (f: Fixture) => Promise<unknown>, number]> = [
    ['frozen Workspace mismatch', f => pool.query('UPDATE agent_runs SET "agentDefinition"=jsonb_set("agentDefinition",\'{executionIdentity,workspaceId}\',to_jsonb($2::text)) WHERE id=$1', [f.runId, f.otherWorkspaceId]), 403],
    ['token Workspace mismatch', f => pool.query('UPDATE device_tokens SET "boundWorkspaceId"=$2 WHERE id=$1', [f.deviceTokenId, f.otherWorkspaceId]), 403],
    ['device owner mismatch', f => pool.query('UPDATE devices SET "ownerId"=$2 WHERE id=$1', [f.deviceId, f.peerId]), 403],
    ['repository owner mismatch', f => pool.query('UPDATE device_repos SET "userId"=$2 WHERE id=$1', [f.repoId, f.peerId]), 403],
    ['repository remote mismatch', f => pool.query('UPDATE device_repos SET "remoteUrl"=\'https://github.com/mikka-ci/wrong.git\' WHERE id=$1', [f.repoId]), 403],
    ['frozen repository mismatch', f => pool.query('UPDATE agent_runs SET "agentDefinition"=jsonb_set("agentDefinition",\'{repositoryAdmission,remoteKey}\',\'"v2/github.com/mikka-ci/wrong"\') WHERE id=$1', [f.runId]), 403],
    ['stopped Run', f => pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [f.runId]), 409],
    ['legacy stopped Run without stopRequestedAt', f => pool.query('UPDATE agent_runs SET status=\'stopped\' WHERE id=$1', [f.runId]), 409],
    ['cancelled Run without stopRequestedAt', f => pool.query('UPDATE agent_runs SET status=\'cancelled\' WHERE id=$1', [f.runId]), 409],
    ['expired active lease', f => pool.query('UPDATE agent_runs SET "leaseExpiresAt"=now()-interval \'1 second\' WHERE id=$1', [f.runId]), 409],
    ['recycled VM', f => pool.query('UPDATE thread_machines SET state=\'ended\',"sandboxId"=NULL WHERE "runId"=$1', [f.runId]), 409],
    ['removed device', f => pool.query('UPDATE devices SET "removedAt"=now() WHERE id=$1', [f.deviceId]), 409],
    ['revoked device token', f => pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', [f.deviceTokenId]), 409],
    ['missing physical authority', f => pool.query('UPDATE agent_runs SET "machineAuthority"=false WHERE id=$1', [f.runId]), 409],
    ['non-normalized worktree', f => pool.query('UPDATE agent_runs SET "worktreePath"=\'/home/user/../root\' WHERE id=$1', [f.runId]), 404],
    ['closed Task', f => pool.query('UPDATE issues SET status=\'done\' WHERE id=$1', [f.taskId]), 409],
  ]
  for (const [name, mutate, status] of mutations) await t.test(name, async () => { const f = await fixture(); await mutate(f); await refused(read(f), status) })
  await t.test('an unavailable newer run never falls back to an old authorized checkout', async () => {
    const f = await fixture(), before = await read(f), next = randomUUID()
    await pool.query('INSERT INTO agent_runs(id,"userId","agentId","issueId",status,"createdAt") VALUES($1,$2,$3,$4,\'queued\',now()+interval \'1 second\')', [next, f.userId, f.agentId, f.taskId])
    await refused(read(f), 404, 'review_checkout_unavailable')
    await refused(read(f, f.session, { runId: before.runId, bindingId: before.bindingId }), 409, 'review_binding_changed')
  })
  await t.test('expected binding rejects epoch, claim and path changes between prepare and mint', async () => {
    const f = await fixture(), before = await read(f)
    await pool.query('UPDATE thread_machines SET epoch=epoch+1 WHERE "runId"=$1', [f.runId])
    await refused(read(f, f.session, { runId: before.runId, bindingId: before.bindingId }), 409, 'review_binding_changed')
    assert.notEqual((await read(f)).bindingId, before.bindingId)
  })
  await t.test('safe native exit is explicit evidence, not merely a terminal status', async () => {
    const f = await fixture()
    await pool.query('UPDATE agent_runs SET status=\'succeeded\',"leaseExpiresAt"=NULL,"finishedAt"=now() WHERE id=$1', [f.runId])
    assert.equal((await read(f)).nativeExitedProof, false)
    await pool.query('UPDATE agent_runs SET report=$2 WHERE id=$1', [f.runId, JSON.stringify({ safePoint: { session: 'exited', observedAt: new Date().toISOString() } })])
    assert.equal((await read(f)).nativeExitedProof, true)
    await pool.query('UPDATE agent_runs SET report=$2 WHERE id=$1', [f.runId, JSON.stringify({ safePoint: { session: 'exited', observedAt: new Date(Date.now() + 60_000).toISOString() } })])
    assert.equal((await read(f)).nativeExitedProof, false)
  })
  await t.test('normal parking permits a new review lease without reviving the execution token', async () => {
    const f = await fixture()
    await pool.query('UPDATE agent_runs SET status=\'succeeded\',"leaseExpiresAt"=NULL,"finishedAt"=now(),report=$2 WHERE id=$1',
      [f.runId, JSON.stringify({ safePoint: { session: 'exited', observedAt: new Date().toISOString() } })])
    await pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', [f.deviceTokenId])
    for (const phase of ['paused', 'review_starting', 'review_resume_requested', 'review_resumed', 'review_active']) {
      await pool.query('UPDATE thread_machines SET state=\'paused\',lifecycle=$2 WHERE "runId"=$1', [f.runId, JSON.stringify({ phase })])
      const authority = await read(f)
      assert.equal(authority.nativeExitedProof, true)
      assert.equal(authority.deviceTokenActive, false)
    }
    assert.ok((await pool.query('SELECT "revokedAt" FROM device_tokens WHERE id=$1', [f.deviceTokenId])).rows[0].revokedAt)
    await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [f.runId])
    await refused(read(f), 409, 'review_machine_gone')
  })
  await t.test('parked provenance requires the trusted exit receipt and an enabled device', async () => {
    const f = await fixture()
    await pool.query('UPDATE agent_runs SET status=\'succeeded\',"leaseExpiresAt"=NULL,"finishedAt"=now() WHERE id=$1', [f.runId])
    await pool.query('UPDATE thread_machines SET state=\'paused\',lifecycle=\'{"phase":"paused"}\' WHERE "runId"=$1', [f.runId])
    await pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', [f.deviceTokenId])
    await refused(read(f), 409)
    await pool.query('UPDATE agent_runs SET report=$2 WHERE id=$1', [f.runId, JSON.stringify({ safePoint: { session: 'exited', observedAt: new Date().toISOString() } })])
    await pool.query('UPDATE devices SET enabled=false WHERE id=$1', [f.deviceId])
    await refused(read(f), 409)
  })
  await t.test('explicit device credential revocation cannot be mistaken for normal parking', async () => {
    const f = await fixture()
    await pool.query('UPDATE agent_runs SET status=\'succeeded\',"leaseExpiresAt"=NULL,"finishedAt"=now(),report=$2 WHERE id=$1',
      [f.runId, JSON.stringify({ safePoint: { session: 'exited', observedAt: new Date().toISOString() } })])
    await pool.query('UPDATE thread_machines SET state=\'paused\',lifecycle=\'{"phase":"paused"}\' WHERE "runId"=$1', [f.runId])
    await pool.query('UPDATE device_tokens SET "revokedAt"=now(),"revokedBy"=$2 WHERE id=$1', [f.deviceTokenId, f.userId])
    await refused(read(f), 409)
    await pool.query('UPDATE device_tokens SET "revokedBy"=NULL WHERE id=$1', [f.deviceTokenId])
    await pool.query('INSERT INTO device_credential_revocations("tokenId","ownerId","actorId","revokedAt") VALUES($1,$2,$2,now())', [f.deviceTokenId, f.userId])
    await refused(read(f), 409)
  })
  await t.test('lease work is atomic with authority and owns the machine mutation lock', async () => {
    const f = await fixture()
    const result = await resolve(pool, pool, f.session, f.taskId, {}, async (authority, client) => {
      assert.equal(authority.runId, f.runId)
      const contender = await pool.connect()
      try {
        await contender.query('BEGIN')
        await assert.rejects(contender.query('SELECT "runId" FROM thread_machines WHERE "runId"=$1 FOR UPDATE NOWAIT', [f.runId]),
          (error: unknown) => error instanceof Error && 'code' in error && error.code === '55P03')
        await contender.query('ROLLBACK')
        await contender.query('BEGIN')
        await assert.rejects(contender.query('SELECT id FROM issues WHERE id=$1 FOR KEY SHARE NOWAIT', [f.taskId]),
          (error: unknown) => error instanceof Error && 'code' in error && error.code === '55P03')
      } finally {
        await contender.query('ROLLBACK')
        contender.release()
      }
      await client.query('UPDATE thread_machines SET lifecycle=\'{"phase":"review_starting"}\' WHERE "runId"=$1', [f.runId])
      return 'committed'
    })
    assert.equal(result, 'committed')
    const before = (await pool.query('SELECT lifecycle FROM thread_machines WHERE "runId"=$1', [f.runId])).rows[0].lifecycle
    const failure = new Error('fixture rollback')
    await assert.rejects(resolve(pool, pool, f.session, f.taskId, {}, async (_authority, client) => {
      await client.query('UPDATE thread_machines SET lifecycle=\'{"phase":"review_active"}\' WHERE "runId"=$1', [f.runId])
      throw failure
    }), error => error === failure)
    assert.deepEqual((await pool.query('SELECT lifecycle FROM thread_machines WHERE "runId"=$1', [f.runId])).rows[0].lifecycle, before)
  })

  const { beginReviewSession, readReviewSession, closeReviewSession, revokeReviewSession,
    revokeReviewSessions, expireReviewSessions, reviewSessionTransport } = await import('./review-sessions')
  const { resumeReviewMachine } = await import('./review-machine')
  const { TerminalError } = await import('@mikka/protocol/coding-terminal')
  type Kind = 'terminal' | 'preview'
  const closeCalls: Array<{ kind: Kind; ids: string[]; sandboxId: string; expiresAt: string }> = []
  const failingKinds = new Set<Kind>()
  t.mock.method(reviewSessionTransport, 'close', async (...[target, ids, expiresAt, kind]: Parameters<typeof reviewSessionTransport.close>) => {
    const pending = await pool.query('SELECT "revokedAt" FROM coding_review_sessions WHERE id=ANY($1::uuid[])', [ids])
    assert.equal(pending.rowCount, ids.length)
    assert.ok(pending.rows.every(row => row.revokedAt), 'durable fence precedes any network operation')
    closeCalls.push({ kind, ids, sandboxId: target.sandboxId, expiresAt })
    if (failingKinds.has(kind)) throw new Error('synthetic close acknowledgement unavailable')
  })
  const grant = (f: Fixture, kind: Kind = 'terminal', session = f.session, expiresAt?: string) =>
    resolve(pool, pool, session, f.taskId, {}, async (authority, client) => ({ authority,
      lease: await beginReviewSession(authority, { kind, expiresAt }, client) }))
  const leaseRow = async (id: string) => (await pool.query('SELECT * FROM coding_review_sessions WHERE id=$1', [id])).rows[0]
  const leaseTest = async (name: string, operation: () => Promise<void>) => t.test(name, async () => {
    // Every row belongs to this suite's throwaway database; no real gateway is issued.
    await pool.query('DELETE FROM coding_review_sessions')
    closeCalls.length = 0; failingKinds.clear()
    await operation()
  })

  await leaseTest('review lease is bounded, credential-bound, and reconnect never slides its deadline', async () => {
    const f = await fixture(), first = await grant(f), again = await grant(f)
    assert.deepEqual(again.lease, first.lease)
    const row = await leaseRow(first.lease.id)
    assert.ok(row.expiresAt.getTime() - row.createdAt.getTime() <= 300_000)
    const otherSession = await account(f.userId)
    await refused(grant(f, 'terminal', otherSession), 409, 'review_binding_changed')
    assert.equal((await readReviewSession(first.authority, { kind: 'terminal', id: first.lease.id }, pool))?.id, first.lease.id)
    const alternate = await read(f, otherSession)
    assert.equal(await readReviewSession(alternate, { kind: 'terminal' }, pool), null)
    assert.equal(await readReviewSession(first.authority, { kind: 'preview' }, pool), null)
    const shortened = new Date(Date.now() + 30_000).toISOString()
    assert.equal((await grant(f, 'terminal', f.session, shortened)).lease.expiresAt, shortened)
    assert.equal((await grant(f)).lease.expiresAt, shortened)
  })
  await leaseTest('lease creation cannot outlive its browser credential', async () => {
    const f = await fixture(), expiresAt = new Date(Date.now() + 40_000)
    await pool.query('UPDATE "session" SET "expiresAt"=$2 WHERE id=$1', [f.session.session.id, expiresAt])
    const current = await grant(f)
    assert.equal(current.lease.expiresAt, expiresAt.toISOString())
  })
  const parkedFixture = async () => {
    const f = await fixture()
    await pool.query(`UPDATE agent_runs SET status='succeeded',"leaseExpiresAt"=NULL,"finishedAt"=now(),report=$2 WHERE id=$1`,
      [f.runId, JSON.stringify({ safePoint: { session: 'exited', observedAt: new Date().toISOString() } })])
    await pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', [f.deviceTokenId])
    await pool.query(`UPDATE thread_machines SET state='paused',lifecycle='{"phase":"paused"}' WHERE "runId"=$1`, [f.runId])
    return f
  }
  await leaseTest('review resumes only its same parked VM without renewing an execution credential', async () => {
    const f = await parkedFixture(), current = await grant(f)
    let resumed = 0
    await resumeReviewMachine(current.authority, current.lease, undefined, { database: pool, resume: async (target, remaining) => {
      resumed++
      assert.equal(target.sandboxId, f.sandboxId)
      assert.equal(target.machineEpoch, current.authority.machineEpoch)
      assert.ok(remaining > 0 && remaining <= 300_000)
      const intent = (await pool.query('SELECT lifecycle,state FROM thread_machines WHERE "runId"=$1', [f.runId])).rows[0]
      assert.equal(intent.state, 'paused')
      assert.equal(intent.lifecycle.phase, 'review_resume_requested')
    } })
    assert.equal(resumed, 1)
    const machine = (await pool.query('SELECT * FROM thread_machines WHERE "runId"=$1', [f.runId])).rows[0]
    assert.equal(machine.state, 'running')
    assert.equal(machine.lifecycle.phase, 'review_resumed')
    assert.equal(machine.sandboxId, f.sandboxId)
    assert.equal(machine.epoch, current.authority.machineEpoch)
    assert.equal(machine.lifecycleAt.toISOString(), current.lease.expiresAt)
    assert.equal((await pool.query('SELECT status,"leaseExpiresAt" FROM agent_runs WHERE id=$1', [f.runId])).rows[0].status, 'succeeded')
    assert.ok((await pool.query('SELECT "revokedAt" FROM device_tokens WHERE id=$1', [f.deviceTokenId])).rows[0].revokedAt)
  })
  await leaseTest('a stop during provider resume defeats the final CAS and keeps the revoked lease for cleanup', async () => {
    const f = await parkedFixture(), current = await grant(f)
    await assert.rejects(resumeReviewMachine(current.authority, current.lease, undefined, { database: pool, resume: async () => {
      await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [f.runId])
    } }), error => error instanceof TerminalError && error.code === 'terminal_binding_changed')
    const machine = (await pool.query('SELECT state,lifecycle FROM thread_machines WHERE "runId"=$1', [f.runId])).rows[0]
    assert.equal(machine.state, 'paused')
    assert.equal(machine.lifecycle.phase, 'review_resume_failed')
    assert.ok((await leaseRow(current.lease.id)).revokedAt)
    assert.equal((await leaseRow(current.lease.id)).sandboxId, f.sandboxId)
  })
  await leaseTest('title, output, success and automatic parking do not revoke a review lease', async () => {
    const f = await fixture(), current = await grant(f)
    await pool.query('UPDATE issues SET title=\'Updated fixture\',content=\'{"type":"doc","content":[]}\',"updatedAt"=now() WHERE id=$1', [f.taskId])
    await pool.query('UPDATE agent_runs SET "updatedAt"=now(),report=\'{"syntheticOutput":"ordinary update"}\' WHERE id=$1', [f.runId])
    await pool.query('UPDATE agent_runs SET status=\'succeeded\',"leaseExpiresAt"=NULL,"finishedAt"=now(),report=$2 WHERE id=$1',
      [f.runId, JSON.stringify({ safePoint: { session: 'exited', observedAt: new Date().toISOString() } })])
    await pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', [f.deviceTokenId])
    await pool.query('UPDATE thread_machines SET state=\'paused\',lifecycle=\'{"phase":"paused"}\' WHERE "runId"=$1', [f.runId])
    assert.equal((await leaseRow(current.lease.id)).revokedAt, null)
    assert.equal((await readReviewSession(await read(f), { kind: 'terminal' }, pool))?.id, current.lease.id)
    assert.equal(closeCalls.length, 0)
  })
  const sourceFences: Array<[string, (f: Fixture) => Promise<unknown>]> = [
    ['session delete', f => pool.query('DELETE FROM "session" WHERE id=$1', [f.session.session.id])],
    ['session expiry shortening', f => pool.query('UPDATE "session" SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [f.session.session.id])],
    ['task closure', f => pool.query('UPDATE issues SET status=\'done\' WHERE id=$1', [f.taskId])],
    ['effective owner handoff', f => pool.query('UPDATE issues SET content=$2 WHERE id=$1', [f.taskId, JSON.stringify({ type: 'doc', attrs: { mikka: { assignee: { kind: 'member', id: f.peerId } } } })])],
    ['run stop', f => pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [f.runId])],
    ['machine epoch change', f => pool.query('UPDATE thread_machines SET epoch=epoch+1 WHERE "runId"=$1', [f.runId])],
    ['device disabled', f => pool.query('UPDATE devices SET enabled=false WHERE id=$1', [f.deviceId])],
    ['repository moved', f => pool.query('UPDATE device_repos SET "remoteUrl"=\'https://github.com/mikka-ci/changed.git\' WHERE id=$1', [f.repoId])],
    ['explicit device credential revoke', f => pool.query('UPDATE device_tokens SET "revokedAt"=now(),"revokedBy"=$2 WHERE id=$1', [f.deviceTokenId, f.userId])],
    ['run worktree change', f => pool.query('UPDATE agent_runs SET "worktreePath"=\'/home/user/other\' WHERE id=$1', [f.runId])],
  ]
  for (const [name, mutate] of sourceFences) await leaseTest(`durable source fence: ${name}`, async () => {
    const f = await fixture(), current = await grant(f)
    await mutate(f)
    const row = await leaseRow(current.lease.id)
    assert.ok(row.revokedAt)
    assert.ok(row.retryAt)
    assert.equal(row.sandboxId, f.sandboxId)
    assert.equal(await readReviewSession(current.authority, { kind: 'terminal' }, pool), null)
  })
  await leaseTest('PAT revocation fences only the exact credential and retains the close target', async () => {
    const f = await fixture(), id = randomUUID()
    await pool.query('INSERT INTO personal_access_tokens(id,"userId","workspaceId",name,"tokenHash",hint) VALUES($1,$2,$3,\'Review fixture\',$4,\'test\')',
      [id, f.userId, f.workspaceId, id.replaceAll('-', '').repeat(2)])
    const pat: ApiSession = { user: { ...f.session.user, [tokenWorkspace]: f.workspaceId }, session: { id: `pat:${id}` }, tokenWorkspaceId: f.workspaceId }
    const current = await grant(f, 'preview', pat)
    await pool.query('UPDATE personal_access_tokens SET "revokedAt"=now() WHERE id=$1', [id])
    assert.ok((await leaseRow(current.lease.id)).revokedAt)
    assert.deepEqual(await revokeReviewSession(current.authority, { kind: 'preview', id: current.lease.id }, pool), { closed: 1, pending: 0 })
    assert.deepEqual(closeCalls.map(call => call.kind), ['preview'])
    assert.equal(closeCalls[0]?.sandboxId, f.sandboxId)
  })
  await leaseTest('pending close survives transport failure and blocks replacement until exact ACK', async () => {
    const f = await fixture(), terminal = await grant(f), preview = await grant(f, 'preview')
    failingKinds.add('terminal')
    assert.deepEqual(await revokeReviewSessions(pool, { runIds: [f.runId] }, 'run_control'), { closed: 1, pending: 1 })
    const pending = await leaseRow(terminal.lease.id)
    assert.ok(pending.revokedAt)
    assert.ok(pending.retryAt.getTime() > Date.now())
    assert.equal(await leaseRow(preview.lease.id), undefined)
    await refused(grant(f), 409)
    assert.deepEqual(new Set(closeCalls.map(call => call.kind)), new Set(['terminal', 'preview']))
    for (const call of closeCalls) assert.deepEqual(call.ids, [call.kind === 'terminal' ? terminal.lease.id : preview.lease.id])
    failingKinds.clear()
    assert.deepEqual(await revokeReviewSessions(pool, { runIds: [f.runId] }, 'run_control'), { closed: 1, pending: 0 })
    assert.notEqual((await grant(f)).lease.id, terminal.lease.id)
  })
  await leaseTest('expiry closes only the due kind and never renews another kind', async () => {
    const f = await fixture(), terminal = await grant(f), preview = await grant(f, 'preview')
    await pool.query('UPDATE coding_review_sessions SET "createdAt"=now()-interval \'6 minutes\',"expiresAt"=now()-interval \'1 minute\' WHERE id=$1', [terminal.lease.id])
    assert.deepEqual(await expireReviewSessions(pool), { closed: 1, pending: 0 })
    assert.deepEqual(closeCalls.map(call => call.kind), ['terminal'])
    assert.equal((await leaseRow(preview.lease.id)).expiresAt.toISOString(), preview.lease.expiresAt)
  })
  await leaseTest('deleting a source preserves its remote-close target until acknowledged', async () => {
    const f = await fixture(), current = await grant(f)
    await pool.query('DELETE FROM agent_runs WHERE id=$1', [f.runId])
    const retained = await leaseRow(current.lease.id)
    assert.ok(retained.revokedAt)
    assert.equal(retained.sandboxId, f.sandboxId)
    assert.deepEqual(await revokeReviewSession(current.authority, { kind: 'terminal', id: current.lease.id }, pool), { closed: 1, pending: 0 })
    assert.equal(await leaseRow(current.lease.id), undefined)
  })
  await leaseTest('a new Run cannot commit ahead of a grant and then miss its revocation', async () => {
    const f = await fixture(), next = randomUUID()
    const insert = 'INSERT INTO agent_runs(id,"userId","agentId","issueId",status,"createdAt") VALUES($1,$2,$3,$4,\'queued\',now()+interval \'1 second\')'
    const values = [next, f.userId, f.agentId, f.taskId]
    const lease = await resolve(pool, pool, f.session, f.taskId, {}, async (authority, client) => {
      const opened = await beginReviewSession(authority, { kind: 'terminal' }, client)
      const contender = await pool.connect()
      try {
        await contender.query('BEGIN')
        await contender.query("SET LOCAL lock_timeout='100ms'")
        await assert.rejects(contender.query(insert, values), (error: unknown) => error instanceof Error && 'code' in error && error.code === '55P03')
      } finally { await contender.query('ROLLBACK'); contender.release() }
      return opened
    })
    await pool.query(insert, values)
    assert.ok((await leaseRow(lease.id)).revokedAt)
    await refused(read(f), 404, 'review_checkout_unavailable')
  })
  await leaseTest('another browser cannot deadlock logout while trying to acquire the same run', async () => {
    const f = await fixture(), current = await grant(f), other = await account(f.userId)
    const results = await Promise.allSettled([
      pool.query('DELETE FROM "session" WHERE id=$1', [f.session.session.id]), grant(f, 'terminal', other),
    ])
    assert.equal(results[0].status, 'fulfilled')
    assert.equal(results[1].status, 'rejected')
    if (results[1].status === 'rejected') assert.ok(results[1].reason instanceof ReviewAuthorityError && results[1].reason.status === 409)
    assert.ok((await leaseRow(current.lease.id)).revokedAt)
  })
  await leaseTest('a close acknowledgement only releases its own exact lease and binding', async () => {
    const f = await fixture(), terminal = await grant(f), preview = await grant(f, 'preview')
    await closeReviewSession(terminal.authority, { kind: 'terminal', id: preview.lease.id }, pool)
    assert.ok(await leaseRow(terminal.lease.id)); assert.ok(await leaseRow(preview.lease.id))
    await closeReviewSession(terminal.authority, { kind: 'terminal', id: terminal.lease.id }, pool)
    assert.equal(await leaseRow(terminal.lease.id), undefined)
    assert.ok(await leaseRow(preview.lease.id))
  })
  assert.equal(external, 0)
})
