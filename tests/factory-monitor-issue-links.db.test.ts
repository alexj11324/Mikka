import { seedFixtureWorkspace } from './helpers/task-workspace'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { assertE2eTarget } from './helpers/e2e-target.mjs'

const target=process.env.E2E_DATABASE_URL
if(target){assertE2eTarget(target);assert.equal(process.env.MIKKA_DATABASE_URL,target);assert.equal(process.env.DATABASE_URL,target)}
if(!target&&process.env.REQUIRE_DB==='1')throw Error('Monitor mappings require an isolated E2E database')
let actor:string|null=null
const credential=randomUUID()

test('monitor mappings use actual owner/scope authorization, GitHub readback and durable local references',{skip:!target,timeout:120_000},async t=>{
  const pool=new Pool({connectionString:target,max:12})
  for(const name of ['20261031060510_monitor_followup_issues.sql','20261031060511_monitor_github_issue_links.sql'])await pool.query(await readFile(new URL(`../drizzle/${name}`,import.meta.url),'utf8'))
  const owner=`monitor-map-${randomUUID()}`,peer=`monitor-peer-${randomUUID()}`
  actor=owner
  for(const id of [owner,peer])await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',[id,`${id}@example.invalid`])
  const environment={GITHUB_APP_ID:process.env.GITHUB_APP_ID,LINEAR_TOKEN_ENCRYPTION_KEY:process.env.LINEAR_TOKEN_ENCRYPTION_KEY,
    BETTER_AUTH_URL:process.env.BETTER_AUTH_URL,BETTER_AUTH_SECRET:process.env.BETTER_AUTH_SECRET,
    MIKKA_EDITION:process.env.MIKKA_EDITION,NEXT_PUBLIC_POSTHOG_KEY:process.env.NEXT_PUBLIC_POSTHOG_KEY}
  const origin='http://localhost:3100'
  Object.assign(process.env,{GITHUB_APP_ID:'4840908',LINEAR_TOKEN_ENCRYPTION_KEY:randomBytes(32).toString('hex'),
    BETTER_AUTH_URL:origin,BETTER_AUTH_SECRET:randomBytes(32).toString('hex'),MIKKA_EDITION:'cloud',NEXT_PUBLIC_POSTHOG_KEY:''})
  const incidentWorkspaces=new Map<string,string>()
  let issueReads=0,repositoryAllowed=true,afterIssueRead:(()=>Promise<void>)|undefined
  const receiver=createServer(async(request,response)=>{
    assert.equal(request.method,'GET','no external mutation is permitted')
    assert.equal(request.headers.authorization,`Bearer ${credential}`)
    const url=new URL(request.url!,'http://127.0.0.1')
    let data:unknown
    if(url.pathname==='/user')data={id:42}
    else if(url.pathname==='/user/installations')data={installations:[{id:77,app_id:4840908,suspended_at:null}]}
    else if(url.pathname==='/user/installations/77/repositories')data={repositories:repositoryAllowed?[{id:71,full_name:'mikka-ci/followup',private:true}]:[]}
    else{
      const match=/^\/repos\/mikka-ci\/followup\/issues\/(\d+)$/.exec(url.pathname)
      assert.ok(match)
      const number=Number(match[1]);issueReads++
      data={id:1000+number,number,html_url:`https://github.com/mikka-ci/followup/issues/${number}`,state:'open',updated_at:'2026-10-31T04:00:00Z',body:'PRIVATE GITHUB BODY'}
      await afterIssueRead?.()
    }
    response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(data))
  })
  await new Promise<void>(resolve=>receiver.listen(0,'127.0.0.1',resolve))
  const address=receiver.address() as {port:number}
  const originalFetch=globalThis.fetch
  globalThis.fetch=(async(input,options)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url)
    assert.equal(url.origin,'https://api.github.com')
    assert.equal(options?.redirect,'error')
    return originalFetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`,options)
  }) as typeof fetch
  t.after(async()=>{
    globalThis.fetch=originalFetch
    mock.restoreAll()
    for(const [key,value]of Object.entries(environment)){if(value===undefined)delete process.env[key];else process.env[key]=value}
    receiver.closeAllConnections();await new Promise<void>(resolve=>receiver.close(()=>resolve()))
    await pool.end();await(await import('../lib/db')).pool.end();await(await import('../lib/workspace-db')).workspacePool.end()
  })
  const context=await import('../apps/api/src/context')
  const framework=await import('next/headers')
  mock.module('next/headers',{namedExports:{...framework,
    headers:async()=>context.requireRequestScope().headers,cookies:async()=>context.requireRequestScope().cookies}})
  const next=await import('next/server')
  mock.module('next/server',{namedExports:{...next,after:(work:()=>unknown)=>context.requireRequestScope().after.add(work)}})
  const {auth}=await import('../lib/auth')
  const nativeTokens=new Map<string,string>()
  for(const id of [owner,peer]){
    const session=await(await auth.$context).internalAdapter.createSession(id)
    assert.ok(session)
    nativeTokens.set(id,session.token)
  }
  const {saveGitHubConnection}=await import('../lib/github/connection')
  await saveGitHubConnection(owner,{githubAccountId:'42',githubLogin:'monitor-fixture'},{access_token:credential})
  const {recordMonitorIncidentState}=await import('../lib/factory/monitor-incidents')
  const {withTaskWorkspace}=await import('../lib/task-workspace')
  const routes=await import('../app/api/factory/monitor-incidents/[incidentId]/links/route')
  const urlFor=(number=7)=>`https://github.com/mikka-ci/followup/issues/${number}`
  async function seed(workspace=false,imported?:{id:string;workspaceKey:string;workspaceId:string}){
    const issueId=imported?.id??randomUUID(),taskId=randomUUID(),attemptId=randomUUID(),candidateId=randomUUID()
    const workspaceId=imported?.workspaceId??await seedFixtureWorkspace(pool,workspace?peer:owner,workspace?'team':'personal')
    if(workspace)await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,\'member\',\'active\')',[workspaceId,owner,`${owner}@example.invalid`])
    return withTaskWorkspace(owner,workspaceId,async()=>{
    const tx=await pool.connect()
    try{
      await tx.query('BEGIN')
      if(!imported)await tx.query('INSERT INTO issues(id,"userId",title,content,status,priority,scope,"workspaceId","ownershipState") VALUES($1,$2,\'Completed delivery\',\'{"type":"doc","content":[]}\',\'done\',\'normal\',$3,$4,\'bound\')',[issueId,workspace?peer:owner,workspace?'workspace':'personal',workspaceId])
      if(workspace){
        const team=randomUUID()
        await tx.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,\'Monitor fixture\',\'MM\')',[team,workspaceId,peer])
        await tx.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)',[issueId,team,workspaceId,peer])
      }
      await tx.query('INSERT INTO factory_tasks(id,"userId","issueId","sourceEventId",route,stage,status,"attemptId",reason,"scopeVersion") VALUES($1,$2,$3,$4,\'{}\',\'monitor\',\'running\',$5,\'Trusted monitor fixture\',1)',[taskId,owner,issueId,randomUUID(),attemptId])
      await tx.query('INSERT INTO factory_candidates(id,"taskId",sha,repository,environment,scope,"runId") VALUES($1,$2,repeat(\'a\',40),\'https://github.com/mikka-ci/followup.git\',\'device:fixture\',\'fixture\',$3)',[candidateId,taskId,randomUUID()])
      await tx.query('INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"candidateId",reason) VALUES($1,$2,\'monitor\',1,1,\'running\',$3,\'Trusted monitor fixture\')',[attemptId,taskId,candidateId])
      await tx.query('UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1',[taskId,candidateId])
      const incident=await recordMonitorIncidentState(tx,{ownerId:owner,workspaceKey:imported?.workspaceKey??(workspace?`workspace:${workspaceId}`:`personal:${owner}`),fingerprint:createHash('sha256').update(randomUUID()).digest('hex'),checkKey:'c'.repeat(64),issueId,taskId,candidateId,outcome:'unhealthy'})
      await tx.query('COMMIT')
      incidentWorkspaces.set(String(incident.id),workspaceId)
      return {incidentId:String(incident.id),sourceIssueId:issueId,issueId:String(incident.followupIssueId??incident.issueId),workspaceId,taskId}
    }catch(error){await tx.query('ROLLBACK');throw error}finally{tx.release()}
    })
  }
  const request=(id:string,method='GET',body:unknown={url:urlFor()},requestOrigin=origin)=>{
    const workspaceId=incidentWorkspaces.get(id)
    assert.ok(workspaceId,'the request selects the fixture incident\'s persisted Workspace')
    const headers=new Headers({origin:requestOrigin,'content-type':'application/json','x-mikka-workspace-id':workspaceId})
    if(actor){const token=nativeTokens.get(actor);assert.ok(token);headers.set('authorization','Bearer '+token)}
    return new Request(`${origin}/mikka/api/factory/monitor-incidents/${id}/links`,{method,headers,...(method==='POST'?{body:JSON.stringify(body)}:{})})
  }
  const call=async(id:string,method='GET',body:unknown={url:urlFor()},requestOrigin?:string)=>{
    const req=request(id,method,body,requestOrigin),scope=context.createRequestScope(req)
    try{return await context.runRequestScope(scope,()=>(method==='POST'?routes.POST:routes.GET)(req,{params:Promise.resolve({incidentId:id})}))}
    finally{await scope.after.finish()}
  }
  await t.test('session, origin, schema and foreign tenant deny before provider access',async()=>{
    const f=await seed()
    actor=null;assert.equal((await call(f.incidentId)).status,401)
    actor=owner;assert.equal((await call(f.incidentId,'POST',{url:urlFor()},'https://untrusted.invalid')).status,403)
    assert.equal((await call(f.incidentId,'POST',{url:urlFor(),ownerId:peer})).status,422)
    actor=peer;assert.equal((await call(f.incidentId,'POST')).status,404)
    actor=owner;assert.equal(issueReads,0)
  })
  await t.test('ten links and response replay persist one verified mapping without provider writes',async()=>{
    const f=await seed()
    const results=await Promise.all(Array.from({length:10},()=>call(f.incidentId,'POST')))
    assert.ok(results.every(r=>r.status===200))
    const read=await(await call(f.incidentId)).json()
    assert.equal(read.issueId,f.issueId);assert.equal(read.sourceIssueId,f.sourceIssueId)
    assert.equal(read.github.status,'mapped');assert.equal(read.github.url,urlFor());assert.equal(read.github.githubIssueId,'1007')
    assert.equal(read.github.remoteKey,'v2/github.com/mikka-ci/followup')
    assert.equal(read.linear.status,'unmapped','a personal follow-up never inherits the delivery Linear target')
    assert.equal(JSON.stringify(read).includes('PRIVATE GITHUB BODY'),false);assert.equal(JSON.stringify(read).includes(credential),false)
    assert.equal((await pool.query('SELECT count(*)::int n FROM github_issue_links WHERE "issueId"=$1',[f.issueId])).rows[0].n,1)
    const count=issueReads
    assert.equal((await call(f.incidentId)).status,200);assert.equal(issueReads,count,'local discovery cannot dispatch provider IO')
    assert.equal((await call(f.incidentId,'POST')).status,200,'retry after an unread response rechecks the same existing issue')
    assert.equal((await call(f.incidentId,'POST',{url:urlFor(8)})).status,409)
    assert.equal((await pool.query('SELECT "githubIssueId" FROM github_issue_links WHERE "issueId"=$1',[f.issueId])).rows[0].githubIssueId,'1007')
    await assert.rejects(pool.query('UPDATE github_issue_links SET "remoteKey"=\'v2/github.com/other/repo\' WHERE "issueId"=$1',[f.issueId]),{code:'23514'})
  })
  await t.test('candidate repository, URLs and current GitHub installation remain authoritative',async()=>{
    const f=await seed(),before=issueReads
    assert.equal((await call(f.incidentId,'POST',{url:'https://github.com/other/repo/issues/7'})).status,409)
    for(const url of ['https://evil.invalid/issue/7','https://github.com/mikka-ci/followup/pull/7',`${urlFor()}?redirect=1`])assert.equal((await call(f.incidentId,'POST',{url})).status,422)
    assert.equal(issueReads,before)
    repositoryAllowed=false
    assert.equal((await call(f.incidentId,'POST')).status,403);assert.equal(issueReads,before)
    repositoryAllowed=true
  })
  await t.test('workspace revocation waits for an admitted mapping and rejects subsequent reads and writes',async()=>{
    const f=await seed(true),revoker=await pool.connect()
    const pending:{suspension?:Promise<unknown>}={}
    try{
      await revoker.query('BEGIN')
      await revoker.query("SET LOCAL lock_timeout='10s'")
      const {rows:[backend]}=await revoker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')
      afterIssueRead=async()=>{
        pending.suspension=revoker.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2',[f.workspaceId,owner])
        void pending.suspension.catch(()=>undefined)
        const deadline=Date.now()+5000
        for(;;){
          const {rows:[state]}=await pool.query<{waiting:boolean}>('SELECT cardinality(pg_blocking_pids($1))>0 AS waiting',[backend.pid])
          if(state.waiting)break
          assert.ok(Date.now()<deadline,'suspension must wait on the actual Workspace membership lease')
          await new Promise(resolve=>setTimeout(resolve,10))
        }
      }
      assert.equal((await call(f.incidentId,'POST',{url:urlFor(10)})).status,200,'the already-admitted request commits before suspension')
      assert.ok(pending.suspension)
      await pending.suspension
      await revoker.query('COMMIT')
      afterIssueRead=undefined
      assert.equal((await pool.query('SELECT count(*)::int n FROM github_issue_links WHERE "issueId"=$1',[f.issueId])).rows[0].n,1)
      const reads=issueReads
      assert.equal((await call(f.incidentId)).status,404)
      assert.equal((await call(f.incidentId,'POST',{url:urlFor(10)})).status,404)
      assert.equal(issueReads,reads,'revoked requests do not read the provider')
      assert.equal((await pool.query('SELECT count(*)::int n FROM github_issue_links WHERE "issueId"=$1',[f.issueId])).rows[0].n,1,'revoked requests cannot mutate the mapping')
    }finally{
      afterIssueRead=undefined
      await pending.suspension?.catch(()=>undefined)
      await revoker.query('ROLLBACK')
      revoker.release()
    }
  })
  await t.test('an existing verified Linear target and explicit GitHub issue map to the same logical issue',async()=>{
    const {seal}=await import('../lib/linear-sync/crypto')
    const teamSyncId=randomUUID(),linearTeamId=randomUUID(),remoteId=randomUUID()
    const workspaceId=await seedFixtureWorkspace(pool,owner,'team')
    const {rows:[team]}=await pool.query('INSERT INTO linear_team_syncs(id,"ownerId","linearTeamId","linearTeamKey","linearTeamName","workspaceId") VALUES($1,$2,$3,\'MAP\',\'Monitor fixture\',$4) RETURNING *',[teamSyncId,owner,linearTeamId,workspaceId])
    await pool.query('INSERT INTO linear_connections("userId","linearUserId","organizationId","organizationName","accessToken","refreshToken","expiresAt") VALUES($1,\'fixture\',\'fixture\',\'Fixture\',$2,$3,now()+interval \'1 day\')',[owner,seal(randomUUID()),seal(randomUUID())])
    const {createAppIssueFromLinear}=await import('../lib/linear-sync/issue-sync')
    const {withDatabaseClient}=await import('../lib/db')
    let localIssueId:string
    const tx=await pool.connect()
    try{
      const imported=await withDatabaseClient(tx,()=>createAppIssueFromLinear(team,{id:remoteId,identifier:'MAP-195',title:'Monitored bug',description:'',dueDate:null,priority:0,url:'https://linear.app/fixture/issue/MAP-195',updatedAt:new Date().toISOString(),state:null,team:{id:linearTeamId,key:'MAP',name:'Fixture'},assignee:null,labels:[]}))
      assert.ok(imported)
      localIssueId=imported.id
      assert.notEqual(localIssueId,remoteId,'provider IDs remain distinct from local issue IDs')
      assert.equal(imported.workspaceId,workspaceId)
    }finally{tx.release()}
    const f=await seed(false,{id:localIssueId!,workspaceKey:`linear-team:${teamSyncId}`,workspaceId})
    const response=await call(f.incidentId,'POST',{url:urlFor(9)})
    assert.equal(response.status,200)
    const body=await response.json()
    assert.equal(body.issueId,localIssueId!);assert.equal(body.github.githubIssueId,'1009');assert.equal(body.linear.linearIssueId,remoteId)
    assert.equal(body.linear.linearIdentifier,'MAP-195')
    assert.equal((await pool.query('SELECT count(*)::int n FROM linear_sync_outbox WHERE "issueId"=$1',[localIssueId!])).rows[0].n,0)
    await pool.query('UPDATE linear_connections SET "revokedAt"=now() WHERE "userId"=$1',[owner])
    assert.equal((await(await call(f.incidentId)).json()).linear.status,'unmapped')
  })
})
