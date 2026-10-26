import assert from 'node:assert/strict'
import {test} from 'node:test'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {CoordinatorInbox,isolatedInboxOptions} from './wake-test-helpers'
import {telegramCoordinatorWorkspace} from '../telegram/coordinator-scope'
import {resourceFixture,isolatedResourceUrls} from '../resources/test-fixtures'

test('Telegram pending destinations: real split PG retry, fresh authority and delivery watermarks',async t=>{
 const urls=isolatedResourceUrls(),app=new Pool({connectionString:urls.app,max:8}),workspace=new Pool({connectionString:urls.workspace,max:8})
 let now=new Date(),requests=0
 const inbox=()=>new CoordinatorInbox(app,isolatedInboxOptions(app,workspace,()=>now))
 async function fixture(){const f=await resourceFixture(app,workspace),threadId='telegram:controlled:'+randomUUID(),telegramUserId='synthetic-'+randomUUID();await app.query('INSERT INTO telegram_links("userId","telegramUserId") VALUES($1,$2)',[f.owner,telegramUserId]);return {...f,threadId,telegramUserId}}
 async function take(f:Awaited<ReturnType<typeof fixture>>,telegram=true){
  const eventId=randomUUID(),holder='holder-'+randomUUID()
  await app.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,tier,wake_workspace_id,wake_next_at) VALUES($1::uuid,$2,'user_message',$1::text,$3,'attention',$4,$5)`,[eventId,f.owner,{text:'controlled Telegram reply',workspaceId:f.workspaceId,...(telegram?{telegram:{threadId:f.threadId,telegramUserId:f.telegramUserId,messageId:1}}:{})},f.workspaceId,now])
  const claim=await inbox().claim(f.owner);assert.ok(claim&&'delivery'in claim)
  assert.equal(claim.delivery.eventId,eventId)
  const receipt=await inbox().take(f.owner,holder,claim.delivery)
  return {eventId,holder,delivery:claim.delivery,receipt}
 }
 async function publish(f:Awaited<ReturnType<typeof fixture>>,run:Awaited<ReturnType<typeof take>>){await inbox().acknowledge(f.owner,run.holder,run.delivery,[{role:'assistant',content:'controlled response'}])}
 const pending=async(owner:string)=>(await app.query('SELECT telegram_reply_pending FROM coordinator_sessions WHERE "userId"=$1',[owner])).rows[0].telegram_reply_pending
 try{
  await t.test('failed turn keeps target in PG; a distinct successful turn and fresh store recover it',async()=>{
   const f=await fixture(),failed=await take(f)
   assert.equal(failed.receipt.telegramTargets?.length,1)
   await inbox().beginGeneration(f.owner,failed.holder,failed.delivery);await inbox().fail(f.owner,failed.holder,failed.delivery)
   assert.equal((await app.query('SELECT wake_status FROM coordinator_events WHERE id=$1',[failed.eventId])).rows[0].wake_status,'failed')
   const next=await take(f,false),target=next.receipt.telegramTargets![0]
   assert.equal(target.sourceEventId,failed.eventId)
   await publish(f,next)
   await assert.rejects(inbox().telegramReply(f.owner,target,async()=>{throw new Error('controlled send failure')}),/send failure/)
   assert.equal((await pending(f.owner)).length,1)
   await inbox().telegramReply(f.owner,target,async()=>{requests++})
   assert.equal((await pending(f.owner)).length,1,'delivery must precede explicit completion cleanup')
   await inbox().acknowledgeTelegram(f.owner,target)
   assert.deepEqual(await pending(f.owner),[])
   const replay=await inbox().telegramReply(f.owner,target,async()=>{requests++})
   assert.equal(replay.replayed,true);assert.equal(requests,1)
  })
  await t.test('old delivery ACK cannot remove a newly staged message to the same destination',async()=>{
   const f=await fixture(),first=await take(f),old=first.receipt.telegramTargets![0];await publish(f,first)
   const second=await take(f),fresh=second.receipt.telegramTargets![0];await publish(f,second)
   assert.ok(BigInt(fresh.sequence)>BigInt(old.sequence))
   await inbox().acknowledgeTelegram(f.owner,old)
   assert.equal((await pending(f.owner))[0].sourceEventId,second.eventId)
   await inbox().acknowledgeTelegram(f.owner,fresh);assert.deepEqual(await pending(f.owner),[])
  })
  await t.test('current link, owner, original source and workspace membership gate the actual effect',async()=>{
   const f=await fixture(),run=await take(f),target=run.receipt.telegramTargets![0];await publish(f,run)
   let sent=0
   const send=()=>{sent++;return Promise.resolve()}
   await app.query('DELETE FROM telegram_links WHERE "userId"=$1',[f.owner])
   await assert.rejects(inbox().telegramReply(f.owner,target,send),/wakeTelegramLinkUnavailable/)
   await app.query('INSERT INTO telegram_links("userId","telegramUserId") VALUES($1,$2)',[f.owner,f.telegramUserId])
   await workspace.query("UPDATE mikka_workspace_members SET status='suspended' WHERE \"workspaceId\"=$1 AND \"userId\"=$2",[f.workspaceId,f.owner])
   await assert.rejects(inbox().telegramReply(f.owner,target,send),/wakeWorkspaceAccessDenied/)
   await workspace.query("UPDATE mikka_workspace_members SET status='active' WHERE \"workspaceId\"=$1 AND \"userId\"=$2",[f.workspaceId,f.owner])
   await assert.rejects(inbox().telegramReply(f.owner,{...target,sourceEventId:randomUUID()},send),/wakeNotFound/)
   await assert.rejects(inbox().telegramReply('different-owner',target,send),/wakeNotFound/)
   assert.equal(sent,0);assert.equal((await pending(f.owner)).length,1)
   await inbox().telegramReply(f.owner,target,send);assert.equal(sent,1)
  })
  await t.test('authenticated Telegram ingress captures a real unambiguous workspace and rejects ambiguity/revocation',async()=>{
   const f=await fixture()
   assert.equal(await telegramCoordinatorWorkspace(workspace,f.owner,null),f.workspaceId)
   const other=randomUUID(),team=randomUUID(),issue=randomUUID()
   await workspace.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'other actual workspace\')',[other,f.owner])
   await workspace.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,$2,$3,\'admin\')',[other,f.owner,f.owner+'@example.invalid'])
   assert.equal(await telegramCoordinatorWorkspace(workspace,f.owner,null),null)
   await workspace.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,\'actual linked team\',\'TG294\')',[team,other,f.owner])
   await workspace.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)',[issue,team,other,f.owner])
   assert.equal(await telegramCoordinatorWorkspace(workspace,f.owner,issue),other)
   assert.equal(await telegramCoordinatorWorkspace(workspace,'other-owner',issue),null)
   await workspace.query("UPDATE mikka_workspace_members SET status='suspended' WHERE \"workspaceId\"=$1 AND \"userId\"=$2",[other,f.owner])
   assert.equal(await telegramCoordinatorWorkspace(workspace,f.owner,issue),null)
   assert.equal(await telegramCoordinatorWorkspace(workspace,f.owner,null),f.workspaceId)
   assert.equal((await workspace.query('SELECT count(*)::int n FROM mikka_workspaces WHERE "userId"=$1',[f.owner])).rows[0].n,2)
  })
  await t.test('pending destinations from another workspace never ride a current turn',async()=>{
   const f=await fixture(),first=await take(f);await publish(f,first)
   const other=randomUUID();await workspace.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'other trusted workspace\')',[other,f.owner]);await workspace.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,$2,$3,\'admin\')',[other,f.owner,f.owner+'@example.invalid'])
   const next=await take({...f,workspaceId:other},false)
   assert.deepEqual(next.receipt.telegramTargets,[]);assert.equal((await pending(f.owner)).length,1)
   await publish(f,next)
  })
 }finally{await Promise.all([app.end(),workspace.end()])}
})
