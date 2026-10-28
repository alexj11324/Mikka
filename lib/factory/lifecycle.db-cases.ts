import { personalRunMessageText } from '../personal-run-message';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { handleFactoryQuestion } from './questions/http';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { Pool } from 'pg';
import { FactoryError, type FactoryRoute } from './contract';
import { createFactoryStore, type FactoryAuthorize } from './store';
import { createFactoryDispatch, factoryBinding, type FactoryQueue } from './dispatch';
import { createFactoryQuestions, questionReference } from './questions/store';
import { createFactoryClaim } from './claim';
import { claimLocalRun } from '../computer/claim';
import { factoryCheckIndependent } from './check-independence';
import { createFactoryReconciler } from './reconcile';

export async function lifecycleCases(t:TestContext,pool:Pool,authorize:FactoryAuthorize,fixture:()=>Promise<FactoryRoute>) {
  const denies=(fn:()=>Promise<unknown>,code:string)=>assert.rejects(fn,e=>e instanceof FactoryError&&e.code===code);
  const deviceId=randomUUID(),agentId=randomUUID(),repoId=randomUUID();
  await pool.query(`INSERT INTO devices (id,"ownerId",name,"lastSeenAt",harnesses) VALUES ($1,'owner','Disposable lifecycle',now(),'[{"harness":"codex","installed":true}]')`,[deviceId]);
  await pool.query(`INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,'owner','Fixture','codex',$2)`,[agentId,deviceId]);
  await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath") VALUES ($1,$2,'owner','/fixture/repo')`,[repoId,deviceId]);
  const store=createFactoryStore(pool,authorize,null,{});
  let rejectConfiguration=false;
  const queue:FactoryQueue=async(tx,userId,input,botId)=>{
    const runId=randomUUID();
    await tx.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",status,prompt) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued','Fixture')`,[runId,userId,input.issueId,input.agentId,deviceId,input.deviceRepoId,botId]);
    return {runId};
  };
  const dispatch=createFactoryDispatch(pool,store,queue,{configure:{execute:async()=>{if(rejectConfiguration)throw new Error('configuration failed');}},freeze:async(tx,_task,id)=>{await tx.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1',[id,JSON.stringify({schemaVersion:1,definitionDigest:'fixture',harness:'codex'})]);}});
  const questions=createFactoryQuestions(pool,authorize,store,dispatch);
  const claim=createFactoryClaim(store,questions);
  const input=await fixture();
  let state=await store.route('owner',input);
  const request={binding:factoryBinding(state.task),agentId,deviceRepoId:repoId};
  let dispatched!:Awaited<ReturnType<typeof dispatch>>;
  await t.test('transactional dispatch rollback, ten-way replay and complete payload fence',async()=>{
    rejectConfiguration=true;
    await assert.rejects(dispatch('owner',request),/configuration failed/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1',[input.issueId])).rows[0].n,0);
    rejectConfiguration=false;
    const results=await Promise.all(Array.from({length:10},()=>dispatch('owner',request)));
    assert.equal(new Set(results.map(r=>r.runId)).size,1);
    assert.equal(results.filter(r=>!r.replayed).length,1);
    dispatched=results[0];
    await denies(()=>dispatch('owner',{...request,note:'different'}),'factoryReplayMismatch');
    await denies(()=>dispatch('other',request),'factoryNotFound');
    assert.equal(dispatched.binding.revision,request.binding.revision+1);
  });
  await t.test('actual local claim and token callback commit atomically; cancellation revokes before further claim',async()=>{
    const r=await store.route('owner',await fixture());
    const d=await dispatch('owner',{binding:factoryBinding(r.task),agentId,deviceRepoId:repoId});
    const lease=new Date(Date.now()+60000),tokenId=randomUUID();
    const before=async(tx:import('pg').PoolClient)=>{
      try{await claim(tx,'owner',deviceId,d.runId,lease.toISOString());return true;}
      catch(error){if(error instanceof FactoryError)return false;throw error;}
    };
    const token=async(tx:import('pg').PoolClient)=>{await tx.query('INSERT INTO run_tokens(id,"runId","userId","tokenHash","expiresAt") VALUES ($1,$2,$3,$4,$5)',[tokenId,d.runId,'owner',randomUUID(),lease]);};
    await assert.rejects(claimLocalRun(pool,d.runId,deviceId,lease,undefined,before,async tx=>{await token(tx);throw new Error('token callback interrupted');}),/interrupted/);
    assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1',[d.runId])).rows[0].status,'queued');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM run_tokens WHERE id=$1',[tokenId])).rows[0].n,0);
    assert.equal(await claimLocalRun(pool,d.runId,deviceId,lease,undefined,before,token),'claimed');
    await store.apply('owner',d.binding,randomUUID(),{action:'cancel',reason:'Cancel before worker proceeds'});
    assert.ok((await pool.query('SELECT "revokedAt" FROM run_tokens WHERE id=$1',[tokenId])).rows[0].revokedAt);
    let issuedAgain=false;
    assert.equal(await claimLocalRun(pool,d.runId,deviceId,lease,undefined,before,async()=>{issuedAgain=true;}),'unavailable');
    assert.equal(issuedAgain,false);
  });
  await t.test('question context facts, persisted waiting, continuation CAS and session fence',async()=>{
    await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',"sessionId"='original-session',report=$2 WHERE id=$1`,[dispatched.runId,JSON.stringify({question:{questionId:randomUUID(),kind:'context',question:'Which request?',options:[]}})]);
    const q=await questions.record('owner',dispatched.runId);
    state=await store.read('owner',state.task.id);
    assert.equal(state.task.status,'waiting');
    assert.equal(q.waitingBinding.revision,q.originRevision+1);
    const answer={reference:questionReference(q),answerId:randomUUID(),facts:[{kind:'request' as const,sourceEventId:input.sourceEventId,quote:'Actual synthetic personal request'}]};
    await denies(()=>questions.answer({source:'orchestrator',userId:'owner'},{...answer,facts:[{...answer.facts[0],quote:'invented'}]}),'factoryQuestionFactMismatch');
    const result=await questions.answer({source:'orchestrator',userId:'owner'},answer);
    assert.equal(result.task.revision,q.waitingBinding.revision+2);
    assert.equal((await pool.query('SELECT text FROM run_messages WHERE id=$1',[answer.answerId])).rows[0].text,personalRunMessageText(answer.answerId,answer.facts[0].quote,'peer'));
    assert.equal((await questions.answer({source:'orchestrator',userId:'owner'},answer)).continuationRunId,result.continuationRunId);
    await denies(()=>questions.answer({source:'orchestrator',userId:'owner'},{...answer,answerId:randomUUID()}),'factoryQuestionAnswerConflict');
    const tx=await pool.connect();
    try {
      await tx.query('BEGIN');
      const assignment=await claim(tx,'owner',deviceId,result.continuationRunId,new Date(Date.now()+60000).toISOString());
      assert.equal(assignment.resumeSessionId,'original-session');
      assert.equal(assignment.requireSessionResume,true);
      assert.equal(assignment.preserveQuestionWorktree,true);
      await tx.query('ROLLBACK');
    } finally {tx.release();}
    await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',"sessionId"='different-session' WHERE id=$1`,[result.continuationRunId]);
    await questions.settle('owner',result.continuationRunId);
    assert.equal((await store.read('owner',state.task.id)).task.status,'blocked');
  });
  await t.test('permission question cannot be answered by model; cancel blocks human replay and claim',async()=>{
    const r=await store.route('owner',await fixture());
    const d=await dispatch('owner',{binding:factoryBinding(r.task),agentId,deviceRepoId:repoId});
    await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',"sessionId"='permission-session',report=$2 WHERE id=$1`,[d.runId,JSON.stringify({question:{questionId:randomUUID(),kind:'permission',question:'May I publish?',options:[]}})]);
    const q=await questions.record('owner',d.runId);
    await denies(()=>questions.answer({source:'orchestrator',userId:'owner'},{reference:questionReference(q),answerId:randomUUID(),facts:[{kind:'issue',quote:'Fixture'}]}),'factoryQuestionHumanRequired');
    const current=await store.read('owner',r.task.id);
    await store.apply('owner',factoryBinding(current.task),randomUUID(),{action:'cancel',reason:'Cancelled'});
    await denies(()=>questions.answer({source:'human',userId:'owner',sessionId:'not-a-session'},{reference:questionReference(q),answerId:randomUUID(),text:'yes'}),'factoryStopped');
    assert.equal((await questions.read('owner',q.id)).status,'cancelled');
  });
  await t.test('real loopback HTTP: authenticated human only, origin, strict body, duplicate and cancelled answer fences',async()=>{
    const r=await store.route('owner',await fixture());
    const d=await dispatch('owner',{binding:factoryBinding(r.task),agentId,deviceRepoId:repoId});
    await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',"sessionId"='human-session',report=$2 WHERE id=$1`,[d.runId,JSON.stringify({question:{questionId:randomUUID(),kind:'permission',question:'Confirm requested scope?',options:[]}})]);
    const q=await questions.record('owner',d.runId), sessionId=randomUUID();
    await pool.query(`INSERT INTO "session"(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES ($1,'owner',$2,now()+interval '1 hour',now(),now())`,[sessionId,randomUUID()]);
    let origin='';
    const server=createServer(async(req,res)=>{
      try {
        const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
        const cookie=req.headers.cookie;
        const result=await handleFactoryQuestion(questions,{
          actor:cookie==='fixture=owner'?{userId:'owner',sessionId}:cookie==='fixture=other'?{userId:'other',sessionId}:null,
          authorization:req.headers.authorization??null,method:req.method??'GET',questionId:q.id,
          origin:req.headers.origin??null,url:origin+req.url,
          body:chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined,
        });
        res.writeHead(result.status,{'content-type':'application/json'});res.end(JSON.stringify(result.body));
      }catch{res.writeHead(500);res.end();}
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    origin=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const answer={reference:questionReference(q),answerId:randomUUID(),text:'Continue within the already authorized scope'};
    const send=(body:unknown,headers:Record<string,string>={})=>fetch(origin+'/'+q.id,{method:'POST',headers:{'content-type':'application/json',cookie:'fixture=owner',origin,...headers},body:JSON.stringify(body)});
    try {
      assert.equal((await fetch(origin+'/'+q.id)).status,401);
      assert.equal((await fetch(origin+'/'+q.id,{headers:{cookie:'fixture=other'}})).status,404);
      assert.equal((await send(answer,{authorization:'Bearer synthetic-test'})).status,401);
      assert.equal((await send(answer,{origin:'https://foreign.invalid'})).status,403);
      assert.equal((await send({...answer,source:'human'})).status,422);
      const responses=await Promise.all(Array.from({length:10},()=>send(answer)));
      for (const response of responses) assert.equal(response.status,200);
      const results=await Promise.all(responses.map(response=>response.json() as Promise<{continuationRunId:string}>));
      assert.equal(new Set(results.map(result=>result.continuationRunId)).size,1);
      const result=results[0];
      assert.equal((await pool.query('SELECT text FROM run_messages WHERE id=$1',[answer.answerId])).rows[0].text,answer.text);
      const replay=await send(answer);assert.equal(replay.status,200);
      assert.equal((await replay.json() as {continuationRunId:string}).continuationRunId,result.continuationRunId);
      const current=await store.read('owner',r.task.id);
      await store.apply('owner',factoryBinding(current.task),randomUUID(),{action:'cancel',reason:'Stop continuation'});
      assert.equal((await send(answer)).status,409);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1',[r.task.issueId])).rows[0].n,2);
    }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
  });
  await t.test('expired questions refuse new answers while another task progresses independently',async()=>{
    const r=await store.route('owner',await fixture());
    const d=await dispatch('owner',{binding:factoryBinding(r.task),agentId,deviceRepoId:repoId});
    await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',"sessionId"='expired-session',report=$2 WHERE id=$1`,[d.runId,JSON.stringify({question:{questionId:randomUUID(),kind:'context',question:'Need source?',options:[]}})]);
    const q=await questions.record('owner',d.runId);
    assert.ok(q.expiresAt);
    const other=await store.route('owner',await fixture());
    const progressing=await dispatch('owner',{binding:factoryBinding(other.task),agentId,deviceRepoId:repoId});
    assert.equal(progressing.task.status,'running');
    assert.equal((await store.read('owner',r.task.id)).task.status,'waiting');
    await pool.query(`UPDATE factory_questions SET "expiresAt"=now()-interval '1 second' WHERE id=$1`,[q.id]);
    await denies(()=>questions.answer({source:'orchestrator',userId:'owner'},{reference:questionReference(q),answerId:randomUUID(),facts:[{kind:'issue',quote:'Fixture'}]}),'factoryQuestionExpired');
    assert.equal((await questions.read('owner',q.id)).status,'expired');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1',[r.task.issueId])).rows[0].n,1);
  });
  await t.test('unadopted retry and revoked issue access cannot claim',async()=>{
    const r=await store.route('owner',await fixture());
    const d=await dispatch('owner',{binding:factoryBinding(r.task),agentId,deviceRepoId:repoId});
    const child=randomUUID();
    await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId",status,"retryOf") VALUES ($1,'owner',$2,$3,$4,'queued',$5)`,[child,r.task.issueId,agentId,deviceId,d.runId]);
    const tx=await pool.connect();
    try {await tx.query('BEGIN');await denies(()=>claim(tx,'owner',deviceId,child,new Date().toISOString()),'factoryClaimStale');await tx.query('ROLLBACK');}finally{tx.release();}
    await pool.query('UPDATE issues SET "userId"=$2 WHERE id=$1',[r.task.issueId,'other']);
    await denies(()=>dispatch('owner',{binding:factoryBinding(r.task),agentId,deviceRepoId:repoId}),'factoryNotFound');
  });
  await t.test('monitor cycle CAS keeps old passed evidence and same candidate',async()=>{
    const r=await store.route('owner',await fixture());
    const candidateId=randomUUID();
    await pool.query(`INSERT INTO factory_candidates(id,"taskId",sha,repository,environment,scope,"runId") VALUES ($1,$2,$3,'fixture','test','fixture',$4)`,[candidateId,r.task.id,'a'.repeat(40),randomUUID()]);
    await pool.query(`UPDATE factory_tasks SET stage='monitor',status='passed',"candidateId"=$2 WHERE id=$1`,[r.task.id,candidateId]);
    await pool.query(`UPDATE factory_attempts SET stage='monitor',status='passed',"candidateId"=$2,evidence='[{"fixture":true}]' WHERE id=$1`,[r.task.attemptId,candidateId]);
    const original=await store.read('owner',r.task.id), binding=factoryBinding(original.task),id=randomUUID();
    await denies(()=>store.apply('owner',{...binding,candidateId:randomUUID()},id,{action:'retry',reason:'next'}),'factoryStale');
    const next=await store.apply('owner',binding,id,{action:'retry',reason:'next'});
    assert.equal(next.task.candidateId,candidateId);assert.equal(next.task.status,'pending');
    assert.deepEqual(next.attempts[0].evidence,[{fixture:true}]);assert.deepEqual(next.attempts[1].evidence,[]);
    assert.equal(next.attempts[1].ordinal,2);assert.equal(next.attempts[1].runId,null);
    assert.deepEqual(await store.apply('owner',binding,id,{action:'retry',reason:'next'}),next);
    await denies(()=>store.apply('owner',binding,randomUUID(),{action:'retry',reason:'next'}),'factoryStale');
    await denies(()=>store.apply('owner',factoryBinding(next.task),randomUUID(),{action:'finish',status:'passed',reason:'model says passed',evidence:[],output:{}}),'factoryIndependentRunRequired');
  });
  await t.test('actual v2 predicate accepts persisted monitor question ancestry for pass and failure',async()=>{
    for(const verdict of ['passed','failed'] as const) {
      const phaseStore=createFactoryStore(pool,authorize,null,{independent:factoryCheckIndependent,gates:{monitor:async(_tx,_task,attempt,change)=>attempt.sessionId==='monitor-question-session'&&change.output.fixtureReceipt===true}});
      const phaseDispatch=createFactoryDispatch(pool,phaseStore,queue,{configure:{monitor:async(tx,_task,id)=>{await tx.query("UPDATE agent_runs SET kind='acceptance',\"baseBranch\"=$2 WHERE id=$1",[id,'a'.repeat(40)]);}},freeze:async(tx,_task,id)=>{await tx.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1',[id,JSON.stringify({schemaVersion:1,definitionDigest:'monitor-fixture',harness:'codex'})]);}});
      const phaseQuestions=createFactoryQuestions(pool,authorize,phaseStore,phaseDispatch);
      const route=await fixture(),r=await phaseStore.route('owner',route),candidateId=randomUUID();
      await pool.query(`INSERT INTO factory_candidates(id,"taskId",sha,repository,environment,scope,"runId") VALUES ($1,$2,$3,'fixture','test','fixture',$4)`,[candidateId,r.task.id,'a'.repeat(40),randomUUID()]);
      await pool.query(`UPDATE factory_tasks SET stage='monitor',"candidateId"=$2 WHERE id=$1`,[r.task.id,candidateId]);
      await pool.query(`UPDATE factory_attempts SET stage='monitor',"candidateId"=$2 WHERE id=$1`,[r.task.attemptId,candidateId]);
      const pending=await phaseStore.read('owner',r.task.id);
      const first=await phaseDispatch('owner',{binding:factoryBinding(pending.task),agentId,deviceRepoId:repoId});
      await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',"sessionId"='monitor-question-session',report=$2 WHERE id=$1`,[first.runId,JSON.stringify({question:{questionId:randomUUID(),kind:'context',question:'Need original context?',options:[]}})]);
      const q=await phaseQuestions.record('owner',first.runId);
      const resumed=await phaseQuestions.answer({source:'orchestrator',userId:'owner'},{reference:questionReference(q),answerId:randomUUID(),facts:[{kind:'request',sourceEventId:route.sourceEventId,quote:'Actual synthetic personal request'}]});
      await pool.query(`UPDATE agent_runs SET status=$2,"stopReason"='submitted',"sessionId"='monitor-question-session',report='{"fixture":true}' WHERE id=$1`,[resumed.continuationRunId,verdict==='passed'?'succeeded':'failed']);
      await phaseQuestions.settle('owner',resumed.continuationRunId);
      const current=await phaseStore.read('owner',r.task.id);
      const result=await phaseStore.apply('owner',factoryBinding(current.task),randomUUID(),{action:'finish',status:verdict,reason:'Synthetic receipt fixture, no provider',evidence:[{kind:'report',artifact:`run-report:${resumed.continuationRunId}`,runId:resumed.continuationRunId,sessionId:'monitor-question-session',candidateId,sha:'a'.repeat(40),environment:'test',recordedAt:new Date().toISOString()}],output:{fixtureReceipt:true}});
      assert.equal(result.task.status,verdict);
      assert.equal(result.attempts[0].status,'waiting');
      assert.equal(result.attempts[1].sessionId,'monitor-question-session');
    }
  });
  await t.test('missing consumer blocks only its task and does not stall another question',async()=>{
    const r=await store.route('owner',await fixture());
    const d=await dispatch('owner',{binding:factoryBinding(r.task),agentId,deviceRepoId:repoId});
    await pool.query("UPDATE factory_tasks SET stage='monitor' WHERE id=$1",[r.task.id]);
    await pool.query("UPDATE factory_attempts SET stage='monitor' WHERE id=$1",[r.task.attemptId]);
    await pool.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"='missing-consumer' WHERE id=$1`,[d.runId]);
    const other=await store.route('owner',await fixture());
    const queued=await dispatch('owner',{binding:factoryBinding(other.task),agentId,deviceRepoId:repoId});
    await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',"sessionId"='independent-question',report='{"openQuestions":["Need input"]}' WHERE id=$1`,[queued.runId]);
    await createFactoryReconciler(pool,store,questions)('owner');
    assert.equal((await store.read('owner',r.task.id)).task.status,'blocked');
    assert.equal((await store.read('owner',other.task.id)).task.status,'waiting');
  });
  await t.test('asked_human completion reconciles into waiting rather than cancelled',async()=>{
    const r=await store.route('owner',await fixture());
    const d=await dispatch('owner',{binding:factoryBinding(r.task),agentId,deviceRepoId:repoId});
    await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',"sessionId"='reconcile-session',report='{"openQuestions":["Need input"]}' WHERE id=$1`,[d.runId]);
    await createFactoryReconciler(pool,store,questions)('owner');
    assert.equal((await store.read('owner',r.task.id)).task.status,'waiting');
  });
}
