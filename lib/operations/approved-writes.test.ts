import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import test from 'node:test'
import { Pool } from 'pg'
import { betterAuth } from 'better-auth'
import { approvedWriteHandler } from './write-http'
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
  const receipts = new Map<string, string>()
  const remote = createServer((req,res) => { const key = req.url!; if(req.method === 'POST'){ writes++; receipts.set(key,randomUUID()); if(drop){req.socket.destroy(); return} } res.writeHead(receipts.has(key)?200:404,{'content-type':'application/json'});res.end(JSON.stringify({id:receipts.get(key)})) })
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
    await t.test(action+' rejects another action under the same logical intent',async()=>{
      const intent=randomUUID();await propose(intent)
      const other=action==='cancel_calendar_event'?'send_slack_message':'cancel_calendar_event'
      const otherInput=other==='send_slack_message'?{channel:'C12345678',text:'Synthetic'}:{event_id:'synthetic',send_updates:'none'}
      assert.equal((await(await call('/propose',{action:other,input:otherInput,intent})).json()).error,'operationBindingConflict')
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
})
