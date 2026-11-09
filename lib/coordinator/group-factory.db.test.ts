import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { authorizeGroupFactoryActor, delegateGroupTask, groupExecutionRemedy, groupTaskReferences, groupTaskReport, groupsWithPendingTaskReports, reconcileGroupTaskReports, type GroupFactoryAdapters } from './group-factory'
import { initializeGroupDecisionTrace, recordGroupDecisionRoute, type GroupDecisionTrace } from './group-decision-trace'
import { groupTraceObservation } from './group-decision-eval'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { createFactoryStore } from '../factory/store'
import { createLegacyFactoryStore } from '../../tests/helpers/factory-legacy'
import { createFactoryApprovalGates } from '../factory/approval'
import { createFactoryMerges } from '../factory/merge'
import type { FactoryBinding, FactoryEvidence } from '../factory/contract'
import { BASE_PATH } from '../base-path'

const url=disposableDatabase()?process.env.E2E_DATABASE_URL:undefined
if (process.env.REQUIRE_DB==='1' && !url) throw Error('REQUIRE_DB requires isolated *_e2e PG')

test('PG: group delegation has one Task/Thread, requester scope, replay receipt, latest epoch, status/stop and one reporter', {skip:!url},async()=>{
  const outer=new Pool({connectionString:url})
  const schema=`group_factory_${randomUUID().replaceAll('-','')}`
  await outer.query(`CREATE SCHEMA "${schema}"`)
  const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`})
  const client=await pool.connect()
  try {
    await client.query(await readFile(new URL('../../drizzle/20261023213851_group_conversations.sql',import.meta.url),'utf8'))
    await client.query(await readFile(new URL('../../drizzle/20261029043634_group_turns.sql',import.meta.url),'utf8'))
    await client.query(`CREATE TABLE bots (id uuid PRIMARY KEY); CREATE TABLE issues(id uuid PRIMARY KEY,title text,"userId" text);
      CREATE TABLE attention_settings("userId" text PRIMARY KEY,locale text);
      CREATE TABLE coordinator_events(id uuid PRIMARY KEY,"userId" text,"botId" uuid,"issueId" uuid,"runId" uuid,kind text,"dedupeKey" text,payload jsonb,tier text,"deliveredAt" timestamptz);
      CREATE TABLE factory_tasks(id uuid PRIMARY KEY,"userId" text,"botId" uuid,"issueId" uuid,"attemptId" uuid,status text,stage text,revision integer,"sourceEventId" uuid,"createdAt" timestamptz DEFAULT now());
      CREATE TABLE factory_attempts(id uuid PRIMARY KEY,"taskId" uuid,"runId" uuid,output jsonb DEFAULT '{}');
      CREATE TABLE factory_candidates(id uuid PRIMARY KEY,"taskId" uuid,"runId" uuid,kind text);
      CREATE TABLE factory_deliverable_acceptances(id uuid PRIMARY KEY,"taskId" uuid,"candidateId" uuid,"userId" text);
      CREATE TABLE factory_merges(id uuid PRIMARY KEY,"taskId" uuid,"candidateId" uuid,"userId" text,status text);
      CREATE TABLE artifacts(id uuid PRIMARY KEY,"runId" uuid,"issueId" uuid,"userId" text,kind text DEFAULT 'markdown',title text DEFAULT 'Fixture',"updatedAt" timestamptz DEFAULT now());
      CREATE TABLE artifact_versions("artifactId" uuid,version integer,"createdAt" timestamptz DEFAULT now());
      CREATE TABLE test_runs(id uuid PRIMARY KEY,"issueId" uuid,"threadId" uuid,"userId" text,"botId" uuid);
      CREATE VIEW agent_runs AS SELECT id,"issueId","userId" FROM test_runs;`)
    await client.query('ALTER TABLE factory_tasks ADD COLUMN "candidateId" uuid')
    await client.query(await readFile(new URL('../../drizzle/20261031153511_group_bot_members.sql',import.meta.url),'utf8'))
    await client.query(await readFile(new URL('../../drizzle/20261103220201_group_factory.sql',import.meta.url),'utf8'))
    await client.query(await readFile(new URL('../../drizzle/20261103220201_group_factory.sql',import.meta.url),'utf8'))
    await client.query(await readFile(new URL('../../drizzle/20261103220300_group_decision_quality.sql',import.meta.url),'utf8'))
    const conversationId=randomUUID(),workspaceId=randomUUID(),reporter=randomUUID(),executionBot=randomUUID()
    await client.query(`INSERT INTO conversations(id,"workspaceId",kind,title,"createdBy") VALUES($1,$2,'group','Group fixture','requester')`,[conversationId,workspaceId])
    await client.query(`INSERT INTO conversation_members("conversationId","memberType","memberId",role) VALUES($1,'user','requester','owner'),($1,'bot',$2,'member')`,[conversationId,reporter])
    let position=0
    const scope=async(operation:'create'|'continue'|'status'|'stop',issueId:string|null=null)=>{
      const messageId=randomUUID();position=Number((await client.query('UPDATE conversations SET "lastPosition"="lastPosition"+1 WHERE id=$1 RETURNING "lastPosition"',[conversationId])).rows[0].lastPosition)
      await client.query(`INSERT INTO conversation_messages(id,"conversationId",position,"authorType","authorId",body,mentions) VALUES($1,$2,$3,'user','requester','新增文件并完成验证','[]')`,[messageId,conversationId,position])
      await client.query(`INSERT INTO group_turns("messageId","conversationId","userId") VALUES($1,$2,'requester')`,[messageId,conversationId])
      await initializeGroupDecisionTrace(client,messageId,[],[])
      await recordGroupDecisionRoute(client,messageId,{by:'model',action:'delegate',responders:[reporter],delegation:{operation,issueId}})
      return {userId:'requester',workspaceId,conversationId,messageId,reporter:{id:reporter,name:'Reporter',description:'Public role',memberType:'bot' as const,executionAvailable:true},text:'新增文件并完成验证',delegation:{operation,issueId}}
    }
    const trace=async(messageId:string)=>(await client.query<{trace:GroupDecisionTrace}>('SELECT trace FROM group_turns WHERE "messageId"=$1',[messageId])).rows[0].trace
    let dispatches=0,authorizations=0,epochUpdates=0,stops=0,allowed=true
    const adapters:GroupFactoryAdapters={
      async authorize(input){authorizations++;assert.equal(input.userId,'requester');if(!allowed)throw Error('revoked')},
      async executionBot(){return{botId:executionBot,reporterOwnerId:'reporter-owner',repository:null}},
      async create(userId,eventId,title){
        const event=(await client.query('SELECT * FROM coordinator_events WHERE id=$1',[eventId])).rows[0]
        assert.equal(event.userId,userId);assert.equal(event.botId,executionBot);assert.equal(event.kind,'user_message')
        if(event.issueId)return event.issueId
        const issueId=randomUUID();await client.query('INSERT INTO issues VALUES($1,$2,$3)',[issueId,title,userId]);await client.query('UPDATE coordinator_events SET "issueId"=$2 WHERE id=$1',[eventId,issueId]);return issueId
      },
      async dispatch(userId,input,botId){
        dispatches++;assert.equal(userId,'requester');assert.equal(botId,executionBot);assert.equal(input.repo,undefined,'standalone work must not invent a repository')
        const event=(await client.query('SELECT * FROM coordinator_events WHERE id=$1',[input.sourceEventId])).rows[0]
        assert.equal(event.userId,userId);assert.equal(event.botId,executionBot);assert.equal(event.payload.conversationId,conversationId)
        const current=(await client.query('SELECT * FROM factory_tasks WHERE "issueId"=$1',[input.issueId])).rows[0]
        if(current){const run=(await client.query('SELECT "runId" FROM factory_attempts WHERE id=$1',[current.attemptId])).rows[0];return{runId:run.runId,thread:'message',status:'messageSent'}}
        const taskId=randomUUID(),attemptId=randomUUID(),runId=randomUUID()
        await client.query('INSERT INTO factory_tasks(id,"userId","botId","issueId","attemptId",status,stage,revision,"sourceEventId","createdAt") VALUES($1,$2,$3,$4,$5,\'running\',\'execute\',1,$6,now())',[taskId,userId,botId,input.issueId,attemptId,input.sourceEventId])
        await client.query('INSERT INTO factory_attempts(id,"taskId","runId",output) VALUES($1,$2,$3,$4)',[attemptId,taskId,runId,JSON.stringify({requestEpoch:input.sourceEventId})]);await client.query('INSERT INTO test_runs VALUES($1,$2,$1,$3,$4)',[runId,input.issueId,userId,botId]);return{runId,thread:'new',status:'queued'}
      },
      async latest(userId,issueId){return(await client.query('SELECT id FROM test_runs WHERE "issueId"=$1 AND "userId"=$2',[issueId,userId])).rows[0]??null},
      async continuation(userId,runId,text,eventId){epochUpdates++;const event=(await client.query('SELECT payload FROM coordinator_events WHERE id=$1',[eventId])).rows[0];assert.equal(event.payload.source,'thread_continuation');assert.equal(event.payload.previousRunId,runId);await client.query('UPDATE factory_tasks SET "sourceEventId"=$2,revision=revision+1 WHERE "userId"=$1',[userId,eventId]);await client.query('UPDATE factory_attempts SET output=$2 WHERE "runId"=$1',[runId,JSON.stringify({requestEpoch:eventId})])},
      async stop(userId,task,botId){assert.ok(!['cancelled','revoked'].includes(task.status),'Factory rejects a second cancel on a terminal task');stops++;assert.equal(botId,executionBot);await client.query('UPDATE factory_tasks SET status=\'cancelled\',revision=revision+1 WHERE id=$1 AND "userId"=$2',[task.taskId,userId])},
    }
    const first=await scope('create')
    const response=await delegateGroupTask(client,first,adapters)
    assert.match(response.text,/Factory/);assert.match(response.text,/\[Task\][\s\S]*\[Thread\]/)
    assert.deepEqual(await delegateGroupTask(client,first,adapters),response)
    assert.equal(dispatches,1)
    assert.equal((await trace(first.messageId)).events.filter(event=>event.type==='delegate' && event.outcome==='succeeded').length,1,'a receipt replay must not count another delegation')
    const refs=await groupTaskReferences(client,{userId:'requester',conversationId});assert.equal(refs.length,1);assert.equal(refs[0].reporterId,reporter)
    assert.deepEqual(await groupTaskReferences(client,{userId:'reporter-owner',conversationId}),[])
    const binding=(await client.query('SELECT * FROM group_task_bindings')).rows[0]
    assert.equal(binding.userId,'requester');assert.equal(binding.reporterOwnerId,'reporter-owner');assert.equal(binding.executionBotId,executionBot)
    const follow=await scope('continue',refs[0].issueId)
    const silent={...follow,delegation:{...follow.delegation,reportTiming:'on_completion' as const}}
    const silentReceipt=await delegateGroupTask(client,silent,adapters)
    assert.equal(silentReceipt.text,'');assert.equal(silentReceipt.taskReceipt?.outcome,'succeeded')
    await delegateGroupTask(client,silent,adapters)
    assert.equal(epochUpdates,1);assert.equal(dispatches,2)
    const intake=groupTraceObservation('silent-delegation',await trace(follow.messageId),null)
    assert.equal(intake.delegated,1);assert.equal(intake.generations,0);assert.equal(intake.published,0);assert.equal(intake.endToEndLatencyMs,null)
    for(const table of ['issues','factory_tasks','test_runs','group_task_bindings']) assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,1)
    const status=await scope('status',refs[0].issueId)
    await delegateGroupTask(client,status,adapters);assert.equal(dispatches,2)
    assert.equal((await trace(status.messageId)).events.length,0,'a status read is not a delegation')
    await assert.rejects(delegateGroupTask(client,{...await scope('continue',refs[0].issueId),reporter:{...first.reporter,id:randomUUID()}},adapters),/not_authorized/)
    await client.query(`UPDATE factory_tasks SET stage='review',status='passed',revision=revision+1`)
    assert.deepEqual(await groupsWithPendingTaskReports(client),[])
    assert.equal(await reconcileGroupTaskReports(conversationId,{pool,authorize:adapters.authorize}),0)
    await client.query(`UPDATE factory_tasks SET stage='approval',status='pending',revision=revision+1`)
    assert.deepEqual(await groupsWithPendingTaskReports(client),[conversationId])
    const progress=await delegateGroupTask(client,await scope('status',refs[0].issueId),adapters)
    assert.match(progress.text,/人工验收/);assert.equal(dispatches,2)
    assert.equal(await reconcileGroupTaskReports(conversationId,{pool,authorize:adapters.authorize}),0,'an explicit status reply already reported this revision')
    await client.query(`UPDATE factory_tasks SET stage='monitor',status='passed',revision=revision+1`)
    const artifactId=randomUUID()
    await client.query('INSERT INTO artifacts(id,"runId","issueId","userId") VALUES($1,$2,$3,\'requester\')',[artifactId,refs[0].runId,refs[0].issueId])
    await client.query('INSERT INTO artifact_versions("artifactId",version) VALUES($1,1)',[artifactId])
    assert.equal(await reconcileGroupTaskReports(conversationId,{pool,authorize:adapters.authorize}),1)
    assert.equal(await reconcileGroupTaskReports(conversationId,{pool,authorize:adapters.authorize}),0)
    const reports=(await client.query(`SELECT "authorId",body FROM conversation_messages WHERE "authorType"='bot'`)).rows
    assert.equal(reports.length,1);assert.equal(reports[0].authorId,reporter);assert.match(reports[0].body,/观察结果/);assert.ok(reports[0].body.includes(`artifact=${artifactId}`))
    const terminalTrace=await trace(follow.messageId)
    const terminal=groupTraceObservation('silent-delegation',terminalTrace,null)
    assert.equal(terminal.published,1);assert.equal(terminal.delegationCompleted,true);assert.ok(terminal.endToEndLatencyMs!==null)
    assert.equal(terminalTrace.events.filter(event=>event.type==='task_result').length,1,'a reconciler replay must not count another result')
    const stop=await scope('stop',refs[0].issueId)
    await delegateGroupTask(client,stop,adapters);await delegateGroupTask(client,stop,adapters);assert.equal(stops,1);assert.equal(dispatches,2)
    assert.equal((await trace(stop.messageId)).events.length,0,'a stop is not a new delegation')
    const feedback=(await client.query('SELECT * FROM group_decision_feedback')).rows
    assert.equal(feedback.length,1);assert.equal(feedback[0].messageId,follow.messageId);assert.equal(feedback[0].sourceMessageId,stop.messageId)
    assert.equal(feedback[0].source,'human_cancellation');assert.equal(feedback[0].kind,'cancelled_task');assert.equal(feedback[0].targetId,reporter)
    assert.equal((await trace(follow.messageId)).events.filter(event=>event.type==='task_result' && event.outcome==='stopped').length,1)
    const finishedAt=(await trace(follow.messageId)).taskFinishedAt
    const cancelledRevision=(await client.query('SELECT revision FROM factory_tasks WHERE id=$1',[refs[0].taskId])).rows[0].revision
    // The task cancellation survived a worker crash but its group receipt did
    // not. A replay must read the committed terminal state without reapplying.
    await client.query('UPDATE group_task_receipts SET result=NULL WHERE "messageId"=$1',[stop.messageId])
    assert.equal((await delegateGroupTask(client,stop,adapters)).taskReceipt?.outcome,'stopped')
    assert.equal((await delegateGroupTask(client,await scope('stop',refs[0].issueId),adapters)).taskReceipt?.outcome,'stopped')
    assert.equal(stops,1);assert.equal((await client.query('SELECT revision FROM factory_tasks WHERE id=$1',[refs[0].taskId])).rows[0].revision,cancelledRevision)
    assert.equal((await trace(follow.messageId)).events.filter(event=>event.type==='task_result' && event.outcome==='stopped').length,1)
    assert.equal((await trace(follow.messageId)).taskFinishedAt,finishedAt)
    assert.equal((await client.query('SELECT count(*)::int AS n FROM group_decision_feedback')).rows[0].n,1)
    await client.query(`INSERT INTO attention_settings("userId",locale) VALUES('requester','en'),('reporter-owner','zh-CN')`)
    const english=await delegateGroupTask(client,await scope('status',refs[0].issueId),adapters)
    assert.match(english.text,/Task status:/);assert.doesNotMatch(english.text,/[\u3400-\u9fff]/)
    assert.ok(english.text.includes(`${BASE_PATH}/en/`),'the initiating person selects the language, not the reporter owner')
    allowed=false;await assert.rejects(delegateGroupTask(client,first,adapters),/revoked/)
    assert.ok(authorizations>5)
    console.log(`Retained isolated group Factory bridge schema ${schema}; source/dispatch adapters synthetic, PG persistence real`)
  } finally {client.release();await pool.end();await outer.end()}
})

test('server reports do not claim work passed merely because execute passed',()=>{
  const text=groupTaskReport({issueId:'issue',taskId:'factory',runId:'run',requestEpoch:'epoch',revision:3,stage:'execute',status:'passed'}).text
  assert.match(text,/本阶段通过/);assert.doesNotMatch(text,/全部完成|已部署|人工验收通过/)
})

test('localized task, producer thread and artifact links use the application navigation owners',()=>{
  const issueId=randomUUID(),runId=randomUUID(),artifactId=randomUUID()
  for(const locale of ['zh-CN','en'] as const) {
    const text=groupTaskReport({issueId,taskId:randomUUID(),runId,requestEpoch:randomUUID(),revision:4,stage:'approval',status:'passed',acceptedDeliverable:true,artifacts:[{id:artifactId}]},undefined,locale).text
    const links=[...text.matchAll(/\]\(([^)]+)\)/g)].map(match=>new URL(match[1],'https://fixture.invalid'))
    assert.equal(links.length,4)
    for(const link of links) {assert.equal(link.searchParams.get('issue'),issueId);assert.equal(link.pathname,locale==='en'?`${BASE_PATH}/en/`:BASE_PATH || '/')}
    assert.equal(links[1].searchParams.get('thread'),runId);assert.equal(links[2].searchParams.get('thread'),runId)
    assert.equal(links[3].searchParams.get('artifact'),artifactId)
    assert.match(text,locale==='en'?/Task completed:/:/任务已完成/)
    if(locale==='en')assert.doesNotMatch(text,/[\u3400-\u9fff]/)
    for(const reason of ['repositoryRequired','noDevice','task_tool_disabled','execution_unavailable']) {
      const remedy=groupExecutionRemedy(reason,locale)
      assert.ok(remedy.length>20)
      if(locale==='en')assert.doesNotMatch(remedy,/[\u3400-\u9fff]/)
    }
  }
})

for(const flowVersion of [2,1] as const)for(const kind of ['deliverable','repository'] as const)test(`PG: real Factory flow ${flowVersion} ${kind} acceptance publishes one final report with current-epoch artifact and producer thread`, {skip:!url,timeout:120000},async()=>{
  const outer=new Pool({connectionString:url})
  // pg_trgm is database-scoped; a fresh loopback *_e2e database keeps its
  // extension out of concurrently running schema fixtures.
  const database=`group_accepted_${randomUUID().replaceAll('-','')}_e2e`
  await outer.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
  const target=new URL(url!);target.pathname=`/${database}`
  const pool=new Pool({connectionString:target.toString()})
  try {
    const migrationDir=new URL('../../drizzle/',import.meta.url)
    for(const file of orderMigrations((await readdir(migrationDir)).filter(name=>name.endsWith('.sql'))))await pool.query(await readFile(new URL(file,migrationDir),'utf8'))
    const userId='accepted-fixture-owner',workspaceId=randomUUID(),botId=randomUUID(),agentId=randomUUID(),issueId=randomUUID(),sourceEventId=randomUUID()
    const locale=kind==='repository'?'en':'zh-CN'
    await pool.query('INSERT INTO attention_settings("userId",locale) VALUES($1,$2)',[userId,locale])
    const actor={userId,sessionId:'accepted-fixture-session'}
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,'Fixture','group-acceptance@example.invalid',true,now(),now())`,[userId])
    await pool.query(`INSERT INTO "session"(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES($1,$2,'fixture-only-no-real-login',now()+interval '1 hour',now(),now())`,[actor.sessionId,userId])
    await seedFixtureWorkspace(pool,userId,'team',workspaceId)
    await pool.query(`INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,'Reporter')`,[botId,userId,workspaceId])
    await pool.query(`INSERT INTO agents(id,"userId",name,harness) VALUES($1,$2,'Synthetic execution','codex')`,[agentId,userId])
    await pool.query(`INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority) VALUES($1,$2,$3,'Standalone deliverable','{}','todo','normal')`,[issueId,userId,workspaceId])
    await pool.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload) VALUES($1::uuid,$2,$3,$4,'user_message',$1::uuid::text,'{"text":"Produce the standalone deliverable"}')`,[sourceEventId,userId,botId,issueId])
    const authorize=async(owner:string,issue:string,tx:import('pg').PoolClient)=>(await tx.query('SELECT 1 FROM issues WHERE id=$1 AND "userId"=$2',[issue,owner])).rowCount===1
    const gates=createFactoryApprovalGates()
    // Only upstream execution/check outputs are fixtures. The store,
    // owner/source checks, acceptance gate and final reconciliation are real.
    const store=(flowVersion===2?createFactoryStore:createLegacyFactoryStore)(pool,authorize,botId,{independent:async()=>true,gates:{review:async()=>true,verify:async()=>true,approval:gates.approval,publish:gates.publish}})
    const binding=(task:{id:string;issueId:string;attemptId:string;candidateId:string|null;revision:number}):FactoryBinding=>({taskId:task.id,issueId:task.issueId,attemptId:task.attemptId,candidateId:task.candidateId,revision:task.revision})
    let state=await store.route(userId,{issueId,sourceEventId,eventId:randomUUID(),rationale:'Synthetic upstream deliverable fixture',missingInformation:[],missingPermissions:[],needsSpec:false})
    let producerRun=''
    const sha=kind==='repository'?'a'.repeat(40):null
    assert.equal(state.task.route.flowVersion,flowVersion===2?2:undefined)
    const stages=flowVersion===2?['execute','review'] as const:['execute','review','verify'] as const
    for(const stage of stages) {
      const runId=randomUUID(),sessionId=`fixture-${stage}-${randomUUID()}`
      await pool.query(`INSERT INTO agent_runs(id,"userId","botId","issueId","agentId",kind,status,"sessionId","startedAt") VALUES($1,$2,$3,$4,$5,$6,'running',$7,clock_timestamp())`,[runId,userId,botId,issueId,agentId,stage==='execute'?'implement':'acceptance',sessionId])
      state=await store.apply(userId,binding(state.task),randomUUID(),{action:'bind_run',runId})
      if(stage==='execute') {
        producerRun=runId
        state=await store.apply(userId,binding(state.task),randomUUID(),{action:'candidate',runId,candidate:kind==='deliverable'?{kind,sha:null,repository:'none',environment:'fixture-deliverable',scope:'standalone file'}:{sha:sha!,repository:'fixture/repository',environment:'fixture-deliverable',scope:'repository changes'}})
      }
      await pool.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"finishedAt"=clock_timestamp(),report=$2 WHERE id=$1`,[runId,JSON.stringify({summary:'Synthetic upstream evidence; no real Harness run',sourceCommit:'a'.repeat(40),publish:{commit:sha},verify:{status:'passed'}})])
      const recordedAt=(await pool.query("SELECT clock_timestamp()+interval '1 second' AS at")).rows[0].at.toISOString()
      const evidence:FactoryEvidence={artifact:`run-report:${runId}`,kind:'report',runId,sessionId,candidateId:state.task.candidateId,sha,environment:'fixture-deliverable',recordedAt}
      state=await store.apply(userId,binding(state.task),randomUUID(),{action:'finish',status:'passed',reason:'Synthetic independent upstream evidence',evidence:[evidence],output:{}})
      state=await store.apply(userId,binding(state.task),randomUUID(),{action:'advance',stage:stage==='execute'?'review':stage==='review'&&flowVersion===1?'verify':'approval',reason:'Proceed through real store'})
    }
    assert.equal(state.attempts.filter(attempt=>attempt.stage==='review').length,1)
    assert.equal(state.attempts.filter(attempt=>attempt.stage==='verify').length,flowVersion===2?0:1)
    const artifactId=randomUUID(),staleArtifactId=randomUUID(),oldRun=randomUUID(),conversationId=randomUUID(),messageId=randomUUID()
    await pool.query(`INSERT INTO agent_runs(id,"userId","botId","issueId","agentId",status) VALUES($1,$2,$3,$4,$5,'succeeded')`,[oldRun,userId,botId,issueId,agentId])
    // The continuation updates the same artifact created by an earlier run.
    // Only its v2 host receipt associates it with the current request epoch.
    for(const id of [artifactId,staleArtifactId]) {
      await pool.query(`INSERT INTO artifacts(id,"userId","runId","issueId",title,kind,"latestVersion") VALUES($1,$2,$3,$4,'Accepted file','markdown',$5)`,[id,userId,oldRun,issueId,id===artifactId?2:1])
      for(const [version,runId] of (id===artifactId?[[1,oldRun],[2,producerRun]]:[[1,oldRun]]) as [number,string][]) {
        await pool.query(`INSERT INTO artifact_versions(id,"artifactId",version,"storageKey","inlineContent",sha256,size,"authorName") VALUES($1,$2,$3,'fixture','accepted bytes',$4,14,'Fixture')`,[randomUUID(),id,version,'a'.repeat(64)])
        await pool.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId","runId",kind,"dedupeKey",payload) VALUES($1,$2,$3,$4,$5,'artifact_submitted',$6,$7)`,[randomUUID(),userId,botId,issueId,runId,`artifact_submitted:${id}:${version}`,JSON.stringify({artifactId:id,version,title:'Accepted file',artifactKind:'markdown',authorName:'Fixture'})])
      }
    }
    await pool.query(`INSERT INTO conversations(id,"workspaceId",kind,title,"createdBy","lastPosition") VALUES($1,$2,'group','Accepted fixture',$3,1)`,[conversationId,workspaceId,userId])
    await pool.query(`INSERT INTO conversation_members("conversationId","memberType","memberId",role) VALUES($1,'user',$2,'owner'),($1,'bot',$3,'member')`,[conversationId,userId,botId])
    await pool.query(`INSERT INTO conversation_messages(id,"conversationId",position,"authorType","authorId",body) VALUES($1,$2,1,'user',$3,'Create a deliverable, report when finished')`,[messageId,conversationId,userId])
    await pool.query(`INSERT INTO group_turns("messageId","conversationId","userId") VALUES($1,$2,$3)`,[messageId,conversationId,userId])
    await initializeGroupDecisionTrace(pool,messageId,[],[])
    await pool.query(`INSERT INTO group_task_bindings("conversationId","issueId","userId","reporterId","reporterOwnerId","reporterType","executionBotId","sourceMessageId","sourceEventId") VALUES($1,$2,$3,$4,$3,'bot',$4,$5,$6)`,[conversationId,issueId,userId,botId,messageId,sourceEventId])
    const dependencies={pool,authorize:async(scope:Parameters<GroupFactoryAdapters['authorize']>[0])=>{assert.equal(scope.userId,userId);assert.equal(scope.reporter.id,botId)}}
    assert.equal(await reconcileGroupTaskReports(conversationId,dependencies),1,'approval pending is a required human input, not completed work')
    assert.equal(await reconcileGroupTaskReports(conversationId,dependencies),0,'the same pending revision does not repeat')
    const pending=(await pool.query(`SELECT body FROM conversation_messages WHERE "authorType"='bot'`)).rows[0]
    assert.match(pending.body,locale==='en'?/required human acceptance/:/仍需/);assert.doesNotMatch(pending.body,/任务已完成|Task completed:/)
    await assert.rejects(store.apply(userId,binding(state.task),randomUUID(),{action:'finish',status:'passed',reason:'Forged acceptance must not pass',evidence:state.attempts.flatMap(attempt=>attempt.evidence) as FactoryEvidence[],output:{deliverableAcceptanceId:randomUUID()}}),/factoryConsumerGateRequired/)
    if(kind==='repository')await pool.query(`INSERT INTO run_publications("runId","userId","issueId","remoteUrl","remoteKey","pullRequest") VALUES($1,$2,$3,'https://github.com/fixture/repository','fixture/repository',$4)`,[producerRun,userId,issueId,JSON.stringify({url:'https://github.com/fixture/repository/pull/1',state:'open'})])
    let mergeCalls=0
    const merges=createFactoryMerges(pool,authorize,store,{pullRequest:async()=>{assert.equal(kind,'repository');return{state:'open',merged:false,headSha:sha!,mergeableState:'clean',mergeCommitSha:null}},mergeMethods:async()=>['squash'],merge:async()=>{assert.equal(kind,'repository');mergeCalls++;return{merged:true,mergeCommitSha:'b'.repeat(40)}}})
    const request={binding:binding(state.task),eventId:randomUUID()}
    const accepted=await merges.accept(actor,request,kind==='repository'?'synthetic-owner-credential':null)
    assert.equal(accepted.status,kind==='deliverable'?'accepted':'merged');assert.deepEqual(await merges.accept(actor,request,kind==='repository'?'synthetic-owner-credential':null),accepted)
    assert.equal(mergeCalls,kind==='deliverable'?0:1)
    const done=await store.read(userId,state.task.id)
    assert.equal(done.task.stage,kind==='deliverable'?'approval':'publish');assert.equal(done.task.status,'passed')
    assert.equal(done.attempts.find(attempt=>attempt.id===done.task.attemptId)?.output.requestEpoch,sourceEventId)
    assert.deepEqual(await groupsWithPendingTaskReports(pool),[conversationId])
    assert.equal(await reconcileGroupTaskReports(conversationId,dependencies),1)
    assert.equal(await reconcileGroupTaskReports(conversationId,dependencies),0)
    const reports=(await pool.query(`SELECT "authorId","replyToId",body FROM conversation_messages WHERE "authorType"='bot' ORDER BY position`)).rows
    assert.equal(reports.length,2);assert.equal(reports[1].authorId,botId);assert.equal(reports[1].replyToId,messageId)
    assert.match(reports[1].body,locale==='en'?/Task completed:/:/任务已完成/);assert.doesNotMatch(reports[1].body,/已部署|deployed/);assert.ok(reports[1].body.includes(`artifact=${artifactId}`));assert.ok(reports[1].body.includes(`thread=${producerRun}`))
    assert.ok(!reports[1].body.includes(staleArtifactId),'a prior-epoch artifact cannot be presented as the current accepted result')
    assert.equal((await pool.query('SELECT "runId" FROM artifacts WHERE id=$1',[artifactId])).rows[0].runId,oldRun,'reporting the submitted v2 never rewrites its creator')
    if(locale==='en')assert.doesNotMatch(reports[1].body,/[\u3400-\u9fff]/)
    const trace=(await pool.query('SELECT trace FROM group_turns WHERE "messageId"=$1',[messageId])).rows[0].trace as GroupDecisionTrace
    assert.equal(trace.events.filter(event=>event.type==='task_result' && event.outcome==='succeeded').length,1);assert.ok(trace.taskFinishedAt)
    assert.equal(trace.events.filter(event=>event.type==='publish').length,2)
    console.log(`Retained ${database}; real Factory store/acceptance/reconciliation, synthetic upstream execution and browser session`)
  } finally {await pool.end();await outer.end()}
})

test('PG: production group Factory authorization uses typed Bot membership and rechecks both current workspace owners', {skip:!url},async()=>{
  const outer=new Pool({connectionString:url})
  const schema=`group_factory_authorization_${randomUUID().replaceAll('-','')}`
  await outer.query(`CREATE SCHEMA "${schema}"`)
  const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`})
  try {
    await pool.query(await readFile(new URL('../../drizzle/20261023213851_group_conversations.sql',import.meta.url),'utf8'))
    await pool.query(await readFile(new URL('../../drizzle/20261029043634_group_turns.sql',import.meta.url),'utf8'))
    await pool.query(await readFile(new URL('../../drizzle/20261031153511_group_bot_members.sql',import.meta.url),'utf8'))
    await pool.query(`CREATE TABLE bots(id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid,"archivedAt" timestamptz);
      CREATE TABLE workspace_members("userId" text,"workspaceId" uuid,status text,PRIMARY KEY("userId","workspaceId"))`)
    const workspaceId=randomUUID(),otherWorkspaceId=randomUUID(),conversationId=randomUUID(),botId=randomUUID()
    const userId='requester-with-non-uuid-id',reporterOwner='reporter-owner-with-non-uuid-id'
    await pool.query(`INSERT INTO conversations(id,"workspaceId",kind,title,"createdBy") VALUES($1,$2,'group','Authorization fixture',$3)`,[conversationId,workspaceId,userId])
    await pool.query(`INSERT INTO bots VALUES($1,$2,$3,NULL)`,[botId,userId,workspaceId])
    await pool.query(`INSERT INTO conversation_members("conversationId","memberType","memberId",role)
      VALUES($1,'user',$2,'owner'),($1,'bot',$3,'member'),($1,'bot','non-uuid-member','member')`,[conversationId,userId,botId])
    await pool.query(`INSERT INTO workspace_members VALUES($1,$2,'active'),($3,$2,'active'),($1,$4,'active')`,[userId,workspaceId,reporterOwner,otherWorkspaceId])
    const scope={userId,workspaceId,conversationId,reporter:{id:botId,name:'Reporter',description:'',memberType:'bot' as const}}
    const checks:string[]=[]
    const authorizeWorkspace=async(owner:string,workspace:string)=>{
      checks.push(owner)
      if (!(await pool.query(`SELECT 1 FROM workspace_members WHERE "userId"=$1 AND "workspaceId"=$2 AND status='active'`,[owner,workspace])).rowCount) throw Error('workspaceAccessDenied')
    }
    await authorizeGroupFactoryActor(pool,scope,authorizeWorkspace)
    assert.deepEqual(checks,[userId,userId],'production helper preserves both requester and actual Bot-owner checks')
    await assert.rejects(authorizeGroupFactoryActor(pool,{...scope,reporter:{...scope.reporter,id:'non-uuid-member'}},authorizeWorkspace),/group_task_not_authorized/,'text group identities must not be cast to UUID')
    await assert.rejects(authorizeGroupFactoryActor(pool,{...scope,workspaceId:otherWorkspaceId},authorizeWorkspace),/group_task_not_authorized/)
    await pool.query(`UPDATE conversation_members SET "leftAt"=now() WHERE "memberId"=$1`,[botId])
    await assert.rejects(authorizeGroupFactoryActor(pool,scope,authorizeWorkspace),/group_task_not_authorized/)
    await pool.query(`UPDATE conversation_members SET "leftAt"=NULL WHERE "memberId"=$1`,[botId])
    await pool.query(`UPDATE conversation_members SET "leftAt"=now() WHERE "memberId"=$1`,[userId])
    await assert.rejects(authorizeGroupFactoryActor(pool,scope,authorizeWorkspace),/group_task_not_authorized/)
    await pool.query(`UPDATE conversation_members SET "leftAt"=NULL WHERE "memberId"=$1`,[userId])
    await pool.query(`UPDATE bots SET "archivedAt"=now() WHERE id=$1`,[botId])
    await assert.rejects(authorizeGroupFactoryActor(pool,scope,authorizeWorkspace),/group_task_not_authorized/)
    await pool.query(`UPDATE bots SET "archivedAt"=NULL,"ownerId"=$2 WHERE id=$1`,[botId,reporterOwner])
    checks.length=0
    await authorizeGroupFactoryActor(pool,scope,authorizeWorkspace)
    assert.deepEqual(checks,[userId,reporterOwner])
    await pool.query(`UPDATE workspace_members SET status='left' WHERE "userId"=$1`,[reporterOwner])
    await assert.rejects(authorizeGroupFactoryActor(pool,scope,authorizeWorkspace),/workspaceAccessDenied/)
    await pool.query(`UPDATE workspace_members SET status='left' WHERE "userId"=$1`,[userId])
    checks.length=0
    await assert.rejects(authorizeGroupFactoryActor(pool,scope,authorizeWorkspace),/workspaceAccessDenied/)
    assert.deepEqual(checks,[userId])
  } finally {await pool.end();await outer.query(`DROP SCHEMA "${schema}" CASCADE`);await outer.end()}
})
