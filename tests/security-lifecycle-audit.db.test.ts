import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedBot, seedTeam, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { CredentialStore } from '../lib/credentials/store'
import { AgentToolApprovalStore } from '../lib/agent-tool-approval/store'

// Actual business/audit transactions and current-scope membership guards. KMS
// and the authenticated caller's identity are explicit fixture ports, not SaaS.
test('credential lifecycle and Agent approval audit commit with their actual protected transitions', { skip: !dbUrl }, async t => {
  const database = new Pool({ connectionString: dbUrl, max: 8 })
  const previousSecret = process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('hex')
  t.after(async () => {
    if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = previousSecret
    await database.end(); await (await import('../lib/db')).pool.end(); await (await import('../lib/workspace-db')).workspacePool.end()
  })
  const owner = await seedUser(database, 'security-audit-owner'), peer = await seedUser(database, 'security-audit-peer')
  const a = await seedWorkspace(database, owner, [{ userId: owner, role: 'admin' }])
  const b = await seedWorkspace(database, owner, [{ userId: owner, role: 'admin' }])
  const team = await seedTeam(database, b.id, owner), issueId = randomUUID(), botId = await seedBot(database, a.id, owner)
  await database.query('INSERT INTO issues(id,"userId",title,content,status,priority,scope) VALUES($1,$2,\'Audit fixture\',\'{"type":"doc"}\',\'doing\',\'normal\',\'workspace\')', [issueId, owner])
  await database.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [issueId, team.id, b.id, owner])
  const deviceId = randomUUID(), agentId = randomUUID(), runId = randomUUID()
  await database.query('INSERT INTO devices(id,"ownerId",name,enabled,kind) VALUES($1,$2,\'Audit device\',true,\'local\')', [deviceId, owner])
  await database.query('INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,\'Audit agent\',\'codex\',$3)', [agentId, owner, deviceId])
  await database.query('INSERT INTO agent_runs(id,"userId","issueId","botId","agentId","deviceId",status,"leaseExpiresAt") VALUES($1,$2,$3,$4,$5,$6,\'running\',now()+interval \'5 minutes\')', [runId, owner, issueId, botId, agentId, deviceId])
  const userActor = { type: 'user' as const, id: owner, name: 'Verified fixture user' }
  const caller = { userId: owner, workspaceId: a.id, botId, runId, auditActor: userActor }
  const credentials = new CredentialStore(database, { generate: async () => ({ plaintext: randomBytes(32), wrapped: 'synthetic-kms-fixture' }), decrypt: async () => { throw new Error('No decryption needed') } })
  const origin = 'https://fixture-credential.example', username = 'fixture-user-never-audit', password = randomBytes(24).toString('base64url')
  const audits = () => database.query('SELECT * FROM workspace_audit_events WHERE "workspaceId"=ANY($1::uuid[]) ORDER BY "createdAt",id', [[a.id, b.id]]).then(result => result.rows)
  await t.test('create, replace and revoke contain only real actor and opaque credential reference; repeats do not fabricate events', async () => {
    const save = async (value: string) => { const challenge = await credentials.challenge(caller, origin); return credentials.save(caller, { nonce: challenge.nonce, origin, username, password: value }) }
    await save(password); await save(password + '-updated')
    await credentials.remove({ userId: peer, workspaceId: a.id }, origin, username)
    const tokenActor = { type: 'token' as const, id: randomUUID(), name: 'Personal access token' }
    await credentials.remove({ ...caller, auditActor: tokenActor }, origin, username)
    await credentials.remove(caller, origin, username)
    const rows = (await audits()).filter(row => row.action.startsWith('credential.'))
    assert.deepEqual(rows.map(row => row.action), ['credential.created', 'credential.replaced', 'credential.revoked'])
    assert.ok(rows.every(row => row.workspaceId === a.id && row.targetType === 'credential' && Object.keys(row.metadata).length === 0))
    assert.equal(new Set(rows.map(row => row.targetId)).size, 1)
    assert.equal(rows[0].actorType, 'user'); assert.equal(rows[0].actorId, owner)
    assert.equal(rows[2].actorType, 'token'); assert.equal(rows[2].actorId, tokenActor.id)
    for (const secret of [origin, username, password]) assert.equal(JSON.stringify(rows).includes(secret), false)
    const challenge = await credentials.challenge(caller, origin), name = `credential_audit_${randomUUID().replaceAll('-', '')}`
    await database.query(`ALTER TABLE workspace_audit_events ADD CONSTRAINT ${name} CHECK("workspaceId"<>'${a.id}'::uuid) NOT VALID`)
    try {
      await assert.rejects(credentials.save(caller, { nonce: challenge.nonce, origin, username: 'blocked-fixture-user', password }))
      assert.equal((await database.query('SELECT count(*)::int n FROM credentials WHERE user_id=$1 AND username=\'blocked-fixture-user\'', [owner])).rows[0].n, 0)
      assert.equal((await database.query('SELECT consumed_at FROM credential_challenges WHERE user_id=$1 AND consumed_at IS NULL', [owner])).rowCount, 1)
    } finally { await database.query(`ALTER TABLE workspace_audit_events DROP CONSTRAINT ${name}`) }
  })
  await t.test('human approval and device consumption retain both Bot/task workspace evidence exactly once', async () => {
    const { readCliRunPolicy } = await import('../lib/agent-tool-approval/policy-store')
    const policy = await readCliRunPolicy(database, runId, owner)
    const store = new AgentToolApprovalStore(database), actor = { userId: owner, deviceId }
    const proposal = (requestId: string) => store.propose(actor, { runId, requestId, harness: 'codex', method: 'item/commandExecution/requestApproval', input: { command: 'private-tool-input-not-audit' }, policyRevision: policy.revision })
    const first = await proposal('approved')
    await store.decide(owner, runId, first.id, first.digest, 'approve', { name: userActor.name })
    const results = await Promise.all(Array.from({ length: 10 }, () => store.take(actor, runId, first.id, first.digest)))
    assert.equal(results.filter(result => result === 'allow').length, 1)
    const denied = await proposal('denied')
    await store.decide(owner, runId, denied.id, denied.digest, 'deny', { name: userActor.name })
    assert.equal(await store.take(actor, runId, denied.id, denied.digest), 'deny')
    await assert.rejects(store.decide(peer, runId, denied.id, denied.digest, 'approve'))
    const rows = (await audits()).filter(row => row.action.startsWith('agent.approval_'))
    assert.equal(rows.length, 6)
    assert.ok(rows.filter(row => row.action === 'agent.approval_decided').every(row => row.actorType === 'user' && row.actorId === owner))
    assert.ok(rows.filter(row => row.action === 'agent.approval_consumed').every(row => row.actorType === 'system' && row.actorId === deviceId))
    assert.deepEqual([...new Set(rows.map(row => row.workspaceId))].sort(), [a.id, b.id].sort())
    assert.ok(rows.every(row => row.metadata.runId === runId && row.metadata.revision === policy.revision && row.targetType === 'approval'))
    assert.equal(JSON.stringify(rows).includes('private-tool-input-not-audit'), false)
    const pending = await proposal('audit-rollback'), name = `approval_audit_${randomUUID().replaceAll('-', '')}`
    const count = () => database.query('SELECT count(*)::int n FROM workspace_audit_events WHERE "workspaceId"=ANY($1::uuid[])', [[a.id, b.id]]).then(result => result.rows[0].n)
    const before = await count()
    await database.query(`ALTER TABLE workspace_audit_events ADD CONSTRAINT ${name} CHECK("workspaceId"<>'${a.id}'::uuid) NOT VALID`)
    try {
      await assert.rejects(store.decide(owner, runId, pending.id, pending.digest, 'approve', { name: userActor.name }))
      assert.equal((await database.query('SELECT status FROM agent_tool_approvals WHERE id=$1', [pending.id])).rows[0].status, 'pending')
      assert.equal(await count(), before)
    } finally { await database.query(`ALTER TABLE workspace_audit_events DROP CONSTRAINT ${name}`) }
    await store.decide(owner, runId, pending.id, pending.digest, 'approve', { name: userActor.name })
    await database.query(`ALTER TABLE workspace_audit_events ADD CONSTRAINT ${name} CHECK("workspaceId"<>'${a.id}'::uuid) NOT VALID`)
    const afterDecision = await count()
    try {
      await assert.rejects(store.take(actor, runId, pending.id, pending.digest))
      assert.equal((await database.query('SELECT status FROM agent_tool_approvals WHERE id=$1', [pending.id])).rows[0].status, 'approved')
      assert.equal(await count(), afterDecision)
    } finally { await database.query(`ALTER TABLE workspace_audit_events DROP CONSTRAINT ${name}`) }
    assert.equal(await store.take(actor, runId, pending.id, pending.digest), 'allow')
  })
})
