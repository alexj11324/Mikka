import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { SCOPE_DATABASES as names, SCOPE_LIMITS, SCOPE_MIGRATION_COUNT, scopeUrl, checkedScopeUrl, scopePolicy, controlledChild, sqlHash, lostScopeSupervisor } from './scope-acceptance-policy.mjs'
import { scopeNativeRuntime, SCOPE_IDENTITY_SQL, frozenScopeModule } from './scope-acceptance-runtime.mjs'
import { verifyScopeManifest, scopePhases, scopeWorkerMode } from './scope-acceptance.mjs'
import { scopeSubtest } from '../tests/support/scope-acceptance.mjs'
const phaseUrl=scopeUrl(names.scope)
const policy=()=>{const events=[];return {events,p:scopePolicy([],event=>events.push(event))}}

test('target mismatch fails before any native connection and aliases/credentials/options are refused', async()=>{
  for(const value of [scopeUrl('production'),phaseUrl+'?options=x',phaseUrl.replace('127.0.0.1','localhost'),phaseUrl.replace('postgres@','postgres:guess@'),scopeUrl(names.app)])assert.throws(()=>checkedScopeUrl(value,'scope'),/mismatch/)
  let constructions=0
  const runtime=scopeNativeRuntime({Pool:class {constructor(){constructions++} connect(){throw Error('native connection forbidden')}},Client:class {}},()=>{},'scope','suite')
  const pool = new runtime.Pool({connectionString:scopeUrl(names.app)})
  pool.options={connectionString:scopeUrl(names.app)}
  await assert.rejects(pool.connect(),/mismatch/)
  assert.equal(constructions,1,'constructor remains the actual native constructor; connection is denied')
  await runtime.close()
})

test('global application/migration budgets count failed attempts and deny work after exhaustion',()=>{
  const {p,events}=policy();p.state.created.set(names.scope,'1')
  const query={url:phaseUrl,text:'select $1'}
  for(let n=0;n<SCOPE_LIMITS.queries.scope;n++){
    const token=p.grant('scope',query);p.result(token.id,{ok:n%2===0,rowCount:n%2===0?1:0})
  }
  assert.throws(()=>p.grant('scope',query),/budget exhausted/)
  assert.equal(events.filter(e=>e.event==='query-attempt').length,11000)
  assert.equal(events.filter(e=>e.event==='query-result').length,11000)
  assert.equal(p.state.pending.size,0)
  assert.throws(()=>p.grant('scope:migrate',{url:phaseUrl,text:'COMMIT'}),/stopped/)
  const rollback=p.cleanup('scope',{url:phaseUrl,text:'ROLLBACK'});p.result(rollback.id,{ok:true,rowCount:0})
  assert.throws(()=>p.cleanup('scope',{url:phaseUrl,text:'update issues set title=null'}),/mismatch/)
})

test('only a successful create with verified ownership opens a fresh DB; creation and migrations cannot repeat',()=>{
  const {p}=policy(),input={url:scopeUrl('issue184_e2e'),text:`create database "${names.scope}"`}
  const attempt=p.grant('scope',input)
  assert.throws(()=>p.grant('scope',{url:phaseUrl,text:'select 1'}),/ownership/)
  p.result(attempt.id,{ok:false,code:'synthetic-response-loss'})
  assert.throws(()=>p.grant('scope',input),/only its exact/)
  assert.equal(p.state.created.size,0)
  p.migrationCall('scope');assert.throws(()=>p.migrationCall('scope'),/repeated/)
})

test('migration child only accepts pinned files, exact target and the required ledger query',()=>{
  const text='begin;select 1;commit;',file={path:'drizzle/20261027183117_fixture.sql',target:'MIKKA_DATABASE_URL',sha256:sqlHash(text)}
  const p=scopePolicy([file]);p.state.created.set(names.scope,'1');p.state.created.set(names.app,'2');p.state.created.set(names.workspace,'3')
  p.grant('scope:migrate',{url:phaseUrl,text})
  assert.throws(()=>p.grant('scope:migrate',{url:phaseUrl,text}),/repetition/)
  assert.throws(()=>p.grant('team:migrate',{url:scopeUrl(names.workspace),text}),/target/)
  assert.throws(()=>p.grant('scope:migrate',{url:phaseUrl,text:'insert into schema_migrations (name) values ($1)',ledgerName:'forged.sql'}),/ledger/)
  assert.throws(()=>p.grant('scope:migrate',{url:phaseUrl,text:'select unknown()'}),/unexpected/)
})

test('subtest rejection propagates to the suite, preserves finally, and prevents the next write',async()=>{
  const trace=[],failure=Error('expected assertion')
  const context={async test(_name,callback){try{await callback({})}catch{trace.push('record-original-failure')}}}
  await assert.rejects(async()=>{
    await scopeSubtest(context,'failure',async()=>{try{throw failure}finally{trace.push('finally')}})
    trace.push('forbidden-next-write')
  },error=>error===failure)
  assert.deepEqual(trace,['finally','record-original-failure'])
})

class Child extends EventEmitter {
  constructor(){super();this.stdout=new EventEmitter();this.stderr=new EventEmitter();this.connected=true;this.signals=[];this.messages=[]}
  send(message){this.messages.push(message);if(message.control==='abort')queueMicrotask(()=>this.emit('close',1,null))}
  kill(signal){this.signals.push(signal);queueMicrotask(()=>this.emit('close',1,signal));return true}
}
test('mock child cancellation is terminal, sends cooperative abort and never respawns',async()=>{
  const child=new Child(),controller=new AbortController()
  const pending=controlledChild(child,{timeoutMs:1000,graceMs:20,signal:controller.signal})
  controller.abort()
  await assert.rejects(pending,/cancelled/)
  assert.deepEqual(child.messages,[{control:'abort'}]);assert.deepEqual(child.signals,[])
})
test('mock child timeout and output exhaustion stop owned children; no automatic retry',async()=>{
  const timeout=new Child()
  await assert.rejects(controlledChild(timeout,{timeoutMs:5,graceMs:20}),/timeout/)
  const output=new Child(),pending=controlledChild(output,{timeoutMs:1000,graceMs:20,maxOutput:3})
  output.stdout.emit('data',Buffer.from('overflow'))
  await assert.rejects(pending,/output budget/)
  assert.equal(output.messages.length,1)
})
test('mock noncooperative child is killed after grace and async RPC failures stop it',async()=>{
  const child=new Child();child.send=message=>child.messages.push(message)
  const pending=controlledChild(child,{timeoutMs:5,graceMs:20})
  await assert.rejects(pending,/timeout/);assert.deepEqual(child.signals,['SIGTERM'])
  const rpc=new Child(),work=controlledChild(rpc,{timeoutMs:1000,graceMs:20,onMessage(){throw Error('RPC target mismatch')}})
  rpc.emit('message',{})
  await assert.rejects(work,/RPC target mismatch/)
})

test('native facade applies per-connection timeouts, logs SQL failure and closes only owned clients',async()=>{
  const trace=[],options=[]
  class NativeClient {
    constructor(input){options.push(input)}
    async query(text){trace.push(text);if(text===SCOPE_IDENTITY_SQL)return {rows:[{database:names.scope,role:'postgres',oid:'1'}],rowCount:1};if(text==='bad')throw Object.assign(Error('synthetic SQL failure'),{code:'23514'});return {rows:[],rowCount:2,command:'UPDATE'}}
    async end(){this._ending=true;trace.push('client-end')}
  }
  class NativePool {
    constructor(input){this.options=input;options.push(input)}
    connect(callback){const client=new NativeClient();client.release=()=>{};callback(null,client)}
    async end(){this.ending=true;trace.push('pool-end')}
  }
  let id=0
  const rpc=async(kind,input)=>{trace.push({kind,input});return kind==='query'?{id:String(++id)}:undefined}
  const runtime=scopeNativeRuntime({Pool:NativePool,Client:NativeClient},rpc,'scope','suite')
  const pool=new runtime.Pool({connectionString:phaseUrl,max:1}),client=await pool.connect()
  await assert.rejects(client.query('bad'),/synthetic/)
  const value=await client.query('update synthetic');assert.equal(value.rowCount,2)
  assert.ok(trace.some(e=>e.kind==='query-result'&&e.input.ok===false&&e.input.code==='23514'))
  assert.equal(options[0].statement_timeout,20000);assert.equal(options[0].lock_timeout,10000)
  await runtime.close();assert.ok(trace.includes('client-end'));assert.ok(trace.includes('pool-end'))
})
test('manifest validation is source-only and refuses drift before any executor is invoked',()=>{
  const migrations=Array.from({length:SCOPE_MIGRATION_COUNT},(_,i)=>({path:`sql-${i}`,sha256:sqlHash('sql'),target:i<7?'DATABASE_URL':'MIKKA_DATABASE_URL'}))
  const manifest={migrations,sources:[...migrations,...Array.from({length:10},(_,i)=>({path:`source-${i}`,sha256:sqlHash('source')}))]}
  assert.doesNotThrow(()=>verifyScopeManifest(manifest,path=>Buffer.from(path.startsWith('sql')?'sql':'source')))
  assert.throws(()=>verifyScopeManifest(manifest,()=>Buffer.from('changed')),/hash mismatch/)
  assert.throws(()=>verifyScopeManifest({...manifest,sources:manifest.sources.slice(1)},path=>Buffer.from(path.startsWith('sql')?'sql':'source')),/frozen migration cache entry missing/)
  assert.throws(()=>verifyScopeManifest({...manifest,sources:[...manifest.sources,manifest.sources[0]]},path=>Buffer.from(path.startsWith('sql')?'sql':'source')),/duplicate paths/)
})

test('current main table additions fit the separately proposed snapshot budget',async()=>{
  const {readFileSync}=await import('node:fs')
  const additions=['20261027181000_agent_kit.sql','20261027203647_mobile_push.sql','20261027231815_user_facts.sql','20261028015330_issue_tool_calls.sql','20261028143920_operation_ledger.sql']
  const tables=additions.flatMap(name=>[...readFileSync('drizzle/'+name,'utf8').matchAll(/create table if not exists\s+([\w"]+)/ig)].map(match=>match[1]))
  assert.equal(tables.length,14);assert.equal(new Set(tables).size,14)
  // Original retained scope bootstrap:94 tables. One decision_calls fixture
  // table is added by the unchanged business suite. No live schema is queried.
  assert.ok(SCOPE_LIMITS.snapshotTables>=94+tables.length+1)
  assert.equal(SCOPE_LIMITS.snapshotTables,120,'new limit requires a new approval; it is not the previous 100-table permit')
})


test('supervisor phases stop after the first mock child failure and never start team writes',async()=>{
  const calls=[]
  await assert.rejects(scopePhases(async phase=>{calls.push(phase);throw Error('mock scope child failed')}),/mock scope child failed/)
  assert.deepEqual(calls,['scope'])
  const successful=[];await scopePhases(async phase=>successful.push(phase));assert.deepEqual(successful,['scope','team'])
})
test('migration query budget is independent but bounded and cleanup has a separate strict cap',()=>{
  const {p}=policy();p.state.created.set(names.scope,'1')
  for(let n=0;n<1000;n++){const token=p.grant('scope:migrate',{url:phaseUrl,text:'COMMIT'});p.result(token.id,{ok:true,rowCount:0})}
  assert.throws(()=>p.grant('scope:migrate',{url:phaseUrl,text:'COMMIT'}),/budget/)
  for(let n=0;n<64;n++){const token=p.cleanup('scope',{url:phaseUrl,text:'ROLLBACK'});p.result(token.id,{ok:true,rowCount:0})}
  assert.throws(()=>p.cleanup('scope',{url:phaseUrl,text:'ROLLBACK'}),/budget/)
})
test('a child ignoring cooperative abort and TERM is killed, without a replacement process',async()=>{
  const child=new Child();child.send=message=>child.messages.push(message);child.kill=signal=>{child.signals.push(signal);if(signal==='SIGKILL')queueMicrotask(()=>child.emit('close',1,signal));return true}
  await assert.rejects(controlledChild(child,{timeoutMs:5,graceMs:20}),/timeout/)
  assert.deepEqual(child.signals,['SIGTERM','SIGKILL'])
})
test('frozen module loader executes verified bytes rather than rereading changed source',async()=>{
  const loaded=frozenScopeModule('synthetic.ts',Buffer.from('export const value: number = 7'))
  const result=await import('data:text/javascript,'+encodeURIComponent(loaded.source))
  assert.equal(result.value,7)
  const json=frozenScopeModule('synthetic.json',Buffer.from('{"__proto__":{"valid":true},"value":8}'))
  const data=await import('data:text/javascript,'+encodeURIComponent(json.source))
  assert.equal(data.default.value,8);assert.ok(Object.hasOwn(data.default,'__proto__'))
})


test('connection checkout budget and wrong bucket are denied before native work',()=>{
  const {p}=policy();p.state.created.set(names.scope,'1')
  assert.throws(()=>p.connect('scope:migrate',{url:scopeUrl(names.app)}),/mismatch/)
  for(let n=0;n<1000;n++)p.connect('scope:migrate',{url:phaseUrl})
  assert.throws(()=>p.connect('scope:migrate',{url:phaseUrl}),/budget/)
})
test('falsy exceptions still stop later subtest writes and preserve the thrown value',async()=>{
  let continued=false
  const context={async test(_name,fn){try{await fn({})}catch{}}}
  await assert.rejects(async()=>{await scopeSubtest(context,'null',async()=>{throw null});continued=true},value=>value===null)
  assert.equal(continued,false)
})


test('supervised migration explicitly opts in while the application worker cannot inherit production migration mode',()=>{
  assert.deepEqual(scopeWorkerMode('migrate'),{MIGRATE:'1',VERCEL_ENV:''})
  assert.deepEqual(scopeWorkerMode('suite'),{MIGRATE:'0',VERCEL_ENV:''})
  assert.throws(()=>scopeWorkerMode('production'),/mismatch/)
})

test('application and migration native adapters do not submit SQL after a denied grant',async()=>{
  for(const mode of ['suite','migrate']){
    let nativeQueries=0
    class NativeClient {async query(){nativeQueries++;return {rows:[{database:names.scope,role:'postgres',oid:'1'}],rowCount:1}} async end(){this._ending=true}}
    class NativePool {constructor(input){this.options=input} connect(callback){const client=new NativeClient();client.release=()=>{};callback(null,client)} async end(){this.ending=true}}
    const rpc=async(kind,input)=>{
      if(kind==='query'){assert.equal(input.bucket,'scope'+(mode==='migrate'?':migrate':''));if(!input.handshake)throw Error('budget exhausted');return {id:'handshake'}}
    }
    const runtime=scopeNativeRuntime({Pool:NativePool,Client:NativeClient},rpc,'scope',mode)
    const client=await new runtime.Pool({connectionString:phaseUrl}).connect()
    await assert.rejects(client.query('update synthetic set value=1'),/budget exhausted/)
    assert.equal(nativeQueries,1,'only identity read reached the fake native client')
    await runtime.close()
  }
})


test('cancellation while awaiting a granted query is rechecked before native submission',async()=>{
  let nativeQueries=0,runtime
  const results=[]
  class NativeClient {async query(){nativeQueries++;return {rows:[{database:names.scope,role:'postgres',oid:'1'}],rowCount:1}} async end(){this._ending=true}}
  class NativePool {constructor(input){this.options=input} connect(callback){const client=new NativeClient();client.release=()=>{};callback(null,client)} async end(){this.ending=true}}
  const rpc=async(kind,input)=>{
    if(kind==='query'){if(!input.handshake)runtime.cancel();return {id:input.handshake?'identity':'cancelled'}}
    if(kind==='query-result')results.push(input)
  }
  runtime=scopeNativeRuntime({Pool:NativePool,Client:NativeClient},rpc,'scope','suite')
  const client=await new runtime.Pool({connectionString:phaseUrl}).connect()
  await assert.rejects(client.query('update synthetic set value=1'),/cancelled before native/)
  assert.equal(nativeQueries,1)
  assert.ok(results.some(result=>result.id==='cancelled'&&result.code==='CANCELLED_BEFORE_SUBMIT'))
  await runtime.close()
})


test('loss of supervisor closes only owned worker resources and forces exit if teardown stalls',async()=>{
  const trace=[]
  await lostScopeSupervisor(async()=>{trace.push('close-owned')},code=>trace.push(code),20)
  assert.deepEqual(trace,['close-owned',1])
  await new Promise(resolve=>{void lostScopeSupervisor(()=>new Promise(()=>{}),code=>{assert.equal(code,1);resolve()},5)})
})
