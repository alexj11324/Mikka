import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {readFile,readdir} from 'node:fs/promises'
import test from 'node:test'
import {Pool} from 'pg'
import {orderMigrations} from '../scripts/migration-order.mjs'
import {groupDirectory} from './group-conversations-directory'
import {handleGroup} from './group-conversations-store'
import {withGroupWorkerAuthority} from './group-worker-authority'
import {handleGroupWorkerRequest} from './group-worker-route'

const url=process.env.MIKKA_DISPOSABLE_POSTGRES_URL
const workspaceUrl=process.env.MIKKA_DISPOSABLE_WORKSPACE_POSTGRES_URL??url
for(const value of [url,workspaceUrl])if(value){const u=new URL(value);assert.equal(u.hostname,'127.0.0.1');assert.ok(['/mikka_review','/mikka_workspace_review'].includes(u.pathname))}
test('trusted issue-less group HTTP assignment and commit-time authority on separate PG databases',{skip:!url},async t=>{
 const schema='authority_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url}),wa=new Pool({connectionString:workspaceUrl})
 await admin.query(`CREATE SCHEMA "${schema}"`);await wa.query(`CREATE SCHEMA "${schema}_ws"`)
 const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:8}),ws=new Pool({connectionString:workspaceUrl,options:`-c search_path=${schema}_ws`,max:4})
 const workspaceId=randomUUID(),deviceId=randomUUID(),agentId=randomUUID(),tokenId=randomUUID(),token='orv_controlled_'+randomUUID(),foreignTokenId=randomUUID(),foreignToken='orv_controlled_'+randomUUID()
 const directory=groupDirectory({async activeUsers(w,ids){return(await ws.query('SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=ANY($2::text[]) AND status=\'active\'',[w,ids])).rows.map(r=>r.userId)},async ownedAgents(userId,ids,client){return(await(client??pool).query('SELECT id FROM agents WHERE "userId"=$1 AND id=ANY($2::uuid[])',[userId,ids])).rows.map(r=>r.id)}})
 const server=createServer(async(req,res)=>{
  try{
   const bytes=[];for await(const b of req)bytes.push(b)
   const hash=createHash('sha256').update((req.headers.authorization??'').replace(/^Bearer /,'')).digest('hex')
   const caller=(await pool.query('SELECT id AS "tokenId","userId" FROM device_tokens WHERE "tokenHash"=$1 AND "revokedAt" IS NULL',[hash])).rows[0]
   if(!caller){res.writeHead(401);res.end('{}');return}
   const request=new Request('http://127.0.0.1'+req.url,{method:'POST',headers:{'content-type':'application/json'},body:Buffer.concat(bytes)})
   const result=await withGroupWorkerAuthority(ws,caller,deviceId,d=>handleGroupWorkerRequest(request,deviceId,{pool,directory:d,authenticate:async()=>caller}))
   res.writeHead(result.status,{'content-type':'application/json'});res.end(await result.text())
  }catch(error){res.writeHead((error as {status?:number}).status??500);res.end(JSON.stringify({error:(error as Error).message}))}
 })
 let port=0
 const call=async(input:unknown,bearer=token)=>{const r=await fetch(`http://127.0.0.1:${port}/group-reviews`,{method:'POST',headers:{authorization:'Bearer '+bearer,'content-type':'application/json'},body:JSON.stringify(input)});return{status:r.status,body:await r.json()}}
 const fresh=async()=>{
  const group=await handleGroup(pool,directory,{userId:'owner',method:'POST',resource:'conversations',body:JSON.stringify({workspaceId,title:'controlled',members:[{memberType:'user',memberId:'member'},{memberType:'agent',memberId:agentId}]}),origin:null,host:'127.0.0.1'})
  assert.equal(group.status,201);const conversationId=(group.body as {id:string}).id
  const message=await handleGroup(pool,directory,{userId:'member',method:'POST',resource:'messages',id:conversationId,body:JSON.stringify({body:'Controlled request',mentions:[{memberType:'agent',memberId:agentId}]}),origin:null,host:'127.0.0.1'})
  assert.equal(message.status,201);assert.equal((await call({action:'poll'})).status,200)
  const work=(await pool.query('SELECT * FROM conversation_work WHERE "conversationId"=$1',[conversationId])).rows[0]
  return{work,conversationId}
 }
 const finish=(r:Awaited<ReturnType<typeof fresh>>,epoch:number)=>call({action:'complete',runId:r.work.runId,reply:{workId:r.work.id,triggerMessageId:r.work.triggerMessageId,claimEpoch:epoch,body:'Controlled trusted reply'}})
 try{
  for(const name of orderMigrations((await readdir(new URL('../drizzle/',import.meta.url))).filter(n=>n.endsWith('.sql')))){
   const sql=await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8');await(/^--\s*target:\s*DATABASE_URL/m.test(sql)?ws:pool).query(sql)
  }
  for(const u of ['owner','member'])await ws.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,\'member\',\'active\')',[workspaceId,u,u+'@example.invalid'])
  await pool.query('INSERT INTO devices(id,"ownerId",name,enabled) VALUES($1,\'owner\',\'fixture\',true)',[deviceId])
  await pool.query('INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,\'owner\',\'fixture\',\'codex\',$2)',[agentId,deviceId])
  for(const [id,user,value] of [[tokenId,'owner',token],[foreignTokenId,'outsider',foreignToken]])await pool.query('INSERT INTO device_tokens(id,"userId",name,"tokenHash") VALUES($1,$2,\'fixture\',$3)',[id,user,createHash('sha256').update(value).digest('hex')])
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));port=(server.address() as {port:number}).port
  await t.test('persisted group assignment executes without issue; anonymous/non-owner/forged body denied',async()=>{
   const r=await fresh();assert.equal((await call({action:'claim',runId:r.work.runId},'invalid')).status,401)
   assert.equal((await call({action:'claim',runId:r.work.runId},foreignToken)).status,404)
   assert.equal((await call({action:'claim',runId:r.work.runId,userId:'owner'})).status,422)
   const c=await call({action:'claim',runId:r.work.runId});assert.equal(c.status,200);assert.equal(c.body.status,'claimed')
   assert.equal((await finish(r,c.body.claimEpoch)).body.status,'completed');assert.equal((await finish(r,c.body.claimEpoch)).body.status,'completed')
   assert.equal((await pool.query('SELECT count(*) FROM conversation_messages WHERE "conversationId"=$1 AND "authorType"=\'agent\'',[r.conversationId])).rows[0].count,'1')
  })
  await t.test('orphan and cross-workspace mailbox identity cannot authorize an issue-less run',async()=>{
   const orphan=randomUUID();await pool.query('INSERT INTO agent_runs(id,"userId","agentId","deviceId",kind,status) VALUES($1,\'owner\',$2,$3,\'group_review\',\'queued\')',[orphan,agentId,deviceId])
   assert.equal((await call({action:'claim',runId:orphan})).status,404)
   const r=await fresh();await pool.query('UPDATE session_mailboxes SET "workspaceId"=$1 WHERE "latestRunId"=$2',[randomUUID(),r.work.runId])
   assert.equal((await call({action:'claim',runId:r.work.runId})).status,403)
  })
  await t.test('queued suspension and running removal/revocation/stop/lease fences admit no late reply',async()=>{
   for(const mode of ['suspend','remove','grant','stop','expiry','token']){
    const r=await fresh();let epoch=0
    if(mode!=='suspend'){const c=await call({action:'claim',runId:r.work.runId});assert.equal(c.status,200);epoch=c.body.claimEpoch}
    if(mode==='suspend')await ws.query("UPDATE mikka_workspace_members SET status='suspended' WHERE \"workspaceId\"=$1 AND \"userId\"='member'",[workspaceId])
    if(mode==='remove')await pool.query('UPDATE conversation_members SET "leftAt"=now() WHERE "conversationId"=$1 AND "memberId"=\'member\'',[r.conversationId])
    if(mode==='grant')await pool.query('UPDATE conversation_agent_grants SET "revokedAt"=now() WHERE id=$1',[r.work.grantId])
    if(mode==='stop')await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1',[r.work.runId])
    if(mode==='expiry')await pool.query('UPDATE agent_runs SET "leaseExpiresAt"=now()-interval \'1 second\' WHERE id=$1',[r.work.runId])
    if(mode==='token')await pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1',[tokenId])
    const result=mode==='suspend'?await call({action:'claim',runId:r.work.runId}):await finish(r,epoch)
    assert.ok(result.status>=400||result.body.status==='cancelled',mode)
    assert.equal((await pool.query('SELECT count(*) FROM conversation_messages WHERE "conversationId"=$1 AND "authorType"=\'agent\'',[r.conversationId])).rows[0].count,'0')
    await ws.query("UPDATE mikka_workspace_members SET status='active' WHERE \"workspaceId\"=$1 AND \"userId\"='member'",[workspaceId]);await pool.query('UPDATE device_tokens SET "revokedAt"=NULL WHERE id=$1',[tokenId])
   }
  })
  await t.test('workspace and token revocation wait for authorized commit; subsequent writes denied',async()=>{
   for(const fence of ['workspace','token']){
    const r=await fresh(),c=await call({action:'claim',runId:r.work.runId});assert.equal(c.status,200)
    const blocker=await pool.connect();await blocker.query('SELECT pg_advisory_lock(936236)')
    await pool.query(`CREATE FUNCTION authority_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."authorType"='agent' THEN PERFORM pg_advisory_xact_lock(936236); END IF; RETURN NEW; END $$; CREATE TRIGGER authority_pause BEFORE INSERT ON conversation_messages FOR EACH ROW EXECUTE FUNCTION authority_pause()`)
    const writing=finish(r,c.body.claimEpoch);let revoking:Promise<unknown>|undefined
    try{
     let waiting=false
     for(let i=0;i<100;i++){waiting=Boolean((await admin.query("SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE 'INSERT INTO conversation_messages%' AND query NOT LIKE '%pg_stat_activity%'")).rowCount);if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10))}
     assert.ok(waiting,'reply reached insert while authority locks held')
     let revoked=false
     revoking=(fence==='workspace'?ws.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"='member'`,[workspaceId]):pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1',[tokenId])).then(()=>{revoked=true})
     await new Promise(resolve=>setTimeout(resolve,100));assert.equal(revoked,false)
     await blocker.query('SELECT pg_advisory_unlock(936236)')
     assert.equal((await writing).body.status,'completed');await revoking
     assert.equal((await finish(r,c.body.claimEpoch)).status,fence==='workspace'?404:401)
    }finally{
     await blocker.query('SELECT pg_advisory_unlock(936236)');blocker.release()
     await Promise.allSettled([writing,...(revoking?[revoking]:[])])
     await ws.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"='member'`,[workspaceId]);await pool.query('UPDATE device_tokens SET "revokedAt"=NULL WHERE id=$1',[tokenId])
     await pool.query('DROP TRIGGER authority_pause ON conversation_messages; DROP FUNCTION authority_pause()')
    }
   }
  })
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();await ws.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await wa.query(`DROP SCHEMA "${schema}_ws" CASCADE`);await admin.end();await wa.end()}
})
