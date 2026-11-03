import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { delegateGroupTask, groupTaskReferences, groupTaskReport, groupsWithPendingTaskReports, reconcileGroupTaskReports, type GroupFactoryAdapters } from './group-factory'
import { initializeGroupDecisionTrace, recordGroupDecisionRoute, type GroupDecisionTrace } from './group-decision-trace'
import { groupTraceObservation } from './group-decision-eval'

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
      CREATE TABLE coordinator_events(id uuid PRIMARY KEY,"userId" text,"botId" uuid,"issueId" uuid,kind text,"dedupeKey" text,payload jsonb,tier text,"deliveredAt" timestamptz);
      CREATE TABLE factory_tasks(id uuid PRIMARY KEY,"userId" text,"botId" uuid,"issueId" uuid,"attemptId" uuid,status text,stage text,revision integer,"sourceEventId" uuid,"createdAt" timestamptz DEFAULT now());
      CREATE TABLE factory_attempts(id uuid PRIMARY KEY,"taskId" uuid,"runId" uuid,output jsonb DEFAULT '{}');
      CREATE TABLE artifacts(id uuid PRIMARY KEY,"runId" uuid,"issueId" uuid,"userId" text,"updatedAt" timestamptz DEFAULT now());
      CREATE TABLE test_runs(id uuid PRIMARY KEY,"issueId" uuid,"threadId" uuid,"userId" text,"botId" uuid);`)
    await client.query(await readFile(new URL('../../drizzle/20261031153511_group_bot_members.sql',import.meta.url),'utf8'))
    await client.query(await readFile(new URL('../../drizzle/20261103220000_group_factory.sql',import.meta.url),'utf8'))
    await client.query(await readFile(new URL('../../drizzle/20261103220000_group_factory.sql',import.meta.url),'utf8'))
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
        assert.equal(event.userId,userId);assert.equal(event.botId,null);assert.equal(event.kind,'user_message')
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
        await client.query('INSERT INTO factory_tasks VALUES($1,$2,$3,$4,$5,\'running\',\'execute\',1,$6,now())',[taskId,userId,botId,input.issueId,attemptId,input.sourceEventId])
        await client.query('INSERT INTO factory_attempts(id,"taskId","runId",output) VALUES($1,$2,$3,$4)',[attemptId,taskId,runId,JSON.stringify({requestEpoch:input.sourceEventId})]);await client.query('INSERT INTO test_runs VALUES($1,$2,$1,$3,$4)',[runId,input.issueId,userId,botId]);return{runId,thread:'new',status:'queued'}
      },
      async latest(userId,issueId){return(await client.query('SELECT id FROM test_runs WHERE "issueId"=$1 AND "userId"=$2',[issueId,userId])).rows[0]??null},
      async continuation(userId,runId,text,eventId){epochUpdates++;const event=(await client.query('SELECT payload FROM coordinator_events WHERE id=$1',[eventId])).rows[0];assert.equal(event.payload.source,'thread_continuation');assert.equal(event.payload.previousRunId,runId);await client.query('UPDATE factory_tasks SET "sourceEventId"=$2,revision=revision+1 WHERE "userId"=$1',[userId,eventId]);await client.query('UPDATE factory_attempts SET output=$2 WHERE "runId"=$1',[runId,JSON.stringify({requestEpoch:eventId})])},
      async stop(userId,task,botId){stops++;assert.equal(botId,executionBot);await client.query('UPDATE factory_tasks SET status=\'cancelled\',revision=revision+1 WHERE id=$1 AND "userId"=$2',[task.taskId,userId])},
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
    allowed=false;await assert.rejects(delegateGroupTask(client,first,adapters),/revoked/)
    assert.ok(authorizations>5)
    console.log(`Retained isolated group Factory bridge schema ${schema}; source/dispatch adapters synthetic, PG persistence real`)
  } finally {client.release();await pool.end();await outer.end()}
})

test('server reports do not claim work passed merely because execute passed',()=>{
  const text=groupTaskReport({issueId:'issue',taskId:'factory',runId:'run',requestEpoch:'epoch',revision:3,stage:'execute',status:'passed'}).text
  assert.match(text,/本阶段通过/);assert.doesNotMatch(text,/全部完成|已部署|人工验收通过/)
})
