import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'

const valid = disposableDatabase() && process.env.E2E_DATABASE_URL === process.env.MIKKA_DATABASE_URL && process.env.E2E_DATABASE_URL === process.env.DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !valid) throw new Error('Eve settlement tests require matching isolated loopback _e2e databases')

test('host settlement receipts preserve product publication across native RPC retries', {skip:!valid}, async t => {
  const {pool} = await import('../db')
  for (const migration of ['20261111070100_eve_sessions.sql','20261111070200_eve_settlements.sql']) await pool.query(await readFile(new URL('../../drizzle/'+migration,import.meta.url),'utf8'))
  const {finishEveTurn} = await import('./settlement')
  const {registerSession} = await import('./scope')
  const ownerId='eve-settlement-'+randomUUID(),botId=randomUUID(),workspaceId=randomUUID()
  const scope={ownerId,botId,workspaceId,surface:'web' as const}
  const scheduleIds:string[]=[]
  const nativeSession = async () => {const id='wrun_'+randomUUID();await registerSession(scope,id);return id}
  async function scheduled() {
    const eventId=randomUUID(),scheduleId=randomUUID(),occurrenceId=randomUUID(),lease=randomUUID(),sessionId=await nativeSession()
    scheduleIds.push(scheduleId)
    const definition={title:'Read task fixture',timezone:'UTC',timing:{kind:'once',at:new Date().toISOString()},task:{kind:'agent_read',prompt:'Read tasks and summarize',allowedActions:['list_issues']},misfire:'catch_up_once',maxLatenessMinutes:5}
    await pool.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload,tier)VALUES($1,$2,$3,'run_report',($1::uuid)::text,$4,'attention')`,[eventId,ownerId,botId,{source:'schedule_due'}])
    await pool.query(`INSERT INTO user_schedules(id,owner_id,workspace_id,bot_id,source_event_id,request_id,definition,request_definition,status)VALUES($1,$2,$3,$4,$5,($1::uuid)::text,$6,$6,'active')`,[scheduleId,ownerId,workspaceId,botId,eventId,definition])
    await pool.query(`INSERT INTO schedule_occurrences(id,schedule_id,version,due_at,definition,status,execution_decision,operation_id,event_id,attempts,next_retry_at,lease_token,lease_until)VALUES($1,$2,1,now(),$3,'running','execute',$4,$5,1,now(),$6,now()+interval '5 minutes')`,[occurrenceId,scheduleId,definition,randomUUID(),eventId,lease])
    await pool.query('INSERT INTO eve_turn_sources(session_id,turn_id,source_event_id)VALUES($1,$2,$3)',[sessionId,'turn_0',eventId])
    return {sessionId,occurrenceId,eventId}
  }
  try {
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt")VALUES($1,'Eve settlement fixture',$2,true,now(),now())`,[ownerId,ownerId+'@example.invalid'])
    await pool.query(`INSERT INTO mikka_workspaces(id,"userId",name)VALUES($1,$2,'Eve settlement fixture')`,[workspaceId,ownerId])
    await pool.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role)VALUES($1,$2,'Owner',$3,'admin')`,[workspaceId,ownerId,ownerId+'@example.invalid'])
    await pool.query(`INSERT INTO bots(id,"ownerId","workspaceId",name)VALUES($1,$2,$3,'Eve settlement fixture')`,[botId,ownerId,workspaceId])
    await t.test('completed root survives concurrent finish and effect committed before receipt acknowledgement',async()=>{
      const {sessionId,occurrenceId}=await scheduled()
      const input={sessionId,turnId:'turn_0',outcome:'completed' as const,messages:[{role:'assistant',content:[{type:'text',text:'Combined root result'}]}]}
      await Promise.all([finishEveTurn(scope,input),finishEveTurn(scope,input)])
      await pool.query('UPDATE eve_turn_settlements SET completed_at=NULL WHERE session_id=$1',[sessionId])
      assert.deepEqual(await finishEveTurn(scope,input),{status:'accepted'})
      const row=(await pool.query('SELECT status FROM schedule_occurrences WHERE id=$1',[occurrenceId])).rows[0]
      assert.equal(row.status,'succeeded')
      const reports=(await pool.query('SELECT message FROM coordinator_messages WHERE "userId"=$1 AND message->>\'mikkaStreamId\'=$2',[ownerId,`eve:${sessionId}:turn_0`])).rows
      assert.equal(reports.length,1)
      assert.equal(reports[0].message.content,'Combined root result')
      await assert.rejects(finishEveTurn(scope,{...input,messages:[]}),/operationBindingConflict/)
    })
    await t.test('root failure uses the host schedule timer and cannot fail a later occurrence claim on replay',async()=>{
      const {wakeTransport}=await import('../workflow-wake')
      const {dueTimerTransport}=await import('../due-timer')
      const priorResume=wakeTransport.resume,priorStart=dueTimerTransport.start
      const timer=Promise.withResolvers<string>()
      wakeTransport.resume=async()=>{throw new Error('no running fixture timer')}
      dueTimerTransport.start=async kind=>{timer.resolve(kind)}
      try {
        const {sessionId,occurrenceId}=await scheduled()
        const input={sessionId,turnId:'turn_0',outcome:'failed' as const,messages:[]}
        await finishEveTurn(scope,input)
        const timeout=setTimeout(()=>timer.reject(new Error('Host schedule timer was not armed')),5000)
        try {assert.equal(await timer.promise,'schedules')}finally{clearTimeout(timeout)}
        assert.equal((await pool.query('SELECT status FROM schedule_occurrences WHERE id=$1',[occurrenceId])).rows[0].status,'pending')
        // Simulate a lost finish acknowledgement, then a new product claim.
        await pool.query('UPDATE eve_turn_settlements SET completed_at=NULL WHERE session_id=$1',[sessionId])
        const newLease=randomUUID()
        await pool.query(`UPDATE schedule_occurrences SET status='running',lease_token=$2,lease_until=now()+interval '5 minutes' WHERE id=$1`,[occurrenceId,newLease])
        await finishEveTurn(scope,input)
        assert.equal((await pool.query('SELECT lease_token FROM schedule_occurrences WHERE id=$1',[occurrenceId])).rows[0].lease_token,newLease)
      } finally {wakeTransport.resume=priorResume;dueTimerTransport.start=priorStart}
    })
    await t.test('compatibility reply and ended product execution finish once with exact session binding',async()=>{
      const {AgentKitStore}=await import('../agent-kit/store')
      const {DEFAULT_AGENT_DEFINITION}=await import('../agent-kit/builtin')
      const store=new AgentKitStore(pool),sessionId=await nativeSession()
      const execution=await store.beginExecution(scope,`${sessionId}:turn_0:0`,'Fixture product policy',{harness:'codex',model:null},DEFAULT_AGENT_DEFINITION)
      const input={sessionId,turnId:'turn_0',executionId:execution.id,outcome:'completed' as const,messages:[{role:'assistant',content:'Native compatibility reply',mikkaStreamId:`eve:${sessionId}:turn_0`}]}
      await finishEveTurn(scope,input)
      await pool.query('UPDATE eve_turn_settlements SET completed_at=NULL WHERE session_id=$1',[sessionId])
      await finishEveTurn(scope,input)
      assert.equal((await store.readExecution(scope,execution.id)).status,'completed')
      assert.equal((await pool.query('SELECT 1 FROM coordinator_messages WHERE "userId"=$1 AND message->>\'content\'=\'Native compatibility reply\'',[ownerId])).rowCount,1)
      await assert.rejects(finishEveTurn(scope,{...input,executionId:randomUUID()}),/agentExecutionClosed/)
      await assert.rejects(finishEveTurn({...scope,ownerId:'other-owner'},input))
    })
    await t.test('failed native turn marks only its owned source and never overwrites a newer session',async()=>{
      const {projectEveTurn,projectTurnState}=await import('./projection')
      const {emptySessionView,foldEvents}=await import('eve/events')
      const {chatItems}=await import('../coordinator/context')
      const sessionId=await nativeSession(),source=randomUUID(),newerSource=randomUUID()
      for(const id of [source,newerSource])await pool.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload,"deliveredAt")VALUES($1,$2,$3,'user_message',($1::uuid)::text,$4,now())`,[id,ownerId,botId,{text:id===source?'Failed request':'Newer queued request',source:'person'}])
      await pool.query('INSERT INTO eve_turn_sources(session_id,turn_id,source_event_id)VALUES($1,$2,$3)',[sessionId,'turn_0',source])
      const position=Number((await pool.query('SELECT coalesce(max(position),0) last FROM coordinator_messages WHERE "userId"=$1 AND "botId"=$2',[ownerId,botId])).rows[0].last)
      for(const [index,id]of [source,newerSource].entries())await pool.query('INSERT INTO coordinator_messages(id,"userId","botId",position,message)VALUES($1,$2,$3,$4,$5)',[randomUUID(),ownerId,botId,position+index+1,{role:'user',content:id===source?'Failed request':'Newer queued request',mikkaUserEvent:{id}}])
      await projectTurnState(scope,sessionId,'turn_0',true)
      const view=foldEvents(emptySessionView(),[
        {type:'turn.started',data:{turnId:'turn_0',cause:{deliveryId:'delivery_0'},follows:null},meta:{position:{line:0,index:0},at:'2026-11-11T00:00:00Z',endOfLine:true}},
        {type:'turn.settled',data:{turnId:'turn_0',outcome:'failed',error:{code:'rate_limit_exceeded',message:'Do not show raw provider diagnostic'}},meta:{position:{line:1,index:0},at:'2026-11-11T00:00:01Z',endOfLine:true}},
      ])
      await finishEveTurn(scope,{sessionId,turnId:'turn_0',outcome:'failed',messages:projectEveTurn(view,sessionId,'turn_0','failed')})
      const rows=(await pool.query('SELECT position,message,"createdAt" FROM coordinator_messages WHERE "userId"=$1 AND "botId"=$2 ORDER BY position',[ownerId,botId])).rows
      const items=chatItems(rows)
      assert.equal(items.find(item=>item.text==='Failed request')?.failure?.raw,'rate_limit_exceeded')
      assert.equal(items.find(item=>item.text==='Newer queued request')?.failure,undefined)
      assert.equal((await pool.query('SELECT "lastError" FROM coordinator_sessions WHERE "userId"=$1 AND "botId"=$2',[ownerId,botId])).rows[0].lastError,'rate_limit_exceeded')
      const fresh=await nativeSession()
      await projectTurnState(scope,fresh,'turn_0',true)
      const stale=await nativeSession()
      await pool.query('INSERT INTO eve_turn_sources(session_id,turn_id,source_event_id)VALUES($1,$2,$3)',[stale,'turn_0',source])
      await finishEveTurn(scope,{sessionId:stale,turnId:'turn_0',outcome:'failed',messages:projectEveTurn(view,stale,'turn_0','failed')})
      const state=(await pool.query('SELECT "lastError","leaseHolder" FROM coordinator_sessions WHERE "userId"=$1 AND "botId"=$2',[ownerId,botId])).rows[0]
      assert.equal(state.lastError,null);assert.equal(state.leaseHolder,fresh)
      const newer=(await pool.query('SELECT message FROM coordinator_messages WHERE "userId"=$1 AND message#>>\'{mikkaUserEvent,id}\'=$2',[ownerId,newerSource])).rows[0]
      assert.equal(newer.message.mikkaFailure,undefined)
    })
    await t.test('native resend marks an owned failed row and recovers only the original submission receipt',async()=>{
      const {acceptEveMessage,commitEveIngress}=await import('./submission')
      const {chatItems}=await import('../coordinator/context')
      const position=Number((await pool.query('SELECT coalesce(max(position),0) last FROM coordinator_messages WHERE "userId"=$1 AND "botId"=$2',[ownerId,botId])).rows[0].last)+1
      const original=randomUUID()
      await pool.query('INSERT INTO coordinator_messages(id,"userId","botId",position,message)VALUES($1,$2,$3,$4,$5)',[original,ownerId,botId,position,{role:'user',content:'Original failed resend',mikkaFailure:'turn_failed'}])
      const submissionId=randomUUID()
      const request=(id:string)=>new Request('https://app.test/eve/v1/session/wrun_fixture',{method:'POST',headers:{'x-mikka-submission-id':id}})
      const firstRequest=request(submissionId)
      const first=await acceptEveMessage(scope,'Retry replacement',{retryOf:position},firstRequest)
      await commitEveIngress(firstRequest)
      const repeated=request(submissionId)
      assert.equal((await acceptEveMessage(scope,'Retry replacement',{retryOf:position},repeated)).eventId,first.eventId)
      await commitEveIngress(repeated)
      await assert.rejects(acceptEveMessage(scope,'Retry replacement',{retryOf:position},request(randomUUID())),/submissionConflict/)
      await assert.rejects(acceptEveMessage(scope,'Changed replacement',{retryOf:position},request(submissionId)),/submissionConflict/)
      const prior=(await pool.query('SELECT message FROM coordinator_messages WHERE id=$1',[original])).rows[0]
      assert.equal(prior.message.mikkaRetried,true)
      const rows=(await pool.query('SELECT position,message,"createdAt" FROM coordinator_messages WHERE "userId"=$1 AND "botId"=$2 ORDER BY position',[ownerId,botId])).rows
      assert.equal(chatItems(rows).filter(item=>item.text==='Original failed resend').length,0)
      assert.equal(chatItems(rows).filter(item=>item.text==='Retry replacement').length,1)
      assert.equal((await pool.query('SELECT payload->>\'retryOf\' retry FROM coordinator_events WHERE id=$1',[first.eventId])).rows[0].retry,String(position))
    })
    await t.test('a native failure before HTTP acknowledgement still follows its original user message',async()=>{
      const {projectTurnState}=await import('./projection')
      const sessionId=await nativeSession(),source=randomUUID()
      await pool.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload)VALUES($1,$2,$3,'user_message',($1::uuid)::text,$4)`,[source,ownerId,botId,{text:'Fast failed request',source:'person'}])
      await pool.query('INSERT INTO eve_turn_sources(session_id,turn_id,source_event_id)VALUES($1,$2,$3)',[sessionId,'turn_0',source])
      await projectTurnState(scope,sessionId,'turn_0',true)
      await finishEveTurn(scope,{sessionId,turnId:'turn_0',outcome:'failed',messages:[{role:'assistant',content:[],mikkaFailure:'turn_failed',mikkaStreamId:`eve:${sessionId}:turn_0`}]})
      const rows=(await pool.query('SELECT position,message FROM coordinator_messages WHERE "userId"=$1 AND (message#>>\'{mikkaUserEvent,id}\'=$2 OR message->>\'mikkaStreamId\'=$3) ORDER BY position',[ownerId,source,`eve:${sessionId}:turn_0`])).rows
      assert.equal(rows.length,2)
      assert.equal(rows[0].message.role,'user');assert.equal(rows[0].message.content,'Fast failed request')
      assert.equal(rows[0].message.mikkaFailure,'turn_failed');assert.equal(rows[1].message.role,'assistant')
    })
  } finally {
    await pool.query('DELETE FROM user_schedules WHERE id=ANY($1::uuid[])',[scheduleIds])
    await pool.query('DELETE FROM bots WHERE id=$1',[botId])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=$1',[workspaceId])
    await pool.query('DELETE FROM "user" WHERE id=$1',[ownerId])
  }
})
