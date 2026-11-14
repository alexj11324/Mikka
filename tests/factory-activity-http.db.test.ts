import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { Pool } from 'pg'
import { stopOwnedApplication } from '../apps/desktop/test/production-application.mjs'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { bootstrapEnvironment, recordRunnerEvidenceSecrets } from '../scripts/test-accounts/bootstrap.mjs'
import { assertDeploymentIdentity, EnvironmentError } from '../scripts/test-accounts/environment.mjs'
import { acquireTestAccounts, recordAuthenticationSecrets, type AccountScope } from '../scripts/test-accounts/session.mjs'
import { capturePosterBinary } from '../lib/captures/poster'
import { decode, DESKTOP_RPC_VERSION, encode } from '../lib/desktop-rpc/wire'
import type { FactoryActivityView } from '../lib/factory/activity'
import { assertE2eTarget, disposableDatabase } from './helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from './support/drop-test-database'
import { seedAgent, seedBot, seedTeam, seedWorkspace } from './support/workspace-admin-db'
import { WORKSPACE_SELECTION_HEADER } from '../lib/workspace-selection'

const execute = promisify(execFile)
const base = process.env.E2E_DATABASE_URL
const enabled = Boolean(base && disposableDatabase() && process.env.DATABASE_URL===base && process.env.MIKKA_DATABASE_URL===base)
if (process.env.REQUIRE_DB==='1') assert.ok(enabled,'Activity HTTP acceptance requires matching isolated loopback *_e2e database URLs')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCZkAAAAASUVORK5CYII=','base64')
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function freePort(): Promise<number> {
  const reservation=createServer()
  await new Promise<void>((done,fail)=>{reservation.once('error',fail);reservation.listen(0,'127.0.0.1',done)})
  const address=reservation.address()
  assert.ok(address && typeof address==='object')
  await new Promise<void>((done,fail)=>reservation.close(error=>error?fail(error):done()))
  return address.port
}

test('HTTP network guard isolates compiler metadata while refusing external model and credentialed requests', async () => {
  const directory=await mkdtemp(join(tmpdir(),'factory-activity-network-'))
  const receipt=join(directory,'network.txt')
  try {
    const script=`
      import assert from 'node:assert/strict'
      import net from 'node:net'
      import {createServer} from 'node:http'
      const catalog='https://ai-gateway.vercel.sh/v1/models/catalog'
      assert.equal((await fetch(catalog)).status,503)
      for(const [url,init] of [
        [catalog+'?extra=1'],[catalog,{method:'POST'}],
        [catalog,{headers:{authorization:'Bearer synthetic'}}],
        [catalog,{headers:{cookie:'synthetic=1'}}],
        [new Request(catalog,{headers:{authorization:'Bearer synthetic'}})],
        ['https://ai-gateway.vercel.sh/v1/chat/completions',{method:'POST'}],
        ['https://another.invalid/v1/models/catalog'],
      ]) await assert.rejects(Promise.resolve().then(()=>fetch(url,init)),/FACTORY_ACTIVITY_HTTP_EXTERNAL_TRANSPORT_FORBIDDEN/)
      assert.throws(()=>net.connect({host:'another.invalid',port:443}),/FACTORY_ACTIVITY_HTTP_EXTERNAL_TRANSPORT_FORBIDDEN/)
      const server=createServer((_request,response)=>response.end('owned-local-listener'))
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
      try {
        const response=await fetch('http://127.0.0.1:'+server.address().port)
        assert.equal(await response.text(),'owned-local-listener')
      } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
    `
    await execute(process.execPath,['--import',resolve('tests/fixtures/factory-activity-http-network.mjs'),'--input-type=module','--eval',script],{
      cwd:process.cwd(),env:{...process.env,NODE_OPTIONS:'',FACTORY_ACTIVITY_HTTP_NETWORK_RECEIPT:receipt},timeout:15_000,maxBuffer:64*1024,
    })
    const observation=await readFile(receipt,'utf8')
    assert.equal(observation.split('\n').filter(line=>line==='model-catalog-offline').length,1)
    assert.equal(observation.split('\n').filter(line=>line==='blocked').length,8)
  } finally {await rm(directory,{recursive:true,force:true})}
})

test('real Vite/Nitro HTTP: authenticated activity, all-run media, immutable versions and historical video posters',
  {skip:!enabled,timeout:300_000},async t=>{
  const adminUrl=assertE2eTarget(base!), name=`activity_http_${randomUUID().replaceAll('-','')}_e2e`
  const admin=new Pool({connectionString:adminUrl.toString(),max:1})
  await createTestDatabase(admin, name, 'template0')
  const target=new URL(adminUrl);target.pathname=`/${name}`
  const pool=new Pool({connectionString:target.toString(),max:5})
  const directory=await mkdtemp(join(tmpdir(),'factory-activity-http-'))
  let server:ChildProcess|undefined, accounts:AccountScope|undefined
  const previous=new Map<string,string|undefined>()
  const configure=(key:string,value:string)=>{if(!previous.has(key))previous.set(key,process.env[key]);process.env[key]=value}
  t.after(async()=>{
    try { await accounts?.release({outcome:'dirty'}) }
    finally {
      try { await stopOwnedApplication(server) }
      finally {
        await pool.end();await dropTestDatabase(admin,name);await admin.end()
        for(const [key,value] of previous) {if(value===undefined)delete process.env[key];else process.env[key]=value}
        await rm(directory,{recursive:true,force:true})
      }
    }
  })
  assert.equal((await pool.query('SHOW server_version_num')).rows[0].server_version_num.slice(0,2),'17')
  const migrations=new URL('../drizzle/',import.meta.url)
  for(const file of orderMigrations((await readdir(migrations)).filter(file=>file.endsWith('.sql'))))
    await pool.query(await readFile(new URL(file,migrations),'utf8'))
  const revision=(await execute('git',['rev-parse','HEAD'],{cwd:process.cwd()})).stdout.trim()
  assert.match(revision,/^[a-f0-9]{40}$/)
  const port=await freePort(), origin=`http://127.0.0.1:${port}`
  const descriptor=join(directory,'environment.json'), networkReceipt=join(directory,'network.txt')
  for(const [key,value] of Object.entries({
    E2E_DATABASE_URL:target.toString(),MIKKA_DATABASE_URL:target.toString(),DATABASE_URL:target.toString(),
    BETTER_AUTH_URL:origin,BETTER_AUTH_SECRET:randomBytes(32).toString('hex'),E2E_BASE_URL:origin,
    MIKKA_LOCAL_TEST_ACCOUNTS:'1',MIKKA_TEST_DEPLOYMENT_SHA:revision,MIKKA_TEST_ENVIRONMENT_FILE:descriptor,
    MIKKA_DEV_SKIP_ENV_FILES:'1',WORKFLOW_TARGET_WORLD:'local',WORKFLOW_LOCAL_BASE_URL:origin,
    MIKKA_TRACE_SAMPLE_RATE:'0',NEXT_PUBLIC_POSTHOG_KEY:'',
    WORKFLOW_LOCAL_DATA_DIR:join(directory,'workflow'),FACTORY_ACTIVITY_HTTP_NETWORK_RECEIPT:networkReceipt,
  }))configure(key,value)
  if(process.env.ORVILO_DATABASE_URL)configure('ORVILO_DATABASE_URL',target.toString())
  // The existing account harness rejects deployed targets and external service
  // credentials. Refuse object storage too: every fixture byte belongs here.
  for(const key of ['S3_ENDPOINT','S3_BUCKET','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY'])
    assert.ok(!process.env[key],`HTTP fixture cannot use ${key}`)
  const environment=await bootstrapEnvironment({connectionString:target.toString(),origin,deploymentSha:revision,
    id:`activity-http-${randomUUID()}`,outputFile:descriptor,authorizeDatabase:async (database:Pool)=>{
      // assertE2eTarget already requires a loopback client URL, and this harness
      // created the exact database above. A mapped Docker service reports its
      // container address here; match bootstrapLocal's connected-server check.
      const {rows:[actual]}=await database.query('SELECT current_database() AS name,host(inet_server_addr()) AS address')
      if(actual.name!==name)throw new EnvironmentError('ACTUAL_DATABASE_MISMATCH')
      if(!actual.address)throw new EnvironmentError('LOCAL_DATABASE_UNVERIFIED')
    }})
  await recordRunnerEvidenceSecrets(environment)
  let stdoutBytes=0,stderrBytes=0
  const startupCodes=new Set<string>()
  server=spawn(process.execPath,['apps/api/scripts/dev.mjs','--host','127.0.0.1','--port',String(port)],{
    cwd:process.cwd(),detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,
      NODE_OPTIONS:`${process.env.NODE_OPTIONS??''} --import ${resolve('tests/fixtures/factory-activity-http-network.mjs')}`.trim()},
  })
  await new Promise<void>((done,fail)=>{
    const timer=setTimeout(()=>fail(new Error('FACTORY_ACTIVITY_HTTP_START_TIMEOUT')),180_000)
    let recent=''
    const finish=(error?:Error)=>{clearTimeout(timer);if(error)fail(error);else done()}
    server!.once('error',error=>finish(new Error('FACTORY_ACTIVITY_HTTP_START_FAILED',{cause:error})))
    server!.once('exit',()=>finish(new Error(`FACTORY_ACTIVITY_HTTP_START_EXITED:${[...startupCodes].join(',')}`)))
    server!.stdout!.on('data',(bytes:Buffer)=>{stdoutBytes+=bytes.length;recent=(recent+bytes.toString()).slice(-2048);if(/\[dev\] Ready in/.test(recent))finish()})
    server!.stderr!.on('data',(bytes:Buffer)=>{
      stderrBytes+=bytes.length
      for(const match of bytes.toString().matchAll(/code:\s*['"]([A-Z][A-Z0-9_]+)['"]/g))startupCodes.add(match[1])
    })
  })
  await assertDeploymentIdentity(environment)
  accounts=await acquireTestAccounts({database:pool,environment,runId:`activity-http-${randomUUID()}`,workerId:'activity',requestId:randomUUID(),ttlMs:300_000})
  const owner=accounts.owner.userId, peer=accounts.peer.userId
  assert.notEqual(owner,peer)
  const workspace=await seedWorkspace(pool,owner,[{userId:owner,role:'admin'},{userId:peer,role:'member'}])
  const outsideWorkspace=await seedWorkspace(pool,owner,[{userId:owner,role:'admin'}])
  const selectedRequest=(account:AccountScope['owner'],path:string,init:RequestInit={})=>{
    const headers=new Headers(init.headers)
    if(!headers.has(WORKSPACE_SELECTION_HEADER))headers.set(WORKSPACE_SELECTION_HEADER,workspace.id)
    return account.request(path,{...init,headers})
  }
  const ownerRequest=(path:string,init:RequestInit={})=>selectedRequest(accounts!.owner,path,init)
  const peerRequest=(path:string,init:RequestInit={})=>selectedRequest(accounts!.peer,path,init)
  const bot=await seedBot(pool,workspace.id,owner),agent=await seedAgent(pool,owner),team=await seedTeam(pool,workspace.id,owner)
  const issueId=randomUUID(),taskId=randomUUID(),source=randomUUID(),candidate=randomUUID()
  const runs=Array.from({length:24},(_,index)=>({id:randomUUID(),attemptId:randomUUID(),stage:index===0?'spec':index===2?'review':'execute'}))
  // The task belongs to owner, while the issue belongs to the teammate. Both
  // are bound to the same tenant; account identity cannot replace membership.
  await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority,scope,"workspaceId","ownershipState")
    VALUES($1,$2,'HTTP runtime fixture','{"type":"doc"}','todo','normal','workspace',$3,'bound')`,[issueId,peer,workspace.id])
  await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)',[issueId,team.id,workspace.id,owner])
  await pool.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload)
    VALUES($1::uuid,$2,$3,$4,'user_message',$1::text,'{"text":"HTTP runtime fixture"}')`,[source,owner,bot,issueId])
  const tx=await pool.connect()
  try {
    await tx.query('BEGIN')
    await tx.query(`INSERT INTO factory_tasks(id,"userId","botId","issueId","sourceEventId","scopeVersion",route,stage,status,revision,"attemptId",reason)
      SELECT $1,$2,$3,$4,$5,"scopeVersion",'{}','execute','passed',24,$6,'HTTP fixture' FROM issues WHERE id=$4`,[taskId,owner,bot,issueId,source,runs[23].attemptId])
    for(const [index,run] of runs.entries()){
      const start=new Date(Date.UTC(2026,10,1,0,index)),finish=new Date(start.getTime()+30_000)
      await tx.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","botId",kind,status,"stopReason","startedAt","finishedAt",report,"agentDefinition")
        VALUES($1,$2,$3,$4,$5,$6,'succeeded','submitted',$7,$8,$9,$10)`,[run.id,owner,issueId,agent,bot,run.stage==='spec'?'plan':run.stage==='review'?'review':'implement',start,finish,
          JSON.stringify({summary:`Completed ${index+1}\nHTTP_PRIVATE_SECOND_LINE`,private:'HTTP_PRIVATE_REPORT'}),JSON.stringify({harness:'codex',model:'gpt-6-luna',name:'HTTP coder'})])
      await tx.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"runId",reason,"createdAt","finishedAt",output)
        VALUES($1,$2,$3,$4,$4,'passed',$5,'HTTP completed',$6,$7,$8)`,[run.attemptId,taskId,run.stage,index+1,run.id,start,finish,JSON.stringify({requestEpoch:source})])
    }
    await tx.query(`INSERT INTO factory_candidates(id,"taskId",sha,repository,environment,scope,"runId") VALUES($1,$2,$3,'fixture/repository','fixture','fixture',$4)`,[candidate,taskId,'a'.repeat(40),runs[3].id])
    await tx.query('UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1',[taskId,candidate])
    await tx.query('COMMIT')
  }catch(error){await tx.query('ROLLBACK');throw error}finally{tx.release()}
  const artifact=async(runId:string|null,title:string,artifactIssueId:string|null=issueId)=>{
    const id=randomUUID()
    await pool.query(`INSERT INTO artifacts(id,"userId","issueId","runId",kind,title) VALUES($1,$2,$3,$4,'markdown',$5)`,[id,owner,artifactIssueId,runId,title])
    return id
  }
  const version=async(artifactId:string,n:number,runId:string,title:string,content:string)=>{
    const hash=digest(content)
    await pool.query(`INSERT INTO artifact_versions(id,"artifactId",version,"storageKey","inlineContent",sha256,size,"authorName") VALUES($1,$2,$3,$4,$5,$6,$7,'HTTP coder')`,
      [randomUUID(),artifactId,n,`http-fixture/${artifactId}/${n}`,content,hash,Buffer.byteLength(content)])
    await pool.query('UPDATE artifacts SET "latestVersion"=$2,title=$3 WHERE id=$1',[artifactId,n,title])
    await pool.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId","runId",kind,"dedupeKey",payload) VALUES($1,$2,$3,$4,$5,'artifact_submitted',$6,$7)`,
      [randomUUID(),owner,bot,issueId,runId,`artifact_submitted:${artifactId}:${n}`,JSON.stringify({artifactId,version:n,title,artifactKind:'markdown'})])
    return hash
  }
  const plan=await artifact(runs[0].id,'Original plan'),planHash=await version(plan,1,runs[0].id,'Original plan','# Original plan')
  await version(plan,2,runs[3].id,'Plan annotation','# Later annotation')
  await pool.query(`UPDATE factory_attempts SET output=jsonb_set(output,'{specArtifact}',$2::jsonb) WHERE id=$1`,
    [runs[0].attemptId,JSON.stringify({artifactId:plan,version:1,runId:runs[0].id,sha256:planHash})])
  const report=await artifact(runs[1].id,'Acceptance first')
  await version(report,1,runs[1].id,'Acceptance first','# First implementation')
  const reportHash=await version(report,2,runs[3].id,'Acceptance repair','# Repaired implementation')
  await pool.query('INSERT INTO factory_acceptance_artifacts("taskId","artifactId","candidateId","runId",sha256) VALUES($1,$2,$3,$4,$5)',[taskId,report,candidate,runs[3].id,reportHash])
  const videoPath=join(directory,'historical.mp4')
  await execute(await capturePosterBinary(),['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=1280x720:d=0.12','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','+faststart',videoPath],{timeout:15_000})
  const video=await readFile(videoPath)
  const capture=async(runId:string,bytes:Buffer,kind:'image'|'video',captureIssueId:string=issueId)=>{
    const id=randomUUID()
    await pool.query(`INSERT INTO run_captures(id,"userId","runId","issueId",kind,"contentType",source,status,title,"storageKey","inlineContent",size,sha256,"durationMs")
      VALUES($1,$2,$3,$4,$5,$6,'local','ready','Unreferenced HTTP media',$7,$8,$9,$10,$11)`,
      [id,owner,runId,captureIssueId,kind,kind==='video'?'video/mp4':'image/png',`http-fixture/${id}`,bytes,bytes.length,digest(bytes),kind==='video'?120:null])
    return id
  }
  const images:string[]=[]
  for(const run of runs)images.push(await capture(run.id,png,'image'))
  const movie=await capture(runs[0].id,video,'video'),unrelatedRun=randomUUID()
  await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","botId",status) VALUES($1,$2,$3,$4,$5,'succeeded')`,[unrelatedRun,owner,issueId,agent,bot])
  const unrelated=await capture(unrelatedRun,png,'image')
  const activityPath=`/api/factory/tasks/${taskId}/activity`,mediaPath=(id:string)=>`/api/factory/tasks/${taskId}/media/${id}`
  let taskPat:string|undefined,taskPatId:string|undefined
  const anonymous=(path:string,token?:string,selectedWorkspace?:string)=>{
    const headers=new Headers()
    if(token)headers.set('authorization',`Bearer ${token}`)
    if(selectedWorkspace!==undefined)headers.set(WORKSPACE_SELECTION_HEADER,selectedWorkspace)
    return fetch(`${origin}/mikka${path}`,{redirect:'error',signal:AbortSignal.timeout(30_000),headers})
  }
  const denied=async(response:Response,status:401|404,path:string)=>{
    if(path===activityPath){
      const body=await response.json()
      assert.deepEqual(Object.keys(body),['error'],'activity denial contains no task data')
      assert.equal(body.error,status===401?'authRequired':'factoryNotFound')
    }
    assert.equal(response.status,status,`${path.endsWith('/activity')?'activity':path.endsWith('/poster')?'poster':'media'} denial status`)
    assert.equal(response.headers.get('cache-control'),'private, no-store')
  }

  await t.test('real route manifest returns all 24 attempts and every submitted version with base-path-safe links',async()=>{
    const response=await ownerRequest(activityPath)
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store')
    const view=await response.json() as FactoryActivityView
    assert.equal(view.version,1);assert.equal(view.agents.length,24);assert.equal(view.timeline.attempts.length,24)
    assert.equal(view.liveWorkspaceId,workspace.id)
    assert.equal(view.artifacts.filter(artifact=>'captureId' in artifact).length,25)
    for(const id of [...images,movie])assert.ok(view.artifacts.some(artifact=>artifact.id===id))
    assert.ok(!view.artifacts.some(artifact=>artifact.id===unrelated))
    const documents=view.artifacts.filter(artifact=>'artifactId' in artifact)
    assert.deepEqual(documents.filter(document=>document.artifactId===report).map(document=>[document.version,document.runId,document.kind]),
      [[1,runs[1].id,'document'],[2,runs[3].id,'acceptance']])
    assert.equal(new Set(documents.map(document=>document.id)).size,4)
    const original=documents.find(document=>document.artifactId===plan&&document.version===1)!
    assert.equal(original.kind,'plan');assert.equal(view.timeline.attempts[0].plan?.version,1)
    assert.ok(original.downloadUrl.startsWith('/mikka/api/artifacts/'))
    assert.equal(await (await ownerRequest(original.downloadUrl)).text(),'# Original plan')
    const historical=view.artifacts.find(artifact=>artifact.id===movie)!
    assert.ok('posterUrl' in historical && historical.posterUrl?.startsWith('/mikka/api/factory/'))
    for(const privateField of ['HTTP_PRIVATE_SECOND_LINE','HTTP_PRIVATE_REPORT','storageKey','inlineContent'])assert.ok(!JSON.stringify(view).includes(privateField))
  })
  await t.test('anonymous and another authenticated workspace member cannot read task-owned originals or render covers',async()=>{
    for(const path of [activityPath,mediaPath(movie),`${mediaPath(movie)}/poster`]){
      await denied(await anonymous(path),401,path)
      await denied(await peerRequest(path),404,path)
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM run_capture_posters')).rows[0].n,0)
  })
  await t.test('cookie workspace selection cannot cross the task-detail boundary',async()=>{
    for(const selected of [outsideWorkspace.id,'invalid-workspace']){
      for(const path of [`/api/factory/tasks/${taskId}`,activityPath,mediaPath(movie),`${mediaPath(movie)}/poster`])
        await denied(await ownerRequest(path,{headers:{[WORKSPACE_SELECTION_HEADER]:selected}}),404,path)
    }
    assert.equal((await ownerRequest(activityPath)).status,200)
  })
  await t.test('all-run originals retain byte ranges while a same-owner unrelated run remains inaccessible',async()=>{
    for(const id of [images[0],images[23]]){
      const response=await ownerRequest(mediaPath(id));assert.equal(response.status,200)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),png)
    }
    const response=await ownerRequest(mediaPath(movie),{headers:{range:'bytes=0-31'}})
    assert.equal(response.status,206);assert.equal(response.headers.get('content-type'),'video/mp4')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),video.subarray(0,32))
    assert.equal((await ownerRequest(mediaPath(unrelated))).status,404)
  })
  await t.test('a historical recording produces a real JPEG over HTTP and subsequently reuses its cached bytes',async()=>{
    const path=`${mediaPath(movie)}/poster`,response=await ownerRequest(path)
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/jpeg')
    const bytes=Buffer.from(await response.arrayBuffer()),sharp=(await import('sharp')).default
    const metadata=await sharp(bytes).metadata()
    assert.equal(metadata.format,'jpeg');assert.equal(metadata.width,640);assert.equal(metadata.height,360)
    const {data}=await sharp(bytes).resize(1,1).raw().toBuffer({resolveWithObject:true})
    assert.ok(data[2]>180 && data[0]<40 && data[1]<40,'cover comes from the blue recording, not a placeholder')
    assert.deepEqual(Buffer.from(await (await ownerRequest(path)).arrayBuffer()),bytes)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM run_capture_posters WHERE "captureId"=$1',[movie])).rows[0].n,1)
  })
  await t.test('a pre-M4 token reaches same-workspace HTTP media; a newly created v1 token and another workspace PAT do not',async()=>{
    // The settings action now mints a public /api/v1 token, so it must be
    // rejected by this pre-M4 route; the legacy fixture below is the one that
    // still reaches the old factory HTTP surface.
    const created=await ownerRequest('/api/rpc',{method:'POST',headers:{'content-type':'application/json','x-mikka-rpc':'1',[WORKSPACE_SELECTION_HEADER]:workspace.id},
      body:JSON.stringify({version:DESKTOP_RPC_VERSION,action:'tokens.createAccessToken',args:encode([{name:'Activity HTTP v1 token'},workspace.id])})})
    assert.equal(created.status,200)
    const envelope=await created.json();assert.equal(envelope.ok,true)
    const fresh=decode(envelope.result) as {id?:string;token?:string;error?:string}
    assert.equal(fresh.error,undefined);assert.ok(typeof fresh.token==='string' && fresh.token.startsWith('mkp_'))
    await recordAuthenticationSecrets([fresh.token],{environment})
    await denied(await anonymous(activityPath,fresh.token),401,activityPath)
    const token=async(workspaceId:string)=>{
      const { createLegacyPersonalAccessToken } = await import('../lib/tokens/store')
      const legacy=await createLegacyPersonalAccessToken(owner,workspaceId,{name:'Activity HTTP acceptance'})
      if(workspaceId===workspace.id)taskPatId=legacy.id
      await recordAuthenticationSecrets([legacy.token],{environment})
      return legacy.token
    }
    const allowed=await token(workspace.id),outside=await token(outsideWorkspace.id)
    taskPat=allowed
    for(const path of [activityPath,mediaPath(movie),`${mediaPath(movie)}/poster`]){
      const ok=await anonymous(path,allowed);assert.equal(ok.status,200);await ok.body?.cancel()
      await denied(await anonymous(path,outside),404,path)
      await denied(await anonymous(path,allowed,outsideWorkspace.id),404,path)
      await denied(await anonymous(path,`mkp_${'a'.repeat(43)}`),401,path)
    }
    const outsideBot=await seedBot(pool,outsideWorkspace.id,owner)
    const outsideIssue=randomUUID()
    await pool.query(`INSERT INTO issues(id,"userId","workspaceId","ownershipState",scope,title,content,status,priority)
      VALUES($1,$2,$3,'bound','workspace','Other tenant task','{"type":"doc"}','todo','normal')`,[outsideIssue,owner,outsideWorkspace.id])
    const mixedRuns:string[]=[],mixedCaptures:string[]=[]
    // Historical receipts can name a run outside the task. The run itself has
    // a valid immutable tenant; never disable the new tenant integrity guards.
    for(const [index,kind] of ['foreign','foreign_binding'].entries()){
      const runId=randomUUID(),attemptId=randomUUID();mixedRuns.push(runId)
      await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","botId",status,kind) VALUES($1,$2,$3,$4,$5,'succeeded','implement')`,
        [runId,owner,outsideIssue,agent,outsideBot])
      await pool.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"runId",reason,output)
        VALUES($1,$2,'execute',$3,$3,'passed',$4,'Workspace scope fixture',$5)`,[attemptId,taskId,25+index,runId,JSON.stringify({requestEpoch:source})])
      if(kind==='foreign_binding')await pool.query('INSERT INTO computer_run_bindings("runId","ownerId","workspaceId","botId") VALUES($1,$2,$3,$4)',
        [runId,owner,outsideWorkspace.id,outsideBot])
      mixedCaptures.push(await capture(runId,video,'video',outsideIssue))
    }
    // Its original Artifact belongs to A, but this later version was submitted
    // by a run persisted in B. Both the document and producer boundaries apply
    // to a selected cookie session as well as a scoped PAT.
    await version(plan,3,mixedRuns[0],'Cross-workspace submission','# Hidden from the workspace A token')
    const outsideDocument=await artifact(mixedRuns[0],'Foreign document',outsideIssue)
    const pendingDocument=await artifact(null,'Quarantined document',null)
    // An otherwise visible producer receipt cannot grant access to a foreign
    // or unresolved document, even when the same account owns every row.
    await version(outsideDocument,1,runs[4].id,'Foreign receipt','# Other tenant document')
    await version(pendingDocument,1,runs[4].id,'Pending receipt','# Unresolved tenant document')
    const cookieView=await (await ownerRequest(activityPath)).json() as FactoryActivityView
    const patView=await (await anonymous(activityPath,allowed)).json() as FactoryActivityView
    for(const view of [cookieView,patView]){
      for(const runId of mixedRuns)assert.ok(!view.agents.some(row=>row.runId===runId))
      assert.ok(!view.artifacts.some(row=>'artifactId' in row && row.artifactId===plan && row.version===3))
      for(const artifactId of [outsideDocument,pendingDocument])
        assert.ok(!view.artifacts.some(row=>'artifactId' in row && row.artifactId===artifactId))
    }
    for(const artifactId of [outsideDocument,pendingDocument]){
      const path=`/api/artifacts/${artifactId}/versions/1/download`
      assert.equal((await ownerRequest(path)).status,404)
      assert.equal((await anonymous(path,allowed)).status,404)
    }
    const foreignDownload=await ownerRequest(`/api/artifacts/${outsideDocument}/versions/1/download`,
      {headers:{[WORKSPACE_SELECTION_HEADER]:outsideWorkspace.id}})
    assert.equal(foreignDownload.status,200);assert.equal(await foreignDownload.text(),'# Other tenant document')
    for(const id of mixedCaptures){
      assert.ok(!cookieView.artifacts.some(row=>row.id===id))
      assert.ok(!patView.artifacts.some(row=>row.id===id))
      for(const path of [mediaPath(id),`${mediaPath(id)}/poster`]){
        await denied(await anonymous(path,allowed),404,path)
        await denied(await ownerRequest(path),404,path)
      }
    }
    // The acceptance document can remain visible while an older embedded media
    // reference belongs to a hidden producer. Filter the embedded references as
    // well as the independent artifacts collection.
    await pool.query(`UPDATE factory_acceptance_artifacts SET media=$2 WHERE "taskId"=$1`,[taskId,JSON.stringify([
      {captureId:movie,kind:'video',runId:runs[0].id,title:'Visible report media',criterion:null,url:`/mikka${mediaPath(movie)}`},
      {captureId:mixedCaptures[1],kind:'video',runId:mixedRuns[1],title:'Hidden report media',criterion:null,url:`/mikka${mediaPath(mixedCaptures[1])}`},
    ])])
    try {
      const cookie=await (await ownerRequest(activityPath)).json() as FactoryActivityView
      const scoped=await (await anonymous(activityPath,allowed)).json() as FactoryActivityView
      assert.equal(cookie.task.acceptance?.artifactId,report);assert.equal(scoped.task.acceptance?.artifactId,report)
      assert.deepEqual(cookie.task.acceptance?.media.map(media=>media.captureId),[movie])
      assert.deepEqual(scoped.task.acceptance?.media.map(media=>media.captureId),[movie])
    } finally { await pool.query(`UPDATE factory_acceptance_artifacts SET media='[]' WHERE "taskId"=$1`,[taskId]) }
    const hiddenProducer=mixedRuns[1],hiddenReviewer=mixedRuns[0],hiddenCandidate=randomUUID(),hiddenWait=randomUUID()
    const {rows:[producerAttempt]}=await pool.query<{id:string}>('SELECT id FROM factory_attempts WHERE "taskId"=$1 AND "runId"=$2',[taskId,hiddenProducer])
    const hiddenReport=await artifact(hiddenProducer,'Hidden producer acceptance',outsideIssue)
    const hiddenHash=await version(hiddenReport,1,hiddenProducer,'Hidden producer acceptance','# Hidden producer evidence')
    const hiddenPr='https://github.com/fixture/hidden-workspace/pull/81'
    await pool.query(`INSERT INTO factory_candidates(id,"taskId",sha,repository,environment,scope,"runId")
      VALUES($1,$2,$3,'fixture/hidden-workspace','fixture','fixture',$4)`,[hiddenCandidate,taskId,'b'.repeat(40),hiddenProducer])
    await pool.query(`INSERT INTO run_publications("runId","userId","issueId","remoteUrl","remoteKey",status,"pullRequest")
      VALUES($1,$2,$3,'https://github.com/fixture/hidden-workspace','fixture/hidden-workspace','published',$4)`,
      [hiddenProducer,owner,issueId,JSON.stringify({url:hiddenPr,state:'open',title:'Hidden producer PR'})])
    await pool.query(`UPDATE factory_acceptance_artifacts SET "artifactId"=$2,"candidateId"=$3,"runId"=$4,sha256=$5,media=$6 WHERE "taskId"=$1`,
      [taskId,hiddenReport,hiddenCandidate,hiddenProducer,hiddenHash,JSON.stringify([{captureId:mixedCaptures[1],kind:'video',runId:hiddenProducer,title:'Hidden producer capture',criterion:null,url:`/mikka${mediaPath(mixedCaptures[1])}`}])])
    await pool.query(`UPDATE agent_runs SET kind='review' WHERE id=$1`,[hiddenReviewer])
    await pool.query(`UPDATE factory_attempts SET stage='review',"candidateId"=$3,output=output||$4::jsonb WHERE "taskId"=$1 AND "runId"=$2`,
      [taskId,hiddenReviewer,hiddenCandidate,JSON.stringify({completion:{reviewVerdict:'changes_requested'}})])
    await pool.query(`UPDATE factory_attempts SET status='blocked',"candidateId"=$2,"finishedAt"='2026-11-01T04:00:00Z' WHERE id=$1`,
      [producerAttempt.id,hiddenCandidate])
    await pool.query(`UPDATE factory_tasks SET "attemptId"=$2,"candidateId"=$3,stage='execute',status='blocked',revision=100 WHERE id=$1`,
      [taskId,producerAttempt.id,hiddenCandidate])
    await pool.query(`INSERT INTO factory_events("taskId","eventId",request,result,"createdAt") VALUES($1,$2,$3,$4,'2026-11-01T04:00:00Z')`,
      [taskId,hiddenWait,JSON.stringify({change:{action:'finish'}}),JSON.stringify({task:{id:taskId,attemptId:producerAttempt.id,candidateId:hiddenCandidate,stage:'execute',status:'blocked',revision:100}})])
    try {
      const cookie=await (await ownerRequest(activityPath)).json() as FactoryActivityView
      const scoped=await (await anonymous(activityPath,allowed)).json() as FactoryActivityView
      assert.equal(scoped.task.stage,cookie.task.stage);assert.deepEqual(scoped.task.needsYou,cookie.task.needsYou)
      for(const view of [cookie,scoped]){
        assert.equal(view.task.acceptance,null);assert.equal(view.task.pullRequest,null);assert.equal(view.task.review,null)
        assert.ok(!view.timeline.waits.some(wait=>wait.attemptId===producerAttempt.id||wait.id===`event:${hiddenWait}`),
          'neither transition waits nor the current-attention fallback expose a hidden attempt')
        for(const value of [hiddenProducer,hiddenReviewer,hiddenReport,hiddenPr,mixedCaptures[1]])
          assert.ok(!JSON.stringify(view).includes(value),'nested task flow cannot bypass producer scope')
      }
    } finally {
      await pool.query(`DELETE FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2`,[taskId,hiddenWait])
      await pool.query(`UPDATE factory_tasks SET "attemptId"=$2,"candidateId"=$3,stage='execute',status='passed',revision=24 WHERE id=$1`,[taskId,runs[23].attemptId,candidate])
      await pool.query(`UPDATE factory_attempts SET stage='execute',"candidateId"=NULL,output=$3 WHERE "taskId"=$1 AND "runId"=$2`,
        [taskId,hiddenReviewer,JSON.stringify({requestEpoch:source})])
      await pool.query(`UPDATE agent_runs SET kind='implement' WHERE id=$1`,[hiddenReviewer])
      await pool.query(`UPDATE factory_attempts SET status='passed',"candidateId"=NULL,"finishedAt"=NULL WHERE id=$1`,[producerAttempt.id])
      await pool.query(`UPDATE factory_acceptance_artifacts SET "artifactId"=$2,"candidateId"=$3,"runId"=$4,sha256=$5,media='[]' WHERE "taskId"=$1`,
        [taskId,report,candidate,runs[3].id,reportHash])
    }
    // A legacy no-Bot run retains its task's immutable tenant A. A historical
    // computer binding in B cannot transfer the run or expose B's VM interval
    // to either A's cookie session or its PAT.
    const legacyTask=randomUUID(),legacyAttempt=randomUUID(),legacyRun=randomUUID(),legacySource=randomUUID(),legacySession=randomUUID()
    const legacyTx=await pool.connect()
    try {
      await legacyTx.query('BEGIN')
      await legacyTx.query(`INSERT INTO coordinator_events(id,"userId","issueId",kind,"dedupeKey",payload,tier,"deliveredAt")
        VALUES($1::uuid,$2,$3,'user_message',$1::uuid::text,'{"text":"Legacy computer scope fixture"}','background',now())`,
        [legacySource,owner,issueId])
      await legacyTx.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId",status,kind,"startedAt","finishedAt")
        VALUES($1,$2,$3,$4,'succeeded','implement','2026-11-01T03:00:00Z','2026-11-01T03:01:00Z')`,
        [legacyRun,owner,issueId,agent])
      await legacyTx.query(`INSERT INTO factory_tasks(id,"userId","issueId","sourceEventId","scopeVersion",route,stage,status,revision,"attemptId",reason)
        SELECT $1,$2,$3,$4,"scopeVersion",'{}','execute','passed',1,$5,'Legacy computer scope fixture' FROM issues WHERE id=$3`,
        [legacyTask,owner,issueId,legacySource,legacyAttempt])
      await legacyTx.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"runId",reason,output)
        VALUES($1,$2,'execute',1,1,'passed',$3,'Legacy computer scope fixture',$4)`,
        [legacyAttempt,legacyTask,legacyRun,JSON.stringify({requestEpoch:legacySource})])
      await legacyTx.query('INSERT INTO computer_run_bindings("runId","ownerId","workspaceId","botId") VALUES($1,$2,$3,$4)',
        [legacyRun,owner,outsideWorkspace.id,outsideBot])
      await legacyTx.query(`INSERT INTO thread_machine_sessions(id,"runId","ownerId","workspaceId","botId","sandboxId","startedAt","endedAt",reason,source)
        VALUES($1,$2,$3,$4,$5,'http-legacy-sandbox','2026-11-01T03:00:00Z','2026-11-01T03:01:00Z','paused','running_since')`,
        [legacySession,legacyRun,owner,outsideWorkspace.id,outsideBot])
      await legacyTx.query('COMMIT')
    }catch(error){await legacyTx.query('ROLLBACK');throw error}finally{legacyTx.release()}
    const legacyPath=`/api/factory/tasks/${legacyTask}/activity`
    const legacyCookieResponse=await ownerRequest(legacyPath),legacyPatResponse=await anonymous(legacyPath,allowed)
    assert.equal(legacyCookieResponse.status,200);assert.equal(legacyPatResponse.status,200)
    const legacyCookie=await legacyCookieResponse.json() as FactoryActivityView,legacyPat=await legacyPatResponse.json() as FactoryActivityView
    assert.equal((await pool.query('SELECT "workspaceId" FROM agent_runs WHERE id=$1',[legacyRun])).rows[0].workspaceId,workspace.id)
    for(const view of [legacyCookie,legacyPat]){
      assert.ok(view.agents.some(row=>row.runId===legacyRun))
      assert.deepEqual(view.timeline.computers,[],'a foreign binding never grants a different tenant VM interval')
      assert.ok(!JSON.stringify(view).includes(legacySession))
    }
    // More requests than the application's five connections exercise reuse of
    // the held transaction; a second pool checkout here would deadlock.
    const concurrent=await Promise.all(Array.from({length:8},()=>anonymous(`${mediaPath(movie)}/poster`,allowed)))
    for(const response of concurrent){assert.equal(response.status,200);await response.body?.cancel()}
  })
  await t.test('live task-detail boundaries revoke even already-cached cover access after source or membership changes',async()=>{
    await pool.query('UPDATE coordinator_events SET "userId"=$2 WHERE id=$1',[source,peer])
    assert.equal((await ownerRequest(`/api/factory/tasks/${taskId}`)).status,404)
    for(const path of [activityPath,mediaPath(movie),`${mediaPath(movie)}/poster`]){
      await denied(await ownerRequest(path),404,path)
      await denied(await anonymous(path,taskPat),404,path)
    }
    await pool.query('UPDATE coordinator_events SET "userId"=$2 WHERE id=$1',[source,owner])
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2',[workspace.id,owner])
    assert.equal((await ownerRequest(`/api/factory/tasks/${taskId}`)).status,404)
    for(const path of [activityPath,mediaPath(movie),`${mediaPath(movie)}/poster`])await denied(await ownerRequest(path),404,path)
    const revokedPatStatus=(await anonymous(`/api/factory/tasks/${taskId}`,taskPat)).status
    assert.ok(revokedPatStatus===401||revokedPatStatus===404)
    for(const path of [activityPath,mediaPath(movie),`${mediaPath(movie)}/poster`])
      await denied(await anonymous(path,taskPat),revokedPatStatus,path)
    await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2',[workspace.id,owner])
    assert.equal((await ownerRequest(`/api/factory/tasks/${taskId}`)).status,200)
    assert.equal((await ownerRequest(activityPath)).status,200)
    assert.ok(taskPatId && taskPat)
    const revoked=await ownerRequest('/api/rpc',{method:'POST',headers:{'content-type':'application/json','x-mikka-rpc':'1'},
      body:JSON.stringify({version:DESKTOP_RPC_VERSION,action:'tokens.revokeAccessToken',args:encode([{id:taskPatId},workspace.id])})})
    assert.equal(revoked.status,200)
    const revokeEnvelope=await revoked.json();assert.equal(revokeEnvelope.ok,true)
    const revokedToken=decode(revokeEnvelope.result) as {id?:string;error?:string}
    assert.equal(revokedToken.error,undefined);assert.equal(revokedToken.id,taskPatId)
    for(const path of [`/api/factory/tasks/${taskId}`,activityPath,mediaPath(movie),`${mediaPath(movie)}/poster`])
      await denied(await anonymous(path,taskPat),401,path)
    assert.equal((await ownerRequest(activityPath)).status,200,'revoking a PAT does not revoke the active browser member')
  })
  const transport=await readFile(networkReceipt,'utf8')
  assert.match(transport,/guard-start/);assert.ok(!transport.includes('blocked'),'application made no external transport attempt')
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM agent_runs WHERE status IN ('queued','running')")).rows[0].n,0)
  t.diagnostic(JSON.stringify({revision,origin,database:name,runtime:'Vite+Nitro',authentication:'leased Better Auth cookie sessions and browser-created PATs',
    attempts:24,taskMedia:25,externalTransportAttempts:0,offlineCompilerCatalogReads:transport.split('\n').filter(line=>line==='model-catalog-offline').length,modelRunsStarted:0,serverStdoutBytes:stdoutBytes,serverStderrBytes:stderrBytes}))
})
