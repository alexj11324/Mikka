import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import test from 'node:test'
import { Pool } from 'pg'
import { betterAuth } from 'better-auth'
import { approvedWriteHandler } from './write-http'
import { composioWriteProvider } from './write-provider'
import type { ComposioActionClient } from '../composio-actions'
import { createApprovedWrites } from './approved-writes'
import { WRITE_ACTIONS, type WriteProvider } from './write-contract'

test('three approved writes: real PG, auth HTTP, loopback effects and durable recovery', { skip: process.env.OPERATION_DB_TESTS !== '1' && process.env.REQUIRE_DB !== '1' }, async t => {
  assert.ok(!process.env.COMPOSIO_API_KEY && !process.env.AI_GATEWAY_API_KEY)
  const url = new URL((process.env.OPERATION_TEST_DATABASE_URL ?? process.env.E2E_DATABASE_URL)!)
  assert.equal(url.hostname, '127.0.0.1'); assert.ok(['/mikka_208_test','/mikka_e2e'].includes(url.pathname))
  const admin = new Pool({ connectionString: url.toString() }), schema = 'write177_' + randomUUID().replaceAll('-', '')
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: url.toString(), options: `-c search_path=${schema}` })
  t.after(async () => { await pool.end(); await admin.end() })
  for (const file of ['20261023221259_application_baseline.sql','20261025043000_pending_actions.sql','20261026135215_operation_ledger.sql','20261026135216_approved_write_binding.sql']) await pool.query(await readFile(new URL('../../drizzle/' + file, import.meta.url), 'utf8'))
  await pool.query('CREATE RULE retain_test_sessions AS ON DELETE TO "session" DO INSTEAD NOTHING')
  let writes = 0, drop = false, missing = true, connection = 'fixture-account'
  let currentEvent: Record<string,unknown> = {}
  let deletes=0
  const receipts = new Map<string, string>()
  const remote = createServer((req,res) => { const key = req.url!; if(req.method==='DELETE'){deletes++;if(req.headers['if-match']!==currentEvent.etag){res.writeHead(412);res.end();return}writes++;res.writeHead(204);res.end();return} if(req.method === 'POST'){ writes++; receipts.set(key,randomUUID()); if(drop){req.socket.destroy(); return} } res.writeHead(receipts.has(key)?200:404,{'content-type':'application/json'});res.end(JSON.stringify({id:receipts.get(key)})) })
  remote.listen(0,'127.0.0.1');await once(remote,'listening'); const address=remote.address();assert.ok(address && typeof address!=='string');const endpoint=`http://127.0.0.1:${address.port}`
  const provider: WriteProvider = { name:'synthetic-http',prepare:async()=>({accountId:connection,version:'fixed-v1'}),execute:async p=>{assert.equal(p.accountId,connection);await p.beforeSend();p.signal.throwIfAborted();const r=await fetch(endpoint+'/'+p.idempotencyKey,{method:'POST',signal:p.signal});return receipt((await r.json()).id)},lookup:async p=>{if(missing)return null;const r=await fetch(endpoint+'/'+p.idempotencyKey);return r.ok?receipt((await r.json()).id):null} }
  const receipt=(id:string)=>({providerObjectId:id,evidenceDigest:createHash('sha256').update(id).digest('hex')})
  const makeAuth=(baseURL:string)=>betterAuth({database:pool,baseURL,secret:randomUUID()+randomUUID(),emailAndPassword:{enabled:true},logger:{disabled:true}})
  let origin='';let auth:ReturnType<typeof makeAuth>
  const server=createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks).toString();const request=new Request(origin+req.url,{method:req.method,headers:req.headers as Record<string,string>,...(body?{body}:{})});
    if(req.url?.startsWith('/api/auth/')){const r=await auth.handler(request);res.writeHead(r.status,{'set-cookie':r.headers.getSetCookie(),'content-type':'application/json'});res.end(await r.text());return}
    const r=await approvedWriteHandler(auth,action=>createApprovedWrites(pool,provider,action))(request)
    res.writeHead(r.status,{'content-type':'application/json'});res.end(await r.text())
  }catch{res.writeHead(403);res.end()}})
  server.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();assert.ok(a&&typeof a!=='string');origin=`http://127.0.0.1:${a.port}`
  auth=makeAuth(origin)
  t.after(async()=>{await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>remote.close(()=>r()))])})
  const signup=await fetch(origin+'/api/auth/sign-up/email',{method:'POST',headers:{Origin:origin,'content-type':'application/json'},body:JSON.stringify({name:'Synthetic fixture',email:randomUUID()+'@example.invalid',password:randomUUID()+randomUUID()})});assert.equal(signup.status,200)
  const owner=(await signup.json()).user.id;const cookie=signup.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ')
  const call=(path:string,args:unknown)=>fetch(origin+path,{method:'POST',headers:{Origin:origin,Cookie:cookie,'content-type':'application/json'},body:JSON.stringify({...args as Record<string,unknown>,op:path==='/propose'?'propose':'decide',intentId:(args as {intent?:string}).intent})})
  for(const action of WRITE_ACTIONS){const input=action==='append_notion_paragraph'?{page_id:randomUUID(),text:'Synthetic paragraph'}:action==='send_slack_message'?{channel:'C12345678',text:'Synthetic message'}:{event_id:'synthetic-event',send_updates:'none'}
    const propose=async(intent=randomUUID())=>{const r=await call('/propose',{action,input,intent});assert.equal(r.status,200);return r.json()}
    await t.test(action+' concurrent intent/approval and success replay',async()=>{const intent=randomUUID(),before=writes;const proposals=await Promise.all(Array.from({length:10},()=>propose(intent)));const id=proposals[0].actionId;assert.equal(new Set(proposals.map(p=>p.actionId)).size,1);assert.equal(writes,before)
      const outcomes=await Promise.all(Array.from({length:10},()=>call('/decide',{action,id,approve:true})));assert.ok(outcomes.every(r=>r.status===200));assert.equal(writes,before+1);assert.equal((await(await call('/decide',{action,id,approve:true})).json()).status,'done');assert.equal(writes,before+1)
      assert.equal((await(await call('/propose',{action,intent,input:action==='cancel_calendar_event'?{...input,send_updates:'all'}:{...input,text:'changed'}})).json()).error,'operationBindingConflict')
    })
    await t.test(action+' canonical intent UUID serial/concurrent replay and unknown result cannot fork',async()=>{
      const intent='a'+randomUUID().slice(1), before=writes
      const first=await propose(intent.toUpperCase()), id=first.actionId
      assert.equal((await propose(intent)).actionId,id)
      const concurrent='b'+randomUUID().slice(1)
      const proposals=await Promise.all(Array.from({length:10},(_,i)=>propose(i%2?concurrent.toUpperCase():concurrent)))
      assert.equal(new Set(proposals.map(p=>p.actionId)).size,1)
      for(const key of [intent,concurrent]){
        const rows=(await pool.query('SELECT id,"intentKey" FROM pending_actions WHERE "userId"=$1 AND lower("intentKey")=$2',[owner,key])).rows
        assert.equal(rows.length,1);assert.equal(rows[0].intentKey,key)
      }
      const changed=action==='cancel_calendar_event'?{...input,send_updates:'all'}:{...input,text:'Changed but valid'}
      for(const key of [intent,intent.toUpperCase()]){
        assert.equal((await(await call('/propose',{action,intent:key,input:changed})).json()).error,'operationBindingConflict')
        const other=action==='cancel_calendar_event'?'send_slack_message':'cancel_calendar_event'
        const otherInput=other==='send_slack_message'?{channel:'C12345678',text:'Fixture'}:{event_id:'fixture',send_updates:'none'}
        assert.equal((await(await call('/propose',{action:other,intent:key,input:otherInput})).json()).error,'operationBindingConflict')
      }
      const other=action==='cancel_calendar_event'?'send_slack_message':'cancel_calendar_event'
      const otherInput=other==='send_slack_message'?{channel:'C12345678',text:'Race fixture'}:{event_id:'race-fixture',send_updates:'none'}
      for(const conflict of [{action,input:changed},{action:other,input:otherInput}]){
        const raceIntent='d'+randomUUID().slice(1)
        const requests=[{action,input,intent:raceIntent.toUpperCase()},{...conflict,intent:raceIntent}]
        const responses=await Promise.all(requests.map(r=>call('/propose',r)))
        assert.deepEqual(responses.map(r=>r.status).sort(),[200,409])
        const winner=responses.findIndex(r=>r.status===200), rejected=1-winner
        assert.equal((await responses[rejected].json()).error,'operationBindingConflict')
        const proposal=await responses[winner].json()
        assert.equal((await pool.query('SELECT count(*) FROM pending_actions WHERE "userId"=$1 AND lower("intentKey")=$2',[owner,raceIntent])).rows[0].count,'1')
        await call('/decide',{action:requests[winner].action,id:proposal.actionId,approve:false})
      }
      assert.equal(writes,before)
      drop=true
      try{assert.equal((await(await call('/decide',{action,id,approve:true})).json()).status,'running')}finally{drop=false}
      assert.equal(writes,before+1)
      const replays=await Promise.all(Array.from({length:10},(_,i)=>propose(i%2?intent.toUpperCase():intent)))
      assert.ok(replays.every(p=>p.actionId===id&&p.status==='running'))
      assert.equal((await(await call('/decide',{action,id,approve:true})).json()).status,'running');assert.equal(writes,before+1)
      assert.equal((await pool.query('SELECT count(*) FROM operation_ledger WHERE "operationId"=$1',[id])).rows[0].count,'1')
      await call('/decide',{action,id:proposals[0].actionId,approve:false})
    })
    await t.test(action+' rejects another action under the same logical intent',async()=>{
      const intent=randomUUID();await propose(intent)
      const other=action==='cancel_calendar_event'?'send_slack_message':'cancel_calendar_event'
      const otherInput=other==='send_slack_message'?{channel:'C12345678',text:'Synthetic'}:{event_id:'synthetic',send_updates:'none'}
      assert.equal((await(await call('/propose',{action:other,input:otherInput,intent})).json()).error,'operationBindingConflict')
    })
    await t.test(action+' old bindings cannot execute but uninvoked proposals can decline',async()=>{
      const {actionId:id}=await propose(), before=writes
      await pool.query(`UPDATE pending_actions SET "operationBinding"="operationBinding"-'contextDigest' WHERE id=$1`,[id])
      assert.equal((await call('/decide',{action,id,approve:true})).status,409)
      assert.equal((await(await call('/decide',{action,id,approve:false})).json()).status,'declined')
      assert.equal(writes,before)
    })
    await t.test(action+' dropped response, fresh service, negative lookup, positive receipt',async()=>{const {actionId:id}=await propose(),before=writes;drop=true;assert.equal((await(await call('/decide',{action,id,approve:true})).json()).status,'running');drop=false;assert.equal(writes,before+1)
      assert.equal((await(await call('/decide',{action,id,approve:true})).json()).status,'running');assert.equal(writes,before+1);missing=false;assert.equal((await(await call('/decide',{action,id,approve:true})).json()).status,'done');missing=true;assert.equal(writes,before+1)
      const row=(await pool.query('SELECT * FROM operation_ledger WHERE "operationId"=$1',[id])).rows[0];assert.equal(row.ownerId,owner);assert.equal(row.workspaceId,`personal:${owner}`)
    })
    await t.test(action+' decline, expiry, owner/account change and session expiry prevent writes',async()=>{const before=writes;let p=await propose();assert.equal((await call('/decide',{action,id:p.actionId,approve:false})).status,200);assert.equal((await call('/decide',{action,id:p.actionId,approve:true})).status,409)
      p=await propose();await pool.query('UPDATE pending_actions SET "createdAt"=clock_timestamp()-interval \'8 days\' WHERE id=$1',[p.actionId]);assert.equal((await call('/decide',{action,id:p.actionId,approve:true})).status,409)
      p=await propose();await pool.query('UPDATE pending_actions SET "userId"=$2 WHERE id=$1',[p.actionId,'other-owner']);assert.equal((await call('/decide',{action,id:p.actionId,approve:true})).status,409)
      p=await propose();connection='replacement';assert.equal((await(await call('/decide',{action,id:p.actionId,approve:true})).json()).status,'running');connection='fixture-account';assert.equal(writes,before)
      p=await propose();await pool.query('UPDATE session SET "expiresAt"=clock_timestamp()-interval \'1 second\' WHERE "userId"=$1',[owner]);assert.equal((await call('/decide',{action,id:p.actionId,approve:true})).status,401);await pool.query('UPDATE session SET "expiresAt"=clock_timestamp()+interval \'1 hour\' WHERE "userId"=$1',[owner]);assert.equal(writes,before)
    })
  }
  await t.test('legacy uppercase intents replay; existing case duplicates fail closed without cleanup',async()=>{
    const action='send_slack_message',input={channel:'C12345678',text:'Legacy case fixture'},intent='c'+randomUUID().slice(1)
    const first=await(await call('/propose',{action,input,intent})).json()
    await pool.query('UPDATE pending_actions SET "intentKey"=$2 WHERE id=$1',[first.actionId,intent.toUpperCase()])
    assert.equal((await(await call('/propose',{action,input,intent})).json()).actionId,first.actionId)
    const duplicate=randomUUID()
    await pool.query('INSERT INTO pending_actions (id,"userId",action,input,"intentKey","operationBinding",context) SELECT $2,"userId",action,input,$3,"operationBinding",context FROM pending_actions WHERE id=$1',[first.actionId,duplicate,intent])
    const before=writes
    for(const key of [intent,intent.toUpperCase()])assert.equal((await(await call('/propose',{action,input,intent:key})).json()).error,'operationIntentAmbiguous')
    assert.equal(writes,before)
    for(const id of [first.actionId,duplicate])await call('/decide',{action,id,approve:false})
  })
  await t.test('decline sees absent ledger, pauses, and serializes a concurrent approval',async()=>{
    const actor={userId:owner,sessionId:(await pool.query('SELECT id FROM session WHERE "userId"=$1',[owner])).rows[0].id}
    let observed!:()=>void, resume!:()=>void
    const emptySeen=new Promise<void>(r=>{observed=r}), continued=new Promise<void>(r=>{resume=r})
    let pause=true
    const wrapped=new Proxy(pool,{get(target,key){if(key==='connect')return async()=>{const client=await target.connect();return new Proxy(client,{get(c,k){if(k==='query')return async(...args:unknown[])=>{const result=await Reflect.apply(c.query,c,args);if(pause&&String(args[0]).startsWith('SELECT status,"invokedAt" FROM operation_ledger')&&!result.rows.length){pause=false;observed();await continued}return result};const v=Reflect.get(c,k);return typeof v==='function'?v.bind(c):v}})};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v}})
    const service=createApprovedWrites(wrapped,provider,'send_slack_message'),proposal=await service.propose(owner,{channel:'C12345678',text:'Race fixture'},randomUUID()),before=writes
    const declining=service.decide(actor,proposal.actionId.toUpperCase(),false);await emptySeen
    const application='approval_race_'+randomUUID(),otherPool=new Pool({connectionString:url.toString(),options:`-c search_path=${schema}`,application_name:application})
    const approving=createApprovedWrites(otherPool,provider,'send_slack_message').decide(actor,proposal.actionId,true).then(()=>false,()=>true)
    try {
      let waiting=false
      for(let i=0;i<100&&!waiting;i++){waiting=(await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory'",[application])).rows.length>0;if(!waiting)await new Promise(r=>setTimeout(r,10))}
      assert.equal(waiting,true,'approval must wait at shared gate, not bypass the missing ledger row')
      resume();assert.equal((await declining).status,'declined');assert.equal(await approving,true);assert.equal(writes,before)
    } finally {resume();await otherPool.end()}
    const p=await service.propose(owner,{channel:'C12345678',text:'Effect wins fixture'},randomUUID());assert.equal((await service.decide(actor,p.actionId,true)).status,'done');await assert.rejects(service.decide(actor,p.actionId,false),/operationUncertain/);assert.equal(writes,before+1)
  })
  await t.test('Calendar PG approval snapshot, execution revalidation, atomic If-Match and no replay',async()=>{
    const actor={userId:owner,sessionId:(await pool.query('SELECT id FROM session WHERE "userId"=$1',[owner])).rows[0].id}
    const original={id:'loopback-event',etag:'"v1"',status:'confirmed',eventType:'default',summary:'Synthetic',organizer:{self:true,email:'synthetic@example.invalid'},attendees:[{email:'approved@example.invalid'}],start:{date:'2027-01-01'},end:{date:'2027-01-02'}}
    let race=false
    const client={connectedAccounts:{list:async()=>({items:[{id:'fixture-account',toolkit:{slug:'googlecalendar'},status:'ACTIVE',isDisabled:false}]})},tools:{getRawComposioToolBySlug:async()=>({version:'fixed-v1'}),execute:async(slug:string)=>{assert.equal(slug,'GOOGLECALENDAR_EVENTS_GET');return {successful:true,data:structuredClone(currentEvent)}}}} as unknown as ComposioActionClient
    const provider=composioWriteProvider(client,'cancel_calendar_event',async p=>{await p.beforeSend();if(race)currentEvent={...currentEvent,etag:'"raced"'};const r=await fetch(endpoint+'/calendar-event',{method:'DELETE',headers:{'if-match':p.ifMatch},signal:p.signal});return {status:r.status}})
    const service=createApprovedWrites(pool,provider,'cancel_calendar_event')
    const input={event_id:original.id,send_updates:'none'}
    for(const mutation of [{etag:'"changed"'},{attendees:[{email:'unapproved@example.invalid'}]},{recurrence:['RRULE:FREQ=DAILY']}]){
      currentEvent=structuredClone(original);const proposal=await service.propose(owner,input,randomUUID());const before=writes,requests=deletes
      const stored=(await pool.query('SELECT context,"operationBinding" FROM pending_actions WHERE id=$1',[proposal.actionId])).rows[0];assert.equal(stored.context.etag,original.etag);assert.ok(stored.operationBinding.contextDigest)
      currentEvent={...currentEvent,...mutation};assert.equal((await service.decide(actor,proposal.actionId,true)).status,'running');assert.equal(writes,before);assert.equal(deletes,requests)
    }
    currentEvent=structuredClone(original);let proposal=await service.propose(owner,input,randomUUID());const before=writes;race=true
    assert.equal((await service.decide(actor,proposal.actionId,true)).status,'running');assert.equal(writes,before);const requests=deletes
    assert.equal((await service.decide(actor,proposal.actionId,true)).status,'running');assert.equal(deletes,requests,'unknown conditional failure never resends')
    race=false;currentEvent=structuredClone(original);proposal=await service.propose(owner,input,randomUUID());assert.equal((await service.decide(actor,proposal.actionId,true)).status,'done');assert.equal(writes,before+1)
    currentEvent=structuredClone(original);proposal=await service.propose(owner,input,randomUUID());await pool.query("UPDATE pending_actions SET context=jsonb_set(context,'{etag}','\"tampered\"'::jsonb) WHERE id=$1",[proposal.actionId]);await assert.rejects(service.decide(actor,proposal.actionId,true),/operationBindingConflict/);assert.equal(writes,before+1)
    currentEvent=structuredClone(original);const closed=createApprovedWrites(pool,composioWriteProvider(client,'cancel_calendar_event'),'cancel_calendar_event');proposal=await closed.propose(owner,input,randomUUID());assert.equal((await closed.decide(actor,proposal.actionId,true)).status,'running');assert.equal(writes,before+1,'no native conditional transport means zero DELETE')
  })

})
