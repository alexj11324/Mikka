import assert from 'node:assert/strict'
import test from 'node:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { createApprovedWrites, type StoredWriteProposal } from './approved-writes'
import type { WriteRequestContext } from './write-transaction'

type Pool = Parameters<typeof createApprovedWrites>[0]
function fixture(context:WriteRequestContext={}) {
 const rows=new Map<string,StoredWriteProposal>(),traces:string[]=[],tails=new Map<string,Promise<void>>()
 const ownership=new AsyncLocalStorage<{active:number}>()
 const state={active:0,prepares:0,inserts:0,valid:true,loseCommit:false,beforePrepare:undefined as (()=>Promise<void>)|undefined}
 const pool={connect:async()=>{
  const caller=ownership.getStore()!;assert.ok(caller)
  const pending=new Map<string,StoredWriteProposal>(),unlocks:(()=>void)[]=[];let active=false
  const finish=()=>{if(active){active=false;state.active--;caller.active--}for(const u of unlocks.splice(0))u()}
  return {release:(error?:Error)=>{if(error)pending.clear();finish()},query:async(sql:string,p:unknown[]=[])=>{
   traces.push(sql)
   if(sql==='BEGIN'){active=true;state.active++;caller.active++;return {rows:[]}}
   if(sql==='ROLLBACK'){pending.clear();finish();return {rows:[]}}
   if(sql==='COMMIT'){for(const [id,row]of pending)rows.set(id,row);finish();if(state.loseCommit&&pending.size){state.loseCommit=false;throw Error('lost COMMIT reply')}return {rows:[]}}
   assert.equal(active,true)
   if(sql.startsWith('SELECT pg_advisory_xact_lock')){const key=String(p[0]),before=tails.get(key)??Promise.resolve();let release!:()=>void;tails.set(key,new Promise<void>(r=>{release=r}));await before;unlocks.push(release);return {rows:[]}}
   if(sql.startsWith('SELECT * FROM pending_actions'))return {rows:[...rows.values()].filter(r=>r.userId===p[0]&&r.intentKey.toLowerCase()===p[1])}
   if(sql.startsWith('SELECT count(*)'))return {rows:[{count:rows.size}]}
   if(sql.startsWith('SELECT id FROM "session"'))return {rows:state.valid&&p[0]==='session'?[{id:'session'}]:[]}
   if(sql.startsWith('INSERT INTO pending_actions')){state.inserts++;const [id,userId,input,intentKey,operationBinding,action,context]=p;pending.set(String(id),{id,userId,input,intentKey,operationBinding,action,context,status:'pending',createdAt:new Date()} as StoredWriteProposal);return {rows:[]}}
   throw Error('unexpected SQL or provider path')
  }}
 }} as unknown as Pool
 const service=createApprovedWrites(pool,{name:'synthetic',prepare:async()=>{assert.equal(ownership.getStore()?.active,0,'metadata must run outside its own APP transactions');state.prepares++;await state.beforePrepare?.();return {accountId:'synthetic-account',version:'fixed'}},execute:async()=>{throw Error('no effect allowed')},lookup:async()=>{throw Error('no lookup allowed')}},'send_slack_message',context)
 const propose=service.propose.bind(service)
 return {service:{...service,propose:(...args:Parameters<typeof propose>)=>ownership.run({active:0},()=>propose(...args))},rows,state,traces}
}
const input={channel:'C12345678',text:'Synthetic'}
test('browser metadata has no open APP transaction and same-intent replay reads original proposal',async()=>{
 const f=fixture(),intent=randomUUID(),first=await f.service.propose('owner',input,intent)
 assert.deepEqual(await f.service.propose('owner',input,intent.toUpperCase()),first)
 assert.equal(f.state.prepares,1);assert.equal(f.rows.size,1);assert.equal(f.state.active,0)
})
test('lost insert COMMIT reply is unknown; explicit same-intent recovery performs no new metadata or insert',async()=>{
 const f=fixture(),intent=randomUUID();f.state.loseCommit=true
 await assert.rejects(f.service.propose('owner',input,intent),/writeCommitUnconfirmed/)
 assert.equal(f.rows.size,1);const recovered=await f.service.propose('owner',input,intent)
 assert.equal(recovered.actionId,[...f.rows.keys()][0]);assert.equal(f.state.prepares,1);assert.equal(f.state.inserts,1)
})
test('session revocation or request abort during metadata never commits the proposal',async()=>{
 for(const revoked of [true,false]){
  const c=new AbortController(),f=fixture({actor:{userId:'owner',sessionId:'session'},signal:c.signal})
  f.state.beforePrepare=async()=>{if(revoked)f.state.valid=false;else c.abort()}
  await assert.rejects(f.service.propose('owner',input,randomUUID()))
  assert.equal(f.rows.size,0);assert.equal(f.state.active,0)
 }
})
test('concurrent identical intents share one inserted proposal; changed payload cannot replace it',async()=>{
 const f=fixture(),intent=randomUUID()
 const result=await Promise.all(Array.from({length:6},()=>f.service.propose('owner',input,intent)))
 assert.equal(new Set(result.map(r=>r.actionId)).size,1);assert.equal(f.state.inserts,1)
 await assert.rejects(f.service.propose('owner',{...input,text:'Changed'},intent),/operationBindingConflict/)
 assert.equal(f.rows.size,1)
})
