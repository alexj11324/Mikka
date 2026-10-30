import assert from 'node:assert/strict'
import { randomUUID,createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { before,after,beforeEach,mock,test } from 'node:test'
import { Pool } from 'pg'
import { browserEffects, type BrowserEffect, type VisualObservation } from './visual-contract'
import type { judgeVisualBrowserAction } from './visual-model'

const database=process.env.COMPUTER_TEST_DATABASE_URL ?? process.env.E2E_DATABASE_URL
const enabled=Boolean(database)
if(process.env.REQUIRE_DB==='1' && !enabled) throw new Error('unattended DB test requires an explicitly configured test database')
if(database) {const url=new URL(database);assert.ok(['127.0.0.1','localhost'].includes(url.hostname));assert.ok(/test|e2e/.test(url.pathname))}
const schema='unattended_'+randomUUID().replaceAll('-','')
let pool:Pool,admin:Pool
let browserAction:typeof import('./action-reviews').browserAction
let execute:typeof import('./action-reviews').executeApprovedBrowserAction
let provision:typeof import('../computer/provision').ensureCloudMachine
let proposeLogin:typeof import('./credential-reviews').proposeCredentialOperation
const actor={userId:'alice',workspaceId:randomUUID()},botId=randomUUID(),subagentId=randomUUID(),credentialId=randomUUID()
let effects=0,mode:'success'|'stale'|'unknown'='success',receipt=new Map<string,unknown>()
let loginMode:'session_applied'|'guarded'='session_applied',leaseCalls=0,submissions=0
const target={targetId:'chromium-target',origin:'https://example.com',endpoint:'https://broker.invalid',expiresAt:Date.now()+60000,observedInputs:[{backendNodeId:12,credentialRole:'password' as const,loaderId:'document',epoch:1,permissionVersion:0}]}
const bytes=Buffer.from([0xff,0xd8,0xff,...Array.from({length:40},()=>0),0xff,0xd9]),imageDigest=createHash('sha256').update(bytes).digest('hex')
const observation=():VisualObservation=>({observationId:'a'.repeat(32),loaderId:'document',origin:target.origin,observedAt:Date.now(),screenshot:'data:image/jpeg;base64,'+bytes.toString('base64'),width:1280,height:800,observation:{url:target.origin,title:'Fixture',text:'Fixture',elements:[],needsLogin:false}})
function judgment(effect:BrowserEffect='browse'):Awaited<ReturnType<typeof judgeVisualBrowserAction>> {
 return {scope:'within_task',effect,execution:{executionId:randomUUID(),modelId:'openai/gpt-6-luna-decisions',providerGenerationId:'synthetic-provider',startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),requestDigest:'b'.repeat(64),imageDigests:[imageDigest],vision:'image-input-submitted'}}
}
const realFetch=globalThis.fetch
before(async()=>{
 if(!enabled)return
 admin=new Pool({connectionString:database});await admin.query(`CREATE SCHEMA "${schema}"`)
 pool=new Pool({connectionString:database,options:`-c search_path=${schema}`,max:6})
 await pool.query(`CREATE TABLE "user"(id text PRIMARY KEY);INSERT INTO "user" VALUES('alice'),('bob');CREATE TABLE agent_runs(id uuid PRIMARY KEY);CREATE TABLE devices(id uuid PRIMARY KEY);CREATE TABLE suggestions(id uuid PRIMARY KEY);CREATE TABLE device_repos(id uuid PRIMARY KEY)`)
 for(const file of ['20261027164501_cloud_computers.sql','20261029011635_subagents_thread_machines.sql','20261029080000_unattended_browser_runtime.sql','20261029080001_owner_cloud_machines.sql']) await pool.query(await readFile(new URL('../../drizzle/'+file,import.meta.url),'utf8'))
 await pool.query(`CREATE TABLE workspace_computer_policies("workspaceId" uuid PRIMARY KEY,permission text DEFAULT 'allow',version bigint DEFAULT 0,external_write_permissions jsonb DEFAULT '{}',external_write_policy_version bigint DEFAULT 0);
 CREATE TABLE agent_kit_heads(owner_id text,bot_id uuid,workspace_id uuid,external_write_permissions jsonb DEFAULT '{}',external_write_policy_version bigint DEFAULT 0);
 CREATE TABLE pending_actions(id uuid PRIMARY KEY,"userId" text NOT NULL,action text NOT NULL,input jsonb NOT NULL,status text DEFAULT 'pending',"createdAt" timestamptz DEFAULT now(),"decidedAt" timestamptz,result jsonb,error text);
 CREATE TABLE credentials(id uuid PRIMARY KEY,user_id text,origin text,username text,unattended_allowed boolean,revoked_at timestamptz);
 CREATE TABLE credential_secrets(credential_id uuid PRIMARY KEY,nonce text);`)
 await pool.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,$4)',[botId,actor.userId,actor.workspaceId,'Fixture'])
 await pool.query('INSERT INTO agent_kit_heads(owner_id,bot_id,workspace_id) VALUES($1,$2,$3)',[actor.userId,botId,actor.workspaceId])
 await pool.query('INSERT INTO workspace_computer_policies("workspaceId") VALUES($1)',[actor.workspaceId])
 await pool.query('INSERT INTO cloud_machines("workspaceId","ownerId","operationId","sandboxId",state,"runtimeReady") VALUES($1,$2,$3,$4,$5,true)',[actor.workspaceId,actor.userId,randomUUID(),'isolated-test-machine','running'])
 await pool.query(`INSERT INTO bot_subagents(id,"ownerId","workspaceId","botId",task,status,epoch,"targetId") VALUES($1,$2,$3,$4,'Open details','running',1,'chromium-target')`,[subagentId,actor.userId,actor.workspaceId,botId])
 await pool.query('INSERT INTO credentials VALUES($1,$2,$3,$4,true,NULL)',[credentialId,actor.userId,target.origin,'saved-user'])
 await pool.query('INSERT INTO credential_secrets VALUES($1,$2)',[credentialId,'secret-version-1'])
 mock.module('@/lib/subscription-runtime',{namedExports:{authorizeSubscriptionWorkspace:async(owner:string,workspace:string)=>{if(owner!==actor.userId || workspace!==actor.workspaceId)throw Error('not authorized')}}})
 mock.module('./runtime',{namedExports:{
  runtimeRequest:async(_sandbox:string,_row:unknown,_path:string,body:any)=>{
   if(mode==='stale')throw Error('observation_stale')
   if(mode==='unknown')throw Error('action_outcome_unknown')
   if(!receipt.has(body.actionId)){effects++;receipt.set(body.actionId,{accepted:true,actionId:body.actionId})}
   return receipt.get(body.actionId)
  },
  installSubagentRuntime:async()=>undefined,
  grant:async(_sandbox:unknown,_row:unknown,_role:unknown,action:any)=>{assert.equal(action.operation,'submit');submissions++;return {endpoint:'https://owned-broker.invalid',expiresAt:Date.now()+60000}},
  endpointPath:(endpoint:string,path:string)=>endpoint+path,
 }})
 mock.module('@/lib/computer/e2b-provider',{namedExports:{connectComputer:async()=>({sandboxId:'isolated-test-machine'}),createComputer:async()=>({sandboxId:'isolated-test-machine'}),installComputerRuntime:async()=>undefined}})
 mock.module('./subagent-browser',{namedExports:{resolveSubagentBrowserTarget:async()=>target}})
 mock.module('@/lib/credentials/runtime',{namedExports:{credentialStore:{authorize:async()=>undefined,lease:async(_caller:unknown,_origin:unknown,_target:unknown,_username:unknown,_force:unknown,expected:any)=>{assert.equal(expected.credentialId,credentialId);assert.equal(expected.revision,'secret-version-1');leaseCalls++;return {status:'ready',lease:'synthetic-lease'}}},executeCredentialLease:async()=>({status:loginMode,origin:target.origin})}})
 const actions=await import('./action-reviews');browserAction=actions.browserAction;execute=actions.executeApprovedBrowserAction
 provision=(await import('../computer/provision')).ensureCloudMachine
 proposeLogin=(await import('./credential-reviews')).proposeCredentialOperation
})
beforeEach(async()=>{
 if(!enabled)return
 effects=0;mode='success';receipt=new Map();leaseCalls=0;submissions=0;loginMode='session_applied'
 await pool.query(`UPDATE bot_subagents SET status='running',needs=NULL,"activeActionId"=NULL,epoch=1,"targetId"='chromium-target';UPDATE pending_actions SET status='declined' WHERE status IN ('running','pending');UPDATE agent_kit_heads SET external_write_permissions='{}',external_write_policy_version=0;UPDATE workspace_computer_policies SET permission='allow',version=0,external_write_permissions='{}',external_write_policy_version=0;UPDATE credentials SET unattended_allowed=true,revoked_at=NULL;UPDATE credential_secrets SET nonce='secret-version-1'`)
})
after(async()=>{if(enabled){console.log(`Retained unattended DB schema: ${schema}`);globalThis.fetch=realFetch;await pool.end();await admin.end()}})
async function propose(effect:BrowserEffect='browse') {return browserAction(pool,actor,botId,subagentId,{action:'click',x:20,y:40},'Open the requested control',observation(),judgment(effect))}
async function stored(id:string){return (await pool.query('SELECT * FROM pending_actions WHERE id=$1',[id])).rows[0]}

test('authorized browsing runs without a human decision and exact replay returns the stored receipt',{skip:!enabled},async()=>{
 const result=await propose();assert.equal(result.state,'running');assert.equal(effects,1)
 const record=await stored(result.actionId);assert.equal(record.status,'done');assert.equal(record.decidedAt,null)
 assert.equal(record.input.mutation,undefined,'done: executable mutation scrubbed');assert.equal(record.input.mutationScrubbed,true)
 assert.ok('error' in await execute(pool,actor.userId,record.input,true),'a scrubbed row can never execute again');assert.equal(effects,1)
})
test('#438 mutation lifecycle: kept only while executable; scrubbed on done, declined, failed and expired; never returned',{skip:!enabled},async()=>{
 const asked=await propose('write_external');assert.equal(asked.state,'needs_you');assert.ok(!('mutation' in asked),'proposer gets no mutation')
 const pending=await stored(asked.actionId);assert.deepEqual(pending.input.mutation,{action:'click',x:20,y:40},'pending: kept for the executor')
 // replay of the exact raw input still matches by digest after the row is scrubbed
 await pool.query(`UPDATE pending_actions SET status='running',"decidedAt"=now() WHERE id=$1`,[asked.actionId])
 assert.ok('data' in await execute(pool,actor.userId,pending.input,true));assert.equal((await stored(asked.actionId)).input.mutation,undefined)
 assert.deepEqual(await execute(pool,actor.userId,pending.input,true),{data:{subagentId,accepted:true,replayed:true}});assert.equal(effects,1)
 // declined
 const d=await propose('write_external'),dRaw=(await stored(d.actionId)).input
 await pool.query(`UPDATE pending_actions SET status='declined',"decidedAt"=now() WHERE id=$1`,[d.actionId])
 assert.deepEqual(await execute(pool,actor.userId,dRaw,false),{data:{declined:true}})
 const declined=await stored(d.actionId);assert.equal(declined.input.mutation,undefined);assert.equal(declined.input.summary,'Open the requested control');assert.equal(declined.input.digest,dRaw.digest)
 // failed (stale)
 mode='stale';await assert.rejects(propose(),/browserActionExpired/);mode='success'
 const failed=(await pool.query(`SELECT input,status FROM pending_actions WHERE status='failed' ORDER BY "createdAt" DESC LIMIT 1`)).rows[0]
 assert.equal(failed.input.mutation,undefined)
 // expired: an undecided action older than 5 minutes is failed and scrubbed by the next proposal's sweep
 const e=await propose('write_external');await pool.query(`UPDATE pending_actions SET "createdAt"=now()-interval '6 minutes' WHERE id=$1`,[e.actionId])
 await pool.query(`UPDATE bot_subagents SET status='running',needs=NULL,"activeActionId"=NULL`)
 await propose()
 const expired=await stored(e.actionId);assert.equal(expired.status,'failed');assert.equal(expired.error,'browserActionExpired');assert.equal(expired.input.mutation,undefined)
 const left=await pool.query(`SELECT id FROM pending_actions WHERE input ? 'mutation' AND status IN ('done','declined','failed')`)
 assert.equal(left.rowCount,0,'no terminal row keeps a mutation')
 // list endpoint and audit event expose summary-level fields only; errors are fixed codes
 const src=await readFile(new URL('../pending-actions.ts',import.meta.url),'utf8'),list=await readFile(new URL('../pending-action-store.ts',import.meta.url),'utf8')
 assert.match(src,/row\.action === 'credential_operation' \|\| row\.action === 'browser_operation' \? \{ summary/)
 assert.match(list,/input: \{ summary: row\.input\.summary, origin: row\.input\.origin, operation: row\.input\.operation/)
})
test('default allow: with no workspace policy row every effect, payment and sending included, runs with no human approval',{skip:!enabled},async()=>{
 await pool.query('DELETE FROM workspace_computer_policies')
 try {
  for(const effect of browserEffects) {
   const result=await propose(effect)
   assert.equal(result.state,'running',effect)
   const record=await stored(result.actionId)
   assert.equal(record.status,'done',effect);assert.equal(record.decidedAt,null,effect)
   const row=(await pool.query('SELECT status,needs,"activeActionId" FROM bot_subagents WHERE id=$1',[subagentId])).rows[0]
   assert.deepEqual(row,{status:'running',needs:null,activeActionId:null},effect)
  }
  assert.equal(effects,browserEffects.length)
  assert.equal((await pool.query(`SELECT 1 FROM pending_actions WHERE action='browser_operation' AND status='pending'`)).rowCount,0)
 } finally {await pool.query('INSERT INTO workspace_computer_policies("workspaceId") VALUES($1)',[actor.workspaceId])}
})
test('a legacy stored ask is not a human gate; concurrent replay produces one effect and other owners or payloads cannot reuse it',{skip:!enabled},async()=>{
 await pool.query(`UPDATE workspace_computer_policies SET permission='ask'`)
 const result=await propose('write_external');assert.equal(result.state,'running');assert.equal(effects,1)
 const record=await stored(result.actionId);assert.equal(record.decidedAt,null)
 const outcomes=await Promise.all(Array.from({length:10},()=>execute(pool,actor.userId,record.input,true)))
 assert.ok(outcomes.every(result=>'data' in result));assert.equal(effects,1)
 assert.ok('error' in await execute(pool,'bob',record.input,true));assert.equal(effects,1)
 assert.ok('error' in await execute(pool,actor.userId,{...record.input,mutation:{action:'click',x:999,y:999}},true));assert.equal(effects,1)
})
test('deny blocks: an explicit effect deny wins over agent allow, and a workspace computer deny blocks every effect',{skip:!enabled},async()=>{
 await pool.query(`UPDATE agent_kit_heads SET external_write_permissions='{"browser_payment":"allow"}'`)
 await pool.query(`UPDATE workspace_computer_policies SET external_write_permissions='{"browser_payment":"deny"}'`)
 await assert.rejects(propose('payment'),/Browser action denied/);assert.equal(effects,0)
 assert.equal((await propose('write_external')).state,'running');assert.equal(effects,1)
 await pool.query(`UPDATE workspace_computer_policies SET permission='deny',version=version+1,external_write_permissions='{}'`)
 for(const effect of browserEffects) await assert.rejects(propose(effect),/Browser action denied/)
 assert.equal(effects,1)
 assert.equal((await pool.query(`SELECT 1 FROM pending_actions WHERE status='pending'`)).rowCount,0)
})
test('stale observations resume observation, unknown outcomes are not silently retried',{skip:!enabled},async()=>{
 mode='stale';await assert.rejects(propose(),/browserActionExpired/)
 let row=(await pool.query('SELECT * FROM bot_subagents WHERE id=$1',[subagentId])).rows[0]
 assert.equal(row.status,'running');assert.equal(row.activeActionId,null)
 mode='unknown';await assert.rejects(propose(),/browserActionOutcomeUnknown/)
 row=(await pool.query('SELECT * FROM bot_subagents WHERE id=$1',[subagentId])).rows[0]
 assert.equal(row.status,'needs_you');assert.ok(row.activeActionId);assert.equal(effects,0)
})
test('a saved same-owner/site unattended grant reuses a login without an approval card',{skip:!enabled},async()=>{
 const result=await proposeLogin(pool,{...actor,botId,subagentId},target,'login')
 assert.equal(result.status,'session_applied');assert.equal(leaseCalls,1)
 const row=(await pool.query('SELECT * FROM bot_subagents WHERE id=$1',[subagentId])).rows[0]
 assert.equal(row.status,'running');assert.equal(row.activeActionId,null)
 const events=(await pool.query('SELECT event FROM subagent_events WHERE "subagentId"=$1',[subagentId])).rows
 assert.ok(events.length>0)
 assert.equal(events.at(-1)?.event.data.state,'running')
 const approvals=await pool.query(`SELECT 1 FROM pending_actions WHERE action='credential_operation' AND status='pending'`)
 assert.equal(approvals.rowCount,0)
})
test('ambiguous, revoked, foreign and denied login grants cannot fill credentials',{skip:!enabled},async()=>{
 await pool.query('UPDATE credentials SET unattended_allowed=false')
 assert.equal((await proposeLogin(pool,{...actor,botId,subagentId},target,'login')).status,'needs_login');assert.equal(leaseCalls,0)
 await pool.query('UPDATE credentials SET unattended_allowed=true,revoked_at=now()')
 assert.equal((await proposeLogin(pool,{...actor,botId,subagentId},target,'login')).status,'needs_login');assert.equal(leaseCalls,0)
 await pool.query('UPDATE credentials SET revoked_at=NULL')
 assert.equal((await proposeLogin(pool,{...actor,userId:'bob',botId,subagentId},target,'login')).status,'needs_login');assert.equal(leaseCalls,0)
 await pool.query(`UPDATE workspace_computer_policies SET permission='deny'`)
 await assert.rejects(proposeLogin(pool,{...actor,botId,subagentId},target,'login'));assert.equal(leaseCalls,0)
})
test('machine allocation does not hold a SQL connection while the provider is creating it',{skip:!enabled},async()=>{
 const single=new Pool({connectionString:database,options:`-c search_path=${schema}`,max:1,connectionTimeoutMillis:1000})
 const owner={userId:'bob',workspaceId:actor.workspaceId}
 let entered!:()=>void,release!:()=>void
 const started=new Promise<void>(resolve=>{entered=resolve}),wait=new Promise<void>(resolve=>{release=resolve})
 const call=provision(single,owner,{createComputer:async()=>{entered();await wait;return {sandboxId:'owned-bob'} as never},connectComputer:async()=>({sandboxId:'owned-bob'} as never),installComputerRuntime:async()=>undefined})
 await started
 assert.equal((await single.query('SELECT 1 AS reachable')).rows[0].reachable,1)
 release();assert.equal((await call)?.sandboxId,'owned-bob')
 await single.end()
})

test('saved login covers guarded fill and one same-document submission, never two approval cards',{skip:!enabled},async()=>{
 loginMode='guarded'
 globalThis.fetch=(async(input:any)=>{assert.equal(String(input),'https://owned-broker.invalid/credentials/continue');return Response.json({resumed:true,operation:'submit'})}) as typeof fetch
 try {
  const result=await proposeLogin(pool,{...actor,botId,subagentId},target,'login')
  assert.equal(result.status,'resumed');assert.equal(leaseCalls,1);assert.equal(submissions,1)
  const pending=await pool.query(`SELECT 1 FROM pending_actions WHERE action='credential_operation' AND status='pending'`)
  assert.equal(pending.rowCount,0)
 } finally {globalThis.fetch=realFetch}
})
test('two saved accounts require a concrete account choice instead of selecting a random login',{skip:!enabled},async()=>{
 const second=randomUUID()
 await pool.query('INSERT INTO credentials VALUES($1,$2,$3,$4,true,NULL)',[second,actor.userId,target.origin,'second-account'])
 await pool.query('INSERT INTO credential_secrets VALUES($1,$2)',[second,'second-version'])
 try {
  const result=await proposeLogin(pool,{...actor,botId,subagentId},target,'login')
  assert.equal(result.status,'needs_login');assert.equal(leaseCalls,0);assert.equal(submissions,0)
 } finally {await pool.query('UPDATE credentials SET revoked_at=now() WHERE id=$1',[second])}
})

test('a permanently failed queued start terminates durably without blocking later work',{skip:!enabled},async()=>{
 const {SubagentStore}=await import('./subagents')
 await pool.query(`UPDATE bot_subagents SET status='queued',"targetId"=NULL WHERE id=$1`,[subagentId])
 const store=new SubagentStore(pool)
 const result=await store.update(actor,botId,subagentId,'failed','Provisioning failed after bounded retries')
 assert.equal(result.status,'failed')
 const saved=(await pool.query('SELECT status,"endedAt" FROM bot_subagents WHERE id=$1',[subagentId])).rows[0]
 assert.ok(saved.endedAt)
 assert.equal((await pool.query(`SELECT count(*)::int AS n FROM bot_subagents WHERE "ownerId"=$1 AND status='queued'`,[actor.userId])).rows[0].n,0)
 assert.equal((await store.update(actor,botId,subagentId,'running','Late callback')).status,'failed','a late start cannot revive the terminal task')
})
test('a denied queued web task ends before starting any browser runtime',{skip:!enabled},async()=>{
 const {SubagentStore}=await import('./subagents')
 await pool.query(`UPDATE bot_subagents SET status='queued',"targetId"=NULL WHERE id=$1`,[subagentId])
 await pool.query(`UPDATE workspace_computer_policies SET permission='deny'`)
 const row=await new SubagentStore(pool).start(actor,botId,subagentId)
 assert.equal(row.status,'failed')
 assert.equal(effects,0,'workspace denial cannot invoke a browser start')
})
