import pg from 'pg'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createApprovedWrites } from './approved-writes'
import { approvedWriteHandler } from './write-http'
import { makeSnapshot, digest } from '../agent-kit/definition'
import { DEFAULT_AGENT_DEFINITION } from '../agent-kit/builtin'
import type { WriteProvider } from './write-contract'
import { validateTarget } from '../../scripts/run-db-tests.mjs'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createWritePolicySettings } from './write-policy-settings'
test('isolated PG and HTTP authorize direct app writes and preserve one effect', { timeout:30000 }, async () => {
validateTarget(process.env)
assert.equal(process.env.REQUIRE_DB,'1')
const schema='write374_chain_'+randomUUID().replaceAll('-','')
console.log(`Retained isolated write-policy fixture schema: ${schema}`)
const admin=new pg.Pool({connectionString:process.env.E2E_DATABASE_URL,max:1})
let pool:pg.Pool | undefined
try {
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const url=new URL(process.env.E2E_DATABASE_URL!)
 url.searchParams.set('options',`-c search_path=${schema},pg_catalog`)
 pool=new pg.Pool({connectionString:url.href,max:4})
 const scopedPool=pool
 await scopedPool.query(`create table "session" (id text primary key, "userId" text not null, "expiresAt" timestamptz not null);
 create table agent_kit_heads (owner_id text, bot_key text, workspace_id uuid, active_version uuid, primary key (owner_id,bot_key));
 create table agent_kit_versions (owner_id text, bot_key text, id uuid, definition jsonb, digest text);
 create table agent_kit_executions (owner_id text, bot_key text, id uuid, status text, snapshot jsonb, version_id uuid)`)
 for (const name of ['20261025043000_pending_actions.sql','20261028143920_operation_ledger.sql','20261028143921_approved_write_binding.sql','20261027164515_workspace_computer_policy.sql','20261029010447_workspace_computer_policy_allow.sql','20261029043646_agent_external_write_policy.sql','20261029043647_workspace_external_write_policy.sql','20261030204751_workspace_computer_policy_default_allow.sql']) await scopedPool.query(await readFile(new URL('../../drizzle/'+name,import.meta.url),'utf8'))
const owner='fixture-owner', runId=randomUUID(), revision=randomUUID(), action='append_notion_paragraph', actor={userId:owner,sessionId:'fixture-session'}
const definition={...DEFAULT_AGENT_DEFINITION,tools:[action]}
const snapshot=makeSnapshot(revision,1,definition,'host',{harness:'ai_sdk',model:'openai/gpt-6-luna'})
let writes=0, uncertain=false
const provider:WriteProvider={name:'synthetic',prepare:async()=>({accountId:'account',version:'v1'}),execute:async ({beforeSend})=>{await beforeSend();writes++;if (uncertain) throw Error('synthetic transport lost');return {providerObjectId:'fixture',evidenceDigest:'a'.repeat(64)}},lookup:async()=>null}
const input={page_id:randomUUID(),text:'fixture'}
const run={ownerId:owner,botId:null,workspaceId:null,runId}
 await scopedPool.query('insert into "session" values($1,$2,now()+interval \'1 hour\')',[actor.sessionId,owner])
 await scopedPool.query('insert into agent_kit_heads(owner_id,bot_key,active_version) values($1,$2,$3)',[owner,'coordinator',revision])
 await scopedPool.query('insert into agent_kit_versions values($1,$2,$3,$4,$5)',[owner,'coordinator',revision,definition,digest(definition)])
 await scopedPool.query('insert into agent_kit_executions values($1,$2,$3,$4,$5,$6)',[owner,'coordinator',runId,'running',snapshot,revision])
 const service=createApprovedWrites(scopedPool,provider,action,{modelRun:run})
 const set=async (decision:string)=>scopedPool.query('update agent_kit_heads set external_write_permissions=$1 where owner_id=$2',[{[action]:decision},owner])
 await set('deny')
 const allowKey=randomUUID(), allowed=await service.proposeFromRun(input,allowKey)
 assert.equal(allowed.status,'done');assert.equal(writes,1)
 const repeated=await service.proposeFromRun(input,allowKey)
 assert.equal(repeated.status,'done');assert.equal(writes,1)
 assert.equal(Number((await scopedPool.query("select count(*) from pending_actions where status='pending'")).rows[0].count),0)
 const review = createApprovedWrites(scopedPool, provider, action, {
   modelRun: run,
   nativeWriteReview: async (decision, binding) => {
     assert.equal(decision, 'allow')
     assert.deepEqual(binding.input, input)
     return 'ask'
   },
 })
 const askKey=randomUUID(), asked=await review.proposeFromRun(input,askKey)
 assert.equal(asked.status,'awaiting_approval');assert.equal(writes,1)
 assert.equal((await review.proposeFromRun(input,askKey)).actionId,asked.actionId)
 await scopedPool.query("update agent_kit_executions set status='completed' where id=$1",[runId])
 const handler=approvedWriteHandler({api:{getSession:async()=>({user:{id:owner},session:{id:actor.sessionId}})}},(name,context)=>createApprovedWrites(scopedPool,provider,name,context))
 const request=()=>new Request('https://fixture.invalid/api/approved-writes',{method:'POST',headers:{origin:'https://fixture.invalid',cookie:'fixture=1'},body:JSON.stringify({op:'decide',action,id:asked.actionId,approve:true})})
 const result=await handler(request());assert.equal(result.status,200);assert.equal((await result.json()).status,'done');assert.equal(writes,2)
 const again=await handler(request());assert.equal(again.status,200);assert.equal(writes,2)
 await scopedPool.query("update agent_kit_executions set status='running' where id=$1",[runId])
 const revoked=await review.proposeFromRun(input,randomUUID())
 const withoutTool={...definition,tools:[]}
 await scopedPool.query('update agent_kit_versions set definition=$1,digest=$2 where id=$3',[withoutTool,digest(withoutTool),revision])
 const no=await handler(new Request('https://fixture.invalid/api/approved-writes',{method:'POST',headers:{origin:'https://fixture.invalid',cookie:'fixture=1'},body:JSON.stringify({op:'decide',action,id:revoked.actionId,approve:true})}))
 assert.equal(no.status,409);assert.equal(writes,2)
 await scopedPool.query('update agent_kit_versions set definition=$1,digest=$2 where id=$3',[definition,digest(definition),revision])
 const concurrentKey=randomUUID()
 const simultaneous=await Promise.all(Array.from({length:4},()=>service.proposeFromRun(input,concurrentKey)))
 assert.equal(new Set(simultaneous.map(value=>value.actionId)).size,1);assert.equal(writes,3)
 uncertain=true
 const unknownKey=randomUUID(), unknown=await service.proposeFromRun(input,unknownKey)
 assert.equal(unknown.status,'running');assert.equal(writes,4)
 uncertain=false
 await service.proposeFromRun(input,unknownKey);assert.equal(writes,4)
 const botId=randomUUID(),workspaceId=randomUUID(),botRun=randomUUID(),botRevision=randomUUID()
 const botSnapshot=makeSnapshot(botRevision,1,definition,'host',{harness:'ai_sdk',model:'openai/gpt-6-luna'})
 await scopedPool.query('insert into agent_kit_heads(owner_id,bot_key,workspace_id,active_version,external_write_permissions) values($1,$2,$3,$4,$5)',[owner,botId,workspaceId,botRevision,{[action]:'allow'}])
 await scopedPool.query('insert into agent_kit_versions values($1,$2,$3,$4,$5)',[owner,botId,botRevision,definition,digest(definition)])
 await scopedPool.query('insert into agent_kit_executions values($1,$2,$3,$4,$5,$6)',[owner,botId,botRun,'running',botSnapshot,botRevision])
 const membership = async (_tx:unknown,signal:AbortSignal) => ({signal,workspaceClient:{query:async()=>({rows:[{role:'admin'}]})} as never,check:async()=>{},close:async()=>{}})
 const botScope={ownerId:owner,botId,workspaceId}
 const settings=createWritePolicySettings(scopedPool,()=>membership)
 const nonAdmin=createWritePolicySettings(scopedPool,()=>async (_tx,signal)=>({signal,workspaceClient:{query:async()=>({rows:[{role:'member'}]})} as never,check:async()=>{},close:async()=>{}}))
 await assert.rejects(nonAdmin.setWorkspace(botScope,{[action]:'allow'},'0'),/workspaceAccessDenied/)
 assert.deepEqual(await settings.readWorkspace(botScope),{permissions:{},version:'0'})
 assert.deepEqual(await settings.setWorkspace(botScope,{[action]:'deny'},'0'),{permissions:{[action]:'deny'},version:'1'})
 const botService=createApprovedWrites(scopedPool,provider,action,{modelRun:{...botScope,runId:botRun},guard:membership,guardForRun:()=>membership})
 assert.equal((await botService.proposeFromRun(input,randomUUID())).status,'done');assert.equal(writes,5)
 console.log('isolated PG/HTTP: direct calls honor the pinned run and tool, native approval remains bound, and replay does not resend')
} finally { await pool?.end(); await admin.end() }
})
