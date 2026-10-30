import './fixtures/activity-runtime.mjs'
import { strict as assert } from 'node:assert'
import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { orderMigrations } from '../scripts/migration-order.mjs'

const target = process.env.CI_SKILL_TEST_DATABASE_URL ?? (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' ? process.env.E2E_DATABASE_URL : undefined)
if (!target && process.env.REQUIRE_DB === '1') throw Error('CI skill database fixture is required')
if (target) { const u = new URL(target); if (!['postgres:', 'postgresql:'].includes(u.protocol) || u.hostname !== '127.0.0.1' || !(['5432', ...(process.env.CI_SKILL_TEST_DATABASE_URL ? ['5433'] : [])].includes(u.port)) || u.pathname !== '/mikka_e2e' || u.search || u.hash) throw Error('CI skill fixture requires loopback mikka_e2e') }

test('isolated PG: CI retains verified skill provenance, immutable receipts and current definition', { skip: !target, timeout: 90000 }, async () => {
  const schema = `ci_skill_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: target, max: 1 }); await admin.query(`CREATE SCHEMA "${schema}"`)
  const u = new URL(target!); u.searchParams.set('options', `-c search_path=${schema}`)
  const databaseURL = u.toString(), fixture = new Pool({ connectionString: databaseURL, max: 8 })
  const previous = { MIKKA_DATABASE_URL: process.env.MIKKA_DATABASE_URL, DATABASE_URL: process.env.DATABASE_URL, MIKKA_BYOS_ENABLED: process.env.MIKKA_BYOS_ENABLED, MIKKA_PERSONAL_MAILBOX_ENABLED: process.env.MIKKA_PERSONAL_MAILBOX_ENABLED, NODE_ENV: process.env.NODE_ENV }
  process.env.MIKKA_DATABASE_URL = databaseURL; process.env.DATABASE_URL = databaseURL; process.env.MIKKA_BYOS_ENABLED = '0'; process.env.MIKKA_PERSONAL_MAILBOX_ENABLED = '0'; Object.assign(process.env, { NODE_ENV: 'test' })
  let scopedPool: Pool | undefined, workspacePool: Pool | undefined
  try {
    assert.equal((await fixture.query('show server_version_num')).rows[0].server_version_num.slice(0, 2), '17')
    const migrations = new URL('../drizzle/', import.meta.url)
    for (const name of orderMigrations((await readdir(migrations)).filter(n => n.endsWith('.sql') && !['20261026013000_issue_search_pg_trgm.sql','20261026013001_issue_search_title_idx.sql'].includes(n)))) await fixture.query(await readFile(new URL(name, migrations), 'utf8'))
    const owner = `fixture-${randomUUID()}`, issueId = randomUUID(), agentId = randomUUID(), deviceId = randomUUID(), key = 'v2/github.com/acme/repo', remoteUrl = 'https://github.com/acme/repo.git'
    await fixture.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Fixture',$2,true,now(),now())`, [owner, `${owner}@example.invalid`])
    await fixture.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'Fixture','local',true,now(),'[{"harness":"codex","installed":true,"toolApproval":true}]')`, [deviceId,owner])
    await fixture.query(`INSERT INTO agents (id,"userId","deviceId",harness,name,instructions) VALUES ($1,$2,$3,'codex','Fixture','')`, [agentId,owner,deviceId])
    await fixture.query(`INSERT INTO issues (id,"userId",title,content,status,priority,scope) VALUES ($1,$2,'Fixture task',$3,'todo','normal','personal')`, [issueId,owner,JSON.stringify({ type: 'doc', attrs: { mikka: { number: 1 } }, content: [] })])
    await fixture.query(`INSERT INTO issue_prefixes ("userId",prefix) VALUES ($1,'TEST')`, [owner])
    await fixture.query(`INSERT INTO repository_settings ("userId","remoteKey",push) VALUES ($1,$2,$3)`, [owner,key,JSON.stringify({ approved:true,remote:'origin',approvedByUserId:owner,approvedAt:new Date().toISOString() })])
    const { pool } = await import('../lib/db'); scopedPool = pool; workspacePool = (await import('../lib/workspace-db')).workspacePool
    const { queueRun } = await import('../lib/agent-runs'); const { runId } = await queueRun(owner, { issueId, agentId, repo: remoteUrl })
    const { skillAssignments } = await import('../lib/self-improvement/server'); await skillAssignments.selectBaseline(owner, runId)
    const lease = new Date(Date.now()+120000).toISOString()
    await fixture.query(`UPDATE agent_runs SET status='preparing',"startedAt"=now()-interval '1 second',"sessionId"='original-session',"leaseExpiresAt"=$2 WHERE id=$1`, [runId,lease])
    const original = await skillAssignments.recordClaim(owner,deviceId,runId,lease,true); assert.ok(original.skillReceipt)
    const { recordSkillMount } = await import('../lib/self-improvement/skill-mounts')
    const mount = { receiptId: original.skillReceipt.id, versionId: original.skillReceipt.artifact.versionId, sha256: original.skillReceipt.artifact.sha256, sessionId: 'original-session', mountedAt: new Date().toISOString() }
    const mountTx = await fixture.connect(); try { await mountTx.query('BEGIN'); await recordSkillMount(mountTx,owner,runId,mount,async () => true); await mountTx.query('COMMIT') } finally { mountTx.release() }
    await fixture.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"finishedAt"=now() WHERE id=$1`, [runId])
    await fixture.query(`UPDATE run_publications SET status='published',"pullRequest"=$2 WHERE "runId"=$1`, [runId,JSON.stringify({url:'https://github.com/acme/repo/pull/7',state:'open'})])
    await fixture.query(`INSERT INTO github_ci_observations ("userId","issueId","remoteKey","prNumber","originRunId","scopeVersion",head,fingerprint,"deliveredFingerprint","expiresAt") VALUES ($1,$2,$3,7,$4,1,$5,$6,$6,now()+interval '1 hour')`, [owner,issueId,key,runId,'a'.repeat(40),'b'.repeat(64)])
    const input = {originRunId:runId,issueId,remoteKey:key,prNumber:7,scopeVersion:1,head:'a'.repeat(40),fingerprint:'b'.repeat(64),followUp:'CI failed: build.'}
    const { queueCiContinuation, guardCiClaim, retryUnsentCiClaim } = await import('../lib/ci-continuation')
    const client = await fixture.connect(); let childId: string
    try { await client.query('BEGIN'); childId = (await queueCiContinuation(client,owner,input)).runId; await client.query('COMMIT') } finally { client.release() }
    const child = (await fixture.query('SELECT * FROM agent_runs WHERE id=$1',[childId])).rows[0]
    assert.equal((await fixture.query('SELECT "versionId" FROM improvement_skill_selections WHERE "runId"=$1',[childId])).rows[0].versionId, original.skillReceipt.artifact.versionId)
    const generation = (await fixture.query('SELECT generation FROM github_ci_observations')).rows[0].generation
    const claim = await fixture.connect(); try { await claim.query('BEGIN'); assert.equal((await guardCiClaim(claim,owner,deviceId,childId,child.ciContinuation,generation))?.resumeSessionId,'original-session'); await claim.query('COMMIT') } finally { claim.release() }
    const childLease = new Date(Date.now()+110000).toISOString()
    await fixture.query(`UPDATE agent_runs SET status='preparing',"startedAt"=now()-interval '1 second',"leaseExpiresAt"=$2 WHERE id=$1`,[childId,childLease])
    const receipt = await skillAssignments.recordClaim(owner,deviceId,childId,childLease,true); assert.ok(receipt.skillReceipt)
    assert.notEqual(receipt.skillReceipt.id,original.skillReceipt.id); assert.deepEqual(receipt.skillReceipt.artifact,original.skillReceipt.artifact)
    const responseFence = await fixture.connect()
    try { await responseFence.query('BEGIN'); await skillAssignments.validateCiClaim(responseFence,owner,childId,childLease); await responseFence.query('COMMIT') } finally { responseFence.release() }
    const { authorizedClaimResponse } = await import('../lib/run-claim-response')
    const repoId = (await fixture.query('SELECT "deviceRepoId" FROM agent_runs WHERE id=$1',[runId])).rows[0].deviceRepoId
    assert.equal((await authorizedClaimResponse(owner,{id:childId,issueId,agentId,deviceId,deviceRepoId:repoId},childLease,()=>new Response('synthetic'),generation))?.status,200)
    assert.equal(await retryUnsentCiClaim(owner,childId,child.ciContinuation,childLease),true)
    assert.equal((await fixture.query('SELECT status FROM agent_runs WHERE id=$1',[childId])).rows[0].status,'stopped')
    assert.equal((await fixture.query('SELECT count(*)::int n FROM improvement_skill_receipts WHERE "runId"=$1',[childId])).rows[0].n,1)
    assert.equal((await fixture.query('SELECT "deliveredFingerprint" FROM github_ci_observations')).rows[0].deliveredFingerprint,null)
    const requeue = await fixture.connect(); let nextId: string
    try { await requeue.query('BEGIN'); nextId = (await queueCiContinuation(requeue,owner,input)).runId; await requeue.query('COMMIT') } finally { requeue.release() }
    assert.notEqual(nextId,childId); assert.equal((await fixture.query('SELECT count(*)::int n FROM improvement_skill_selections WHERE "runId"=$1',[nextId])).rows[0].n,1)
    await fixture.query(`UPDATE agent_runs SET status='stopped',"stopReason"='superseded' WHERE id=$1`,[nextId]); await fixture.query(`UPDATE github_ci_observations SET generation=generation+1`); await fixture.query(`UPDATE agents SET instructions='Changed since origin' WHERE id=$1`,[agentId])
    const before = (await fixture.query('SELECT count(*)::int n FROM agent_runs')).rows[0].n, changed = await fixture.connect()
    try { await changed.query('BEGIN'); await assert.rejects(queueCiContinuation(changed,owner,input), (error: unknown) => error instanceof Error && 'reason' in error && error.reason === 'definition_changed'); await changed.query('COMMIT') } finally { changed.release() }
    assert.equal((await fixture.query('SELECT count(*)::int n FROM agent_runs')).rows[0].n,before)
    // A selected artifact without recorded evidence of mounting in the
    // original session is not a grant for a CI continuation.
    const second = await queueRun(owner,{issueId,agentId,repo:remoteUrl})
    await skillAssignments.selectBaseline(owner,second.runId)
    const secondLease = new Date(Date.now()+120000).toISOString()
    await fixture.query(`UPDATE agent_runs SET status='preparing',"startedAt"=now()-interval '1 second',"sessionId"='unmounted-session',"leaseExpiresAt"=$2 WHERE id=$1`,[second.runId,secondLease])
    await skillAssignments.recordClaim(owner,deviceId,second.runId,secondLease,true)
    await fixture.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"finishedAt"=now() WHERE id=$1`,[second.runId])
    await fixture.query(`UPDATE run_publications SET status='published',"pullRequest"=$2 WHERE "runId"=$1`,[second.runId,JSON.stringify({url:'https://github.com/acme/repo/pull/8',state:'open'})])
    await fixture.query(`INSERT INTO github_ci_observations ("userId","issueId","remoteKey","prNumber","originRunId","scopeVersion",head,fingerprint,"expiresAt") VALUES ($1,$2,$3,8,$4,1,$5,$6,now()+interval '1 hour')`,[owner,issueId,key,second.runId,'c'.repeat(40),'d'.repeat(64)])
    const missing = {...input,originRunId:second.runId,prNumber:8,head:'c'.repeat(40),fingerprint:'d'.repeat(64)}
    const count = (await fixture.query('SELECT count(*)::int n FROM agent_runs')).rows[0].n
    const noMount = await fixture.connect()
    try { await noMount.query('BEGIN'); await assert.rejects(queueCiContinuation(noMount,owner,missing),(error: unknown) => error instanceof Error && 'reason' in error && error.reason === 'skill'); await noMount.query('COMMIT') } finally { noMount.release() }
    assert.equal((await fixture.query('SELECT count(*)::int n FROM agent_runs')).rows[0].n,count)
    // Synthetic active candidate with real immutable selection, receipt and
    // mount ledgers. Withdraw it after provisional claim to exercise the
    // same final fence and offline retirement used for a live revoked skill.
    const active = await queueRun(owner,{issueId,agentId,repo:remoteUrl})
    const repoIdActive = (await fixture.query('SELECT "deviceRepoId" FROM agent_runs WHERE id=$1',[active.runId])).rows[0].deviceRepoId
    const { BASELINE_ARTIFACT } = await import('../lib/self-improvement/builtin-skill')
    const { SKILL_PATH } = await import('../lib/self-improvement/regression')
    const versionId = randomUUID(), proposalId = randomUUID(), markdown = '---\nname: Run report\n---\n\nSynthetic active instructions.\n'
    const artifact = {...BASELINE_ARTIFACT,versionId,sha256:createHash('sha256').update(markdown).digest('hex')}
    const scorer = `fixture-${randomUUID()}`
    await fixture.query(`INSERT INTO improvement_scorers (digest,id,version,definition) VALUES ($1,$2,1,'{}')`,[scorer,scorer])
    await fixture.query(`INSERT INTO improvement_proposals (id,"userId",bucket,fingerprint,"issueId","scorerDigest",candidate,result,status) VALUES ($1,$2,'fixture',$3,$4,$5,'{}','{}','awaiting_independent_review')`,[proposalId,owner,randomUUID(),issueId,scorer])
    await fixture.query(`INSERT INTO improvement_skill_versions (id,artifact,markdown) VALUES ($1,$2,$3)`,[versionId,JSON.stringify(artifact),markdown])
    await fixture.query(`INSERT INTO improvement_skill_candidates ("versionId","userId","issueId","agentId","repoId","proposalId","factoryTaskId","candidateId",repository,"commitSha",path,"baselineVersionId") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[versionId,owner,issueId,agentId,repoIdActive,proposalId,randomUUID(),randomUUID(),remoteUrl,'a'.repeat(40),SKILL_PATH,BASELINE_ARTIFACT.versionId])
    await fixture.query(`INSERT INTO improvement_skill_lifecycle (id,"userId","issueId","repoId","versionId",operation,"publicationId","approvalId") VALUES ($1,$2,$3,$4,$5,'activate',$6,$7)`,[randomUUID(),owner,issueId,repoIdActive,versionId,randomUUID(),randomUUID()])
    await skillAssignments.selectActive(owner,active.runId)
    const activeLease = new Date(Date.now()+120000).toISOString()
    await fixture.query(`UPDATE agent_runs SET status='preparing',"startedAt"=now()-interval '1 second',"sessionId"='active-session',"leaseExpiresAt"=$2 WHERE id=$1`,[active.runId,activeLease])
    const activeReceipt = await skillAssignments.recordClaim(owner,deviceId,active.runId,activeLease,true); assert.ok(activeReceipt.skillReceipt)
    const activeMount = { receiptId:activeReceipt.skillReceipt.id,versionId,sha256:artifact.sha256,sessionId:'active-session',mountedAt:new Date().toISOString() }
    const activeMountTx = await fixture.connect()
    try { await activeMountTx.query('BEGIN'); await recordSkillMount(activeMountTx,owner,active.runId,activeMount,async () => true); await activeMountTx.query('COMMIT') } finally { activeMountTx.release() }
    await fixture.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"finishedAt"=now() WHERE id=$1`,[active.runId])
    await fixture.query(`UPDATE run_publications SET status='published',"pullRequest"=$2 WHERE "runId"=$1`,[active.runId,JSON.stringify({url:'https://github.com/acme/repo/pull/9',state:'open'})])
    await fixture.query(`INSERT INTO github_ci_observations ("userId","issueId","remoteKey","prNumber","originRunId","scopeVersion",head,fingerprint,"deliveredFingerprint","expiresAt") VALUES ($1,$2,$3,9,$4,1,$5,$6,$6,now()+interval '1 hour')`,[owner,issueId,key,active.runId,'e'.repeat(40),'f'.repeat(64)])
    const activeInput = {...input,originRunId:active.runId,prNumber:9,head:'e'.repeat(40),fingerprint:'f'.repeat(64)}
    const activeTx = await fixture.connect(); let activeChildId: string
    try { await activeTx.query('BEGIN'); activeChildId=(await queueCiContinuation(activeTx,owner,activeInput)).runId; await activeTx.query('COMMIT') } finally { activeTx.release() }
    const activeChild = (await fixture.query('SELECT * FROM agent_runs WHERE id=$1',[activeChildId])).rows[0]
    const activeChildLease = new Date(Date.now()+110000).toISOString()
    await fixture.query(`UPDATE agent_runs SET status='preparing',"startedAt"=now()-interval '1 second',"leaseExpiresAt"=$2 WHERE id=$1`,[activeChildId,activeChildLease])
    const activeChildReceipt = await skillAssignments.recordClaim(owner,deviceId,activeChildId,activeChildLease,true); assert.ok(activeChildReceipt.skillReceipt)
    const activeGeneration = (await fixture.query(`SELECT generation FROM github_ci_observations WHERE "prNumber"=9`)).rows[0].generation
    assert.equal((await authorizedClaimResponse(owner,{id:activeChildId,issueId,agentId,deviceId,deviceRepoId:repoIdActive},activeChildLease,()=>new Response('allowed'),activeGeneration))?.status,200)
    await fixture.query(`INSERT INTO improvement_skill_lifecycle (id,"userId","issueId","repoId","versionId",operation,"publicationId","approvalId") VALUES ($1,$2,$3,$4,$5,'withdraw',$6,$7)`,[randomUUID(),owner,issueId,repoIdActive,versionId,randomUUID(),randomUUID()])
    assert.equal(await authorizedClaimResponse(owner,{id:activeChildId,issueId,agentId,deviceId,deviceRepoId:repoIdActive},activeChildLease,()=>new Response('must-not-return'),activeGeneration),null)
    assert.equal(await retryUnsentCiClaim(owner,activeChildId,activeChild.ciContinuation,activeChildLease),true)
    assert.equal((await fixture.query('SELECT count(*)::int n FROM improvement_skill_receipts WHERE "runId"=$1',[activeChildId])).rows[0].n,1)
    await fixture.query(`UPDATE agent_runs SET status='queued',"stopReason"=NULL WHERE id=$1`,[activeChildId])
    const { retireRevokedCiSkillRuns } = await import('../lib/ci-continuation')
    const retire = await fixture.connect()
    try { await retire.query('BEGIN'); await retire.query('SELECT id FROM issues WHERE id=$1 FOR UPDATE',[issueId]); await retire.query('SELECT 1 FROM github_ci_observations WHERE "userId"=$1 AND "issueId"=$2 AND "prNumber"=9 FOR UPDATE',[owner,issueId]); assert.equal(await retireRevokedCiSkillRuns(retire,owner,activeInput),1); await retire.query('COMMIT') } finally { retire.release() }
    assert.equal((await fixture.query('SELECT status FROM agent_runs WHERE id=$1',[activeChildId])).rows[0].status,'stopped')
    const noGrant = await fixture.connect(); const beforeGrant = (await fixture.query('SELECT count(*)::int n FROM agent_runs')).rows[0].n
    try { await noGrant.query('BEGIN'); await assert.rejects(queueCiContinuation(noGrant,owner,activeInput),(error:unknown)=>error instanceof Error && 'reason' in error && error.reason==='skill'); await noGrant.query('COMMIT') } finally { noGrant.release() }
    assert.equal((await fixture.query('SELECT count(*)::int n FROM agent_runs')).rows[0].n,beforeGrant)
    // Evaluation arms are frozen to one run and cannot authorize an automatic
    // continuation, even when their original receipt and mount are valid.
    const evaluation = await queueRun(owner,{issueId,agentId,repo:remoteUrl})
    const { createSkillAssignments } = await import('../lib/self-improvement/assignments')
    const evaluationAssignments = createSkillAssignments(pool,async () => true,async () => true)
    const evalTx = await fixture.connect()
    try { await evalTx.query('BEGIN'); await evaluationAssignments.selectVersion(owner,evaluation.runId,BASELINE_ARTIFACT.versionId,{purpose:'evaluation',evaluationId:randomUUID()},evalTx); await evalTx.query('COMMIT') } finally { evalTx.release() }
    const evalLease = new Date(Date.now()+120000).toISOString()
    await fixture.query(`UPDATE agent_runs SET status='preparing',"startedAt"=now()-interval '1 second',"sessionId"='evaluation-session',"leaseExpiresAt"=$2 WHERE id=$1`,[evaluation.runId,evalLease])
    const evalReceipt = await evaluationAssignments.recordClaim(owner,deviceId,evaluation.runId,evalLease,true); assert.ok(evalReceipt.skillReceipt)
    const evalMount = { receiptId:evalReceipt.skillReceipt.id,versionId:evalReceipt.skillReceipt.artifact.versionId,sha256:evalReceipt.skillReceipt.artifact.sha256,sessionId:'evaluation-session',mountedAt:new Date().toISOString() }
    const evalMountTx = await fixture.connect()
    try { await evalMountTx.query('BEGIN'); await recordSkillMount(evalMountTx,owner,evaluation.runId,evalMount,async () => true); await evalMountTx.query('COMMIT') } finally { evalMountTx.release() }
    await fixture.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"finishedAt"=now() WHERE id=$1`,[evaluation.runId])
    await fixture.query(`UPDATE run_publications SET status='published',"pullRequest"=$2 WHERE "runId"=$1`,[evaluation.runId,JSON.stringify({url:'https://github.com/acme/repo/pull/10',state:'open'})])
    await fixture.query(`INSERT INTO github_ci_observations ("userId","issueId","remoteKey","prNumber","originRunId","scopeVersion",head,fingerprint,"expiresAt") VALUES ($1,$2,$3,10,$4,1,$5,$6,now()+interval '1 hour')`,[owner,issueId,key,evaluation.runId,'1'.repeat(40),'2'.repeat(64)])
    const evalInput = {...input,originRunId:evaluation.runId,prNumber:10,head:'1'.repeat(40),fingerprint:'2'.repeat(64)}
    const beforeEval = (await fixture.query('SELECT count(*)::int n FROM agent_runs')).rows[0].n, deniedEval = await fixture.connect()
    try { await deniedEval.query('BEGIN'); await assert.rejects(queueCiContinuation(deniedEval,owner,evalInput),(error:unknown)=>error instanceof Error && 'reason' in error && error.reason==='skill'); await deniedEval.query('COMMIT') } finally { deniedEval.release() }
    assert.equal((await fixture.query('SELECT count(*)::int n FROM agent_runs')).rows[0].n,beforeEval)
  } finally {
    await scopedPool?.end().catch(() => {}); await workspacePool?.end().catch(() => {}); await fixture.end(); await admin.end()
    for (const [key,value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    console.log(`Retained isolated skill fixture schema: ${schema}`)
  }
})
