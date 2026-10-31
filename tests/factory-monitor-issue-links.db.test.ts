import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { recordMonitorIncidentState } from '../lib/factory/monitor-incidents'
import { assertE2eTarget } from './helpers/e2e-target.mjs'

const target=process.env.E2E_DATABASE_URL
if(target){assertE2eTarget(target);assert.equal(process.env.MIKKA_DATABASE_URL,target);assert.equal(process.env.DATABASE_URL,target)}
if(!target&&process.env.REQUIRE_DB==='1')throw Error('Monitor mappings require an isolated E2E database')
let actor:string|null=null
const credential=randomUUID()
mock.module(new URL('../lib/auth.ts',import.meta.url).href,{namedExports:{auth:{api:{
  getSession:async()=>actor?{user:{id:actor},session:{id:randomUUID()}}:null,
  listUserAccounts:async()=>[{id:'synthetic-account',userId:actor,providerId:'github',accountId:'42'}],
  getAccessToken:async()=>({accessToken:credential}),
}}}})

test('monitor mappings use actual owner/scope authorization, GitHub readback and durable local references',{skip:!target},async t=>{
  const pool=new Pool({connectionString:target,max:12})
  for(const name of ['20261031060510_monitor_followup_issues.sql','20261031060511_monitor_github_issue_links.sql'])await pool.query(await readFile(new URL(`../drizzle/${name}`,import.meta.url),'utf8'))
  const owner=`monitor-map-${randomUUID()}`,peer=`monitor-peer-${randomUUID()}`
  actor=owner
  for(const id of [owner,peer])await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',[id,`${id}@example.invalid`])
  const appId=process.env.GITHUB_APP_ID,linearKey=process.env.LINEAR_TOKEN_ENCRYPTION_KEY
  process.env.GITHUB_APP_ID='4840908'
  process.env.LINEAR_TOKEN_ENCRYPTION_KEY=randomBytes(32).toString('hex')
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
    if(appId===undefined)delete process.env.GITHUB_APP_ID;else process.env.GITHUB_APP_ID=appId
    if(linearKey===undefined)delete process.env.LINEAR_TOKEN_ENCRYPTION_KEY;else process.env.LINEAR_TOKEN_ENCRYPTION_KEY=linearKey
    receiver.closeAllConnections();await new Promise<void>(resolve=>receiver.close(()=>resolve()))
    await pool.end();await(await import('../lib/db')).pool.end();await(await import('../lib/workspace-db')).workspacePool.end()
  })
  const routes=await import('../app/api/factory/monitor-incidents/[incidentId]/links/route')
  const urlFor=(number=7)=>`https://github.com/mikka-ci/followup/issues/${number}`
  async function seed(workspace=false,imported?:{id:string;workspaceKey:string}){
    const issueId=imported?.id??randomUUID(),taskId=randomUUID(),attemptId=randomUUID(),candidateId=randomUUID()
    const workspaceId=workspace?randomUUID():null
    const tx=await pool.connect()
    try{
      await tx.query('BEGIN')
      if(!imported)await tx.query('INSERT INTO issues(id,"userId",title,content,status,priority,scope) VALUES($1,$2,\'Completed delivery\',\'{"type":"doc","content":[]}\',\'done\',\'normal\',$3)',[issueId,workspace?peer:owner,workspace?'workspace':'personal'])
      if(workspace){
        const team=randomUUID()
        await tx.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'Monitor fixture\')',[workspaceId,peer])
        for(const user of [owner,peer])await tx.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,\'member\',\'active\')',[workspaceId,user,`${user}@example.invalid`])
        await tx.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,\'Monitor fixture\',\'MM\')',[team,workspaceId,peer])
        await tx.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)',[issueId,team,workspaceId,peer])
      }
      await tx.query('INSERT INTO factory_tasks(id,"userId","issueId","sourceEventId",route,stage,status,"attemptId",reason,"scopeVersion") VALUES($1,$2,$3,$4,\'{}\',\'monitor\',\'running\',$5,\'Trusted monitor fixture\',1)',[taskId,owner,issueId,randomUUID(),attemptId])
      await tx.query('INSERT INTO factory_candidates(id,"taskId",sha,repository,environment,scope,"runId") VALUES($1,$2,repeat(\'a\',40),\'https://github.com/mikka-ci/followup.git\',\'device:fixture\',\'fixture\',$3)',[candidateId,taskId,randomUUID()])
      await tx.query('INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"candidateId",reason) VALUES($1,$2,\'monitor\',1,1,\'running\',$3,\'Trusted monitor fixture\')',[attemptId,taskId,candidateId])
      await tx.query('UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1',[taskId,candidateId])
      const incident=await recordMonitorIncidentState(tx,{ownerId:owner,workspaceKey:imported?.workspaceKey??(workspaceId?`workspace:${workspaceId}`:`personal:${owner}`),fingerprint:createHash('sha256').update(randomUUID()).digest('hex'),checkKey:'c'.repeat(64),issueId,taskId,candidateId,outcome:'unhealthy'})
      await tx.query('COMMIT')
      return {incidentId:String(incident.id),sourceIssueId:issueId,issueId:String(incident.followupIssueId??incident.issueId),workspaceId,taskId}
    }catch(error){await tx.query('ROLLBACK');throw error}finally{tx.release()}
  }
  const request=(id:string,method='GET',body:unknown={url:urlFor()},origin='http://127.0.0.1')=>new Request(`http://127.0.0.1/api/factory/monitor-incidents/${id}/links`,{method,headers:{origin,'content-type':'application/json'},...(method==='POST'?{body:JSON.stringify(body)}:{})})
  const call=(id:string,method='GET',body:unknown={url:urlFor()},origin?:string)=>(method==='POST'?routes.POST:routes.GET)(request(id,method,body,origin),{params:Promise.resolve({incidentId:id})})
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
  await t.test('workspace revocation during GitHub readback prevents mapping commit',async()=>{
    const f=await seed(true)
    afterIssueRead=async()=>{await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2',[f.workspaceId,owner])}
    assert.equal((await call(f.incidentId,'POST')).status,404)
    afterIssueRead=undefined
    assert.equal((await pool.query('SELECT count(*)::int n FROM github_issue_links WHERE "issueId"=$1',[f.issueId])).rows[0].n,0)
    assert.equal((await call(f.incidentId)).status,404)
  })
  await t.test('an existing verified Linear target and explicit GitHub issue map to the same logical issue',async()=>{
    const {seal}=await import('../lib/linear-sync/crypto')
    const teamSyncId=randomUUID(),linearTeamId=randomUUID(),remoteId=randomUUID()
    const {rows:[team]}=await pool.query('INSERT INTO linear_team_syncs(id,"ownerId","linearTeamId","linearTeamKey","linearTeamName") VALUES($1,$2,$3,\'MAP\',\'Monitor fixture\') RETURNING *',[teamSyncId,owner,linearTeamId])
    await pool.query('INSERT INTO linear_connections("userId","linearUserId","organizationId","organizationName","accessToken","refreshToken","expiresAt") VALUES($1,\'fixture\',\'fixture\',\'Fixture\',$2,$3,now()+interval \'1 day\')',[owner,seal(randomUUID()),seal(randomUUID())])
    const {createAppIssueFromLinear}=await import('../lib/linear-sync/issue-sync')
    const {withDatabaseClient}=await import('../lib/db')
    const tx=await pool.connect()
    try{
      const imported=await withDatabaseClient(tx,()=>createAppIssueFromLinear(team,{id:remoteId,identifier:'MAP-195',title:'Monitored bug',description:'',dueDate:null,priority:0,url:'https://linear.app/fixture/issue/MAP-195',updatedAt:new Date().toISOString(),state:null,team:{id:linearTeamId,key:'MAP',name:'Fixture'},assignee:null,labels:[]}))
      assert.ok(imported)
    }finally{tx.release()}
    const f=await seed(false,{id:remoteId,workspaceKey:`linear-team:${teamSyncId}`})
    const response=await call(f.incidentId,'POST',{url:urlFor(9)})
    assert.equal(response.status,200)
    const body=await response.json()
    assert.equal(body.issueId,remoteId);assert.equal(body.github.githubIssueId,'1009');assert.equal(body.linear.linearIssueId,remoteId)
    assert.equal(body.linear.linearIdentifier,'MAP-195')
    assert.equal((await pool.query('SELECT count(*)::int n FROM linear_sync_outbox WHERE "issueId"=$1',[remoteId])).rows[0].n,0)
    await pool.query('UPDATE linear_connections SET "revokedAt"=now() WHERE "userId"=$1',[owner])
    assert.equal((await(await call(f.incidentId)).json()).linear.status,'unmapped')
  })
})
