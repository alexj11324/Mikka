import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { emptySessionView, foldEvents, type ReceivedEvent, type TurnOutcome } from 'eve/events'
import { projectEveTurn } from './projection'
import { userMessageEvent } from '../coordinator-events'
import { isE2eTarget, E2E_DB_RULE } from '../../tests/helpers/e2e-target.mjs'

let decisions=0,choice:'finished'|'none'='finished'
const decisionInputs:string[]=[]
const pushes:Array<{owner:string;bot:string;text:string|null;reasons:unknown;task:unknown}>=[]
mock.module(new URL('../coordinator/decide.ts',import.meta.url).href,{namedExports:{decide:async(_purpose:string,input:string)=>{decisions++;decisionInputs.push(input);return new Map([['push',{type:'choice',choice}]])}}})
mock.module(new URL('../mobile-push.ts',import.meta.url).href,{namedExports:{pushReply:async(owner:string,bot:string,text:string|null,reasons:unknown,task:unknown)=>{pushes.push({owner,bot,text,reasons,task})}}})
mock.module(new URL('../execution-settings.ts',import.meta.url).href,{namedExports:{executionWorkspace:async()=>null}})
const {createEveOutcomeDelivery}=await import('./outcome-delivery')
const url=process.env.E2E_DATABASE_URL
if(url)assert.ok(isE2eTarget(url),E2E_DB_RULE)
else if(process.env.REQUIRE_DB==='1')throw Error('Native outcome delivery requires E2E_DATABASE_URL')

test('committed native outcomes deliver Telegram and existing phone Decisions once with live source custody',{skip:!url},async t=>{
 const schema='eve_delivery_'+randomUUID().replaceAll('-','')
 const admin=new Pool({connectionString:url}),app=new Pool({connectionString:url,options:`-c search_path=${schema}`})
 const telegram:Array<{thread:string;text:string}>=[]
 try {
  await admin.query(`CREATE SCHEMA ${schema}`)
  await app.query(`CREATE TABLE "user"(id text PRIMARY KEY);
   CREATE TABLE bots(id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid);
   CREATE TABLE mikka_workspaces(id uuid PRIMARY KEY,kind text,"userId" text);
   CREATE TABLE mikka_workspace_members("workspaceId" uuid,"userId" text,status text);
   CREATE TABLE coordinator_bots("ownerId" text,"workspaceId" uuid,"botId" uuid);
   CREATE TABLE eve_sessions(session_id text PRIMARY KEY,owner_id text,bot_id uuid,workspace_id uuid,surface text);
   CREATE TABLE eve_turn_sources(session_id text,turn_id text,source_event_id uuid);
   CREATE TABLE eve_projection_receipts(session_id text,event_key text);
   CREATE TABLE coordinator_events(id uuid PRIMARY KEY,"userId" text,"botId" uuid,kind text,tier text,"issueId" uuid,"runId" uuid,payload jsonb,"deliveredAt" timestamptz);
   CREATE TABLE coordinator_messages(id uuid PRIMARY KEY,"userId" text,"botId" uuid,position integer,message jsonb);
   CREATE TABLE telegram_links("userId" text PRIMARY KEY,"telegramUserId" text);
   CREATE TABLE telegram_conversations("threadId" text PRIMARY KEY,"userId" text);
   CREATE TABLE issues(id uuid PRIMARY KEY,"userId" text,"workspaceId" uuid,"ownershipState" text,content jsonb)`)
  await app.query(await readFile(new URL('../../drizzle/20261112000500_eve_outcome_deliveries.sql',import.meta.url),'utf8'))
  async function fixture(options:{text?:string;outcome?:TurnOutcome;error?:string;quiet?:boolean;commit?:boolean;telegram?:boolean;kind?:string;payload?:Record<string,unknown>}={}) {
   decisions=0;choice='finished';decisionInputs.length=0;pushes.length=0;telegram.length=0
   const owner='owner-'+randomUUID(),bot=randomUUID(),workspace=randomUUID(),source=randomUUID(),session='wrun_'+randomUUID(),turn='turn_0',tg='tg-'+randomUUID(),thread='telegram:'+tg
   const scope={ownerId:owner,botId:bot,workspaceId:workspace,surface:'web' as const},input={sessionId:session,turnId:turn,outcome:options.outcome??'completed'}
   await app.query('INSERT INTO "user" VALUES($1)',[owner]);await app.query('INSERT INTO bots VALUES($1,$2,$3)',[bot,owner,workspace])
   await app.query("INSERT INTO mikka_workspaces VALUES($1,'personal',$2)",[workspace,owner]);await app.query("INSERT INTO mikka_workspace_members VALUES($1,$2,'active')",[workspace,owner])
   await app.query('INSERT INTO coordinator_bots VALUES($1,$2,$3)',[owner,workspace,bot]);await app.query("INSERT INTO eve_sessions VALUES($1,$2,$3,$4,'web')",[session,owner,bot,workspace])
   await app.query('INSERT INTO eve_turn_sources VALUES($1,$2,$3)',[session,turn,source])
   const event=userMessageEvent(owner,'Read the synthetic fixture.',{botId:bot,...options.telegram===false?{}:{telegram:{threadId:thread,telegramUserId:tg,messageId:1}}})
   await app.query('INSERT INTO coordinator_events VALUES($1,$2,$3,$4,\'attention\',NULL,NULL,$5,now())',[source,owner,bot,options.kind??event.kind,options.payload??event.payload])
   await app.query('INSERT INTO telegram_links VALUES($1,$2)',[owner,tg]);await app.query('INSERT INTO telegram_conversations VALUES($1,$2)',[thread,owner])
   // Public Eve event folding and projection supply the committed message.
   // Provider diagnostics are intentionally private and never become reply text.
   const facts:unknown[]=[{type:'turn.started',data:{turnId:turn,cause:{deliveryId:'delivery_0'},follows:null}}]
   if(options.quiet)facts.push({type:'call.requested',data:{callId:'quiet',owner:{turnId:turn},capability:{kind:'tool',name:'no_reply'},input:{}}},{type:'call.started',data:{callId:'quiet'}},{type:'call.settled',data:{callId:'quiet',outcome:'completed',output:null}})
   facts.push({type:'content.completed',data:{partId:'part_0',kind:'text',phase:'reply',value:options.text??'The synthetic task finished.'}},{type:'turn.settled',data:{turnId:turn,outcome:input.outcome,reply:['part_0'],...input.outcome==='failed'?{error:{code:options.error??'points_exhausted',message:'Private provider diagnostic'}}:{}}})
   const events=facts.map((event,line)=>({...event as object,scope:{turnId:turn},meta:{position:{line,index:0},at:'2026-11-11T00:00:00Z',endOfLine:true}})) as ReceivedEvent[]
   const messages=projectEveTurn(foldEvents(emptySessionView(),events),session,turn,input.outcome)
   if(options.commit!==false){await app.query('INSERT INTO eve_projection_receipts VALUES($1,$2)',[session,turn]);for(const [index,message]of messages.entries())await app.query('INSERT INTO coordinator_messages VALUES($1,$2,$3,$4,$5)',[randomUUID(),owner,bot,index+1,message])}
   const deliver=createEveOutcomeDelivery(app,app,{safe:async()=>{},telegram:async(thread,text)=>{telegram.push({thread,text})}})
   return{scope,input,owner,bot,workspace,source,session,turn,tg,thread,deliver}
  }
  await t.test('a real committed native reply and concurrent/repeated finish call post and judge once',async()=>{
   const f=await fixture();await Promise.all([f.deliver(f.scope,f.input),f.deliver(f.scope,f.input)]);await f.deliver(f.scope,f.input)
   assert.deepEqual(telegram,[{thread:f.thread,text:'The synthetic task finished.'}]);assert.equal(decisions,1);assert.equal(pushes.length,1);assert.deepEqual(pushes[0].reasons,['finished'])
   const receipts=(await app.query('SELECT kind,status FROM eve_outcome_deliveries WHERE session_id=$1 ORDER BY kind',[f.session])).rows
   assert.deepEqual(receipts,[{kind:'phone',status:'completed'},{kind:'telegram',status:'completed'}])
  })
  await t.test('each Unicode-safe Telegram chunk has its own durable claim and never repeats',async()=>{
   const text='😀'.repeat(4200),f=await fixture({text});await f.deliver(f.scope,f.input);await f.deliver(f.scope,f.input)
   assert.equal(telegram.length,3);assert.equal(telegram.map(c=>c.text).join(''),text);assert.ok(telegram.every(c=>c.text.length<=4096));assert.equal(decisions,1)
   assert.equal((await app.query("SELECT 1 FROM eve_outcome_deliveries WHERE session_id=$1 AND kind='telegram' AND status='completed'",[f.session])).rowCount,3)
  })
  await t.test('an uncertain provider post is not retried and later chunks are not posted on replay',async()=>{
   const f=await fixture({text:'x'.repeat(9000)});let sends=0
   const deliver=createEveOutcomeDelivery(app,app,{safe:async()=>{},telegram:async()=>{sends++;throw Error('synthetic provider response lost')}})
   await deliver(f.scope,f.input);await deliver(f.scope,f.input);assert.equal(sends,1);assert.equal(decisions,1)
   assert.deepEqual((await app.query("SELECT chunk_index,status FROM eve_outcome_deliveries WHERE session_id=$1 AND kind='telegram'",[f.session])).rows,[{chunk_index:0,status:'unknown'}])
  })
  await t.test('current link and conversation ownership are checked before every chunk',async()=>{
   const f=await fixture({text:'x'.repeat(9000)})
   const deliver=createEveOutcomeDelivery(app,app,{safe:async()=>{},telegram:async(thread,text)=>{telegram.push({thread,text});await app.query('UPDATE telegram_links SET "telegramUserId"=$2 WHERE "userId"=$1',[f.owner,'relinked'])}})
   await deliver(f.scope,f.input);assert.equal(telegram.length,1)
   const other=await fixture();await app.query('UPDATE telegram_conversations SET "userId"=$2 WHERE "threadId"=$1',[other.thread,'different-owner']);await other.deliver(other.scope,other.input);assert.equal(telegram.length,0)
  })
  await t.test('foreign source, wrong scope, inactive member and uncommitted child-like outcome send nothing',async()=>{
   for(const mutation of ['owner','workspace','source','membership','uncommitted']as const){const f=await fixture({commit:mutation!=='uncommitted'});let scope=f.scope
    if(mutation==='owner')scope={...scope,ownerId:'foreign'}
    if(mutation==='workspace')scope={...scope,workspaceId:randomUUID()}
    if(mutation==='source')await app.query('UPDATE coordinator_events SET "userId"=$2 WHERE id=$1',[f.source,'foreign'])
    if(mutation==='membership')await app.query("UPDATE mikka_workspace_members SET status='inactive' WHERE \"workspaceId\"=$1",[f.workspace])
    await f.deliver(scope,f.input);assert.equal(telegram.length,0,mutation);assert.equal(decisions,0,mutation)
   }
  })
  await t.test('Telegram stays on the personal Coordinator and a live bound task',async()=>{
   for(const mutation of ['team','other-bot','task']as const){const f=await fixture()
    if(mutation==='team')await app.query("UPDATE mikka_workspaces SET kind='team' WHERE id=$1",[f.workspace])
    if(mutation==='other-bot')await app.query('DELETE FROM coordinator_bots WHERE "botId"=$1',[f.bot])
    if(mutation==='task'){const issue=randomUUID();await app.query("INSERT INTO issues VALUES($1,$2,$3,'bound',$4)",[issue,f.owner,randomUUID(),{}]);await app.query('UPDATE coordinator_events SET "issueId"=$2 WHERE id=$1',[f.source,issue])}
    await f.deliver(f.scope,f.input);assert.equal(telegram.length,0,mutation)
   }
  })
  await t.test('no_reply suppresses partial text and all phone policy calls; quiet and cancellation do too',async()=>{
   for(const options of [{quiet:true,text:'Earlier partial commentary'},{text:'[quiet]'},{outcome:'cancelled' as const}]){const f=await fixture(options);await f.deliver(f.scope,f.input);assert.equal(telegram.length,0);assert.equal(decisions,0)}
  })
  await t.test('web replies still call the existing push judge once without a Telegram destination',async()=>{
   const f=await fixture({telegram:false});await f.deliver(f.scope,f.input);await f.deliver(f.scope,f.input);assert.equal(telegram.length,0);assert.equal(decisions,1);assert.equal(pushes.length,1)
  })
  await t.test('the existing no-notification judgment still suppresses phone dispatch and is not repeated',async()=>{
   const f=await fixture({telegram:false});choice='none';await f.deliver(f.scope,f.input);await f.deliver(f.scope,f.input);assert.equal(decisions,1);assert.equal(pushes.length,0)
  })
  await t.test('an invented outcome cannot override the committed native outcome',async()=>{
   const f=await fixture({outcome:'failed'});await f.deliver(f.scope,{...f.input,outcome:'completed'});assert.equal(telegram.length,0);assert.equal(decisions,0)
  })
  await t.test('verification codes stay off Telegram and the phone/judge text',async()=>{
   const f=await fixture({kind:'matter_handoff',payload:{assessment:{verificationCode:true}},text:'Your synthetic code is 123456'});await f.deliver(f.scope,f.input);assert.equal(telegram.length,0);assert.equal(decisions,1);assert.equal(pushes[0].text,null);assert.ok(!decisionInputs[0].includes('123456'));assert.match(decisionInputs[0],/text withheld/)
  })
  await t.test('actionable native failure uses existing refusal copy; raw diagnostics and generic failures never post',async()=>{
   const f=await fixture({outcome:'failed',text:'Private partial answer'});await f.deliver(f.scope,f.input);assert.deepEqual(telegram,[{thread:f.thread,text:'Mikka 默认点数已用完'}]);assert.equal(pushes[0].text,'Mikka 默认点数已用完');assert.equal(decisions,1)
   const unknown=await fixture({outcome:'failed',error:'turn_failed'});await unknown.deliver(unknown.scope,unknown.input);assert.equal(telegram.length,0);assert.equal(decisions,0)
  })
  await t.test('scheduled reads and blank native outcomes remain silent',async()=>{
   const f=await fixture({payload:{source:'schedule_due'}});await f.deliver(f.scope,f.input);assert.equal(telegram.length,0);assert.equal(decisions,0)
   for(const options of [{text:''},{text:' \n '},{text:'',outcome:'failed' as const,error:'turn_failed'}]){const blank=await fixture(options);await blank.deliver(blank.scope,blank.input);assert.equal(telegram.length,0);assert.equal(decisions,0)}
  })
  await t.test('an actionable failure still delivers its valid refusal line when native text is blank',async()=>{
   const f=await fixture({text:'',outcome:'failed',error:'points_exhausted'});await f.deliver(f.scope,f.input);assert.deepEqual(telegram,[{thread:f.thread,text:'Mikka 默认点数已用完'}]);assert.equal(decisions,1);assert.equal(pushes[0].text,'Mikka 默认点数已用完')
  })
 }finally{await app.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end()}
})
