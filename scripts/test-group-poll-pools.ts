import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {groupDirectory} from '../lib/group-conversations-directory'
import {handleGroup} from '../lib/group-conversations-store'
import {pollGroupReviews} from '../lib/group-mailbox-runtime'
import {withGroupWorkerAuthority} from '../lib/group-worker-authority'
async function main(){
const url=process.env.EXCHANGE_TEST_DATABASE_URL!
assert.equal(new URL(url).search,'');assert.equal(new URL(url).hash,'')
assert.equal(new URL(url).hostname,'127.0.0.1');assert.equal(new URL(url).pathname,'/mikka_exchange')
const app=new Pool({connectionString:url,max:5,connectionTimeoutMillis:10000}),ws=new Pool({connectionString:url,max:5,connectionTimeoutMillis:10000})
const directory=groupDirectory({activeUsers:async(w,ids)=>(await ws.query('SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=ANY($2::text[]) AND status=\'active\'',[w,ids])).rows.map(r=>r.userId),ownedAgents:async(u,ids,c)=>(await c!.query('SELECT id FROM agents WHERE "userId"=$1 AND id=ANY($2::uuid[])',[u,ids])).rows.map(r=>r.id)})
let unblock!:()=>void
const gate=new Promise<void>(r=>{unblock=r}),boundaries:Promise<void>[]=[]
try{
 const actors=[]
 for(let i=0;i<5;i++){
  const owner='poll-'+randomUUID(),device=randomUUID(),agent=randomUUID(),tokenId=randomUUID(),workspace=randomUUID()
  await app.query('INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,\'Synthetic poll\')',[device,owner])
  await app.query('INSERT INTO device_tokens(id,"userId",name,"tokenHash") VALUES($1,$2,\'Synthetic\',$3)',[tokenId,owner,randomUUID()])
  await app.query('INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,\'Synthetic\',\'codex\',$3)',[agent,owner,device])
  await ws.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,\'Synthetic\',$3,\'member\',\'active\')',[workspace,owner,owner+'@example.invalid'])
  for(let j=0;j<2;j++){
   const req={userId:owner,method:'POST' as const,origin:null,host:'localhost:3110'}
   const group=await handleGroup(app,directory,{...req,resource:'conversations',body:JSON.stringify({workspaceId:workspace,title:'Poll pool',members:[{memberType:'agent',memberId:agent}]})});assert.equal(group.status,201)
   const sent=await handleGroup(app,directory,{...req,id:(group.body as {id:string}).id,resource:'messages',body:JSON.stringify({body:'Scoped request',mentions:[{memberType:'agent',memberId:agent}]})});assert.equal(sent.status,201)
  }
  actors.push({owner,device,tokenId})
 }
 const polls=actors.map(actor=>{
  let acquired=0,arrived!:()=>void;boundaries.push(new Promise<void>(r=>{arrived=r}))
  const scoped=new Proxy(app,{get(target,key){if(key==='connect')return async()=>{if(++acquired===2){arrived();await gate}return app.connect()};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v}})
  const authority=<T>(fn:(d:typeof directory)=>Promise<T>)=>withGroupWorkerAuthority(ws,{userId:actor.owner,tokenId:actor.tokenId},actor.device,fn)
  return process.env.EXCHANGE_EXPECT_POLL_CYCLE==='1'?authority(d=>pollGroupReviews(scoped,d,actor.owner,actor.device)):pollGroupReviews(scoped,directory,actor.owner,actor.device,authority)
 })
 await Promise.all(boundaries)
 // All five real polls have committed their first dispatch. Hold all five app
 // clients as concurrent writers, then request workspace clients in that order.
 const writers=await Promise.all(Array.from({length:5},()=>app.connect()))
 const writes=writers.map(async c=>{try{await c.query('BEGIN');const w=await ws.connect();try{await w.query('BEGIN');await w.query('SELECT 1');await w.query('COMMIT')}finally{w.release()}await c.query('COMMIT')}finally{c.release()}})
 const pending=Promise.allSettled([...polls,...writes]);unblock()
 const outcomes=await pending
 if(process.env.EXCHANGE_EXPECT_POLL_CYCLE==='1'){assert.ok(outcomes.some(r=>r.status==='rejected'));console.log('REPRODUCED multi-dispatch poll pool cycle',outcomes.map(r=>r.status))}
 else {assert.ok(outcomes.every(r=>r.status==='fulfilled'),JSON.stringify(outcomes));for(const r of outcomes.slice(0,5))if(r.status==='fulfilled')assert.equal((r.value as {runIds:string[]}).runIds.length,2);console.log('PASS five actual two-dispatch polls + five writers; max5 pools, no retained workspace borrow')}
}finally{unblock?.();await Promise.all([app.end(),ws.end()])}

}
main().catch(error=>{console.error(error);process.exitCode=1})
