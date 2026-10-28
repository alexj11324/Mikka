import { isolatedPostgresURL } from '../../tests/helpers/isolated-postgres.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { improvementTestDatabase } from './test-database'
import { assignedSkillForRun, createSkillAssignments } from './assignments'
import { createSkillRegistry } from './registry'
import { createImprovementStore } from './store'
import { BASELINE_ARTIFACT, BASELINE_MARKDOWN } from './builtin-skill'
import { SCORER_DIGEST } from './scorer'
import { SKILL_PATH } from './regression'
import { skillMarkdown } from '@mikka/protocol/skill'

const databaseURL = improvementTestDatabase(process.env)
test('PG candidate registration, immutable replay and exact-version claim/resume/withdrawal boundaries',
  { skip: !databaseURL, timeout: 120000 }, async t => {
    const target = new URL(await isolatedPostgresURL(databaseURL!)), schema = `skill_registry_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: target.toString(), max: 1 })
    await admin.query(`CREATE SCHEMA "${schema}"`)
    target.searchParams.set('options', `-c search_path=${schema}`)
    const pool = new Pool({ connectionString: target.toString(), max: 8 })
    t.after(async () => { await pool.end(); await admin.end() })
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const name of orderMigrations((await readdir(dir)).filter(n => n.endsWith('.sql'))))
      await pool.query(await readFile(new URL(name, dir), 'utf8'))
    await pool.query(await readFile(new URL('20261028231556_skill_candidate_registry.sql', dir), 'utf8'))
    const userId = `synthetic-${randomUUID()}`, issueId = randomUUID(), agentId = randomUUID(), deviceId = randomUUID(), repoId = randomUUID()
    const repository = 'https://github.com/example/public'
    await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority) VALUES($1,$2,'Registry boundary fixture','{}','todo','normal')`, [issueId,userId])
    await pool.query(`INSERT INTO devices(id,"ownerId",name,enabled) VALUES($1,$2,'Synthetic registry device',true)`, [deviceId,userId])
    await pool.query(`INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,'Synthetic registry agent','codex',$3)`, [agentId,userId,deviceId])
    await pool.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath","remoteUrl") VALUES($1,$2,$3,'/synthetic/registry',$4)`, [repoId,deviceId,userId,repository])
    let allowed = true
    const authorize = async (user: string, issue: string) => allowed && user === userId && issue === issueId
    const assignments = createSkillAssignments(pool,authorize), registry = createSkillRegistry(pool,authorize)
    async function queued() {
      const id = randomUUID()
      await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId",status)
        VALUES($1,$2,$3,$4,$5,$6,'queued')`, [id,userId,issueId,agentId,deviceId,repoId])
      return id
    }
    async function claim(runId: string, service = assignments) {
      const lease = new Date(Date.now()+60000).toISOString()
      await service.preflight(userId,runId,true)
      await pool.query(`UPDATE agent_runs SET status='preparing',"startedAt"=now(),"leaseExpiresAt"=$2 WHERE id=$1`, [runId,lease])
      return service.recordClaim(userId,deviceId,runId,lease,true)
    }
    // Real DB operations with explicit synthetic identities; no model/network acceptance claim.
    const sourceRunId = await queued()
    await assignments.selectBaseline(userId,sourceRunId)
    await claim(sourceRunId)
    await pool.query(`UPDATE agent_runs SET status='failed',"sessionId"='synthetic-source',"finishedAt"=now(),report='{"verify":{"status":"failed"}}' WHERE id=$1`, [sourceRunId])
    const feedback = await createImprovementStore(pool,authorize).recordFeedback(userId,{
      action:'feedback',eventId:randomUUID(),runId:sourceRunId,verdict:'negative',note:'Synthetic DB source fixture',
    })
    const proposalId=randomUUID(), taskId=randomUUID(), attemptId=randomUUID(), candidateId=randomUUID(), eventId=randomUUID(), executeRunId=await queued()
    const sha='a'.repeat(40),baseSha='b'.repeat(40)
    const report={sourceCommit:baseSha,publish:{commit:sha,pushed:true},verify:{status:'passed'}}
    await pool.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"='synthetic-execute',
      "startedAt"=now()-interval '1 minute',"finishedAt"=now(),report=$2 WHERE id=$1`,[executeRunId,JSON.stringify(report)])
    await pool.query(`INSERT INTO improvement_proposals(id,"userId",bucket,fingerprint,"issueId","scorerDigest",candidate,result,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'awaiting_model_candidate')`,[proposalId,userId,feedback.bucket,randomUUID(),issueId,SCORER_DIGEST,
      JSON.stringify({kind:'feedback_candidate_request_v1',path:SKILL_PATH,baseline:BASELINE_MARKDOWN,baselineDigest:BASELINE_ARTIFACT.sha256,baselineArtifact:BASELINE_ARTIFACT,sourceIds:[feedback.id]}),
      JSON.stringify({kind:'not_evaluated',state:'not_evaluated',productionEligible:false})])
    await pool.query(`INSERT INTO improvement_proposal_sources("proposalId","scoreId","userId",bucket,"runId") VALUES($1,$2,$3,$4,$5)`,[proposalId,feedback.id,userId,feedback.bucket,sourceRunId])
    await pool.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload) VALUES($1,$2,'user_message',$3,'{}')`,[eventId,userId,eventId])
    const tx=await pool.connect()
    try {
      await tx.query('BEGIN')
      await tx.query(`INSERT INTO factory_tasks(id,"userId","issueId","sourceEventId",route,stage,status,"attemptId",reason)
        VALUES($1,$2,$3,$4,'{}','execute','passed',$5,'Synthetic completed execute')`,[taskId,userId,issueId,eventId,attemptId])
      await tx.query(`INSERT INTO factory_candidates(id,"taskId",sha,repository,environment,scope,"runId") VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [candidateId,taskId,sha,repository,`device:${deviceId}`,`issue:${issueId}`,executeRunId])
      await tx.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"candidateId","runId","sessionId",reason)
        VALUES($1,$2,'execute',1,1,'passed',$3,$4,'synthetic-execute','Synthetic execute evidence')`,[attemptId,taskId,candidateId,executeRunId])
      await tx.query('UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1',[taskId,candidateId])
      await tx.query(`INSERT INTO improvement_factory_links("proposalId","userId","issueId","taskId","attemptId","runId",request)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[proposalId,userId,issueId,taskId,attemptId,executeRunId,JSON.stringify({agentId,deviceRepoId:repoId})])
      await tx.query('COMMIT')
    } catch(error) {await tx.query('ROLLBACK');throw error} finally {tx.release()}
    const binding={taskId,issueId,attemptId,revision:1,candidateId},input={proposalId,binding}
    const markdown='---\nname: Run report\n---\n\nSynthetic committed candidate for database boundary validation.\n'
    let reads=0
    const reader=async(source:{repository:string;sha:string;baseSha:string;path?:string})=>{
      reads++;assert.deepEqual(source,{repository,sha,baseSha,path:SKILL_PATH});return markdown
    }
    const registered=await registry.registerCandidate(userId,input,reader)
    const sourceTx=await pool.connect()
    try {
      await sourceTx.query('BEGIN')
      const current=await registry.readRegisteredCandidate(sourceTx,userId,taskId,candidateId)
      assert.deepEqual(current.artifact,registered.artifact)
      await sourceTx.query('COMMIT')
    }catch(error){await sourceTx.query('ROLLBACK');throw error}finally{sourceTx.release()}
    const replays=await Promise.all(Array.from({length:4},()=>registry.registerCandidate(userId,input,reader)))
    assert.ok(replays.every(item=>item.versionId===registered.versionId))
    assert.equal((await pool.query('SELECT * FROM improvement_skill_candidates')).rowCount,1)
    await assert.rejects(registry.registerCandidate(userId,input,async()=>markdown.replace('Synthetic','Changed')),/conflict/)
    const before=reads;allowed=false
    await assert.rejects(registry.registerCandidate(userId,input,reader),/notFound/)
    assert.equal(reads,before);allowed=true
    const activeRunId=await queued()
    await pool.query(`INSERT INTO improvement_skill_lifecycle(id,"userId","issueId","repoId","versionId",operation,"publicationId","approvalId")
      VALUES($1,$2,$3,$4,$5,'activate',$6,$7)`,[randomUUID(),userId,issueId,repoId,registered.versionId,randomUUID(),randomUUID()])
    await assignments.selectActive(userId,activeRunId)
    const prepared=await claim(activeRunId);assert.ok(prepared.skillReceipt&&prepared.skills)
    assert.equal(skillMarkdown(prepared.skills[0]),markdown)
    assert.deepEqual(prepared.skillReceipt.artifact,registered.artifact)
    await assignments.revalidate(userId,activeRunId,prepared.skillReceipt.id,true)
    const evalRunId=await queued(),evaluationId=randomUUID()
    const trusted=createSkillAssignments(pool,authorize,async(_tx,u,run,id,artifact)=>
      u===userId&&run.id===evalRunId&&id===evaluationId&&artifact.versionId===registered.versionId)
    const evaluationTx=await pool.connect()
    try {
      await evaluationTx.query('BEGIN')
      await assert.rejects(assignments.selectVersion(userId,evalRunId,registered.versionId,{purpose:'evaluation',evaluationId},evaluationTx),/sourceRequired/)
      await evaluationTx.query('ROLLBACK')
      await evaluationTx.query('BEGIN')
      await trusted.selectVersion(userId,evalRunId,registered.versionId,{purpose:'evaluation',evaluationId},evaluationTx)
      await evaluationTx.query('COMMIT')
    }catch(error){await evaluationTx.query('ROLLBACK');throw error}finally{evaluationTx.release()}
    await assert.rejects(assignments.preflight(userId,evalRunId,true),/sourceRequired/)
    await trusted.preflight(userId,evalRunId,true)
    await claim(evalRunId,trusted)
    await pool.query(`INSERT INTO improvement_skill_lifecycle(id,"userId","issueId","repoId","versionId",operation,"publicationId","approvalId")
      VALUES($1,$2,$3,$4,$5,'withdraw',$6,$7)`,[randomUUID(),userId,issueId,repoId,registered.versionId,randomUUID(),randomUUID()])
    await assert.rejects(assignments.revalidate(userId,activeRunId,prepared.skillReceipt.id,true),/runUnavailable/)
    assert.deepEqual((await assignments.renewHeartbeat(userId,deviceId,[activeRunId],true)).revoked,[activeRunId])
    const historical=await pool.connect()
    try {
      const run=(await historical.query('SELECT * FROM agent_runs WHERE id=$1',[activeRunId])).rows[0]
      assert.equal((await assignedSkillForRun(historical,userId,run)).skillUsage,'assigned')
      await assert.rejects(assignedSkillForRun(historical,userId,{...run,agentId:randomUUID()}),/sourceMismatch/)
    }finally{historical.release()}
    for(const table of ['improvement_skill_candidates','improvement_skill_lifecycle','improvement_skill_run_purposes'])
      await assert.rejects(pool.query(`DELETE FROM ${table}`),/immutable/)
    const baseline=(await pool.query('SELECT * FROM improvement_skill_versions WHERE id=$1',[BASELINE_ARTIFACT.versionId])).rows[0]
    assert.equal(baseline.markdown,BASELINE_MARKDOWN);assert.deepEqual(baseline.artifact,BASELINE_ARTIFACT)
    console.log(JSON.stringify({layer:'actual-PG-registry-assignment-boundary',sourceReader:'synthetic-test-double',modelCalls:0,retainedSchema:schema}))
  })
