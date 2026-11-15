const { createRequire } = require('node:module')
const { resolve } = require('node:path')
const { randomUUID, randomBytes } = require('node:crypto')
const { writeFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const app=createRequire(resolve('package.json'))
const {Pool}=app('pg')
const {request}=app('@playwright/test')
const origin='http://127.0.0.1:3100',base=origin+'/mikka',source='1381d115207c2f54512f6f7b79906b2ee0796da4'
const report={source,tree:'c0a7ef86b6ab51dc588c6b86df76f2dc4e2b5bec',started:new Date().toISOString(),passed:[],backend:'Original apps/api/src/index.ts, generated application routes, real Better Auth and PostgreSQL; loopback HTTP adapter. No renderer or native device is included.'}
const times=(name)=>{report.passed.push({at:new Date().toISOString(),name});console.log(name)}
async function main(){
 assert.equal(process.env.MIKKA_TEST_DEPLOYMENT_SHA,source)
 const db=new Pool({connectionString:process.env.E2E_DATABASE_URL})
 const contexts=[]
 try {
   report.pgVersion=(await db.query("select current_setting('server_version_num') as v")).rows[0].v;assert.equal(Math.floor(Number(report.pgVersion)/10000),17)
   async function sign(role){
     const ctx=await request.newContext({extraHTTPHeaders:{origin,'sec-fetch-site':'same-origin','x-mikka-rpc':'1'}});contexts.push(ctx)
     const email='unread-'+role+'-'+randomUUID()+'@example.invalid'
     const login=await ctx.post(base+'/api/auth/sign-up/email',{data:{name:'Unread '+role,email,password:randomBytes(32).toString('base64url')}})
     assert.equal(login.status(),200,role+' sign-up')
     const sess=await (await ctx.get(base+'/api/auth/get-session?disableCookieCache=true')).json()
     assert.ok(sess.user?.id&&sess.session?.id,role+' verified session')
     assert.equal((await ctx.get(base+'/api/workspace')).status(),200)
     return {ctx,email,id:sess.user.id,rpc:async(action,...args)=>{
       const p=await ctx.post(base+'/api/rpc',{data:{version:1,action,args}})
       const body=await p.json();assert.equal(p.status(),200,action+' '+String(body.error?.code??''));assert.equal(body.ok,true,action);return body.result
     }}
   }
   const owner=await sign('owner'),member=await sign('member');assert.notEqual(owner.id,member.id)
   const team=await owner.rpc('workspace.createWorkspace',{name:'Unified unread QA',slug:'read-'+randomUUID().slice(0,8)});assert.ok(team.ok)
   const ws=team.data.workspaceId
   const invited=await owner.rpc('workspace.createWorkspaceInvitation',{workspaceId:ws,emails:[member.email],role:'member'})
   assert.ok(invited.ok);const invite=/^\/invite\/([a-f0-9]{64})$/.exec(invited.data[0].path)?.[1];assert.ok(invite)
   const joined=await member.rpc('workspace.acceptWorkspaceInvitation',invite);assert.ok(joined.ok)
   for(const a of [owner,member]){assert.ok((await a.rpc('workspace.switchWorkspace',ws)).ok);assert.equal((await (await a.ctx.get(base+'/api/workspace')).json()).workspace.id,ws)}
   times('Two signed-in identities joined and selected the same existing Workspace via product routes')
   const agent=randomUUID(),run=randomUUID(),first='2026-11-13T09:00:00.010Z'
   await db.query('insert into agents(id,"userId",name,harness) values($1,$2,$3,\'codex\')',[agent,owner.id,'Unread acceptance '+agent.slice(0,8)])
   await db.query('insert into agent_runs(id,"userId","workspaceId","agentId",status,"finishedAt") values($1,$2,$3,$4,\'succeeded\',$5)',[run,owner.id,ws,agent,first])
   const route=base+'/api/conversations/read-state'
   const read=async(a,space=ws)=>a.ctx.get(base+'/api/mobile/threads/'+run,{headers:{'x-mikka-workspace-id':space}})
   const write=(a,payload,space=ws)=>a.ctx.post(route,{headers:{'x-mikka-workspace-id':space},data:payload})
   const getReceipt=async()=>{const resp=await read(owner);assert.equal(resp.status(),200,'owner GET');const body=await resp.json();const val=body.readReceipts?.find(c=>c.id===run);assert.ok(val,'thread GET must return the selected specific run waterline');return val}
   const stored=async()=> (await db.query('select "manuallyUnread","runReadAt","unreadRevision" from conversation_reads where "userId"=$1 and "conversationId"=$2',[owner.id,'run:'+run])).rows[0]
   const original=await getReceipt();assert.equal(original.unread,true);assert.equal(original.through,first)
   times('Previously unseen completion returned unread with its own event watermark')
   const acknowledge=(r)=>write(owner,{action:'read',runId:run,through:r.through,revision:r.revision})
   assert.equal((await acknowledge(original)).status(),200)
   assert.equal((await getReceipt()).unread,false);assert.equal((await stored()).runReadAt.toISOString(),first)
   times('Observed watermark persisted and rereading the product endpoint cleared unread')
   assert.equal((await write(owner,{action:'unread',runId:run})).status(),200)
   const marked=await getReceipt();assert.equal(marked.unread,true);assert.ok(marked.revision>original.revision)
   assert.equal((await acknowledge(original)).status(),200);assert.equal((await getReceipt()).unread,true)
   assert.equal((await stored()).manuallyUnread,true)
   times('Manual unread advanced its persisted revision and survived a stale receipt')
   assert.equal((await read(member)).status(),404);assert.equal((await write(member,{action:'unread',runId:run})).status(),404)
   assert.equal((await write(owner,{action:'unread',runId:run},randomUUID())).status(),404)
   assert.equal((await db.query('select count(*)::int as n from conversation_reads where "userId"=$1 and "conversationId"=$2',[member.id,'run:'+run])).rows[0].n,0)
   times('Same-Workspace Member could neither read nor change the Owner run; unrelated Workspace selection was rejected')
   assert.equal((await write(owner,{action:'readAll'})).status(),200)
   assert.equal((await getReceipt()).unread,false);assert.equal((await stored()).manuallyUnread,false)
   times('Bulk read persisted for the active Owner and was returned by a fresh HTTP request')
 } finally {report.ended=new Date().toISOString();writeFileSync(resolve(process.env.RUNNER_TEMP,'compat-qa-receipt','unread-http.json'),JSON.stringify(report,null,2)+'\n');for(const c of contexts)await c.dispose();await db.end()}
}
main().catch(e=>{console.error('HTTP verification failed:',String(e.message).slice(0,330).replace(/(?:https?|postgres(?:ql)?)\S*:\/\/\S+/ig,'[endpoint]'));process.exitCode=1})
