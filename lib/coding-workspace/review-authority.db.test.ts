import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { Pool, type PoolClient } from 'pg'
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
  const checkout = async (userId: string, workspaceId: string, taskId: string, sponsored = false) => {
    const botId = await seedBot(pool, workspaceId, userId), agentId = await seedAgent(pool, userId)
    const deviceId = randomUUID(), repoId = randomUUID(), deviceTokenId = randomUUID(), runId = randomUUID()
    const remoteKey = 'v2/github.com/mikka-ci/review-fixture', sandboxId = sponsored ? 'a'.repeat(64) : `synthetic-${randomUUID()}`, worktreePath = sponsored ? `/workspace/worktrees/${runId}` : `/home/user/.mikka/worktrees/${runId}`
    await pool.query('INSERT INTO devices(id,"ownerId",name,kind,enabled,"lastSeenAt") VALUES($1,$2,\'Review fixture\',\'cloud\',true,now())', [deviceId, userId])
    await pool.query('INSERT INTO device_repos(id,"deviceId","userId","repoPath","remoteUrl") VALUES($1,$2,$3,$4,\'https://github.com/mikka-ci/review-fixture.git\')', [repoId, deviceId, userId, remoteKey])
    await pool.query('INSERT INTO device_tokens(id,"userId","tokenHash","boundDeviceId","boundWorkspaceId","expiresAt") VALUES($1::uuid,$2,$1::text,$3,$4,now()+interval \'1 hour\')', [deviceTokenId, userId, deviceId, workspaceId])
    const definition = { executionIdentity:{workspaceId, ...(sponsored ? {billingAccount:{runtime:{kind:'cloudflare_sponsored'}}} : {})},
      ...(sponsored ? {taskMachine:{provider:'cloudflare',payer:'mikka',ownerId:userId,workspaceId,taskId,botId,repositoryKey:remoteKey,
        requestEventId:randomUUID()},projectExecution:{repositoryKey:remoteKey}} : {}), repositoryAdmission: { workspaceId, userId, issueId: taskId, deviceId, agentId, remoteKey } }
    await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","botId","deviceId","deviceRepoId","deviceTokenId","agentDefinition",
      "machineAuthority",status,"worktreePath","leaseExpiresAt","startedAt","sessionId")
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true,'running',$10,now()+interval '5 minutes',now()-interval '1 minute','native-fixture')`,
    [runId, userId, taskId, agentId, botId, deviceId, repoId, deviceTokenId, JSON.stringify(definition), worktreePath])
    await pool.query('INSERT INTO computer_run_bindings("runId","botId","workspaceId","ownerId") VALUES($1,$2,$3,$4)', [runId, botId, workspaceId, userId])
    await pool.query(`INSERT INTO thread_machines("runId","workspaceId","ownerId","sandboxId","snapshotId","operationId",state,"deviceId","issueId","repoId","botId",epoch)
      VALUES($1,$2,$3,$4,$10,$5,'running',$6,$7,$8,$9,1)`, [runId, workspaceId, userId, sandboxId, randomUUID(), deviceId, taskId, repoId, botId, sponsored ? 'cloudflare-task-v1':'synthetic'])
    return { botId, agentId, deviceId, repoId, deviceTokenId, runId, remoteKey, sandboxId, worktreePath, definition }
  }
  const fixture = async (sponsored = false) => {
    const userId = await seedUser(pool, 'review-owner'), peerId = await seedUser(pool, 'review-peer'), strangerId = await seedUser(pool, 'review-other')
    const { id: workspaceId } = await seedWorkspace(pool, userId, [{ userId, role: 'admin' }, { userId: peerId, role: 'member' }])
    const { id: otherWorkspaceId } = await seedWorkspace(pool, userId, [{ userId, role: 'admin' }])
    const { id: teamId } = await seedTeam(pool, workspaceId, userId)
    await pool.query('INSERT INTO mikka_team_members("teamId","userId",role) VALUES($1,$2,\'member\')', [teamId, peerId])
    const taskId = randomUUID()
    await pool.query('INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority,scope) VALUES($1,$2,$3,\'Review fixture\',\'{"type":"doc"}\',\'doing\',\'normal\',\'workspace\')', [taskId, userId, workspaceId])
    await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [taskId, teamId, workspaceId, userId])
    return { userId, peerId, strangerId, workspaceId, otherWorkspaceId, teamId, taskId, ...await checkout(userId, workspaceId, taskId, sponsored),
      session: await account(userId), peer: await account(peerId), stranger: await account(strangerId) }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const assign = (f: Fixture, userId: string) => pool.query('UPDATE issues SET content=$2 WHERE id=$1',
    [f.taskId, JSON.stringify({ type: 'doc', attrs: { mikka: { assignee: { kind: 'member', id: userId, name: userId, image: null } } } })])
  const read = (f: Fixture, session = f.session, expected = {}) => resolve(pool, pool, session, f.taskId, expected)
  const refused = (operation: Promise<unknown>, status: number, code?: string) => assert.rejects(operation, error => error instanceof ReviewAuthorityError && error.status === status && (!code || error.code === code))
  // Model inconsistent historical rows that predate immutable stored tenancy.
  // Only the corresponding write-time trigger is suspended in this owned throwaway DB;
  // review source fences, SQL reads/locks and every authorization check remain
  // real. Ordinary production writes are separately asserted to reject drift.
  const legacyWrite = async (table: 'issues' | 'agent_runs' | 'mikka_team_issues', query: string, values: unknown[]) => {
    const trigger = { issues: 'preserve_task_workspace', agent_runs: 'require_run_task_workspace',
      mikka_team_issues: 'check_active_team_relation' }[table]
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`)
      await client.query(query, values)
      await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)
      await client.query('COMMIT')
    } finally { await client.query('ROLLBACK'); client.release() }
  }

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
  await t.test('sponsor review uses the frozen platform and repository, with distinct guest leases in one human operation',async()=>{
    const f=await fixture(true), previous=[process.env.MIKKA_CLOUDFLARE_TASK_WORKSPACES,process.env.MIKKA_TASK_MACHINE_BRIDGE_TOKEN]
    process.env.MIKKA_CLOUDFLARE_TASK_WORKSPACES=f.workspaceId
    process.env.MIKKA_TASK_MACHINE_BRIDGE_TOKEN='synthetic-fixture-only'
    try {
      const {beginReviewSession}=await import('./review-sessions')
      const a=await read(f)
      assert.deepEqual(a.sponsoredPlacement,{operationId:a.machineOperationId,repositoryKey:f.remoteKey})
      const open=(kind:'terminal'|'preview')=>resolve(pool,pool,f.session,f.taskId,{},(scope,client)=>beginReviewSession(scope,{kind},client))
      const terminal=await open('terminal'),preview=await open('preview')
      assert.ok(terminal.reviewOperationId)
      assert.equal(terminal.reviewOperationId,preview.reviewOperationId)
      assert.notEqual(terminal.id,preview.id)
      assert.notEqual(terminal.reviewOperationId,a.machineOperationId)
      const {rows}=await pool.query('SELECT provider,"repositoryKey","reviewOperationId" FROM coding_review_sessions WHERE "runId"=$1',[f.runId])
      assert.equal(rows.length,2)
      assert.ok(rows.every(row=>row.provider==='cloudflare' && row.repositoryKey===f.remoteKey && row.reviewOperationId===terminal.reviewOperationId))
      await refused(read(f,f.peer),403,'not_owner_terminal')
      await pool.query('UPDATE thread_machines SET "snapshotId"=$2 WHERE "runId"=$1',[f.runId,'synthetic'])
      await refused(read(f),403,'review_scope_denied')
    } finally {
      for(const [i,key] of ['MIKKA_CLOUDFLARE_TASK_WORKSPACES','MIKKA_TASK_MACHINE_BRIDGE_TOKEN'].entries())
        if(previous[i] === undefined) delete process.env[key]; else process.env[key]=previous[i]
    }
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
  await t.test('a human assignee with a new owned Run can review without taking the creator checkout', async () => {
    const f = await fixture(), before = await read(f)
    await assign(f, f.peerId)
    const next = await checkout(f.peerId, f.workspaceId, f.taskId), authority = await read(f, f.peer)
    assert.deepEqual([authority.taskId, authority.userId, authority.ownerId, authority.workspaceId, authority.runId,
      authority.deviceId, authority.repoId, authority.deviceTokenId, authority.sandboxId, authority.worktreePath],
    [f.taskId, f.peerId, f.peerId, f.workspaceId, next.runId, next.deviceId, next.repoId, next.deviceTokenId, next.sandboxId, next.worktreePath])
    assert.deepEqual(authority.credential, { kind: 'session', id: f.peer.session.id })
    assert.notEqual(authority.bindingId, before.bindingId)
    await refused(read(f), 403, 'not_owner_terminal')
    await refused(read(f, f.peer, { runId: before.runId, bindingId: before.bindingId }), 409, 'review_binding_changed')
    const { rows } = await pool.query(`SELECT r."userId" AS "runOwner",r."workspaceId",r."agentDefinition",r."worktreePath",
      d."ownerId" AS "deviceOwner",p."userId" AS "repoOwner",t."userId" AS "tokenOwner",
      c."ownerId" AS "bindingOwner",m."ownerId" AS "machineOwner",m."sandboxId"
      FROM agent_runs r JOIN devices d ON d.id=r."deviceId" JOIN device_repos p ON p.id=r."deviceRepoId"
      JOIN device_tokens t ON t.id=r."deviceTokenId" JOIN computer_run_bindings c ON c."runId"=r.id
      JOIN thread_machines m ON m."runId"=r.id WHERE r.id=$1`, [f.runId])
    assert.deepEqual(rows, [{ runOwner: f.userId, workspaceId: f.workspaceId, agentDefinition: f.definition, worktreePath: f.worktreePath,
      deviceOwner: f.userId, repoOwner: f.userId, tokenOwner: f.userId, bindingOwner: f.userId, machineOwner: f.userId, sandboxId: f.sandboxId }])
  })
  await t.test('returning assignment to the creator cannot fall back past the newest Run of another owner', async () => {
    const f = await fixture(), before = await read(f)
    await assign(f, f.peerId)
    const next = await checkout(f.peerId, f.workspaceId, f.taskId)
    assert.equal((await read(f, f.peer)).runId, next.runId, 'the new owner has a usable physical checkout')
    await assign(f, f.userId)
    const { rows } = await pool.query('SELECT id FROM agent_runs WHERE "issueId"=$1 ORDER BY "createdAt" DESC,id DESC', [f.taskId])
    assert.deepEqual(rows.map(row => row.id), [next.runId, f.runId])
    await refused(read(f), 403, 'not_owner_terminal')
    await refused(read(f, f.session, { runId: before.runId, bindingId: before.bindingId }), 403, 'not_owner_terminal')
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
  await t.test('stored Task tenancy authorizes an ungrouped task and refuses immutable transfer', async () => {
    const f = await fixture()
    await pool.query('DELETE FROM mikka_team_issues WHERE "issueId"=$1', [f.taskId])
    assert.equal((await read(f)).workspaceId, f.workspaceId)
    await assert.rejects(pool.query('UPDATE issues SET "workspaceId"=$2 WHERE id=$1', [f.taskId, f.otherWorkspaceId]),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === '23514')
    assert.equal((await read(f)).workspaceId, f.workspaceId)
  })
  await t.test('a historical cross-workspace Task cannot borrow its old Run or machine authority', async () => {
    const f = await fixture()
    await pool.query('DELETE FROM mikka_team_issues WHERE "issueId"=$1', [f.taskId])
    await legacyWrite('issues', 'UPDATE issues SET "workspaceId"=$2 WHERE id=$1', [f.taskId, f.otherWorkspaceId])
    await refused(read(f), 404, 'review_not_found')
  })
  await t.test('quarantined pending Task ownership is unavailable even with a retained physical checkout', async () => {
    const f = await fixture()
    await legacyWrite('issues', 'UPDATE issues SET "workspaceId"=NULL,"ownershipState"=\'pending\' WHERE id=$1', [f.taskId])
    await refused(read(f), 404, 'review_not_found')
  })
  for (const missing of [false, true]) await t.test(`a ${missing ? 'missing' : 'foreign'} stored Run workspace cannot fall back to its frozen claim`, async () => {
    const f = await fixture()
    await legacyWrite('agent_runs', 'UPDATE agent_runs SET "workspaceId"=$2 WHERE id=$1', [f.runId, missing ? null : f.otherWorkspaceId])
    await refused(read(f), 403, 'review_scope_denied')
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
    await refused(read(f), 404, 'review_not_found')
    await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [f.workspaceId, f.userId])
    await assert.rejects(pool.query('UPDATE mikka_team_issues SET "workspaceId"=$2 WHERE "issueId"=$1', [f.taskId, f.otherWorkspaceId]),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === '23514')
    assert.equal((await read(f)).workspaceId, f.workspaceId, 'a rejected relation write preserves the current tenant')
    await legacyWrite('mikka_team_issues', 'UPDATE mikka_team_issues SET "workspaceId"=$2 WHERE "issueId"=$1', [f.taskId, f.otherWorkspaceId])
    await refused(read(f), 403)
  })
  const mutations: Array<[string, (f: Fixture) => Promise<unknown>, number]> = [
    ['frozen Workspace mismatch', f => legacyWrite('agent_runs', 'UPDATE agent_runs SET "agentDefinition"=jsonb_set("agentDefinition",\'{executionIdentity,workspaceId}\',to_jsonb($2::text)) WHERE id=$1', [f.runId, f.otherWorkspaceId]), 403],
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
    revokeReviewSessions, reconcileReviewSessions, expireReviewSessions, reviewSessionTransport } = await import('./review-sessions')
  const { resumeReviewMachine } = await import('./review-machine')
  const { TerminalError } = await import('@mikka/protocol/coding-terminal')
  type Kind = 'terminal' | 'preview'
  const closeCalls: Array<{ kind: Kind; ids: string[]; sandboxId: string; expiresAt: string }> = []
  const failingKinds = new Set<Kind>()
  let beforeClose: (() => Promise<void>) | undefined
  t.mock.method(reviewSessionTransport, 'close', async (...[target, ids, expiresAt, kind]: Parameters<typeof reviewSessionTransport.close>) => {
    const pending = await pool.query('SELECT "revokedAt" FROM coding_review_sessions WHERE id=ANY($1::uuid[])', [ids])
    assert.equal(pending.rowCount, ids.length)
    assert.ok(pending.rows.every(row => row.revokedAt), 'durable fence precedes any network operation')
    await beforeClose?.()
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
    closeCalls.length = 0; failingKinds.clear(); beforeClose = undefined
    await operation()
  })
  const waitForBlockedGrant = async (writerPid: number) => {
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      const { rows: [state] } = await pool.query<{ blocked: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked`, [writerPid])
      if (state?.blocked) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.fail('the real review operation did not reach the held database row lock')
  }

  const { latestTaskRun } = await import('../thread-dispatch')
  type FactoryStage = 'spec' | 'execute' | 'review' | 'verify' | 'monitor'
  // The real persisted queue/configure/bind order, with no provider or model.
  // Actual Store.bind_run authorization and its commit notification have
  // additional coverage below; this helper isolates the SQL source trigger.
  const pendingRun = async (client: PoolClient, f: Fixture, options: {
    stage?: FactoryStage; kind?: string; createdAt?: Date; readOnly?: boolean;
  } = {}) => {
    const id = randomUUID(), taskId = randomUUID(), attemptId = randomUUID()
    if (options.stage) {
      await client.query(`INSERT INTO factory_tasks(id,"userId","issueId","sourceEventId",route,stage,status,"attemptId",reason)
        VALUES($1,$2,$3,$4,'{}',$5,'pending',$6,'Review selection fixture')`,
      [taskId, f.userId, f.taskId, randomUUID(), options.stage, attemptId])
      await client.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,reason)
        VALUES($1,$2,$3,1,1,'pending','Review selection fixture')`, [attemptId, taskId, options.stage])
    }
    await client.query(`INSERT INTO agent_runs(id,"userId","agentId","issueId",status,kind,"createdAt","agentDefinition")
      VALUES($1,$2,$3,$4,'queued',$5,$6,$7)`,
    [id, f.userId, f.agentId, f.taskId, options.kind ?? 'implement', options.createdAt ?? new Date(Date.now() + 1_000),
      JSON.stringify({ readOnly: options.readOnly ?? false })])
    return { id, taskId, attemptId, bind: async () => {
      if (!options.stage) return
      await client.query('UPDATE agent_runs SET kind=$2 WHERE id=$1', [id,
        options.stage === 'spec' ? 'plan' : options.stage === 'execute' ? 'implement' : 'acceptance'])
      await client.query('UPDATE factory_attempts SET "runId"=$2 WHERE id=$1', [attemptId, id])
    } }
  }
  for (const stage of ['review', 'verify', 'monitor'] as const) await leaseTest(`a committed Factory ${stage} never replaces or revokes the Task executor`, async () => {
    const f = await fixture(), current = await grant(f), preview = await grant(f, 'preview'), client = await pool.connect()
    try {
      await client.query('BEGIN')
      const check = await pendingRun(client, f, { stage })
      assert.equal((await client.query('SELECT "revokedAt" FROM coding_review_sessions WHERE id=$1', [current.lease.id])).rows[0].revokedAt, null,
        'INSERT alone cannot classify a run before its Factory binding')
      await check.bind()
      await client.query('COMMIT')
      assert.equal((await latestTaskRun(pool, f.userId, f.taskId))?.id, f.runId)
      assert.equal((await read(f)).runId, f.runId)
      assert.equal((await leaseRow(current.lease.id)).revokedAt, null)
      assert.equal((await leaseRow(preview.lease.id)).revokedAt, null)
      assert.deepEqual(await reconcileReviewSessions(pool, { taskId: f.taskId }), { closed: 0, pending: 0 })
      assert.equal(closeCalls.length, 0)
    } finally { await client.query('ROLLBACK'); client.release() }
  })
  await leaseTest('a group chat is outside the Task review surface', async () => {
    const f = await fixture(), current = await grant(f), client = await pool.connect()
    try {
      await client.query('BEGIN'); await pendingRun(client, f, { kind: 'group_chat' }); await client.query('COMMIT')
      assert.equal((await latestTaskRun(pool, f.userId, f.taskId))?.id, f.runId)
      assert.equal((await read(f)).runId, f.runId)
      assert.equal((await leaseRow(current.lease.id)).revokedAt, null)
      assert.deepEqual(await reconcileReviewSessions(pool, { taskId: f.taskId }), { closed: 0, pending: 0 })
    } finally { await client.query('ROLLBACK'); client.release() }
  })
  for (const stage of ['spec', 'execute', undefined] as const) await leaseTest(`a real ${stage ?? 'unbound read-only'} Task run fences the old surface at COMMIT`, async () => {
    const f = await fixture(), current = await grant(f), client = await pool.connect()
    try {
      await client.query('BEGIN')
      const next = await pendingRun(client, f, { stage, readOnly: true })
      await next.bind()
      assert.equal((await client.query('SELECT "revokedAt" FROM coding_review_sessions WHERE id=$1', [current.lease.id])).rows[0].revokedAt, null,
        'the deferred fence does not publish a transaction that might roll back')
      assert.equal((await latestTaskRun(pool, f.userId, f.taskId))?.id, f.runId)
      await client.query('COMMIT')
      assert.ok((await leaseRow(current.lease.id)).revokedAt)
      assert.equal((await latestTaskRun(pool, f.userId, f.taskId))?.id, next.id)
      await refused(read(f, f.session, { runId: f.runId }), 409, 'review_binding_changed')
      await refused(read(f), 404, 'review_checkout_unavailable')
    } finally { await client.query('ROLLBACK'); client.release() }
  })
  await leaseTest('multiple inserts use final Factory bindings and the final Task ordering', async () => {
    const f = await fixture(), current = await grant(f), client = await pool.connect(), base = Date.now()
    try {
      await client.query('BEGIN')
      const review = await pendingRun(client, f, { stage: 'review', createdAt: new Date(base + 1_000) })
      const execute = await pendingRun(client, f, { stage: 'execute', createdAt: new Date(base + 2_000) })
      const monitor = await pendingRun(client, f, { stage: 'monitor', createdAt: new Date(base + 3_000) })
      await review.bind(); await execute.bind(); await monitor.bind()
      assert.equal((await client.query('SELECT "revokedAt" FROM coding_review_sessions WHERE id=$1', [current.lease.id])).rows[0].revokedAt, null)
      await client.query('COMMIT')
      assert.ok((await leaseRow(current.lease.id)).revokedAt)
      assert.equal((await latestTaskRun(pool, f.userId, f.taskId))?.id, execute.id)
    } finally { await client.query('ROLLBACK'); client.release() }
  })
  await leaseTest('a rolled-back queue and bind leave the original lease and selection intact', async () => {
    const f = await fixture(), current = await grant(f), client = await pool.connect()
    try {
      await client.query('BEGIN')
      const next = await pendingRun(client, f, { stage: 'execute' }); await next.bind()
      await client.query('ROLLBACK')
      assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE id=$1', [next.id])).rowCount, 0)
      assert.equal((await leaseRow(current.lease.id)).revokedAt, null)
      assert.equal((await read(f)).runId, f.runId)
    } finally { await client.query('ROLLBACK'); client.release() }
  })
  await leaseTest('older history and an insert deleted before COMMIT do not replace the executor', async () => {
    const f = await fixture(), current = await grant(f), client = await pool.connect()
    const created = (await pool.query<{ createdAt: Date }>('SELECT "createdAt" FROM agent_runs WHERE id=$1', [f.runId])).rows[0]!.createdAt
    try {
      await client.query('BEGIN')
      const old = await pendingRun(client, f, { stage: 'execute', createdAt: new Date(created.getTime() - 60_000) }); await old.bind()
      const removed = await pendingRun(client, f)
      await client.query('DELETE FROM agent_runs WHERE id=$1', [removed.id])
      await client.query('COMMIT')
      assert.equal((await leaseRow(current.lease.id)).revokedAt, null)
      assert.equal((await read(f)).runId, f.runId)
    } finally { await client.query('ROLLBACK'); client.release() }
  })

  // Exercise the actual Store, current membership, source and Run ownership.
  // Only the request scheduler and remote close ACK are replaced. No model,
  // provider, mock authorization or SQL fixture answers participate.
  const { observePoolCommits } = await import('../db/commit-effects')
  observePoolCommits(pool)
  const { createFactoryStore } = await import('../factory/store')
  const { factoryCheckIndependent } = await import('../factory/check-independence')
  const { factoryAuthorize } = await import('../factory/authorize')
  const { actAs } = await import('../acting-user')
  const { withTaskWorkspace } = await import('../task-workspace')
  const background = await import('../background')
  const reviewJobs: Array<() => unknown> = []
  t.mock.module(new URL('../background.ts', import.meta.url).href, { namedExports: { ...background,
    afterJob: (...[label, work]: Parameters<typeof background.afterJob>) => {
      if (label === 'after:device-wake') reviewJobs.push(work)
    },
  } })
  const queuedReviewJob = async () => {
    const deadline = Date.now() + 3_000
    while (reviewJobs.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(reviewJobs.length, 1, 'one exact-run wake follows the committed binding')
    await reviewJobs.shift()!()
  }
  const checkerBinding = async (f: Fixture, stage: 'review' | 'verify' | 'monitor') => {
    const taskId = randomUUID(), attemptId = randomUUID(), eventId = randomUUID(), client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload)
        VALUES($1::uuid,$2,$3,$4,'user_message',$1::text,'{"text":"Review binding fixture"}')`, [eventId, f.userId, f.botId, f.taskId])
      await client.query(`INSERT INTO factory_tasks(id,"userId","botId","issueId","sourceEventId",route,stage,status,"attemptId",reason,"scopeVersion")
        SELECT $1,$2,$3,id,$4,'{}',$5,'pending',$6,'Review binding fixture',"scopeVersion" FROM issues WHERE id=$7`,
      [taskId, f.userId, f.botId, eventId, stage, attemptId, f.taskId])
      await client.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,reason)
        VALUES($1,$2,$3,1,1,'pending','Review binding fixture')`, [attemptId, taskId, stage])
      await client.query('COMMIT')
    } finally { await client.query('ROLLBACK'); client.release() }
    // Like the normal dispatch Store, opt into lifecycle transitions. Omitting
    // this host configuration intentionally leaves bind_run unavailable.
    const store = createFactoryStore(pool, factoryAuthorize, f.botId, { independent: factoryCheckIndependent })
    return { taskId, attemptId, bind: (tx: PoolClient) => actAs({ id: f.userId, [tokenWorkspace]: f.workspaceId }, () =>
      store.apply(f.userId, { taskId, revision: 1 }, randomUUID(), { action: 'bind_run', runId: f.runId }, tx)) }
  }
  await leaseTest('late Store.bind_run fences only its checker and schedules close outside APP and Workspace locks', async () => {
    const f = await fixture(), unrelated = await fixture()
    await pool.query('UPDATE agent_runs SET kind=\'acceptance\' WHERE id=$1', [f.runId])
    const current = await grant(f, 'preview'), other = await grant(unrelated, 'preview'), binding = await checkerBinding(f, 'review')
    const reader = { id: f.userId, [tokenWorkspace]: f.workspaceId }
    reviewJobs.length = 0
    beforeClose = async () => {
      const probe = await pool.connect()
      try {
        await probe.query('BEGIN')
        await probe.query('SELECT id FROM mikka_workspaces WHERE id=$1 FOR UPDATE NOWAIT', [f.workspaceId])
        await probe.query('SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 FOR UPDATE NOWAIT', [f.workspaceId, f.userId])
        await probe.query('SELECT "runId" FROM thread_machines WHERE "runId"=$1 FOR UPDATE NOWAIT', [f.runId])
      } finally { await probe.query('ROLLBACK'); probe.release() }
    }
    await withTaskWorkspace(reader, f.workspaceId, async () => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('UPDATE factory_attempts SET output=\'{"ordinary":"progress"}\',status=\'running\' WHERE id=$1', [binding.attemptId])
        assert.equal((await leaseRow(current.lease.id)).revokedAt, null, 'ordinary checker progress adds no source fence')
        const result = await binding.bind(client)
        assert.equal(result.task.status, 'running')
        assert.ok((await client.query('SELECT "revokedAt" FROM coding_review_sessions WHERE id=$1', [current.lease.id])).rows[0].revokedAt)
        assert.equal((await leaseRow(current.lease.id)).revokedAt, null, 'uncommitted fence is not externally published')
        assert.equal(reviewJobs.length, 0)
        await client.query('COMMIT')
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(reviewJobs.length, 0, 'APP commit must still wait for the captured outer Workspace executor')
        assert.equal(closeCalls.length, 0)
      } finally { await client.query('ROLLBACK'); client.release() }
    })
    await queuedReviewJob()
    assert.deepEqual(closeCalls.map(call => call.ids), [[current.lease.id]])
    assert.equal(await leaseRow(current.lease.id), undefined)
    assert.equal((await leaseRow(other.lease.id)).revokedAt, null)
    assert.equal(await latestTaskRun(pool, f.userId, f.taskId), null)
    await refused(read(f), 404, 'review_not_found')
  })
  await leaseTest('a rolled-back late Store binding retains the lease and emits no close', async () => {
    const f = await fixture()
    await pool.query('UPDATE agent_runs SET kind=\'acceptance\' WHERE id=$1', [f.runId])
    const current = await grant(f, 'preview'), binding = await checkerBinding(f, 'verify'), client = await pool.connect()
    reviewJobs.length = 0
    try {
      await client.query('BEGIN'); await binding.bind(client)
      assert.ok((await client.query('SELECT "revokedAt" FROM coding_review_sessions WHERE id=$1', [current.lease.id])).rows[0].revokedAt)
      await client.query('ROLLBACK')
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(reviewJobs.length, 0); assert.equal(closeCalls.length, 0)
      assert.equal((await leaseRow(current.lease.id)).revokedAt, null)
      assert.equal((await pool.query('SELECT "runId" FROM factory_attempts WHERE id=$1', [binding.attemptId])).rows[0].runId, null)
      assert.equal((await read(f)).runId, f.runId)
    } finally { await client.query('ROLLBACK'); client.release() }
  })
  await leaseTest('an outer Workspace rollback leaves a committed checker fence for the existing due owner', async () => {
    const f = await fixture()
    await pool.query('UPDATE agent_runs SET kind=\'acceptance\' WHERE id=$1', [f.runId])
    const current = await grant(f, 'preview'), binding = await checkerBinding(f, 'review'), failure = new Error('fixture outer rollback')
    reviewJobs.length = 0
    await assert.rejects(withTaskWorkspace({ id: f.userId, [tokenWorkspace]: f.workspaceId }, f.workspaceId, async () => {
      const client = await pool.connect()
      try { await client.query('BEGIN'); await binding.bind(client); await client.query('COMMIT') }
      finally { await client.query('ROLLBACK'); client.release() }
      throw failure
    }), error => error === failure)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(reviewJobs.length, 0); assert.equal(closeCalls.length, 0)
    assert.ok((await leaseRow(current.lease.id)).revokedAt)
    assert.ok((await pool.query('SELECT "lifecycleAt"<=clock_timestamp() AS due FROM thread_machines WHERE "runId"=$1', [f.runId])).rows[0].due)
    assert.deepEqual(await expireReviewSessions(pool), { closed: 1, pending: 0 })
    assert.deepEqual(closeCalls.map(call => call.ids), [[current.lease.id]])
  })
  await leaseTest('late binding waits for a real concurrent grant then fences that committed capability', async () => {
    const f = await fixture()
    await pool.query('UPDATE agent_runs SET kind=\'acceptance\' WHERE id=$1', [f.runId])
    const binding = await checkerBinding(f, 'verify'), entered = Promise.withResolvers<number>(), finish = Promise.withResolvers<void>()
    reviewJobs.length = 0
    const granting = resolve(pool, pool, f.session, f.taskId, {}, async (authority, client) => {
      entered.resolve((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid)
      await finish.promise
      return beginReviewSession(authority, { kind: 'preview' }, client)
    })
    void granting.catch(error => entered.reject(error))
    // Join failures immediately so a failed fixture cannot leave a hidden
    // rejection or a client waiting for a gate that its owner never releases.
    const granted = Promise.allSettled([granting])
    let bindingResult: Promise<PromiseSettledResult<unknown>[]> | undefined
    try {
      const grantPid = await entered.promise
      bindingResult = Promise.allSettled([withTaskWorkspace({ id: f.userId, [tokenWorkspace]: f.workspaceId }, f.workspaceId, async () => {
        const client = await pool.connect()
        try { await client.query('BEGIN'); await binding.bind(client); await client.query('COMMIT') }
        finally { await client.query('ROLLBACK'); client.release() }
      })])
      await waitForBlockedGrant(grantPid)
      finish.resolve()
      const [issued] = await granted, [bound] = await bindingResult
      assert.equal(issued.status, 'fulfilled'); assert.equal(bound.status, 'fulfilled')
      if (issued.status !== 'fulfilled') return
      assert.ok((await leaseRow(issued.value.id)).revokedAt)
      await queuedReviewJob()
      assert.deepEqual(closeCalls.map(call => call.ids), [[issued.value.id]])
      assert.equal(await leaseRow(issued.value.id), undefined)
    } finally { finish.resolve(); await granted; if (bindingResult) await bindingResult }
  })
  await leaseTest('a reader waiting on Run SHARE rechecks a committed late checker binding after the lock', async () => {
    const f = await fixture()
    await pool.query('UPDATE agent_runs SET kind=\'acceptance\' WHERE id=$1', [f.runId])
    const binding = await checkerBinding(f, 'monitor'), writer = await pool.connect()
    let pending: Promise<PromiseSettledResult<Awaited<ReturnType<typeof read>>>[]> | undefined
    reviewJobs.length = 0
    try {
      await writer.query('BEGIN')
      const pid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      await writer.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE', [f.runId])
      pending = Promise.allSettled([read(f)])
      await waitForBlockedGrant(pid)
      await binding.bind(writer)
      await writer.query('COMMIT')
      const [result] = await pending
      assert.equal(result.status, 'rejected')
      if (result.status === 'rejected') assert.ok(result.reason instanceof ReviewAuthorityError && result.reason.status === 409
        && result.reason.code === 'review_binding_changed', 'the pre-lock statement snapshot cannot admit the newly classified checker')
      await queuedReviewJob()
      assert.equal(closeCalls.length, 0)
      assert.equal((await pool.query('SELECT 1 FROM coding_review_sessions WHERE "runId"=$1', [f.runId])).rowCount, 0)
    } finally { await writer.query('ROLLBACK'); writer.release(); if (pending) await pending }
  })

  await leaseTest('Workspace/member precede the shared relation fence when a real grant waits for an admin writer', async () => {
    const f = await fixture(), writer = await pool.connect()
    await pool.query('DELETE FROM mikka_team_issues WHERE "issueId"=$1', [f.taskId])
    let pending: Promise<PromiseSettledResult<Awaited<ReturnType<typeof grant>>>[]> | undefined
    try {
      await writer.query('BEGIN')
      await writer.query('SELECT id FROM mikka_workspaces WHERE id=$1 FOR UPDATE', [f.workspaceId])
      await writer.query('SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 FOR UPDATE', [f.workspaceId, f.userId])
      const pid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      pending = Promise.allSettled([grant(f)])
      await waitForBlockedGrant(pid)
      assert.equal((await writer.query("SELECT pg_try_advisory_xact_lock(hashtextextended('mikka-team-relations',0)) AS acquired")).rows[0].acquired, true,
        'a grant waiting for Workspace cannot already own the relation lock')
      await writer.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [f.taskId, f.teamId, f.workspaceId, f.userId])
      await writer.query('COMMIT')
    } finally { await writer.query('ROLLBACK'); writer.release() }
    const [result] = await pending!
    assert.equal(result!.status, 'fulfilled')
    if (result!.status === 'fulfilled') {
      assert.equal(result.value.authority.workspaceId, f.workspaceId)
      assert.equal((await leaseRow(result.value.lease.id)).revokedAt, null)
    }
  })
  for (const quarantine of [false, true]) await leaseTest(`the final Task lock refuses ${quarantine ? 'quarantine' : 'a stored tenant change'} committed while admission waits`, async () => {
    const f = await fixture(), writer = await pool.connect()
    let pending: Promise<PromiseSettledResult<Awaited<ReturnType<typeof grant>>>[]> | undefined
    try {
      await writer.query('BEGIN')
      await writer.query('SELECT id FROM mikka_workspaces WHERE id=$1 FOR UPDATE', [f.workspaceId])
      const pid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      pending = Promise.allSettled([grant(f)])
      await waitForBlockedGrant(pid)
      await legacyWrite('issues', 'UPDATE issues SET "workspaceId"=$2,"ownershipState"=$3 WHERE id=$1',
        [f.taskId, quarantine ? null : f.otherWorkspaceId, quarantine ? 'pending' : 'bound'])
    } finally { await writer.query('ROLLBACK'); writer.release() }
    const [result] = await pending!
    assert.equal(result!.status, 'rejected')
    if (result!.status === 'rejected') assert.ok(result.reason instanceof ReviewAuthorityError && result.reason.code === 'review_scope_denied')
    assert.equal((await pool.query('SELECT 1 FROM coding_review_sessions WHERE "taskId"=$1', [f.taskId])).rowCount, 0)
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
    await pool.query('UPDATE issues SET "workspaceId"="workspaceId","ownershipState"=\'bound\',"linearSyncPolicy"=\'disabled\' WHERE id=$1', [f.taskId])
    await pool.query('UPDATE agent_runs SET "workspaceId"="workspaceId" WHERE id=$1', [f.runId])
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
    ['historical stored Task workspace change', f => legacyWrite('issues', 'UPDATE issues SET "workspaceId"=$2 WHERE id=$1', [f.taskId, f.otherWorkspaceId])],
    ['Task ownership quarantine', f => legacyWrite('issues', 'UPDATE issues SET "workspaceId"=NULL,"ownershipState"=\'pending\' WHERE id=$1', [f.taskId])],
    ['historical stored Run workspace change', f => legacyWrite('agent_runs', 'UPDATE agent_runs SET "workspaceId"=$2 WHERE id=$1', [f.runId, f.otherWorkspaceId])],
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
