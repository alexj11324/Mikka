import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { Pool } from 'pg';
import { FactoryError, type FactoryRoute } from './contract';
import { createFactoryStore, type FactoryAuthorize } from './store';
import { createFactoryDispatch, factoryBinding, type FactoryQueue } from './dispatch';
import { createFactoryQuestions, questionReference } from './questions/store';
import { createFactoryClaim } from './claim';
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
    assert.equal((await questions.answer({source:'orchestrator',userId:'owner'},answer)).continuationRunId,result.continuationRunId);
    await denies(()=>questions.answer({source:'orchestrator',userId:'owner'},{...answer,answerId:randomUUID()}),'factoryQuestionAnswerConflict');
    const tx=await pool.connect();
    try {
      await tx.query('BEGIN');
      const assignment=await claim(tx,'owner',deviceId,result.continuationRunId,new Date(Date.now()+60000).toISOString());
      assert.equal(assignment.resumeSessionId,'original-session');
      assert.equal(assignment.requireSessionResume,true);
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
  await t.test('asked_human completion reconciles into waiting rather than cancelled',async()=>{
    const r=await store.route('owner',await fixture());
    const d=await dispatch('owner',{binding:factoryBinding(r.task),agentId,deviceRepoId:repoId});
    await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',"sessionId"='reconcile-session',report='{"openQuestions":["Need input"]}' WHERE id=$1`,[d.runId]);
    await createFactoryReconciler(pool,store,questions)('owner');
    assert.equal((await store.read('owner',r.task.id)).task.status,'waiting');
  });
}
