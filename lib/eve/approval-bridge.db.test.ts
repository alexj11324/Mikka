import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { callAppTool, type AppToolDeps } from '../app-tools'
import { createApprovedWrites } from '../operations/approved-writes'
import { makeSnapshot,digest } from '../agent-kit/definition'
import { DEFAULT_AGENT_DEFINITION } from '../agent-kit/builtin'
import { createEveApprovalBridge,type ApprovalCall } from './approval-bridge'
import { eveApprovalStore } from './approval-store'
import { isE2eTarget,E2E_DB_RULE } from '../../tests/helpers/e2e-target.mjs'

const url=process.env.E2E_DATABASE_URL
if(url)assert.ok(isE2eTarget(url),E2E_DB_RULE)
else if(process.env.REQUIRE_DB==='1')throw new Error('Native approval tests require E2E_DATABASE_URL')

test('native Ask uses one durable product receipt and existing personal operation ledger',{skip:!url,timeout:30000},async()=>{
  const schema=`eve_approval_${randomUUID().replaceAll('-','')}`,owner='fixture-owner',bot=randomUUID(),workspace=randomUUID()
  const admin=new Pool({connectionString:url}),pool=new Pool({connectionString:url,options:`-c search_path=${schema},pg_catalog`})
  await admin.query(`CREATE SCHEMA ${schema}`)
  try {
    await pool.query(`CREATE TABLE "user"(id text PRIMARY KEY);CREATE TABLE bots(id uuid PRIMARY KEY);
      CREATE TABLE agent_kit_heads(owner_id text,bot_key text,workspace_id uuid,active_version uuid,PRIMARY KEY(owner_id,bot_key));
      CREATE TABLE agent_kit_versions(owner_id text,bot_key text,id uuid,definition jsonb,digest text);
      CREATE TABLE agent_kit_executions(owner_id text,bot_key text,id uuid,status text,snapshot jsonb,version_id uuid)`)
    await pool.query('INSERT INTO "user" VALUES($1);',[owner]);await pool.query('INSERT INTO bots VALUES($1)',[bot])
    for(const name of ['20261025043000_pending_actions.sql','20261028143920_operation_ledger.sql','20261028143921_approved_write_binding.sql','20261027164515_workspace_computer_policy.sql','20261029010447_workspace_computer_policy_allow.sql','20261029043646_agent_external_write_policy.sql','20261029043647_workspace_external_write_policy.sql','20261030204751_workspace_computer_policy_default_allow.sql','20261111150000_eve_tool_approvals.sql'])await pool.query(await readFile(new URL('../../drizzle/'+name,import.meta.url),'utf8'))
    const store=eveApprovalStore(pool,owner,bot)
    const call:ApprovalCall={ownerId:owner,botId:bot,workspaceId:workspace,surface:'web',sessionId:'fixture-session',turnId:'fixture-turn',callId:'legacy-call',name:'call_app_tool',input:{toolkit:'slack',tool:'SLACK_SEND_MESSAGE',arguments:{text:'Final text'}},sourceEventId:randomUUID()}
    const responder={authenticator:'mikka',principalType:'user',principalId:owner,attributes:{botId:bot,workspaceId:workspace,surface:'web'}}
    let sends=0,cards=0
    const deps:AppToolDeps={appAllowed:async()=>true,resolveAccount:async()=>({accountId:'account',accounts:[]}),listTools:async()=>[],getTool:async()=>({slug:'SLACK_SEND_MESSAGE',name:'Send',toolkit:{slug:'slack'},version:'v1'}),setting:async()=>'ask',judge:async()=>{throw new Error('explicit Ask must not judge')},execute:async()=>{sends++;return {successful:true,data:{id:'message'}}},recordStart:async()=>'product-receipt',recordEnd:async()=>{},propose:async()=>{cards++;return {status:'awaiting_approval'}}}
    const bridge=createEveApprovalBridge({store,run:(c,review)=>callAppTool(deps,c.input,{ownerId:owner,botId:bot,review})})
    assert.equal((await bridge.review(call))?.status,'user-approval');assert.equal(sends,0);assert.equal(cards,0)
    await Promise.all([bridge.execute(call,responder),bridge.execute(call,responder)])
    assert.equal(sends,1);assert.equal(cards,0)
    assert.equal((await bridge.execute(call,responder) as {status:string}).status,'done');assert.equal(sends,1)
    assert.equal((await eveApprovalStore(pool,'other',bot).read('unknown')),null)
    deps.resolveAccount=async()=>({accountId:null,accounts:[{id:'account-a',alias:'Work'},{id:'account-b',alias:'Personal'}]})
    const selection={...call,callId:'selection-call'}
    assert.equal((await bridge.review(selection))?.status,'not-applicable')
    assert.deepEqual(await bridge.execute(selection),{error:'integrationAccountSelectionRequired',accounts:[{id:'account-a',alias:'Work'},{id:'account-b',alias:'Personal'}]})
    assert.equal(sends,1);assert.equal(cards,0)
    deps.resolveAccount=async()=>({accountId:'account',accounts:[]})

    const action='append_notion_paragraph',runId=randomUUID(),revision=randomUUID(),definition={...DEFAULT_AGENT_DEFINITION,tools:[action]}
    const snapshot=makeSnapshot(revision,1,definition,'host',{harness:'ai_sdk',model:'openai/gpt-6-luna'})
    await pool.query('INSERT INTO agent_kit_heads(owner_id,bot_key,workspace_id,active_version) VALUES($1,$2,$3,$4)',[owner,bot,workspace,revision])
    await pool.query('INSERT INTO agent_kit_versions VALUES($1,$2,$3,$4,$5)',[owner,bot,revision,definition,digest(definition)])
    await pool.query('INSERT INTO agent_kit_executions VALUES($1,$2,$3,$4,$5,$6)',[owner,bot,runId,'running',snapshot,revision])
    await pool.query('INSERT INTO workspace_computer_policies("workspaceId",external_write_permissions) VALUES($1,$2)',[workspace,{[action]:'ask'}])
    let personalSends=0
    const personal={...call,callId:'personal-call',executionId:runId,name:action,input:{page_id:randomUUID(),text:'Final paragraph'}}
    const intents=new Map<string,string>()
    const native=createEveApprovalBridge({store,async run(c,review){
      const service=createApprovedWrites(pool,{name:'fixture',prepare:async()=>({accountId:'account',version:'v1',context:{target:'page'}}),execute:async({beforeSend})=>{await beforeSend();personalSends++;return {providerObjectId:'paragraph',evidenceDigest:'a'.repeat(64)}},lookup:async()=>null},action,{modelRun:{ownerId:owner,botId:bot,workspaceId:workspace,runId},guard:async(_tx,signal)=>({signal,check:async()=>{},close:async()=>{}}),nativeWriteReview:review})
      if(!intents.has(c.callId))intents.set(c.callId,randomUUID())
      try{return await service.proposeFromRun(c.input,intents.get(c.callId)!)}catch(error){if(error instanceof Error&&error.message==='writeDenied')return {error:'writeDenied'};throw error}
    }})
    assert.equal((await native.review(personal))?.status,'user-approval')
    assert.equal(personalSends,0)
    assert.equal(Number((await pool.query('SELECT count(*) FROM pending_actions')).rows[0].count),0,'review creates no parallel generic approval')
    assert.equal((await native.execute(personal,responder) as {status:string}).status,'done')
    assert.equal(personalSends,1)
    assert.equal((await native.execute(personal,responder) as {status:string}).status,'done')
    assert.equal(personalSends,1)
    assert.equal((await pool.query('SELECT status FROM operation_ledger')).rows[0].status,'succeeded')
    assert.equal(Number((await pool.query("SELECT count(*) FROM pending_actions WHERE status='pending'")).rows[0].count),0)
    const revoked={...personal,callId:'revoked-call'}
    assert.equal((await native.review(revoked))?.status,'user-approval')
    await pool.query('UPDATE workspace_computer_policies SET external_write_permissions=$2,external_write_policy_version=external_write_policy_version+1 WHERE "workspaceId"=$1',[workspace,{[action]:'deny'}])
    assert.deepEqual(await native.execute(revoked,responder),{error:'writeDenied'})
    assert.equal(personalSends,1,'revocation before the native response never sends')
    const expired={...call,callId:'expired-call'}
    await bridge.review(expired)
    await pool.query("UPDATE eve_tool_approvals SET created_at=clock_timestamp()-interval '8 days' WHERE status='prepared'")
    await assert.rejects(bridge.execute(expired,responder),/pendingActionUnavailable/)
    assert.equal(sends,1)
  } finally {await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end()}
})
