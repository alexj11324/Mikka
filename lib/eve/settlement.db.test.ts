import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'

const valid = disposableDatabase() && process.env.E2E_DATABASE_URL === process.env.MIKKA_DATABASE_URL && process.env.E2E_DATABASE_URL === process.env.DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !valid) throw new Error('Eve settlement tests require matching isolated loopback _e2e databases')

test('host settlement receipts preserve product publication across native RPC retries', {skip:!valid}, async t => {
  const {pool} = await import('../db')
  for (const migration of ['20261112030100_eve_sessions.sql','20261112030200_eve_settlements.sql','20261112030500_eve_outcome_deliveries.sql']) await pool.query(await readFile(new URL('../../drizzle/'+migration,import.meta.url),'utf8'))
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
    await t.test('a native finish without an Agent Kit execution does not initialize its prepare workflow', async () => {
      const { handleEveProductRequest } = await import('./product-gateway')
      const { internalEveAuthorization } = await import('./auth')
      const sessionId = await nativeSession()
      const imports: string[] = []
      const loader = registerHooks({ load(url, context, next) {
        if (url.includes('/workflows/coordinator/agent-kit-steps.')) imports.push(url)
        return next(url, context)
      } })
      try {
        const response = await handleEveProductRequest(new Request('https://app.example/mikka/api/internal/eve/tools', {
          method: 'POST', headers: { authorization: internalEveAuthorization(scope) },
          body: JSON.stringify({ operation: 'finish', sessionId, turnId: 'child_without_execution', outcome: 'completed' }),
        }))
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { status: 'accepted' })
        assert.deepEqual(imports, [])
      } finally { loader.deregister() }
    })
    await t.test('native admission stays pending until its own root projection, including queued and quiet turns',async()=>{
      const {markEventAccepted}=await import('./submission')
      const {chatView,chatVersion,botChatSnapshot}=await import('../coordinator/store')
      const {chatFailure}=await import('../chat-failure')
      const {eveStreamId}=await import('./projection')
      const sessionId=await nativeSession(),sources=[randomUUID(),randomUUID(),randomUUID()]
      const publish=async(index:number)=>{
        await pool.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload)VALUES($1,$2,$3,'user_message',($1::uuid)::text,$4)`,[sources[index],ownerId,botId,{source:'person',text:'Native queue '+index}])
        await markEventAccepted(scope,sources[index])
      }
      const bind=async(index:number)=>{
        await pool.query('INSERT INTO eve_turn_sources(session_id,turn_id,source_event_id)VALUES($1,$2,$3)',[sessionId,'queued_'+index,sources[index]])
        await (await import('./projection')).projectTurnState(scope,sessionId,'queued_'+index,true)
      }
      await publish(0)
      let chat=await chatView(ownerId,200,botId)
      assert.equal(chat.working,true,'a durably admitted message is not a failed legacy wake')
      assert.equal(chatFailure(chat),null)
      assert.equal((await chatVersion(ownerId,200,botId)).working,true)
      assert.equal((await botChatSnapshot(ownerId)).items[botId].working,true)
      await publish(1);await bind(0)
      await finishEveTurn(scope,{sessionId,turnId:'queued_0',outcome:'completed',messages:[{role:'assistant',content:'First native reply',mikkaStreamId:eveStreamId(sessionId,'queued_0')}]})
      assert.equal((await chatView(ownerId,200,botId)).working,true,'a later queued input remains native work after the earlier reply')
      await bind(1)
      await finishEveTurn(scope,{sessionId,turnId:'queued_1',outcome:'failed',messages:[{role:'assistant',content:[],mikkaFailure:'turn_failed',mikkaStreamId:eveStreamId(sessionId,'queued_1')}]})
      chat=await chatView(ownerId,200,botId)
      assert.equal(chat.working,false);assert.equal(chatFailure(chat)?.kind,'failed')
      await publish(2);await bind(2)
      await finishEveTurn(scope,{sessionId,turnId:'queued_2',outcome:'completed',messages:[{role:'assistant',content:[],mikkaStreamId:eveStreamId(sessionId,'queued_2')}]})
      chat=await chatView(ownerId,200,botId)
      assert.equal(chat.working,false);assert.equal(chatFailure(chat),null,'a successful quiet native outcome is not inferred to have crashed')
    })
    await t.test('admission claims its scoped event once and rolls back with the transcript', async t => {
      const { Client } = await import('pg')
      const { db, withDatabaseTransaction } = await import('../db')
      const { markEventAccepted } = await import('./submission')
      const eventId = randomUUID()
      await pool.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload)
        VALUES($1,$2,$3,'user_message',($1::uuid)::text,$4)`, [eventId, ownerId, botId, {text:'Claimed once'}])
      const delivered = async () => (await pool.query('SELECT "deliveredAt" FROM coordinator_events WHERE id=$1', [eventId])).rows[0].deliveredAt
      const projectionCount = async () => Number((await pool.query(`SELECT count(*) FROM coordinator_messages
        WHERE "userId"=$1 AND "botId"=$2 AND message#>>'{mikkaUserEvent,id}'=$3`, [ownerId, botId, eventId])).rows[0].count)
      await markEventAccepted({...scope, ownerId:ownerId+'-other'}, eventId)
      await markEventAccepted({...scope, botId:randomUUID()}, eventId)
      assert.equal(await delivered(), null)
      await assert.rejects(db.transaction(tx => withDatabaseTransaction(tx, async () => {
        await markEventAccepted(scope, eventId)
        throw new Error('rollback admission')
      })), /rollback admission/)
      assert.equal(await delivered(), null)
      assert.equal(await projectionCount(), 0)

      const queries = t.mock.method(Client.prototype, 'query')
      const { createRequestDatabaseScope } = await import('../db')
      const routed = createRequestDatabaseScope(process.env.E2E_DATABASE_URL!)
      try {
        await routed.run(() => Promise.all([markEventAccepted(scope, eventId), markEventAccepted(scope, eventId)]))
      } finally {
        await routed.close()
      }
      const sourceStatements = queries.mock.calls.filter(call => {
        const query = call.arguments[0] as unknown
        const text = typeof query === 'string' ? query : (query as {text?:string})?.text
        return /(?:from|update)\s+coordinator_events\b/i.test(text ?? '')
      })
      assert.equal(sourceStatements.length, 2, 'one scoped event claim for each of two competing admissions')
      assert.ok(await delivered())
      assert.equal(await projectionCount(), 1)
    })
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
    await t.test('native settlement replay without an execution selector reads its completed receipt once', async t => {
      const { Client } = await import('pg')
      const { handleEveProductRequest } = await import('./product-gateway')
      const { internalEveAuthorization } = await import('./auth')
      const sessionId = await nativeSession()
      const finish = (extra = {}) => handleEveProductRequest(new Request('https://app.example/mikka/api/internal/eve/tools', {
        method: 'POST', headers: { authorization: internalEveAuthorization(scope) },
        body: JSON.stringify({ operation: 'finish', sessionId, turnId: 'native_replay', outcome: 'completed', ...extra }),
      }))
      assert.equal((await finish()).status, 200)
      const { createRequestDatabaseScope } = await import('../db')
      const replay = createRequestDatabaseScope(process.env.E2E_DATABASE_URL!)
      try {
        const queries = t.mock.method(Client.prototype, 'query')
        assert.equal((await replay.run(() => finish())).status, 200)
        const reads = queries.mock.calls.map(call => String(call.arguments[0]))
        assert.equal(reads.filter(sql => /FROM eve_turn_settlements/i.test(sql)).length, 1)
        assert.equal(reads.filter(sql => /FROM agent_kit_executions/i.test(sql)).length, 0)
        assert.equal((await replay.run(() => finish({ executionId: randomUUID() }))).status, 404)
      } finally { await replay.close() }
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
    await t.test('the tool gateway reads one running snapshot bound to the native turn', async t => {
      const { AgentKitStore } = await import('../agent-kit/store')
      const { DEFAULT_AGENT_DEFINITION } = await import('../agent-kit/builtin')
      const { handleEveProductRequest } = await import('./product-gateway')
      const { internalEveAuthorization } = await import('./auth')
      const { Client } = await import('pg')
      const store = new AgentKitStore(pool)
      const slack = { ...scope, surface: 'slack' as const }
      const sessionId = 'wrun_' + randomUUID()
      await registerSession(slack, sessionId)
      const turnId = 'turn_gateway'
      const execution = await store.beginExecution(slack, `${sessionId}:${turnId}:0`, 'Fixture policy', {harness:'codex',model:null}, DEFAULT_AGENT_DEFINITION)
      const instructions = (turn: string) => handleEveProductRequest(new Request('https://app.example/mikka/api/internal/eve/tools', {
        method: 'POST', headers: {authorization: internalEveAuthorization(slack)},
        body: JSON.stringify({operation:'instructions',sessionId,turnId:turn,executionId:execution.id}),
      }))
      const queries = t.mock.method(Client.prototype, 'query')
      const { createRequestDatabaseScope } = await import('../db')
      const routed = createRequestDatabaseScope(process.env.E2E_DATABASE_URL!)
      const response = await routed.run(() => instructions(turnId)).finally(() => routed.close())
      assert.equal(response.status, 200)
      assert.match((await response.json()).instructions, /Slack conversation/)
      const reads = queries.mock.calls.filter(call => /from agent_kit_executions/i.test(String(call.arguments[0])))
      assert.equal(reads.length, 1, 'retrieve and check the same execution row in one SQL statement')
      assert.equal((await instructions('another_turn')).status, 404)
      await store.finishExecution(slack, execution.id, 'completed')
      assert.equal((await instructions(turnId)).status, 404)
      assert.equal((await store.readExecution(slack, execution.id)).status, 'completed')
    })
    await t.test('the product catalogue skips only inapplicable Eve approval reviews', async t => {
      const { AgentKitStore } = await import('../agent-kit/store')
      const { DEFAULT_AGENT_DEFINITION } = await import('../agent-kit/builtin')
      const { handleEveProductRequest, productCatalogue } = await import('./product-gateway')
      const { createProductTool } = await import('./product-tool')
      const { scopeAuth } = await import('./scope')
      const store = new AgentKitStore(pool)
      const sessionId = await nativeSession()
      const turnId = 'turn_tool'
      const execution = await store.beginExecution(scope, `${sessionId}:${turnId}:0`, 'Fixture policy', {harness:'codex',model:null}, DEFAULT_AGENT_DEFINITION)
      const binding = { sessionId, turnId, executionId: execution.id }
      const calls: string[] = []
      t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
        const request = new Request(url, init)
        calls.push((await request.clone().json()).operation)
        return handleEveProductRequest(request)
      })
      const tools = await productCatalogue(scope, binding)
      const read = tools.find(tool => tool.name === 'list_issues')!
      const write = tools.find(tool => tool.name === 'send_email')!
      const input = {}
      const context = {session:{id:sessionId,turn:{id:turnId},auth:{current:scopeAuth(scope)}},callId:'read_1',toolInput:input,abortSignal:new AbortController().signal}
      const tool = createProductTool(scope,binding,read)
      const approval = tool.approval as import('eve/tools/approval').ApprovalConfiguration<unknown>
      const foreign = {...context,session:{...context.session,auth:{current:scopeAuth({...scope,ownerId:'another-owner'})}}}
      assert.equal(await approval.request(foreign as never), 'denied')
      await assert.rejects(async () => approval.request({...context,abortSignal:AbortSignal.abort()} as never), {name:'AbortError'})
      assert.equal(await approval.request(context as never), 'not-applicable')
      assert.deepEqual(await tool.execute!(input as never, context as never), [])
      assert.deepEqual(calls, ['execute'])
      assert.equal(read.needsApprovalReview, false)
      assert.equal(write.needsApprovalReview, true)
      const legacy = createProductTool(scope,binding,{...read,needsApprovalReview:undefined})
      assert.equal(await (legacy.approval as typeof approval).request(context as never), 'not-applicable')
      assert.deepEqual(calls, ['execute','approval'])
      // If the host adds this tool to approval review after discovery, execution
      // still requires a matching durable review before any provider dispatch.
      const priorCatalogue = createProductTool(scope,binding,{...write,needsApprovalReview:false})
      const mail = {to:['fixture@example.invalid'],subject:'Fixture',body:'No delivery'}
      await assert.rejects(async () => priorCatalogue.execute!(mail as never, {...context,callId:'changed_policy'} as never), /agentToolUnavailable/)
      await store.finishExecution(scope, execution.id, 'completed')
      await assert.rejects(async () => tool.execute!(input as never, context as never), /agentToolUnavailable/)
    })
    await t.test('Eve checks live mailbox revocation only when the frozen execution grants mailbox tools', async t => {
      const { AgentKitStore } = await import('../agent-kit/store')
      const { DEFAULT_AGENT_DEFINITION } = await import('../agent-kit/builtin')
      const { mailboxInputs } = await import('@mikka/protocol/mailbox')
      const { productCatalogue } = await import('./product-gateway')
      const { createRequestDatabaseScope } = await import('../db')
      const { Client } = await import('pg')
      const store = new AgentKitStore(pool)
      const sessionId = await nativeSession()
      const start = (turnId: string) => store.beginExecution(scope, `${sessionId}:${turnId}:0`, 'Mailbox fixture', {harness:'codex',model:null}, DEFAULT_AGENT_DEFINITION)
      const original = await start('with_mailbox')
      const queries = t.mock.method(Client.prototype,'query')
      async function catalogue(turnId: string, executionId: string) {
        const before = queries.mock.callCount()
        const conn = createRequestDatabaseScope(process.env.E2E_DATABASE_URL!)
        const tools = await conn.run(() => productCatalogue(scope, { sessionId, turnId, executionId })).finally(() => conn.close())
        const grants = queries.mock.calls.slice(before).filter(call => /select active_version,workspace_id from agent_kit_heads|select snapshot,status,version_id from agent_kit_executions|select definition,digest from agent_kit_versions/i.test(String(call.arguments[0])))
        return {mail:tools.some(tool=>Object.hasOwn(mailboxInputs,tool.name)),liveChecks:grants.length}
      }
      assert.deepEqual(await catalogue('with_mailbox',original.id), {mail:true,liveChecks:3})
      const narrowed = {...DEFAULT_AGENT_DEFINITION,tools:DEFAULT_AGENT_DEFINITION.tools.filter(name=>!Object.hasOwn(mailboxInputs,name))}
      const saved = await store.save(scope,narrowed,original.snapshot.revision,randomUUID(),DEFAULT_AGENT_DEFINITION)
      try {
        assert.deepEqual(await catalogue('with_mailbox',original.id), {mail:false,liveChecks:3})
        const restricted = await start('without_mailbox')
        assert.deepEqual(await catalogue('without_mailbox',restricted.id), {mail:false,liveChecks:0})
      } finally {
        await store.save(scope,DEFAULT_AGENT_DEFINITION,saved.version,randomUUID(),DEFAULT_AGENT_DEFINITION)
      }
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
    await t.test('user retry forwards current credentials, full original task payload and canonical request identity',async()=>{
      const {retryEveTurn,eveRetrySubmission}=await import('./retry')
      const {loadEveRetrySource,eveTaskRequestSource}=await import('./retry-source')
      const {projectTurnState,projectEveTurn}=await import('./projection')
      const {markEventAccepted,acceptEveMessage,commitEveIngress}=await import('./submission')
      const {recordPersonalSubmission}=await import('../coordinator-submission')
      const {db}=await import('../db')
      const sessionId=await nativeSession(),text='Original task\n\nQuoted text and browser notes'
      const images=[{dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='}]
      const first=await recordPersonalSubmission(db,ownerId,text,{botId,submissionId:randomUUID(),images,taskDestination:{kind:'cloud'},profileId:'default',taskTitle:'Original task title',humanSessionId:'original-fixture-session'})
      await markEventAccepted(scope,first.eventId)
      await pool.query('INSERT INTO eve_turn_sources(session_id,turn_id,source_event_id)VALUES($1,$2,$3)',[sessionId,'turn_retry',first.eventId])
      const events=[
        {type:'turn.started',data:{turnId:'turn_retry',cause:{deliveryId:'delivery_retry'},follows:null},meta:{position:{line:0,index:0},at:'2026-11-11T00:00:00Z',endOfLine:true}},
        {type:'turn.settled',data:{turnId:'turn_retry',outcome:'failed',error:{code:'turn_failed'}},meta:{position:{line:1,index:0},at:'2026-11-11T00:00:01Z',endOfLine:true}},
      ]
      const {emptySessionView,foldEvents}=await import('eve/events')
      const view=foldEvents(emptySessionView(),events)
      await projectTurnState(scope,sessionId,'turn_retry',true)
      await finishEveTurn(scope,{sessionId,turnId:'turn_retry',outcome:'failed',messages:projectEveTurn(view,sessionId,'turn_retry','failed')})
      const position=Number((await pool.query('SELECT position FROM coordinator_messages WHERE "userId"=$1 AND message#>>\'{mikkaUserEvent,id}\'=$2',[ownerId,first.eventId])).rows[0].position)
      const source=await loadEveRetrySource(scope,position);assert.ok(source)
      const sent:Array<ReturnType<typeof eveRetrySubmission>>=[]
      const services:import('./retry').EveRetryServices={async open(actual,headers){
        assert.deepEqual(actual,scope)
        assert.deepEqual(headers,{cookie:'current-fixture=session',origin:'https://app.test','x-mikka-workspace-id':workspaceId})
        return {id:sessionId,snapshot:async()=>({events:events as never,session:{sessionId,streamIndex:0}}),send:async(message,options)=>{sent.push({message,options} as ReturnType<typeof eveRetrySubmission>);return {} as never}}
      }}
      const credentials=new Headers({cookie:'current-fixture=session',origin:'https://app.test','x-mikka-workspace-id':workspaceId,'content-length':'999'})
      assert.deepEqual(await retryEveTurn(ownerId,botId,credentials,services),{queued:true})
      assert.deepEqual(await retryEveTurn(ownerId,botId,credentials,services),{queued:true})
      assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1])
      assert.deepEqual(sent[0],eveRetrySubmission(sessionId,'turn_retry',source))
      const request=new Request('https://app.test/eve/v1/session/'+sessionId,{method:'POST',headers:sent[0].options.headers})
      const accepted=await acceptEveMessage(scope,sent[0].message,sent[0].options.clientContext,request)
      await commitEveIngress(request)
      assert.ok(accepted.context.some(text=>text.includes('completed tool receipts')))
      const payload=(await pool.query('SELECT payload FROM coordinator_events WHERE id=$1',[accepted.eventId])).rows[0].payload
      assert.equal(payload.text,text);assert.equal(payload.profileId,'default');assert.equal(payload.taskTitle,'Original task title')
      assert.deepEqual(payload.taskDestination,{kind:'cloud'});assert.equal(payload.images[0].dataUrl,images[0].dataUrl)
      assert.equal(payload.humanSessionId,undefined,'original human session is never impersonated by the adapter')
      assert.equal(await eveTaskRequestSource(scope,accepted.eventId,payload),first.eventId)
      assert.notEqual(accepted.eventId,first.eventId,'a resend has fresh immutable user provenance and retains its original task intent')
      const repeated=new Request(request.url,{method:'POST',headers:sent[0].options.headers})
      assert.equal((await acceptEveMessage(scope,sent[0].message,sent[0].options.clientContext,repeated)).eventId,accepted.eventId)
      await commitEveIngress(repeated)
      assert.equal((await pool.query('SELECT count(*)::int count FROM coordinator_events WHERE "userId"=$1 AND payload->>\'taskRequestSourceEventId\'=$2',[ownerId,first.eventId])).rows[0].count,1)
    })
  } finally {
    await pool.query('DELETE FROM user_schedules WHERE id=ANY($1::uuid[])',[scheduleIds])
    await pool.query('DELETE FROM bots WHERE id=$1',[botId])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=$1',[workspaceId])
    await pool.query('DELETE FROM "user" WHERE id=$1',[ownerId])
  }
})
