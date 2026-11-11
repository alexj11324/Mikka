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
  } finally {
    await pool.query('DELETE FROM user_schedules WHERE id=ANY($1::uuid[])',[scheduleIds])
    await pool.query('DELETE FROM bots WHERE id=$1',[botId])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=$1',[workspaceId])
    await pool.query('DELETE FROM "user" WHERE id=$1',[ownerId])
  }
})
