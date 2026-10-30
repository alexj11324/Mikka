import './fixtures/activity-runtime.mjs'
import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { orderMigrations } from '../scripts/migration-order.mjs'

const target = process.env.CI_MAILBOX_TEST_DATABASE_URL ?? (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' ? process.env.E2E_DATABASE_URL : undefined)
if (!target && process.env.REQUIRE_DB === '1') throw Error('CI mailbox database fixture is required')
if (target) {
  const url = new URL(target)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || (url.port !== '5432' && !(process.env.CI_MAILBOX_TEST_DATABASE_URL && url.port === '5433')) || url.pathname !== '/mikka_e2e' || url.search || url.hash) throw Error('CI mailbox fixture requires loopback mikka_e2e')
}

test('isolated PG: CI continues the original mailbox parent only while current grant and scope remain authorized', { skip: !target, timeout: 90000 }, async () => {
  const schema = `ci_mailbox_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: target, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const scoped = new URL(target!); scoped.searchParams.set('options', `-c search_path=${schema}`)
  const databaseURL = scoped.toString(), fixture = new Pool({ connectionString: databaseURL, max: 8 })
  const previous = { MIKKA_DATABASE_URL: process.env.MIKKA_DATABASE_URL, DATABASE_URL: process.env.DATABASE_URL, MIKKA_PERSONAL_MAILBOX_ENABLED: process.env.MIKKA_PERSONAL_MAILBOX_ENABLED, MIKKA_BYOS_ENABLED: process.env.MIKKA_BYOS_ENABLED, NODE_ENV: process.env.NODE_ENV }
  process.env.MIKKA_DATABASE_URL = databaseURL; process.env.DATABASE_URL = databaseURL; process.env.MIKKA_PERSONAL_MAILBOX_ENABLED = '1'; delete process.env.MIKKA_BYOS_ENABLED
  Object.assign(process.env, { NODE_ENV: 'test' })
  let scopedPool: Pool | undefined, workspacePool: Pool | undefined
  try {
    assert.equal((await fixture.query('show server_version_num')).rows[0].server_version_num.slice(0, 2), '17')
    const migrations = new URL('../drizzle/', import.meta.url)
    for (const name of orderMigrations((await readdir(migrations)).filter(n => n.endsWith('.sql') && !['20261026013000_issue_search_pg_trgm.sql', '20261026013001_issue_search_title_idx.sql'].includes(n)))) await fixture.query(await readFile(new URL(name, migrations), 'utf8'))
    const owner = `fixture-${randomUUID()}`, issueId = randomUUID(), agentId = randomUUID(), deviceId = randomUUID()
    const key = 'v2/github.com/acme/repo', remoteUrl = 'https://github.com/acme/repo.git'
    await fixture.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Fixture',$2,true,now(),now())`, [owner, `${owner}@example.invalid`])
    await fixture.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'Fixture','local',true,now(),'[{"harness":"codex","installed":true,"toolApproval":true}]')`, [deviceId, owner])
    await fixture.query(`INSERT INTO agents (id,"userId","deviceId",harness,name,instructions) VALUES ($1,$2,$3,'codex','Fixture','')`, [agentId, owner, deviceId])
    await fixture.query(`INSERT INTO issues (id,"userId",title,content,status,priority,scope) VALUES ($1,$2,'Fixture task',$3,'todo','normal','personal')`, [issueId, owner, JSON.stringify({ type: 'doc', attrs: { mikka: { number: 1 } }, content: [] })])
    await fixture.query(`INSERT INTO issue_prefixes ("userId",prefix) VALUES ($1,'TEST')`, [owner])
    await fixture.query(`INSERT INTO repository_settings ("userId","remoteKey",push) VALUES ($1,$2,$3)`, [owner, key, JSON.stringify({ approved: true, remote: 'origin', approvedByUserId: owner, approvedAt: new Date().toISOString() })])
    const { pool } = await import('../lib/db'); scopedPool = pool
    workspacePool = (await import('../lib/workspace-db')).workspacePool
    const { AgentKitStore } = await import('../lib/agent-kit/store')
    const { DEFAULT_AGENT_DEFINITION } = await import('../lib/agent-kit/builtin')
    const { queueRun, queueFactoryRun } = await import('../lib/agent-runs')
    const store = new AgentKitStore(pool), scope = { ownerId: owner, botId: null, workspaceId: null }
    const definition = { ...DEFAULT_AGENT_DEFINITION, tools: ['mailbox_inbox' as const] }
    const execution = await store.beginExecution(scope, `fixture:${randomUUID()}`, 'HOST', { harness: 'ai_sdk', model: 'synthetic' }, definition)
    const { runId } = await queueRun(owner, { issueId, agentId, repo: remoteUrl }, null, execution)
    const { rows: [origin] } = await fixture.query('SELECT "agentDefinition","deviceRepoId" FROM agent_runs WHERE id=$1', [runId])
    assert.deepEqual(origin.agentDefinition.mailbox.tools, ['mailbox_inbox'])
    await fixture.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"='original-session',"finishedAt"=now() WHERE id=$1`, [runId])
    await fixture.query(`UPDATE run_publications SET status='published',"pullRequest"=$2 WHERE "runId"=$1`, [runId, JSON.stringify({ url: 'https://github.com/acme/repo/pull/7', state: 'open' })])
    await fixture.query(`INSERT INTO github_ci_observations ("userId","issueId","remoteKey","prNumber","originRunId","scopeVersion",head,fingerprint,"expiresAt") VALUES ($1,$2,$3,7,$4,1,$5,$6,now()+interval '1 hour')`, [owner, issueId, key, runId, 'a'.repeat(40), 'b'.repeat(64)])
    const { queueCiContinuation, guardCiClaim, retireRevokedMailboxCiRun, retireRevokedMailboxCiRuns } = await import('../lib/ci-continuation')
    const input = { originRunId: runId, issueId, remoteKey: key, prNumber: 7, scopeVersion: 1, head: 'a'.repeat(40), fingerprint: 'b'.repeat(64), followUp: 'CI failed: build.' }
    const tx = await fixture.connect()
    let childId: string
    try {
      await tx.query('BEGIN')
      const queued = await queueCiContinuation(tx, owner, input)
      childId = queued.runId
      await tx.query('COMMIT')
    } finally { tx.release() }
    const { rows: [child] } = await fixture.query('SELECT * FROM agent_runs WHERE id=$1', [childId])
    assert.equal(child.agentDefinition.definitionDigest, origin.agentDefinition.definitionDigest)
    assert.deepEqual(child.agentDefinition.mailbox, origin.agentDefinition.mailbox)
    const generation = (await fixture.query('SELECT generation FROM github_ci_observations')).rows[0].generation
    const claim = await fixture.connect()
    try { await claim.query('BEGIN'); assert.equal((await guardCiClaim(claim, owner, deviceId, childId, child.ciContinuation, generation))?.resumeSessionId, 'original-session'); await claim.query('COMMIT') } finally { claim.release() }
    const lease = new Date(Date.now() + 120000).toISOString()
    await fixture.query(`UPDATE agent_runs SET status='preparing',"leaseExpiresAt"=$2 WHERE id=$1`, [childId, lease])
    const { authorizedClaimResponse } = await import('../lib/run-claim-response')
    const hint = { id: childId, issueId, agentId, deviceId, deviceRepoId: origin.deviceRepoId }
    assert.equal((await authorizedClaimResponse(owner, hint, lease, () => new Response('ok'), generation))?.status, 200)
    await store.save(scope, { ...definition, tools: [] }, 1, randomUUID(), definition)
    assert.equal(await authorizedClaimResponse(owner, hint, lease, () => new Response('must-not-return'), generation), null)
    await fixture.query(`UPDATE agent_runs SET status='queued' WHERE id=$1`, [childId])
    const revoked = await fixture.connect()
    try { await revoked.query('BEGIN'); await assert.rejects(guardCiClaim(revoked, owner, deviceId, childId, child.ciContinuation, generation), /not supported/); await revoked.query('COMMIT') } finally { revoked.release() }
    assert.equal(await retireRevokedMailboxCiRun(owner, childId, child.ciContinuation, generation), true)
    assert.equal((await fixture.query('SELECT status FROM agent_runs WHERE id=$1', [childId])).rows[0].status, 'stopped')
    const observation = (await fixture.query('SELECT generation,"nextCheckAt","deliveredFingerprint" FROM github_ci_observations')).rows[0]
    assert.equal(String(observation.generation), String(Number(generation)+1))
    assert.equal(observation.deliveredFingerprint, null)
    // Simulate an offline device: the due reconciler retires the still-queued
    // old result without waiting for the daemon to ask for an assignment.
    await fixture.query(`UPDATE agent_runs SET status='queued',"stopReason"=NULL WHERE id=$1`, [childId])
    const offline = await fixture.connect()
    try {
      await offline.query('BEGIN')
      assert.equal(await retireRevokedMailboxCiRuns(offline, owner, input), 1)
      await offline.query('COMMIT')
    } finally { offline.release() }
    assert.equal((await fixture.query('SELECT status FROM agent_runs WHERE id=$1', [childId])).rows[0].status, 'stopped')
    const blocked = await fixture.connect()
    try {
      await blocked.query('BEGIN')
      await assert.rejects(queueCiContinuation(blocked, owner, input))
      await blocked.query('ROLLBACK')
    } finally { blocked.release() }
    // Existing self-improvement/source-run dispatch does not opt into CI
    // mailbox reconstruction or its CI-specific unsupported error.
    const generic = await fixture.connect()
    let genericRunId: string
    try {
      await generic.query('BEGIN')
      genericRunId = (await queueFactoryRun(generic, owner, { issueId, agentId, deviceRepoId: origin.deviceRepoId, note: 'Ordinary source dispatch' }, null, undefined, runId)).runId
      await generic.query('COMMIT')
    } finally { generic.release() }
    const ordinary = (await fixture.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [genericRunId])).rows[0].agentDefinition
    assert.equal(ordinary.mailbox, undefined)
    assert.equal(ordinary.parent, null)
    // A CI response for a shared task holds the membership row until the
    // response is built. If revocation wins first, no assignment is returned.
    const sharedIssue = randomUUID(), workspace = randomUUID(), team = randomUUID(), taskOwner = `shared-${randomUUID()}`
    await fixture.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Shared owner',$2,true,now(),now())`, [taskOwner, `${taskOwner}@example.invalid`])
    await fixture.query(`INSERT INTO issues (id,"userId",title,content,status,priority,scope) VALUES ($1,$2,'Shared fixture',$3,'todo','normal','workspace')`, [sharedIssue,taskOwner,JSON.stringify({type:'doc',content:[]})])
    await fixture.query(`INSERT INTO mikka_teams (id,"workspaceId","userId",name,identifier) VALUES ($1,$2,$3,'Fixture team','FIX')`, [team,workspace,taskOwner])
    await fixture.query(`INSERT INTO mikka_team_issues ("issueId","teamId","workspaceId","userId") VALUES ($1,$2,$3,$4)`, [sharedIssue,team,workspace,taskOwner])
    await fixture.query(`INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,'Member',$3,'member','active')`, [workspace,owner,`${owner}@example.invalid`])
    await fixture.query(`UPDATE agent_runs SET "issueId"=$2,"agentDefinition"="agentDefinition"-'mailbox' WHERE id=$1`, [runId,sharedIssue])
    await fixture.query(`UPDATE agent_runs SET "issueId"=$2::uuid,status='preparing',"stopReason"=NULL,"leaseExpiresAt"=$3,"agentDefinition"="agentDefinition"-'mailbox',"ciContinuation"=jsonb_set("ciContinuation",'{issueId}',to_jsonb(($2::uuid)::text)) WHERE id=$1`, [childId,sharedIssue,lease])
    await fixture.query(`INSERT INTO github_ci_observations ("userId","issueId","remoteKey","prNumber","originRunId","scopeVersion",head,fingerprint,"expiresAt") VALUES ($1,$2,$3,7,$4,1,$5,$6,now()+interval '1 hour')`, [owner,sharedIssue,key,runId,'a'.repeat(40),'b'.repeat(64)])
    const sharedHint = { ...hint, issueId: sharedIssue }
    assert.equal((await authorizedClaimResponse(owner, sharedHint, lease, () => new Response('shared'), '0'))?.status, 200)
    // Provider-error attention for a shared task is generic and carries no
    // task/run identifiers; after revocation it cannot be written at all.
    const { rows: [sharedObservation] } = await fixture.query('SELECT "watchId",generation FROM github_ci_observations WHERE "userId"=$1 AND "issueId"=$2', [owner,sharedIssue])
    const { recordCiAttention } = await import('../lib/github/ci/notice')
    const noticeIdentity = { userId: owner, issueId: sharedIssue, remoteKey: key, prNumber: 7, originRunId: runId, scopeVersion: 1, generation: sharedObservation.generation, watchId: sharedObservation.watchId }
    assert.equal(await recordCiAttention(fixture, noticeIdentity, `ci_escalation:fixture-${randomUUID()}`, 'Private check fixture failed.'), true)
    const { rows: [sharedNotice] } = await fixture.query(`SELECT "issueId","runId",payload FROM coordinator_events WHERE "userId"=$1 AND "issueId" IS NULL AND payload->>'source'='github_ci'`, [owner])
    assert.equal(sharedNotice.issueId, null); assert.equal(sharedNotice.runId, null)
    assert.equal(sharedNotice.payload.text, 'CI needs attention. Open an authorized task to review its checks.')
    const revoker = await fixture.connect()
    try {
      await revoker.query('BEGIN')
      await revoker.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [workspace,owner])
      let settled = false
      const response = authorizedClaimResponse(owner, sharedHint, lease, () => new Response('must-not-return'), '0').then(value => { settled = true; return value })
      await new Promise(resolve => setTimeout(resolve, 100))
      assert.equal(settled, false, 'membership row is locked by the revocation')
      await revoker.query('COMMIT')
      assert.equal(await response, null, 'revoked member receives no CI assignment')
      await assert.rejects(recordCiAttention(fixture, noticeIdentity, `ci_escalation:revoked-${randomUUID()}`, 'Private check fixture failed.'), /authority unavailable/)
    } finally { revoker.release() }
  } finally {
    await scopedPool?.end().catch(() => {})
    await workspacePool?.end().catch(() => {})
    await fixture.end(); await admin.end()
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    console.log(`Retained isolated mailbox fixture schema: ${schema}`)
  }
})
