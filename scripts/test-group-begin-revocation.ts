import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {Pool,type PoolClient} from 'pg'
import {deviceScopedPool} from '../lib/db/device-scope'
import {withDeviceAdmission} from '../lib/device-revocation'
import {transaction} from '../lib/group-review-access'
import {handleGroupWorkerRequest} from '../lib/group-worker-route'
import {handleGroup} from '../lib/group-conversations-store'

async function main(){
 const url=new URL(process.env.EXCHANGE_TEST_DATABASE_URL!)
 assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/mikka_exchange');assert.equal(url.search,'');assert.equal(url.hash,'')
 assert.equal(process.env.MIKKA_DATABASE_URL,url.href)
 const app=new Pool({connectionString:url.href,max:1}),observer=new Pool({connectionString:url.href,max:1})
 const owner='begin-revoke-'+randomUUID(),tokenId=randomUUID(),table='begin_probe_'+randomUUID().replaceAll('-','')
 await observer.query('INSERT INTO device_tokens(id,"userId",name,"tokenHash") VALUES($1,$2,\'Synthetic BEGIN regression\',$3)',[tokenId,owner,randomUUID()])
 await observer.query(`CREATE TABLE "${table}" (id integer)`)
 const deviceId=randomUUID(),agentId=randomUUID(),workspaceId=randomUUID()
 await observer.query('INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,\'Synthetic poll BEGIN\')',[deviceId,owner])
 await observer.query('INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,\'Synthetic\',\'codex\',$3)',[agentId,owner,deviceId])
 // Fixture creation only: the denied dispatch must never reach its directory.
 const seedRequest={userId:owner,method:'POST' as const,origin:null,host:'localhost'}
 const group=await handleGroup(observer,async()=>true,{...seedRequest,resource:'conversations',body:JSON.stringify({workspaceId,title:'BEGIN fixture',members:[{memberType:'agent',memberId:agentId}]})})
 assert.equal(group.status,201)
 const groupId=(group.body as {id:string}).id
 const message=await handleGroup(observer,async()=>true,{...seedRequest,id:groupId,resource:'messages',body:JSON.stringify({body:'Synthetic pending poll',mentions:[{memberType:'agent',memberId:agentId}]})})
 assert.equal(message.status,201)
 let beginCountdown=1
 let currentToken=tokenId
 let inject=false,callbacks=0,rollbacks=0,releases=0,ordinaryErrors=0,afterBegin=false
 const intercepted=new Proxy(app,{get(target,key){if(key==='connect')return async()=>{
  const raw=await app.connect()
  return new Proxy(raw,{get(c,p){if(p==='query')return async(...args:unknown[])=>{
   const text=typeof args[0]==='string'?args[0]:''
   const result=await Reflect.apply(c.query,c,args)
   if(text==='ROLLBACK')rollbacks++
   if(text==='BEGIN'&&inject&&--beginCountdown===0){inject=false;afterBegin=true;await observer.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1',[currentToken])}
   return result
  };if(p==='release')return (...args:unknown[])=>{releases++;return Reflect.apply(c.release,c,args)};const v=Reflect.get(c,p);return typeof v==='function'?v.bind(c):v}}) as PoolClient
 };const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v}})
 const server=createServer(async(req,res)=>{
  try{
   const result=await withDeviceAdmission({userId:owner,tokenId:currentToken},async()=>{
    if(req.url==='/exchange'||req.url==='/claim'||req.url==='/poll'){
     inject=true;beginCountdown=req.url==='/poll'?3:1
     const input=req.url==='/poll'?{action:'poll'}:req.url==='/claim'?{action:'claim',runId:randomUUID()}:{action:'exchange',runId:randomUUID(),exchange:{workId:randomUUID(),triggerMessageId:randomUUID(),claimEpoch:1,exchangeId:randomUUID(),messageId:randomUUID(),toAgentId:randomUUID(),body:'Synthetic denied exchange'}}
     return handleGroupWorkerRequest(new Request('http://localhost/group-reviews',{method:'POST',body:JSON.stringify(input)}),deviceId,{pool:deviceScopedPool(intercepted),directory:async()=>false,authenticate:async()=>({userId:owner})})
    }
    inject=req.url==='/revoked';beginCountdown=1
    return transaction(deviceScopedPool(intercepted),async c=>{
     callbacks++
     if(req.url==='/sql')await c.query('SELECT * FROM missing_begin_regression_table')
     await c.query(`INSERT INTO "${table}" VALUES(1)`)
     return Response.json({ok:true})
    })
   })
   res.writeHead(result?200:401);res.end('{}')
  }catch(error){assert.ok(error instanceof Error);ordinaryErrors++;res.writeHead(500);res.end('{}')}
 })
 server.listen(0,'127.0.0.1');await once(server,'listening')
 const address=server.address() as {port:number},origin=`http://127.0.0.1:${address.port}`
 try{
  const beforePid=(await app.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  assert.equal((await fetch(origin+'/revoked')).status,401)
  assert.equal(afterBegin,true);assert.equal(callbacks,0);assert.equal(rollbacks,1);assert.equal(releases,1);assert.equal(ordinaryErrors,0)
  assert.equal((await observer.query(`SELECT count(*) FROM "${table}"`)).rows[0].count,'0')
  assert.equal((await app.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,beforePid,'same max1 connection is reusable after rejected BEGIN')
  for(const path of ['/exchange','/claim','/poll']){
   currentToken=randomUUID();await observer.query('INSERT INTO device_tokens(id,"userId",name,"tokenHash") VALUES($1,$2,\'Synthetic command boundary\',$3)',[currentToken,owner,randomUUID()])
   const previousRollbacks:number=rollbacks,previousReleases:number=releases
   assert.equal((await fetch(origin+path)).status,401,path)
   assert.equal(rollbacks,previousRollbacks+1);assert.equal(releases,previousReleases+(path==='/poll'?3:1));assert.equal(ordinaryErrors,0)
   assert.equal((await app.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,beforePid)
  }
  assert.equal((await observer.query('SELECT status,"runId" FROM conversation_work WHERE "conversationId"=$1',[groupId])).rows[0].status,'pending')
  assert.equal((await observer.query('SELECT count(*) FROM agent_runs WHERE "agentId"=$1',[agentId])).rows[0].count,'0')
  // New independent credential; never un-revoke the first fixture.
  const fresh=randomUUID();await observer.query('INSERT INTO device_tokens(id,"userId",name,"tokenHash") VALUES($1,$2,\'Synthetic SQL control\',$3)',[fresh,owner,randomUUID()])
  const sqlResult=await withDeviceAdmission({userId:owner,tokenId:fresh},()=>transaction(deviceScopedPool(app),async c=>c.query('SELECT * FROM missing_begin_regression_table'))).catch(error=>error)
  assert.equal(sqlResult.code,'42P01','ordinary SQL errors remain ordinary errors')
  // A separate HTTP endpoint uses the fresh authority for the normal SQL path.
  const sqlServer=createServer(async(_req,res)=>{try{const r=await withDeviceAdmission({userId:owner,tokenId:fresh},()=>transaction(deviceScopedPool(app),async c=>c.query('SELECT * FROM missing_begin_regression_table')));res.writeHead(r?200:401).end()}catch{res.writeHead(500).end()}})
  sqlServer.listen(0,'127.0.0.1');await once(sqlServer,'listening')
  try{assert.equal((await fetch(`http://127.0.0.1:${(sqlServer.address() as {port:number}).port}`)).status,500)}finally{sqlServer.closeAllConnections();await new Promise<void>(r=>sqlServer.close(()=>r()))}
  await withDeviceAdmission({userId:owner,tokenId:fresh},()=>transaction(deviceScopedPool(app),async c=>{await c.query(`INSERT INTO "${table}" VALUES(2)`)}))
  assert.equal((await observer.query(`SELECT count(*) FROM "${table}"`)).rows[0].count,'1')
  const original=new Error('Synthetic body failure'),cleanup=new Error('Synthetic rollback transport failure')
  const cleanupPool=new Proxy(app,{get(target,key){if(key==='connect')return async()=>{const c=await app.connect();return new Proxy(c,{get(client,k){if(k==='query')return async(...args:unknown[])=>{const r=await Reflect.apply(client.query,client,args);if(args[0]==='ROLLBACK')throw cleanup;return r};const v=Reflect.get(client,k);return typeof v==='function'?v.bind(client):v}})};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v}})
  await assert.rejects(transaction(cleanupPool,async()=>{throw original}),error=>error===original)
  assert.equal((await app.query('SELECT 1 AS ok')).rows[0].ok,1)
  console.log('PASS real PG + HTTP admission/group transaction + claim/exchange/poll dispatch: revoke after raw BEGIN =>401, zero callback/writes, one rollback/release, same backend reusable; SQL42P01=>500; subsequent transaction commits')
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await Promise.all([app.end(),observer.end()])}
}
main().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1)})
