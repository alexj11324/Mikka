import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { Pool } from 'pg'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { ScheduleStore, SCHEDULE_LEASE_MS, type WorkspaceGuard } from './store'
import { ScheduleError, type Actor, type Definition } from './contract'
import { scheduleTools } from './tools'

const target=process.env.E2E_DATABASE_URL
const valid=isE2eTarget(target)&&target===process.env.MIKKA_DATABASE_URL&&target===process.env.DATABASE_URL
if(process.env.REQUIRE_DB==='1'&&!valid)throw new Error('Schedule tests require matching isolated loopback _e2e URLs')

test('actual PostgreSQL schedules: lifecycle, concurrent due work, authority and original chat', {skip:!valid}, async t=>{
 const pool=new Pool({connectionString:target,max:5}), members=new Pool({connectionString:target,max:5})
 let now=new Date('2030-01-01T00:00:00Z')
 const owner=`schedule179-${randomUUID()}`,other=`schedule179-${randomUUID()}`,member=`schedule179-${randomUUID()}`,workspace=randomUUID(),botId=randomUUID(),memberBot=randomUUID(),sourceEventId=randomUUID(),memberEvent=randomUUID()
 const actor:Actor={ownerId:owner,workspaceId:workspace,botId,sourceEventId}
 const memberActor:Actor={ownerId:member,workspaceId:workspace,botId:memberBot,sourceEventId:memberEvent}
 const guard:WorkspaceGuard=async(user,workspace,work)=>{
  if(!workspace)return work({role:'member'})
  const tx=await members.connect()
  try{await tx.query('BEGIN');const member=await tx.query<{role:'owner'|'admin'|'member'}>(`SELECT role FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active' FOR SHARE`,[workspace,user]);if(!member.rowCount)throw new ScheduleError('scheduleWorkspaceAccessDenied',403);const v=await work({role:member.rows[0].role});await tx.query('COMMIT');return v}catch(e){await tx.query('ROLLBACK');throw e}finally{tx.release()}
 }
 let agentReady=true
 const store=()=>new ScheduleStore(pool,guard,async(tx,user,id)=>(await tx.query<{id:string;title:string;status:string}>('SELECT id,title,status FROM issues WHERE id=$1 AND "userId"=$2 FOR SHARE',[id,user])).rows[0]??null,async()=>{},()=>agentReady,()=>now)
 const def=(task:Definition['task']={kind:'reminder',text:'Controlled reminder'}):Definition=>({title:'179 controlled task',timezone:'UTC',timing:{kind:'once',at:new Date(now.getTime()+60_000).toISOString()},task,misfire:'catch_up_once',maxLatenessMinutes:5})
 const create=async(d=def(),requestId=randomUUID())=>(await store().command(actor,{action:'create',requestId,definition:d}) as {schedule:{id:string;version:number;status:string;next_at:Date}}).schedule
 const history=async(id:string)=>(await store().command(actor,{action:'history',scheduleId:id}) as {occurrences:Array<{id:string;status:string;attempts:number;operation_id:string;event_id:string;result:unknown;error:string|null}>}).occurrences
 try{
  await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,'Schedule owner',$2,true,now(),now()),($3,'Other owner',$4,true,now(),now()),($5,'Workspace member',$6,true,now(),now())`,[owner,`${owner}@example.invalid`,other,`${other}@example.invalid`,member,`${member}@example.invalid`])
  await members.query(`INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,'Schedule test')`,[workspace,owner])
  await members.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,'owner',$3,'admin'),($1,$4,'member',$5,'member')`,[workspace,owner,`${owner}@example.invalid`,member,`${member}@example.invalid`])
  await pool.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,$4),($5,$6,$3,$7)',[botId,owner,workspace,`Schedule ${botId}`,memberBot,member,`Schedule ${memberBot}`])
  await pool.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload,tier) VALUES($1,$2,$3,'user_message',$4,'{"text":"Please schedule the controlled task"}','attention'),($5,$6,$7,'user_message',$8,'{"text":"Member schedule request"}','attention')`,[sourceEventId,owner,botId,sourceEventId,memberEvent,member,memberBot,memberEvent])
  await t.test('ten create retries and ten scans produce one occurrence, one chat result and stable operation',async()=>{
   const d=def(),requestId=randomUUID(),tools=scheduleTools(command=>store().command(actor,command))
   const results=await Promise.all(Array.from({length:10},()=>tools.schedule_create.execute!({definition:d},{toolCallId:requestId,messages:[],context:{}})))
   const rows=results as Array<{schedule:{id:string}}>;assert.equal(new Set(rows.map(r=>r.schedule.id)).size,1);const id=rows[0].schedule.id
   now=new Date(now.getTime()+60_000);await Promise.all(Array.from({length:10},()=>store().tick()))
   const done=await history(id);assert.equal(done.length,1);assert.equal(done[0].status,'succeeded');assert.equal(done[0].attempts,1)
   assert.equal((await pool.query('SELECT count(*)::int n FROM coordinator_messages WHERE id=$1 AND "userId"=$2 AND "botId"=$3',[done[0].operation_id,owner,botId])).rows[0].n,1)
   const message=(await pool.query('SELECT message FROM coordinator_messages WHERE id=$1',[done[0].operation_id])).rows[0].message
   assert.equal(message.content,'Controlled reminder','chat body is the useful result, not execution bookkeeping')
   assert.deepEqual(message.mikkaScheduleResult,{version:1,title:d.title,status:'succeeded'})
   assert.ok(!JSON.stringify(message).includes(done[0].operation_id))
   assert.ok(done[0].operation_id,'history retains the operation identity')
   assert.equal((await create(d,requestId)).id,id)
   await assert.rejects(create({...d,title:'Different request'},requestId),/scheduleRequestConflict/)
  })
  await t.test('repeat slots persist across fresh stores; pause, timezone update, resume and cancel',async()=>{
   const d=def();d.timing={kind:'interval',start:new Date(now.getTime()+60_000).toISOString(),minutes:1};const row=await create(d)
   now=new Date(now.getTime()+60_000);await store().tick();now=new Date(now.getTime()+60_000);await store().tick()
   const done=await history(row.id);assert.equal(done.length,2);assert.ok(done.every(r=>r.status==='succeeded'));assert.equal(new Set(done.map(r=>r.operation_id)).size,2)
   await store().command(actor,{action:'pause',scheduleId:row.id,version:1});now=new Date(now.getTime()+120_000);await store().tick();assert.equal((await history(row.id)).length,2)
   const updated=def();updated.timezone='Asia/Tokyo';updated.timing={kind:'daily',time:'09:00',gap:'skip',fold:'earlier'}
   await store().command(actor,{action:'update',scheduleId:row.id,version:2,definition:updated})
   const resumed=await store().command(actor,{action:'resume',scheduleId:row.id,version:3}) as {schedule:{next_at:Date}}
   assert.equal(resumed.schedule.next_at.toISOString(),'2030-01-02T00:00:00.000Z')
   await store().command(actor,{action:'cancel',scheduleId:row.id,version:4})
   await assert.rejects(store().command(actor,{action:'resume',scheduleId:row.id,version:5}),/scheduleCancelled/)
  })
  await t.test('legacy protocol rows are projected by their persisted operation identity without rewriting history',async()=>{
   const scheduled=await create(def({kind:'reminder',text:'Legacy useful reminder'}))
   now=new Date(now.getTime()+60_000);await store().tick()
   const occurrence=(await history(scheduled.id))[0]
   const content=`[Schedule ${scheduled.id}; occurrence ${occurrence.id}; operation ${occurrence.operation_id}] Legacy: succeeded\nLegacy useful reminder`
   const old={role:'assistant',content}
   await pool.query('UPDATE coordinator_messages SET message=$2 WHERE id=$1',[occurrence.operation_id,old])
   const {createRequestDatabaseScope}=await import('../db/request-scope')
   const request=createRequestDatabaseScope(target!)
   try{
    const coordinator=await import('../coordinator/store')
    const chat=await request.run(()=>coordinator.chatView(owner,200,botId))
    assert.equal(chat.items.find(item=>item.id===occurrence.operation_id)?.text,'Legacy useful reminder')
    const previews=await request.run(()=>coordinator.botChats(owner))
    assert.equal(previews[botId].line,'Legacy useful reminder')
    assert.deepEqual((await pool.query('SELECT message FROM coordinator_messages WHERE id=$1',[occurrence.operation_id])).rows[0].message,old,'read projection preserves the original receipt')
    const plainId=randomUUID()
    await pool.query(`INSERT INTO coordinator_messages(id,"userId","botId",position,message) SELECT $1,$2,$3,coalesce(max(position),0)+1,$4 FROM coordinator_messages WHERE "userId"=$2 AND "botId"=$3`,[plainId,owner,botId,old])
    const again=await request.run(()=>coordinator.chatView(owner,200,botId))
    assert.equal(again.items.find(item=>item.id===plainId)?.text,content,'same words with no persisted occurrence identity are not stripped')
   }finally{await request.close()}
  })
  await t.test('a killed claimant recovers the same occurrence; stale lease cannot publish',async()=>{
   const row=await create();now=new Date(now.getTime()+60_000);await store().materialize()
   const child=spawn(process.execPath,['--import','tsx','lib/schedules/claim-child.mts'],{env:{...process.env,SCHEDULE_TEST_CLOCK:now.toISOString()},stdio:['ignore','pipe','inherit']})
   const lines=createInterface({input:child.stdout!});const [line]=await once(lines,'line');const stale=JSON.parse(line)
   const exited=once(child,'exit');child.kill('SIGKILL');assert.deepEqual(await exited,[null,'SIGKILL']);lines.close()
   now=new Date(now.getTime()+SCHEDULE_LEASE_MS+1);const current=await store().claim();assert.ok(current);assert.equal(current.id,stale.id)
   await store().execute(stale);assert.equal((await history(row.id))[0].status,'running')
   await store().execute(current);assert.equal((await history(row.id))[0].status,'succeeded');assert.equal((await history(row.id))[0].attempts,2)
  })
  await t.test('cancel after claim and ten cancel/execute races are serialized by the schedule row',async()=>{
   const row=await create();now=new Date(now.getTime()+60_000);await store().materialize();const claim=await store().claim();assert.ok(claim)
   await store().command(actor,{action:'cancel',scheduleId:row.id,version:1});await store().execute(claim);assert.equal((await history(row.id))[0].status,'cancelled')
   for(let n=0;n<10;n++){const row=await create();now=new Date(now.getTime()+60_000);await store().materialize();const c=await store().claim();assert.ok(c)
    await Promise.all([store().execute(c),store().command(actor,{action:'cancel',scheduleId:row.id,version:1})]);assert.ok(['succeeded','cancelled'].includes((await history(row.id))[0].status))
   }
  })
  await t.test('owner, bot and human-source bounds; workspace revocation stops execution',async()=>{
   const row=await create()
   await assert.rejects(store().command({...actor,ownerId:other},{action:'history',scheduleId:row.id}),/scheduleWorkspaceAccessDenied/)
   await assert.rejects(store().command({...actor,botId:null,workspaceId:null},{action:'history',scheduleId:row.id}),/scheduleNotFound/)
   await assert.rejects(store().command({...actor,sourceEventId:undefined},{action:'create',requestId:randomUUID(),definition:def()}),/scheduleUserSourceRequired/)
   now=new Date(now.getTime()+60_000);await members.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`,[workspace,owner]);await store().tick()
   await members.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"=$2`,[workspace,owner]);await store().flushFailedReports()
   assert.equal((await history(row.id))[0].status,'failed')
  })
  await t.test('workspace schedules are visible to active members, but results stay in the original chat',async()=>{
   const row=await create()
   const visible=await store().command(memberActor,{action:'list'}) as {schedules:Array<{id:string}>}
   assert.ok(visible.schedules.some(s=>s.id===row.id),'an active member lists the workspace schedule')
   assert.equal(((await store().command(memberActor,{action:'history',scheduleId:row.id})) as {occurrences:unknown[]}).occurrences.length,0)
   const stored=(await pool.query('SELECT visibility,workspace_id FROM user_schedules WHERE id=$1',[row.id])).rows[0]
   assert.deepEqual(stored,{visibility:'workspace',workspace_id:workspace},'new schedules are workspace-owned')
   now=new Date(now.getTime()+60_000);await store().materialize()
   await store().command(memberActor,{action:'pause',scheduleId:row.id,version:1})
   const done=(await history(row.id))[0];assert.equal(done.status,'cancelled');assert.equal(done.error,'scheduleChanged')
   assert.equal((await pool.query('SELECT count(*)::int n FROM coordinator_messages WHERE id=$1 AND "userId"=$2 AND "botId"=$3',[done.operation_id,owner,botId])).rows[0].n,1,'the creator chat receives the cancellation')
   assert.equal((await pool.query('SELECT count(*)::int n FROM coordinator_messages WHERE id=$1 AND "userId"=$2 AND "botId"=$3',[done.operation_id,member,memberBot])).rows[0].n,0,'the member chat does not receive the creator result')
  })
  await t.test('creator or workspace admin may update and resume; ordinary members may not',async()=>{
   const repeat=def();repeat.timing={kind:'interval',start:new Date(now.getTime()+60_000).toISOString(),minutes:60};const row=await create(repeat)
   const edited={...repeat,title:'Member edit'}
   await assert.rejects(store().command(memberActor,{action:'update',scheduleId:row.id,version:1,definition:edited}),/scheduleAdminRequired/)
   await store().command(memberActor,{action:'pause',scheduleId:row.id,version:1})
   await assert.rejects(store().command(memberActor,{action:'resume',scheduleId:row.id,version:2}),/scheduleAdminRequired/)
   await members.query(`UPDATE mikka_workspace_members SET role='admin' WHERE "workspaceId"=$1 AND "userId"=$2`,[workspace,member])
   const resumed=await store().command(memberActor,{action:'resume',scheduleId:row.id,version:2}) as {schedule:{status:string}}
   assert.equal(resumed.schedule.status,'active')
   await store().command(memberActor,{action:'update',scheduleId:row.id,version:3,definition:{...edited,title:'Admin edit'}})
   await members.query(`UPDATE mikka_workspace_members SET role='member' WHERE "workspaceId"=$1 AND "userId"=$2`,[workspace,owner])
   await store().command(actor,{action:'update',scheduleId:row.id,version:4,definition:{...edited,title:'Creator edit'}})
   await store().command(actor,{action:'cancel',scheduleId:row.id,version:5})
  })
  await t.test('legacy owner-only schedules stay isolated from workspace members',async()=>{
   const legacy=randomUUID(),legacyDef=def()
   await pool.query(`INSERT INTO user_schedules(id,owner_id,workspace_id,bot_id,visibility,source_event_id,request_id,definition,request_definition,status,next_at) VALUES($1,$2,$3,$4,'owner',$5,$6,$7,$7,'active',NULL)`,[legacy,owner,workspace,botId,randomUUID(),`legacy-${legacy}`,legacyDef])
   const memberList=await store().command(memberActor,{action:'list'}) as {schedules:Array<{id:string}>}
   const ownerList=await store().command(actor,{action:'list'}) as {schedules:Array<{id:string}>}
   assert.ok(!memberList.schedules.some(s=>s.id===legacy),'a member cannot see the creator legacy row')
   assert.ok(ownerList.schedules.some(s=>s.id===legacy),'the owner still sees the legacy row')
   await assert.rejects(store().command(memberActor,{action:'pause',scheduleId:legacy,version:1}),/scheduleNotFound/)
  })
  await t.test('create requires a workspace',async()=>{
   await assert.rejects(store().command({...actor,workspaceId:null,botId:null},{action:'create',requestId:randomUUID(),definition:def()}),/scheduleWorkspaceRequired/)
  })
  await t.test('deleting a bot keeps the schedule and publishes to the Coordinator chat',async()=>{
   const deleteBot=randomUUID(),deleteEvent=randomUUID()
   await pool.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,$4)',[deleteBot,owner,workspace,`Delete ${deleteBot}`])
   await pool.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload,tier) VALUES($1,$2,$3,'user_message',$4,'{"text":"Schedule a reminder"}','attention')`,[deleteEvent,owner,deleteBot,deleteEvent])
   const deleteActor:Actor={ownerId:owner,workspaceId:workspace,botId:deleteBot,sourceEventId:deleteEvent}
   const row=(await store().command(deleteActor,{action:'create',requestId:randomUUID(),definition:def()}) as {schedule:{id:string}}).schedule
   await pool.query('DELETE FROM bots WHERE id=$1',[deleteBot])
   assert.equal((await pool.query('SELECT bot_id FROM user_schedules WHERE id=$1',[row.id])).rows[0].bot_id,null,'the schedule survives with a null bot anchor')
   now=new Date(now.getTime()+60_000);await store().tick()
   const done=(await history(row.id))[0];assert.equal(done.status,'succeeded')
   assert.equal((await pool.query('SELECT count(*)::int n FROM coordinator_messages WHERE id=$1 AND "userId"=$2 AND "botId" IS NULL',[done.operation_id,owner])).rows[0].n,1,'the result falls back to the Coordinator chat')
  })
  await t.test('cron schedules materialize and pause removes future work',async()=>{
   now=new Date('2030-02-01T08:00:00Z')
   const d=def();d.timing={kind:'cron',expression:'0 9 * * *'}
   const row=await create(d)
   assert.equal((await pool.query('SELECT next_at FROM user_schedules WHERE id=$1',[row.id])).rows[0].next_at.toISOString(),'2030-02-01T09:00:00.000Z')
   now=new Date('2030-02-01T09:00:00Z');await store().tick()
   const done=await history(row.id);assert.equal(done.length,1);assert.equal(done[0].status,'succeeded')
   assert.equal((await pool.query('SELECT next_at FROM user_schedules WHERE id=$1',[row.id])).rows[0].next_at.toISOString(),'2030-02-02T09:00:00.000Z')
   await store().command(actor,{action:'pause',scheduleId:row.id,version:1})
   assert.equal((await pool.query('SELECT next_at FROM user_schedules WHERE id=$1',[row.id])).rows[0].next_at,null)
   now=new Date('2030-02-02T09:00:00Z');await store().tick();assert.equal((await history(row.id)).length,1)
  })
  await t.test('agent reads use a canonical event link; cancel and replacement claims revoke authority',async()=>{
   const d=def({kind:'agent_read',prompt:'Read the controlled issue status',allowedActions:['get_issue']});const row=await create(d)
   now=new Date(now.getTime()+60_000);await store().tick();const h=(await history(row.id))[0];assert.equal(h.status,'running')
   assert.equal(await store().inbox(other,null,[h.event_id]),null)
   const bound=await store().inbox(owner,botId,[h.event_id]);assert.ok(bound?.scope)
   await store().assertRead(owner,botId,bound.scope)
   const {assertNativeToolScope}=await import('../../workflows/coordinator/tool-scope')
   await assertNativeToolScope(owner,{scheduledRead:{botId,occurrence:bound.scope}})
   await assert.rejects(store().assertRead(owner,botId,{...bound.scope,allowedActions:['web_search']}),/scheduleReadAuthorityLost/)
   await store().command(actor,{action:'cancel',scheduleId:row.id,version:1})
   await assert.rejects(store().completeRead(owner,botId,bound.scope,'Old output'),/scheduleReadAuthorityLost/)
   await assert.rejects(assertNativeToolScope(owner,{scheduledRead:{botId,occurrence:bound.scope}}),/scheduleReadAuthorityLost/)
   assert.equal((await history(row.id))[0].status,'cancelled')
   const second=await create(def({kind:'agent_read',prompt:'Read only',allowedActions:['get_issue']}));now=new Date(now.getTime()+60_000);await store().tick()
   const old=(await store().inbox(owner,botId,[(await history(second.id))[0].event_id]))!;assert.ok(old.scope)
   now=new Date(now.getTime()+SCHEDULE_LEASE_MS+1);await store().tick()
   await assert.rejects(store().assertRead(owner,botId,old.scope),/scheduleReadAuthorityLost/)
   const fresh=await store().inbox(owner,botId,[(await history(second.id))[0].event_id]);assert.ok(fresh?.scope)
   await store().completeRead(owner,botId,fresh.scope,'Current read result')
   assert.equal((await history(second.id))[0].status,'succeeded')
   // The result event gets no fixed background tier: triage (the Decisions API) decides whether it needs the person.
   const reported=(await pool.query(`SELECT tier,"deliveredAt" FROM coordinator_events WHERE "dedupeKey"=$1`,[`schedule_result:${(await history(second.id))[0].id}`])).rows[0]
   assert.deepEqual(reported,{tier:null,deliveredAt:null})
  })
  await t.test('actual Coordinator inbox isolates the scheduled read and preserves user source identity',async()=>{
   const app=await import('../db/request-scope')
   const coordinator=await import('../coordinator/store')
   const request=app.createRequestDatabaseScope(target!)
   try{
    await pool.query('UPDATE coordinator_events SET "deliveredAt"=now() WHERE "userId"=$1',[owner])
    const row=await create(def({kind:'agent_read',prompt:'Read current status only',allowedActions:['get_issue']}));now=new Date(now.getTime()+60_000);await store().tick()
    const read=(await history(row.id))[0]
    const inbox=await request.run(()=>coordinator.takeInbox(owner,`schedule-fixture-${randomUUID()}`,botId))
    assert.equal(inbox.added,1);assert.equal(inbox.sourceEventId,undefined);assert.equal(inbox.scheduledRead?.occurrenceId,read.id);assert.deepEqual(inbox.scheduledRead?.allowedActions,['get_issue'])
    assert.equal(inbox.scheduledRead?.prompt,'Read current status only')
    const prompt=(await pool.query('SELECT message FROM coordinator_messages WHERE "userId"=$1 AND "botId"=$2 ORDER BY position DESC LIMIT 1',[owner,botId])).rows[0].message
    assert.ok(!JSON.stringify(prompt).includes(inbox.scheduledRead!.leaseToken),'private occurrence fence must not enter model/chat data')
    assert.match(prompt.content,/Use only the available allowed read tools/,'the runtime still receives execution instructions')
    const dueView=await request.run(()=>coordinator.chatView(owner,200,botId))
    assert.ok(dueView.items.some(item=>item.from==='event'&&item.line?.kind==='scheduleDue'))
    assert.ok(!dueView.items.some(item=>item.text.includes('[Scheduled read-only task]')||item.text.includes('Use only the available')),'display never serializes the execution body')
    const duePreview=(await request.run(()=>coordinator.botChats(owner)))[botId]
    assert.equal(duePreview.line,null,'the bot list uses the same audience projection')
    for (const page of [await request.run(()=>coordinator.chatView(owner,200,botId,{through:dueView.cursor})),await request.run(()=>coordinator.chatUpdate(owner,botId,dueView.continuation))]) {
      assert.ok(!page.items.some(item=>item.text.includes('Use only the available')),'history and delta retain the same audience boundary')
    }
    const streamId='wrun_schedule-fixture:0'
    await store().completeRead(owner,botId,inbox.scheduledRead!,'Read-only result',streamId)
    assert.equal((await pool.query('SELECT message FROM coordinator_messages WHERE id=$1',[read.operation_id])).rows[0].message.mikkaStreamId,streamId,'scheduled reply and stream identity persist atomically')
    assert.ok((await request.run(()=>coordinator.chatView(owner,200,botId))).persistedStreamIds?.includes(streamId))
    const modelHistory=(await request.run(()=>coordinator.loadConversation(owner,botId))).messages
    assert.ok(modelHistory.every(({message})=>!('mikkaStreamId' in message)&&!('mikkaScheduleResult' in message)))
    assert.ok(modelHistory.every(({message})=>message.role!=='assistant'||message.content!==''),'status-only receipts do not become empty model messages')
    const holder=(await pool.query('SELECT "leaseHolder" FROM coordinator_sessions WHERE "userId"=$1 AND "botId"=$2',[owner,botId])).rows[0].leaseHolder
    await request.run(()=>coordinator.releaseLease(owner,holder,botId))
    const human=randomUUID();await pool.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload,tier) VALUES($1,$2,$3,'user_message',$4,'{"text":"Create a reminder"}','attention')`,[human,owner,botId,human])
    const next=await request.run(()=>coordinator.takeInbox(owner,`schedule-human-${randomUUID()}`,botId))
    assert.equal(next.sourceEventId,human);assert.equal(next.scheduledRead,undefined)
   }finally{await request.close()}
  })
  await t.test('actual cron handler over loopback HTTP executes a persisted real-time reminder',async()=>{
   const {GET}=await import('../../app/api/cron/schedules/route')
   const secret='controlled-cron-secret-179-runtime'
   const previous=process.env.CRON_SECRET;process.env.CRON_SECRET=secret
   const realtime=new ScheduleStore(pool,guard,async()=>null,async()=>{},()=>true)
   const definition=def();definition.timing={kind:'once',at:new Date(Date.now()+1500).toISOString()}
   const row=(await realtime.command(actor,{action:'create',requestId:randomUUID(),definition}) as {schedule:{id:string}}).schedule
   const server=createServer(async(request,response)=>{
    try{const result=await GET(new Request(`http://localhost${request.url}`,{headers:new Headers(request.headers as Record<string,string>)}));response.writeHead(result.status,Object.fromEntries(result.headers));response.end(await result.text())}catch{response.writeHead(500);response.end()}
   })
   server.listen(0,'127.0.0.1');await once(server,'listening')
   const port=(server.address() as {port:number}).port
   try{
    assert.equal((await fetch(`http://127.0.0.1:${port}/mikka/api/cron/schedules`)).status,401)
    await delay(1600)
    const result=await fetch(`http://127.0.0.1:${port}/mikka/api/cron/schedules`,{headers:{authorization:`Bearer ${secret}`}})
    assert.equal(result.status,200);assert.ok((await result.json() as {executed:number}).executed>=1)
    const done=await history(row.id);assert.equal(done.length,1);assert.equal(done[0].status,'succeeded')
    assert.equal((await pool.query('SELECT count(*)::int n FROM coordinator_messages WHERE id=$1 AND "botId"=$2',[done[0].operation_id,botId])).rows[0].n,1)
   }finally{server.close();await once(server,'close');if(previous===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=previous}
  })
  await t.test('model availability rejects upfront; expired model work exhausts at three attempts',async()=>{
   agentReady=false;await assert.rejects(create(def({kind:'agent_read',prompt:'Read',allowedActions:['get_issue']})),/scheduleAgentReadUnavailable/);agentReady=true
   const row=await create(def({kind:'agent_read',prompt:'Read',allowedActions:['get_issue']}));now=new Date(now.getTime()+60_000);await store().tick()
   for(let n=0;n<3;n++){now=new Date(now.getTime()+SCHEDULE_LEASE_MS+1);await store().tick()}
   const done=(await history(row.id))[0];assert.equal(done.status,'failed');assert.equal(done.attempts,3)
  })
  await t.test('skip remains immutable through a report failure and retry',async()=>{
   const d=def();d.misfire='skip';d.maxLatenessMinutes=1;const row=await create(d);now=new Date(now.getTime()+180_000);await store().materialize()
   const claim=await store().claim();assert.ok(claim)
   await pool.query(`CREATE FUNCTION schedule_test_report_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled report failure'; END $$; CREATE TRIGGER schedule_test_report_fault BEFORE INSERT ON coordinator_messages FOR EACH ROW EXECUTE FUNCTION schedule_test_report_fault()`)
   try{await store().execute(claim);assert.equal((await history(row.id))[0].status,'pending')}finally{await pool.query('DROP TRIGGER schedule_test_report_fault ON coordinator_messages; DROP FUNCTION schedule_test_report_fault()')}
   now=new Date(now.getTime()+30_000);await store().tick();const done=(await history(row.id))[0];assert.equal(done.status,'skipped');assert.equal(done.result,null)
   await assert.rejects(pool.query(`UPDATE schedule_occurrences SET execution_decision='execute' WHERE id=$1`,[done.id]),/execution decision is immutable/)
  })
  await t.test('maxConcurrent skips later running agent reads without misfire or a duplicate report',async()=>{
   now=new Date('2030-03-01T00:00:00Z')
   const read=()=>def({kind:'agent_read',prompt:'Read concurrently',allowedActions:['get_issue']})
   const first=read();first.timing={kind:'interval',start:new Date(now.getTime()+60_000).toISOString(),minutes:1};first.maxConcurrent=2;const two=await create(first)
   for(let n=0;n<3;n++){now=new Date(now.getTime()+60_000);await store().tick()}
   const twoRows=(await pool.query<{status:string;error:string|null;operation_id:string}>('SELECT status,error,operation_id FROM schedule_occurrences WHERE schedule_id=$1 ORDER BY due_at',[two.id])).rows
   assert.deepEqual(twoRows.map(o=>[o.status,o.error]),[['running',null],['running',null],['skipped','concurrencyLimit']])
   assert.equal((await pool.query('SELECT count(*)::int n FROM coordinator_messages m JOIN schedule_occurrences o ON o.operation_id=m.id WHERE o.schedule_id=$1 AND o.status=$2',[two.id,'skipped'])).rows[0].n,1)
   await store().command(actor,{action:'cancel',scheduleId:two.id,version:1})
   const next=read();next.timing={kind:'interval',start:new Date(now.getTime()+60_000).toISOString(),minutes:1};next.maxConcurrent=1;const one=await create(next)
   now=new Date(now.getTime()+60_000);await store().tick();now=new Date(now.getTime()+60_000);await store().tick()
   const oneRows=(await pool.query<{status:string;error:string|null}>('SELECT status,error FROM schedule_occurrences WHERE schedule_id=$1 ORDER BY due_at',[one.id])).rows
   assert.deepEqual(oneRows.map(o=>[o.status,o.error]),[['running',null],['skipped','concurrencyLimit']])
   assert.equal((await pool.query('SELECT count(*)::int n FROM agent_runs WHERE "userId"=$1',[owner])).rows[0].n,0,'scheduled reads create no agent_runs')
  })
 }finally{await pool.end();await members.end()}
})
