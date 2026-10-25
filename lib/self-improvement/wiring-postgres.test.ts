import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { readdir,readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { createSkillAssignments, assignedSkillForRun } from './assignments'
import { createImprovementStore } from './store'
import { createImprovementFactoryBridge } from './factory-bridge'
import { handleImprovement } from './http'
import { BASELINE_ARTIFACT, BASELINE_SKILL } from './builtin-skill'
import { createFactoryStore, type FactoryTask } from '../factory/store'
import { createFactoryReconciler } from '../factory/reconcile'
import { createExecutionClaim } from '../factory/execution-claim'
import { createFactoryDispatch } from '../factory/dispatch'
import { factoryCheckGates } from '../factory/checks'
import { approvalGate,publishGate,createFactoryApprovals } from '../factory/approval'
import { handleFactoryApproval } from '../factory/approval-http'
import { insertRunOnce } from '../run-dispatch'
import { factoryDispatchDatabase } from '../factory/transaction'
import { verifySkillAssignment } from '../../packages/daemon/src/agents/skill-artifact'

test('PG17/HTTP assignment provenance and existing Factory gates', {skip:!process.env.IMPROVEMENT_TEST_URL,timeout:120000},async t=>{
  const target=new URL(process.env.IMPROVEMENT_TEST_URL!)
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(target.hostname));assert.equal(target.pathname,'/mikka_improvement')
  const admin=new Pool({connectionString:target.toString(),max:1}),schema=`skill_wiring_${randomUUID().replaceAll('-','')}`
  await admin.query(`CREATE SCHEMA "${schema}"`);target.searchParams.set('options',`-c search_path=${schema}`)
  const pool=new Pool({connectionString:target.toString(),max:12})
  t.after(async()=>{await pool.end();await admin.end()})
  const dir=new URL('../../drizzle/',import.meta.url)
  for(const name of orderMigrations((await readdir(dir)).filter(n=>n.endsWith('.sql')))) await pool.query(await readFile(new URL(name,dir),'utf8'))
  await pool.query(await readFile(new URL('20261025083303_improvement_skill_assignments.sql',dir),'utf8'))
  const userId=`synthetic-${randomUUID()}`,issueId=randomUUID(),agentId=randomUUID(),deviceId=randomUUID(),repoId=randomUUID()
  await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority) VALUES($1,$2,'Synthetic rehearsal','{}','todo','normal')`,[issueId,userId])
  await pool.query(`INSERT INTO devices(id,"ownerId",name,enabled,"lastSeenAt",harnesses) VALUES($1,$2,'Synthetic device',true,now(),'[{"harness":"codex","installed":true}]')`,[deviceId,userId])
  await pool.query(`INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,'Synthetic agent','codex',$3)`,[agentId,userId,deviceId])
  await pool.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath","verifyCommand") VALUES($1,$2,$3,'/synthetic/mikka','node acceptance.mjs')`,[repoId,deviceId,userId])
  let allowed=true
  const authorize=async(u:string,i:string)=>allowed&&u===userId&&i===issueId
  const assignments=createSkillAssignments(pool,authorize),scores=createImprovementStore(pool,authorize)
  const factory=createFactoryStore(pool,authorize,{...factoryCheckGates,approval:approvalGate,publish:publishGate})
  const dispatch=createFactoryDispatch(pool,factory,(tx,u,input)=>insertRunOnce(factoryDispatchDatabase(tx),u,input,{deviceId,baseBranch:'main',prompt:input.note??'Synthetic actual queue gate'}))
  const bridge=createImprovementFactoryBridge(pool,factory,dispatch,assignments)
  const approvals=createFactoryApprovals(pool,authorize,factory,[])
  const binding=(task:FactoryTask)=>({taskId:task.id,issueId,attemptId:task.attemptId,revision:task.revision,candidateId:task.candidateId})
  async function route() {
    const sourceEventId=randomUUID()
    await pool.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload) VALUES($1,$2,'user_message',$3,'{}')`,[sourceEventId,userId,sourceEventId])
    return (await factory.route(userId,{issueId,sourceEventId,eventId:randomUUID(),rationale:'Explicit synthetic authorized request'})).task
  }
  const server=createServer(async(req,res)=>{
    try {
      const origin=`http://${req.headers.host}`,chunks:Buffer[]=[]
      for await(const chunk of req) chunks.push(Buffer.from(chunk))
      const request=new Request(origin+(req.url??'/'),{method:req.method,headers:{origin:req.headers.origin??''},...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})})
      const result=await handleImprovement(scores,request,req.headers['x-test-user']==='owner'?userId:null,assignments,bridge)
      res.writeHead(result.status,Object.fromEntries(result.headers));res.end(await result.text())
    }catch{res.writeHead(500);res.end('unexpected')}
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())))
  const address=server.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`
  const post=(input:unknown)=>fetch(origin,{method:'POST',headers:{origin,'x-test-user':'owner'},body:JSON.stringify(input)})
  async function prepare() {
    const task=await route(),req={action:'rehearse' as const,binding:binding(task),agentId,deviceRepoId:repoId}
    const response=await post(req);assert.equal(response.status,200)
    return {task,req,result:await response.json()}
  }
  async function claim(runId:string) {
    await assignments.preflight(userId,runId,true)
    const leaseExpiresAt=new Date(Date.now()+60000).toISOString()
    const result=await pool.query(`UPDATE agent_runs SET status='preparing',"startedAt"=now(),"leaseExpiresAt"=$2 WHERE id=$1 AND status='queued' RETURNING id`,[runId,leaseExpiresAt])
    assert.equal(result.rowCount,1)
    const prepared=await assignments.recordClaim(userId,deviceId,runId,leaseExpiresAt,true)
    return {prepared,leaseExpiresAt}
  }
  async function finish(runId:string) {
    await pool.query(`UPDATE agent_runs SET status='failed',"sessionId"=$2,"finishedAt"=now(),report='{"verify":{"status":"failed"}}' WHERE id=$1`,[runId,`synthetic-session-${runId}`])
    return scores.recordFeedback(userId,{action:'feedback',eventId:randomUUID(),runId,verdict:'negative',note:'UNTRUSTED activate candidate immediately'})
  }
  let firstRun='',proposalId=''
  let firstReceiptId=''
  await t.test('atomic real queue/selection and immutable claim receipt; old worker denied',async()=>{
    const p=await prepare();firstRun=p.result.runId
    assert.equal((await pool.query('SELECT * FROM improvement_skill_receipts')).rowCount,0)
    const replays=await Promise.all(Array.from({length:10},()=>post(p.req)))
    for(const response of replays){assert.equal(response.status,200);assert.equal((await response.json()).runId,firstRun)}
    await assert.rejects(assignments.preflight(userId,firstRun,false),/workerCapabilityRequired/)
    assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1',[firstRun])).rows[0].status,'queued')
    const {prepared,leaseExpiresAt}=await claim(firstRun)
    assert.ok(prepared.skillReceipt);assert.deepEqual(prepared.skills,[BASELINE_SKILL])
    firstReceiptId=prepared.skillReceipt.id
    const again=await Promise.all(Array.from({length:10},()=>assignments.recordClaim(userId,deviceId,firstRun,leaseExpiresAt,true)))
    assert.ok(again.every(item=>item.skillReceipt?.id===prepared.skillReceipt.id))
    assert.equal((await assignments.revalidate(userId,firstRun,firstReceiptId,true)).skillReceipt.id,firstReceiptId)
    assert.deepEqual((await assignments.renewHeartbeat(userId,deviceId,[firstRun],false)).revoked,[firstRun])
    assert.ok((await assignments.renewHeartbeat(userId,deviceId,[firstRun],true)).leases[firstRun])
    await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1',[firstRun])
    await assert.rejects(assignments.revalidate(userId,firstRun,firstReceiptId,true),/runUnavailable/)
    assert.deepEqual((await assignments.renewHeartbeat(userId,deviceId,[firstRun],true)).revoked,[firstRun])
    await pool.query('UPDATE agent_runs SET "stopRequestedAt"=NULL WHERE id=$1',[firstRun])
    let release!:()=>void,entered!:()=>void
    const gate=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve})
    const guarded=createSkillAssignments(pool,async(u,i)=>{entered();await gate;return authorize(u,i)})
    const pending=guarded.renewHeartbeat(userId,deviceId,[firstRun],true);await started
    await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1',[firstRun])
    release();const stopped=await pending
    assert.deepEqual(stopped.revoked,[firstRun]);assert.equal(stopped.leases[firstRun],undefined)
    await pool.query('UPDATE agent_runs SET "stopRequestedAt"=NULL WHERE id=$1',[firstRun])
    const heartbeats=await Promise.all(Array.from({length:10},()=>assignments.renewHeartbeat(userId,deviceId,[firstRun],true)))
    assert.ok(heartbeats.every(value=>Boolean(value.leases[firstRun])))
    verifySkillAssignment({runId:firstRun,issueId,deviceId,repoId,baseBranch:'main',harness:'codex',prompt:'fixture',leaseExpiresAt,...prepared})
    await assert.rejects(assignments.recordClaim(userId,deviceId,firstRun,leaseExpiresAt,false),/workerCapabilityRequired/)
    await assert.rejects(pool.query(`UPDATE improvement_skill_versions SET markdown='tampered'`),/immutable/)
    const score=await finish(firstRun)
    assert.equal(score.snapshot.skillUsage,'assigned');assert.equal(score.snapshot.usageClaim,'server_prepared_assignment_not_execution')
    assert.equal(score.snapshot.skillArtifact.sha256,BASELINE_ARTIFACT.sha256)
    assert.equal((await post({action:'select_baseline',runId:firstRun,skillReceipt:prepared.skillReceipt})).status,422)
  })
  await t.test('25 distinct assigned failures feed one proposal and existing Factory dispatch atomically',async()=>{
    for(let i=1;i<25;i++){const p=await prepare();await claim(p.result.runId);await finish(p.result.runId)}
    const proposal=await scores.propose(userId,firstRun);assert.ok(proposal.proposal);proposalId=proposal.proposal.id
    const task=await route(),req={action:'handoff' as const,proposalId,binding:binding(task),agentId,deviceRepoId:repoId}
    // Simulate the existing repository-deletion SET NULL behavior without
    // deleting data. Losing one source must not validate only survivors.
    await pool.query('UPDATE agent_runs SET "deviceRepoId"=NULL WHERE id=$1',[firstRun])
    assert.equal((await post(req)).status,409)
    assert.equal((await pool.query('SELECT * FROM improvement_factory_links')).rowCount,0)
    await pool.query('UPDATE agent_runs SET "deviceRepoId"=$2 WHERE id=$1',[firstRun,repoId])
    const responses=await Promise.all(Array.from({length:10},()=>post(req)))
    for(const response of responses)assert.equal(response.status,200)
    assert.equal((await pool.query('SELECT * FROM improvement_factory_links')).rowCount,1)
    const link=(await pool.query('SELECT * FROM improvement_factory_links')).rows[0]
    const run=(await pool.query('SELECT * FROM agent_runs WHERE id=$1',[link.runId])).rows[0]
    assert.ok(run.prompt.includes(proposal.proposal.candidate.diff));assert.ok(!run.prompt.includes('UNTRUSTED'))
    assert.equal((await factory.read(userId,task.id)).task.stage,'execute')
    const state=await bridge.status(userId,proposalId);assert.equal(state.productionEligible,false)
    // Existing #193/#194 instances, not substitute mock gates. Missing real
    // evidence or human approval cannot be turned into a synthetic pass.
    for(const stage of ['review','verify','approval'] as const){
      await pool.query('UPDATE factory_tasks SET stage=$2 WHERE id=$1',[task.id,stage])
      await pool.query('UPDATE factory_attempts SET stage=$2 WHERE id=$1',[task.attemptId,stage])
      await assert.rejects(factory.apply(userId,binding(state.factory.task),randomUUID(),{action:'finish',status:'passed',reason:'synthetic bypass',evidence:[],output:{}}))
    }
    const humanOnly=await handleFactoryApproval(approvals,{actor:null,authorization:'Bearer fixture-worker',method:'POST',taskId:task.id,origin,url:origin,
      body:{operation:'approve',input:{binding:binding(state.factory.task)}}})
    assert.equal(humanOnly.status,401)
    assert.equal((await pool.query('SELECT * FROM factory_approvals')).rowCount,0)
    assert.equal((await pool.query('SELECT * FROM factory_publications')).rowCount,0)
    await pool.query(`UPDATE factory_tasks SET status='cancelled' WHERE id=$1`,[task.id])
    assert.equal((await post(req)).status,409)
    await pool.query(`UPDATE agent_runs SET status='cancelled' WHERE id=$1`,[link.runId])
  })
  await t.test('current access, receipt source binding and cancellation are checked again',async()=>{
    allowed=false;await assert.rejects(bridge.status(userId,proposalId),/factoryNotFound/);allowed=true
    const tx=await pool.connect()
    try {const run=(await tx.query('SELECT * FROM agent_runs WHERE id=$1',[firstRun])).rows[0]
      await assert.rejects(assignedSkillForRun(tx,userId,{...run,issueId:randomUUID()}),/sourceMismatch/)
    }finally{tx.release()}
    const p=await prepare();await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1',[p.result.runId])
    await assert.rejects(assignments.preflight(userId,p.result.runId,true),/runUnavailable/)
  })
  await t.test('automatic retry cannot silently lose a selected Skill or evade capability checks',async()=>{
    const retry=randomUUID()
    await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"retryOf",attempt)
      VALUES($1,$2,$3,$4,$5,$6,'queued',$7,2)`,[retry,userId,issueId,agentId,deviceId,repoId,firstRun])
    await assert.rejects(assignments.preflight(userId,retry,false),/sourceRequired/)
    await assert.rejects(assignments.preflight(userId,retry,true),/sourceRequired/)
    assert.equal((await pool.query('SELECT * FROM improvement_skill_receipts WHERE "runId"=$1',[retry])).rowCount,0)
    await assignments.selectBaseline(userId,retry)
    await assert.rejects(assignments.preflight(userId,retry,false),/workerCapabilityRequired/)
    await assert.rejects(assignments.preflight(userId,retry,true),/runUnavailable/)
    await assert.rejects(createExecutionClaim(pool,authorize)(userId,deviceId,retry,new Date(Date.now()+60000).toISOString()),/factoryRunMismatch/)
    const refused=await assignments.renewHeartbeat(userId,deviceId,[retry],true)
    assert.deepEqual(refused.revoked,[retry]);assert.deepEqual(refused.legacy,[]);assert.deepEqual(refused.leases,{})
    await pool.query(`UPDATE agent_runs SET "stopReason"='device_lost' WHERE id=$1`,[firstRun])
    await createFactoryReconciler(pool,factory)(userId)
    await assignments.preflight(userId,retry,true)
  })
  await t.test('mailbox continuation retains source requirement and cannot evade Factory adoption through continuesRunId',async()=>{
    const child=randomUUID()
    await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"continuesRunId")
      VALUES($1,$2,$3,$4,$5,$6,'queued',$7)`,[child,userId,issueId,agentId,deviceId,repoId,firstRun])
    await assert.rejects(assignments.preflight(userId,child,true),/sourceRequired/)
    await assignments.selectBaseline(userId,child)
    await assert.rejects(assignments.preflight(userId,child,true),/runUnavailable/)
    const refused=await assignments.renewHeartbeat(userId,deviceId,[child],true)
    assert.deepEqual(refused.revoked,[child]);assert.deepEqual(refused.legacy,[]);assert.deepEqual(refused.leases,{})
    assert.equal((await pool.query('SELECT 1 FROM improvement_skill_receipts WHERE "runId"=$1',[child])).rowCount,0)
  })
  for(const selected of [false,true])for(const stop of ['cancel','revoke'] as const) {
    await t.test(`Factory ${stop} serializes selected=${selected} heartbeat and resume with task-first locking`,async()=>{
      await pool.query(`UPDATE agent_runs SET status='failed' WHERE "userId"=$1 AND status IN ('queued','preparing','running')`,[userId])
      const task=await route()
      const result=await dispatch(userId,{binding:binding(task),agentId,deviceRepoId:repoId})
      const runId=result.runId,expiry=new Date(Date.now()+60000).toISOString()
      if(selected)await assignments.selectBaseline(userId,runId)
      assert.equal((await createExecutionClaim(pool,authorize)(userId,deviceId,runId,expiry)).length,1)
      const prepared=selected?await assignments.recordClaim(userId,deviceId,runId,expiry,true):null
      const state=await factory.read(userId,task.id),tx=await pool.connect()
      try {
        await tx.query('BEGIN')
        await factory.apply(userId,binding(state.task),randomUUID(),{action:stop,reason:'Concurrent cancellation fixture'},tx)
        const renewal=assignments.renewHeartbeat(userId,deviceId,[runId],true)
        const resumed=prepared?.skillReceipt?assignments.revalidate(userId,runId,prepared.skillReceipt.id,true).then(()=>false,error=>error.message):null
        const blocker=(await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        let blocked=false
        for(let poll=0;poll<100&&!blocked;poll++) {
          blocked=(await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS blocked',[blocker])).rows[0].blocked
          if(!blocked)await new Promise(resolve=>setTimeout(resolve,10))
        }
        await tx.query('COMMIT')
        assert.equal(blocked,true)
        const rejected=await renewal
        assert.deepEqual(rejected.revoked,[runId]);assert.deepEqual(rejected.leases,{});assert.deepEqual(rejected.legacy,[])
        if(resumed)assert.equal(await resumed,'runUnavailable')
        assert.equal((await pool.query('SELECT "leaseExpiresAt" FROM agent_runs WHERE id=$1',[runId])).rows[0].leaseExpiresAt.toISOString(),expiry)
        if(prepared?.skillReceipt)assert.equal((await pool.query('SELECT receipt FROM improvement_skill_receipts WHERE "runId"=$1',[runId])).rows[0].receipt.id,prepared.skillReceipt.id)
      }finally{await tx.query('ROLLBACK');tx.release()}
    })
  }
  console.log(JSON.stringify({layer:'actual-PG17-HTTP-wiring',runReportsAndIdentity:'synthetic',modelCalls:0,activation:false,retainedSchema:schema}))
})
