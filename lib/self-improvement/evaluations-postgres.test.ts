import { isolatedPostgresURL } from '../../tests/helpers/isolated-postgres.mjs'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { improvementTestDatabase } from './test-database'
import { createSkillAssignments } from './assignments'
import { createSkillComparisonCollector } from './comparison-collector'
import { createRegisteredSkillEvaluator } from './registered-evaluation'
import { syntheticDecision } from './testing/evaluation-fixture'
import { createSkillEvaluations, type EvaluationSettings } from './evaluations'
import { BASELINE_ARTIFACT, BASELINE_MARKDOWN } from './builtin-skill'
import { createImprovementStore } from './store'
import { digest } from './contract'
import { SCORER, SCORER_DIGEST } from './scorer'
import { SKILL_PATH } from './regression'
import { REPORT_BENCHMARK, freezeBenchmarkInstance } from './report-benchmark'

const databaseURL=improvementTestDatabase(process.env)
test('PG frozen benchmark queues actual owned assignments atomically and keeps seeds internal',
  {skip:!databaseURL,timeout:120000},async t=>{
    const target=new URL(await isolatedPostgresURL(databaseURL!)),schema=`skill_evaluation_${randomUUID().replaceAll('-','')}`
    const admin=new Pool({connectionString:target.toString(),max:1})
    await admin.query(`CREATE SCHEMA "${schema}"`)
    target.searchParams.set('options',`-c search_path=${schema}`)
    const pool=new Pool({connectionString:target.toString(),max:5})
    t.after(async()=>{await pool.end();await admin.end()})
    const dir=new URL('../../drizzle/',import.meta.url)
    for(const name of orderMigrations((await readdir(dir)).filter(n=>n.endsWith('.sql'))))
      await pool.query(await readFile(new URL(name,dir),'utf8'))
    const userId=`synthetic-${randomUUID()}`,issueId=randomUUID(),agentId=randomUUID(),deviceId=randomUUID(),repoId=randomUUID(),sourceRunId=randomUUID()
    await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority) VALUES($1,$2,'Evaluation boundary fixture','{}','todo','normal')`,[issueId,userId])
    await pool.query(`INSERT INTO devices(id,"ownerId",name,enabled) VALUES($1,$2,'Synthetic device',true)`,[deviceId,userId])
    await pool.query(`INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,'Synthetic agent','codex',$3)`,[agentId,userId,deviceId])
    await pool.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath") VALUES($1,$2,$3,'/synthetic/evaluation')`,[repoId,deviceId,userId])
    await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId",status) VALUES($1,$2,$3,$4,$5,$6,'queued')`,[sourceRunId,userId,issueId,agentId,deviceId,repoId])
    let allowed=true
    const authorize=async(u:string,i:string)=>allowed && u===userId && i===issueId
    let service:ReturnType<typeof createSkillEvaluations>
    const assignments=createSkillAssignments(pool,authorize,(...args)=>service.authorizeEvaluation(...args))
    await assignments.selectBaseline(userId,sourceRunId)
    const lease=new Date(Date.now()+60000).toISOString()
    await pool.query(`UPDATE agent_runs SET status='preparing',"startedAt"=now(),"leaseExpiresAt"=$2,"sessionId"='synthetic-session' WHERE id=$1`,[sourceRunId,lease])
    await assignments.recordClaim(userId,deviceId,sourceRunId,lease,true)
    await pool.query(`UPDATE agent_runs SET status='succeeded',"finishedAt"=now(),report=$2 WHERE id=$1`,[sourceRunId,JSON.stringify({sourceCommit:'a'.repeat(40),summary:'Synthetic source fixture'})])
    const settings:EvaluationSettings={harness:'codex',model:'synthetic-model',policyDigest:'b'.repeat(64),fixtureDigest:'c'.repeat(64),verifyCommand:REPORT_BENCHMARK.verifyCommand}
    let queueCalls=0,failSelection=false
    const loadComparison=createSkillComparisonCollector(pool,authorize,async()=>{throw Error('No stored object in this synthetic fixture')})
    const assess=createRegisteredSkillEvaluator({loadComparison,modelEvaluationEnabled:true,invokeDecision:syntheticDecision('improved')})
    service=createSkillEvaluations(pool,{authorize,assess,settings:async()=>settings,
      queue:async(tx,u,input)=>{
        queueCalls++
        assert.equal(u,userId)
        const runId=randomUUID()
        await tx.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"dispatchKey") VALUES($1,$2,$3,$4,$5,$6,'queued',$7)`,
          [runId,u,input.issueId,input.agentId,deviceId,input.deviceRepoId,input.requestKey])
        return {runId,status:'queued',replayed:false}
      },selectVersion:(...args)=>assignments.selectVersion(...args),selectBaseline:async(u,r,tx)=>{
        if(failSelection)throw Error('injected assignment failure')
        return assignments.selectBaseline(u,r,tx)
      }})
    const instance=await service.freezeBenchmark(userId,sourceRunId)
    assert.ok(!Object.hasOwn(instance,'seed'))
    assert.ok(!Object.hasOwn(instance,'cases'))
    assert.equal(instance.sourceCommit,'a'.repeat(40))
    assert.deepEqual(await service.freezeBenchmark(userId,sourceRunId),instance)
    await assert.rejects(service.freezeBenchmark('other',sourceRunId),/notFound/)
    allowed=false
    await assert.rejects(service.dispatchNext(userId,instance.id,true),/notFound/)
    allowed=true
    failSelection=true
    await assert.rejects(service.dispatchNext(userId,instance.id,true),/injected assignment failure/)
    assert.equal((await pool.query('SELECT * FROM improvement_benchmark_runs')).rowCount,0)
    assert.equal((await pool.query('SELECT * FROM agent_runs')).rowCount,1)
    failSelection=false
    const dispatched=await service.dispatchNext(userId,instance.id,true)
    assert.ok(dispatched.runId)
    const pending=await service.dispatchNext(userId,instance.id,true)
    assert.equal(pending.runId,dispatched.runId)
    assert.equal(queueCalls,2)
    const {rows:[run]}=await pool.query('SELECT * FROM agent_runs WHERE id=$1',[dispatched.runId])
    assert.equal(run.kind,'implement')
    assert.equal(run.baseBranch,instance.sourceCommit)
    const tx=await pool.connect()
    try {
      await tx.query('BEGIN')
      const assignment=await service.benchmarkAssignment(tx,userId,run.id)
      assert.equal(assignment?.benchmarkDigest,instance.instanceDigest)
      assert.equal(assignment?.caseId,REPORT_BENCHMARK.trainingCaseIds[0])
      await tx.query('ROLLBACK')
    } finally {tx.release()}
    for(const table of ['improvement_benchmark_instances','improvement_benchmark_runs']) {
      await assert.rejects(pool.query(`DELETE FROM ${table}`),/immutable/)
      await assert.rejects(pool.query(`UPDATE ${table} SET "userId"='forged'`),/immutable/)
    }
    const {rows:[binding]}=await pool.query('SELECT * FROM improvement_benchmark_runs WHERE "runId"=$1',[run.id])
    await assert.rejects(pool.query(`INSERT INTO improvement_benchmark_runs("runId","instanceId","caseId",arm,"versionId","userId") VALUES($1,$2,$3,'training',$4,$5)`,
      [randomUUID(),instance.id,binding.caseId,binding.versionId,userId]),/duplicate key/)
    async function settle(runId:string,correct:boolean) {
      const lease=new Date(Date.now()+60000).toISOString(),sessionId=randomUUID()
      await assignments.preflight(userId,runId,true)
      await pool.query(`UPDATE agent_runs SET status='preparing',"startedAt"=now(),"leaseExpiresAt"=$2,"sessionId"=$3 WHERE id=$1`,[runId,lease,sessionId])
      const claim=await assignments.recordClaim(userId,deviceId,runId,lease,true)
      assert.ok(claim.skillReceipt)
      const tx=await pool.connect()
      let context:NonNullable<Awaited<ReturnType<typeof service.benchmarkAssignment>>>
      try {
        await tx.query('BEGIN')
        context=(await service.benchmarkAssignment(tx,userId,runId))!
        assert.ok(context)
        await tx.query('ROLLBACK')
      } finally {tx.release()}
      const {rows:[storedInstance]}=await pool.query('SELECT * FROM improvement_benchmark_instances WHERE id=$1',[instance.id])
      const testCase=freezeBenchmarkInstance(storedInstance.seed).cases.find(item=>item.id===context.caseId)!
      const fields=testCase.expected
      const summary=correct ? JSON.stringify({...fields,unknowns:Object.entries(fields).filter(([,value])=>value===null || value==='unknown').map(([key])=>key)}) : '{}'
      const {model,...executionSettings}=context
      const execution={...executionSettings,requestedModel:model,observedModel:model}
      const report={sourceCommit:context.sourceCommit,summary,verify:{status:'passed',command:context.verifyCommand,exitCode:0}}
      await pool.query(`INSERT INTO improvement_skill_mounts("runId","userId","deviceId","receiptId","versionId",sha256,"sessionId","mountedAt",execution)
        VALUES($1,$2,$3,$4,$5,$6,$7,now(),$8)`,[runId,userId,deviceId,claim.skillReceipt.id,claim.skillReceipt.artifact.versionId,claim.skillReceipt.artifact.sha256,sessionId,JSON.stringify(execution)])
      await pool.query(`UPDATE agent_runs SET status='succeeded',"finishedAt"=now(),report=$2 WHERE id=$1`,[runId,JSON.stringify(report)])
      return report
    }
    // Actual SQL boundary fixtures are synthetic; this is not model acceptance.
    const trainingReport=await settle(run.id,false)
    const feedback=await createImprovementStore(pool,authorize).recordFeedback(userId,{action:'feedback',runId:run.id,eventId:randomUUID(),verdict:'negative',note:'Synthetic malformed report boundary'})
    const qualityTx=await pool.connect()
    let quality:Awaited<ReturnType<typeof service.trainingQuality>>
    try {
      await qualityTx.query('BEGIN')
      quality=await service.trainingQuality(qualityTx,userId,[{id:feedback.id,runId:run.id,reportDigest:digest(trainingReport)}])
      assert.equal(quality.instanceId,instance.id)
      assert.equal(quality.fields.command.missing,1)
      await assert.rejects(service.trainingQuality(qualityTx,userId,[{id:feedback.id,runId:run.id,reportDigest:'f'.repeat(64)}]),/sourceMismatch/)
      await qualityTx.query('ROLLBACK')
    } finally {qualityTx.release()}
    const proposalId=randomUUID(),taskId=randomUUID(),attemptId=randomUUID(),candidateId=randomUUID(),eventId=randomUUID()
    await pool.query(`INSERT INTO improvement_scorers(digest,id,version,definition) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[SCORER_DIGEST,SCORER.id,SCORER.version,JSON.stringify(SCORER)])
    await pool.query(`INSERT INTO improvement_proposals(id,"userId",bucket,fingerprint,"issueId","scorerDigest",candidate,result,status)
      VALUES($1,$2,'synthetic-eval',$3,$4,$5,$6,'{}','awaiting_model_candidate')`,[proposalId,userId,randomUUID(),issueId,SCORER_DIGEST,JSON.stringify({signals:{reportQuality:quality}})])
    await pool.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload) VALUES($1,$2,'user_message',$3,'{}')`,[eventId,userId,eventId])
    const factoryTx=await pool.connect()
    try {
      await factoryTx.query('BEGIN')
      await factoryTx.query(`INSERT INTO factory_tasks(id,"userId","issueId","sourceEventId",route,stage,status,"attemptId",reason)
        VALUES($1,$2,$3,$4,'{}','review','passed',$5,'Synthetic DB evaluation')`,[taskId,userId,issueId,eventId,attemptId])
      await factoryTx.query(`INSERT INTO factory_candidates(id,"taskId",sha,repository,environment,scope,"runId") VALUES($1,$2,$3,'example/public','synthetic','synthetic',$4)`,[candidateId,taskId,'d'.repeat(40),sourceRunId])
      await factoryTx.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"candidateId","runId",reason)
        VALUES($1,$2,'execute',1,1,'passed',$3,$4,'Synthetic DB fixture')`,[attemptId,taskId,candidateId,sourceRunId])
      await factoryTx.query('UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1',[taskId,candidateId])
      await factoryTx.query('COMMIT')
    } catch(error) {await factoryTx.query('ROLLBACK');throw error} finally {factoryTx.release()}
    const markdown=BASELINE_MARKDOWN+'Synthetic candidate boundary fixture.\n'
    const artifact={...BASELINE_ARTIFACT,versionId:candidateId,sha256:createHash('sha256').update(markdown).digest('hex')}
    await pool.query('INSERT INTO improvement_skill_versions(id,artifact,markdown) VALUES($1,$2,$3)',[candidateId,JSON.stringify(artifact),markdown])
    await pool.query(`INSERT INTO improvement_skill_candidates("versionId","userId","issueId","agentId","repoId","proposalId","factoryTaskId","candidateId",repository,"commitSha",path,"baselineVersionId")
      VALUES($1,$2,$3,$4,$5,$6,$7,$1,'example/public',$8,$9,$10)`,[candidateId,userId,issueId,agentId,repoId,proposalId,taskId,'d'.repeat(40),SKILL_PATH,BASELINE_ARTIFACT.versionId])
    const evaluation=await service.beginEvaluation(userId,instance.id,proposalId,candidateId)
    assert.equal((await service.beginEvaluation(userId,instance.id,proposalId,candidateId)).id,evaluation.id)
    await assert.rejects(service.beginEvaluation(userId,instance.id,randomUUID(),candidateId),/sourceMismatch/)
    await assert.rejects(service.compare(userId,evaluation.id),/sourceRequired/)
    assert.equal((await pool.query('SELECT * FROM improvement_evaluation_results')).rowCount,0)
    // A different preexisting source can never substitute for the proposal's frozen instance.
    const otherSourceId=randomUUID()
    await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId",status) VALUES($1,$2,$3,$4,$5,$6,'queued')`,[otherSourceId,userId,issueId,agentId,deviceId,repoId])
    await assignments.selectBaseline(userId,otherSourceId)
    await pool.query(`UPDATE agent_runs SET status='preparing',"startedAt"=now(),"leaseExpiresAt"=$2,"sessionId"='other-source' WHERE id=$1`,[otherSourceId,lease])
    await assignments.recordClaim(userId,deviceId,otherSourceId,lease,true)
    await pool.query(`UPDATE agent_runs SET status='succeeded',"finishedAt"=now(),report=$2 WHERE id=$1`,[otherSourceId,JSON.stringify({sourceCommit:'a'.repeat(40),summary:'Synthetic other source'})])
    const otherInstance=await service.freezeBenchmark(userId,otherSourceId)
    await assert.rejects(service.beginEvaluation(userId,otherInstance.id,proposalId,candidateId),/sourceMismatch/)
    for(let index=0;index<REPORT_BENCHMARK.evaluationCaseIds.length*2;index++) {
      const next=await service.dispatchNext(userId,evaluation.id)
      assert.ok(next.runId)
      await settle(next.runId,index>=REPORT_BENCHMARK.evaluationCaseIds.length)
    }
    assert.equal((await service.dispatchNext(userId,evaluation.id)).complete,true)
    const result=await service.compare(userId,evaluation.id)
    assert.equal(result.passed,true)
    assert.deepEqual(await service.compare(userId,evaluation.id),result)
    // Reorder heap rows physically: replay identities remain ordered by immutable case identity.
    await pool.query('CREATE INDEX evaluation_reorder_fixture ON improvement_benchmark_runs("caseId" DESC,arm DESC)')
    await pool.query('CLUSTER improvement_benchmark_runs USING evaluation_reorder_fixture')
    assert.deepEqual(await service.compare(userId,evaluation.id),result)
    const activationTx=await pool.connect()
    try {
      await activationTx.query('BEGIN')
      assert.equal((await service.passingEvaluation(activationTx,userId,proposalId,candidateId,evaluation.id)).result.passed,true)
      await activationTx.query('ROLLBACK')
    } finally {activationTx.release()}
    await pool.query(`UPDATE factory_tasks SET status='revoked' WHERE id=$1`,[taskId])
    await assert.rejects(service.compare(userId,evaluation.id),/runUnavailable/)
    await pool.query(`UPDATE factory_tasks SET status='passed' WHERE id=$1`,[taskId])
    await pool.query(`UPDATE devices SET enabled=false WHERE id=$1`,[deviceId])
    await assert.rejects(service.compare(userId,evaluation.id),/runUnavailable/)
    for(const table of ['improvement_skill_evaluations','improvement_evaluation_results']) {
      await assert.rejects(pool.query(`DELETE FROM ${table}`),/immutable/)
      const column=table==='improvement_evaluation_results'?'digest':'userId'
      await assert.rejects(pool.query(`UPDATE ${table} SET "${column}"='forged'`),/immutable/)
    }
    console.log(JSON.stringify({layer:'PG-evaluation-assignment-boundary',sessions:'synthetic',realModelCalls:0,decisionTransport:'synthetic',retainedSchema:schema}))
  })
