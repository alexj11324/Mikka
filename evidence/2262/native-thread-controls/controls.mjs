import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { request } from '@playwright/test'
import { Pool } from 'pg'
import { encode, decode } from '../../lib/desktop-rpc/wire.ts'
import { launchElectron } from '../../apps/desktop/test/electron-launch.mjs'
import { closeElectron, stopLocalDaemons } from '../../apps/desktop/test/native-cleanup.mjs'
import { waitForBundledSession } from '../../apps/desktop/test/bundled-session.mjs'

const sha = '6717676486671cc827b134eccc1695e55fe05c72'
const origin = 'http://localhost:3000'
assert.equal(process.env.BETTER_AUTH_URL,origin)
assert.equal(new URL(process.env.DATABASE_URL).hostname,'127.0.0.1')
assert.equal(new URL(process.env.DATABASE_URL).pathname,'/mikka_e2e')
assert.equal(process.env.GITHUB_REPOSITORY,'alexj11324/Mikka')
assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sha)
assert.equal(process.env.MIKKA_TEST_DEPLOYMENT_SHA,sha)
const manifest=JSON.parse(await readFile('apps/desktop/dist/renderer/renderer-manifest.json'))
assert.equal(manifest.publicTestFixture,true)
const archived=JSON.parse(await readFile('.output/mikka-build.json'))
assert.equal(archived.revision,sha)
assert.ok(!archived.overlaySha)
const db = new Pool({connectionString:process.env.DATABASE_URL,max:2})
const report={public:sha,private:null,scope:'Nonproduction Linux Xvfb; public Electron foreground process and protected renderer-to-main-to-server RPC. Synthetic existing history; no external model or private components.',renderer:manifest.rendererBuild,started:new Date().toISOString(),steps:[],cleanup:{}}
let stage='register'
const check=(name,details={})=>{report.steps.push({name,...details,at:new Date().toISOString()});console.log('PASS',name)}
const http=[],clients=[],profiles=[]
async function register(role) {
  const info={name:'E Desktop '+role,email:'e-'+role+'-'+randomUUID()+'@example.invalid',password:randomBytes(32).toString('hex')}
  const ctx=await request.newContext({baseURL:origin,extraHTTPHeaders:{origin,'sec-fetch-site':'same-origin','x-mikka-rpc':'1'}})
  http.push(ctx)
  assert.equal((await ctx.post('/mikka/api/auth/sign-up/email',{data:info})).status(),200,role+' registered')
  const session=await (await ctx.get('/mikka/api/auth/get-session?disableCookieCache=true')).json()
  assert.ok(session.user.id);assert.equal((await ctx.get('/mikka/api/workspace')).status(),200)
  return {info,id:session.user.id,async rpc(action,...args){
    const r=await ctx.post('/mikka/api/rpc',{data:{version:1,action,args}})
    assert.equal(r.status(),200,action);const body=await r.json();assert.equal(body.ok,true,action)
    return body.result
  }}
}
async function native(account,workspace) {
  const profile=await mkdtemp(join(process.env.RUNNER_TEMP,'e-desktop-profile-'))
  profiles.push(profile)
  const app=await launchElectron({args:[resolve('apps/desktop')],cwd:process.cwd(),env:{...process.env,MIKKA_USER_DATA_DIR:profile,MIKKA_DESKTOP_RENDERER:'bundled'},timeout:90000})
  const c={app};clients.push(c)
  const page=c.page=await app.firstWindow({timeout:90000})
  await page.waitForFunction(()=>Boolean(window.mikka?.bundled))
  assert.equal(new URL(page.url()).protocol,'mikka:')
  assert.equal(new URL(page.url()).hostname,'app')
  assert.deepEqual(await page.evaluate(()=>[typeof window.process,typeof window.require,document.cookie,window.mikka.app.flavor]),['undefined','undefined','','dev'])
  assert.equal(await page.evaluate(info=>window.mikka.bundled.signInEmail(info),{email:account.info.email,password:account.info.password}),null)
  assert.equal((await waitForBundledSession(page,account.id)).user.id,account.id)
  c.rpc=async(action,...args)=>{
    const answer=await page.evaluate(async body=>{
      const response=await fetch('/mikka/api/desktop/rpc',{method:'POST',credentials:'omit',headers:{'content-type':'application/json','x-mikka-desktop-protocol':'1'},body})
      const wire=await response.json();return {ok:wire.ok,status:response.status,wire:wire.ok?wire.result:wire.error.code}
    },JSON.stringify({version:1,action,args:encode(args)}))
    return {status:answer.status,ok:answer.ok,value:answer.ok?decode(answer.wire):answer.wire}
  }
  const initial=await c.rpc('desktop.bootstrap',workspace);assert.equal(initial.status,200);assert.equal(initial.value.user.id,account.id)
  if(!initial.value.requestedWorkspaceSelected) {
    assert.equal(ok(await c.rpc('workspace.switchWorkspace',workspace)).ok,true)
  }
  const selected=ok(await c.rpc('desktop.bootstrap',workspace))
  assert.equal(selected.requestedWorkspaceSelected,true);assert.equal(selected.cacheWorkspace.workspaceId,workspace)
  return c
}
function ok(result) {assert.equal(result.status,200);assert.equal(result.ok,true);assert.equal(result.value?.error,undefined);return result.value}
function denied(result) {
  const code=result.ok?result.value?.error:result.value
  assert.ok(['runNotFound','workspaceAccessDenied'].includes(code),'expected scoped denial; '+result.status+' '+String(code))
  return {status:result.status,code}
}
try {
  const pg=(await db.query('show server_version_num')).rows[0].server_version_num;assert.match(pg,/^17/)
  const owner=await register('owner'),member=await register('member');assert.notEqual(owner.id,member.id)
  const workspace=(await owner.rpc('workspace.createWorkspace',{name:'E native qualification',slug:'e-native-'+randomUUID().slice(0,8)})).data.workspaceId
  const invitation=await owner.rpc('workspace.createWorkspaceInvitation',{workspaceId:workspace,emails:[member.info.email],role:'member'})
  const invite=/^\/invite\/([a-f0-9]{64})$/.exec(invitation.data[0].path)
  assert.ok(invite);assert.equal((await member.rpc('workspace.acceptWorkspaceInvitation',invite[1])).ok,true)
  for(const person of [owner,member])assert.equal((await person.rpc('workspace.switchWorkspace',workspace)).ok,true)
  assert.equal((await db.query('SELECT "userId" FROM mikka_workspaces WHERE id=$1',[workspace])).rows[0].userId,owner.id)
  const task=(await owner.rpc('issues.saveIssue',{title:'E disposable native Task',status:'todo',priority:'normal',content:{type:'doc',content:[]}})).issue.id
  check('Fresh Better Auth Owner and Member joined the same workspace; Task created through normal writer',{postgres:pg,workspace,task})
  stage='native-logins'
  const o=await native(owner,workspace),m=await native(member,workspace)
  check('Two separate sandboxed Electron profiles authenticated with normal email and verified their own identity over native RPC')
  stage='seed-declared-history'
  const [agent,device,repo,run,history,result,anchor,version]=Array.from({length:8},()=>randomUUID())
  const pr='https://github.com/example/native-qa/pull/18'
  await db.query('INSERT INTO devices(id,"ownerId",name,kind,enabled,"lastSeenAt",harnesses) VALUES ($1,$2,\'E native fixture\',\'local\',true,now(),$3)',[device,owner.id,JSON.stringify([{harness:'codex',installed:true,activeTurnSteer:true}])])
  await db.query('INSERT INTO device_repos(id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,\'e-qa\',\'https://github.com/example/native-qa\')',[repo,device,owner.id])
  await db.query('INSERT INTO agents(id,"userId",name,harness) VALUES ($1,$2,\'E native agent\',\'codex\')',[agent,owner.id])
  for(const [id,status,answer] of [[run,'running',null],[history,'succeeded','Native original output'],[result,'succeeded','Native edited output']]){
    await db.query('INSERT INTO agent_runs(id,"userId","workspaceId","issueId","agentId","deviceId","deviceRepoId",title,"titleSource",status,"startedAt","finishedAt","lastReply") VALUES ($1,$2,$3,$4,$5,$6,$7,\'E native fixture\',\'manual\',$8,now()-interval \'5 minutes\',CASE WHEN $8=\'succeeded\' THEN now() ELSE NULL END,$9)',[id,owner.id,workspace,task,agent,device,repo,status,answer])
  }
  await db.query('INSERT INTO run_messages(id,"runId","userId",text,origin,"deliveredAt","createdAt") VALUES($1,$2,$3,\'Native original instructions\',\'owner\',now()-interval \'4 minutes\',now()-interval \'4 minutes\')',[anchor,history,owner.id])
  await db.query('INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt") VALUES($1,$2,1,$3,now()-interval \'3 minutes\')',[randomUUID(),history,JSON.stringify({type:'text-delta',id:'native-qa',delta:'Native original output'})])
  await db.query('INSERT INTO run_publications("runId","userId","issueId","remoteUrl","remoteKey",status,"pullRequest") VALUES ($1,$2,$3,\'https://github.com/example/native-qa\',\'example/native-qa\',\'published\',$4)',[history,owner.id,task,JSON.stringify({url:pr})])
  await db.query('INSERT INTO thread_reply_versions(id,"userId","workspaceId","rootRunId","anchorRunId","admissionRunId","anchorKey",operation,"originalText",text,"executionNote","sourceEventId","resultRunId") VALUES ($1,$2,$3,$4,$4,$4,$5,\'edit\',\'Native original instructions\',\'Native edited instructions\',\'Native edited instructions\',$6,$7)',[version,owner.id,workspace,history,anchor,randomUUID(),result])
  stage='queue'
  const payload={issueId:task,runId:run,delivery:'queue',text:'Native queued reply',requestId:randomUUID(),expectedOwnerId:owner.id,expectedWorkspaceId:workspace}
  assert.equal(ok(await o.rpc('agents.sendIssueThreadReply',payload)).sent,true)
  const queued=async()=>(await db.query('SELECT id,status FROM thread_queued_messages WHERE "runId"=$1 AND "userId"=$2 AND text=$3',[run,owner.id,payload.text])).rows
  let rows=await queued();assert.equal(rows.length,1);assert.equal(rows[0].status,'queued')
  const message={issueId:task,runId:run,messageId:rows[0].id,action:'cancel'}
  check('Owner native send created one queued PG17 row',{run,queue:rows[0].id})
  const rejection=denied(await m.rpc('agents.changeQueuedThreadReply',message))
  assert.equal((await queued())[0].status,'queued');check('Member native cancellation denied; unchanged durable queue',rejection)
  assert.equal(ok(await o.rpc('agents.changeQueuedThreadReply',message)).status,'cancelled')
  assert.equal((await queued())[0].status,'cancelled');check('Owner native cancellation persisted in PG17')
  stage='history'
  const inventory=async()=>(await db.query('SELECT (SELECT count(*)::int FROM agent_runs WHERE "issueId"=$1) AS runs,(SELECT count(*)::int FROM thread_reply_versions WHERE "rootRunId"=$2) AS versions',[task,history])).rows[0]
  const before=await inventory();assert.deepEqual(before,{runs:3,versions:1})
  for(let i=0;i<2;i++){const versions=ok(await o.rpc('agents.getThreadReplyVersions',task,history));assert.equal(versions.length,1)
    const v=versions[0];assert.equal(v.id,version);assert.equal(v.originalOutput,'Native original output');assert.equal(v.output,'Native edited output');assert.equal(v.originalPullRequest,pr);assert.equal(v.resultRunId,result)}
  check('Owner native history reader twice returned the immutable original output, original PR and distinct edited output',{history,version,result})
  const hidden=denied(await m.rpc('agents.getThreadReplyVersions',task,history));assert.deepEqual(await inventory(),before)
  check('Member native history refused; repeated reads created no run or version',{...hidden,...before})
} catch(error) {
  report.failure={stage,error:error.name,message:String(error.message||error).replace(/(?:[\w.%-]+)@[^\s]+/g,'[redacted email]').slice(0,240)}
  process.exitCode=1
} finally {
  let cleared=0,closed=0
  for(const c of clients.reverse()){
    try{if(c.page){await c.page.evaluate(()=>window.mikka.bundled.signOut());assert.equal(await c.page.evaluate(()=>window.mikka.bundled.session()),null);cleared++}}catch{process.exitCode=1}
    try{await closeElectron(c.app);closed++}catch{process.exitCode=1}
  }
  try{if(profiles.length){await stopLocalDaemons(profiles);for(const dir of profiles)await rm(dir,{recursive:true,force:true})}}catch{process.exitCode=1}
  for(const ctx of http)await ctx.dispose();await db.end()
  report.cleanup={signedOut:cleared,electronClosed:closed};report.finished=new Date().toISOString()
  report.result=process.exitCode?'failed':'passed'
  await writeFile(join(process.env.RUNNER_TEMP,'native-controls.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600})
  console.log(JSON.stringify({result:report.result,failure:report.failure,cleanup:report.cleanup}))
}
