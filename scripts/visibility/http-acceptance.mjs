import assert from 'node:assert/strict'
import { randomUUID,randomBytes,createHash } from 'node:crypto'
import {mkdirSync,writeFileSync} from 'node:fs'
import {Pool} from 'pg'
const appURL=new URL(process.env.E2E_DATABASE_URL),wsURL=new URL(process.env.VISIBILITY_WORKSPACE_DATABASE_URL),origin=new URL(process.env.E2E_BASE_URL)
for(const u of [appURL,wsURL])assert.ok(['localhost','127.0.0.1'].includes(u.hostname)&&u.pathname.endsWith('_e2e'))
assert.notEqual(appURL.toString(),wsURL.toString());assert.ok(['localhost','127.0.0.1'].includes(origin.hostname))
const app=new Pool({connectionString:appURL.toString()}),ws=new Pool({connectionString:wsURL.toString()})
const id=()=>randomUUID(),owner=id(),member=id(),outsider=id(),w1=id(),w2=id(),team=id(),shared=id(),personal=id(),agent=id(),run=id(),privateRun=id(),device=id(),deviceTokenId=id()
const evidence={sha:process.env.GITHUB_SHA??null,startedAt:new Date().toISOString(),environment:'real Next MCP HTTP, two isolated PostgreSQL databases',checks:[]}
const tokens=new Map(),clients=new Map()
async function call(user,name,args){
 const response=await fetch(new URL('/mikka/api/mcp',origin),{method:'POST',headers:{authorization:'Bearer '+tokens.get(user),'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:id(),method:'tools/call',params:{name,arguments:args}})})
 assert.equal(response.status,200)
 const text=await response.text();const payload=text.startsWith('event:')||text.startsWith('data:')?JSON.parse(text.split('\n').find(line=>line.startsWith('data:')).slice(5)):JSON.parse(text)
 assert.ok(!payload.error,'MCP protocol error')
 const result=payload.result
 return {error:!!result.isError,data:result.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')}
}
async function value(user,name,args){const r=await call(user,name,args);assert.equal(r.error,false);return JSON.parse(r.data)}
try{
 for(const u of [owner,member,outsider]){
  await app.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',[u,u+'@example.invalid'])
  const client=id(),secret=randomBytes(32).toString('base64url');tokens.set(u,'mka_'+secret);clients.set(u,client)
  await app.query('INSERT INTO "oauthClient"(id,"clientId","redirectUris",disabled,"userId") VALUES($1,$1,\'[]\',false,$2)',[client,u])
  await app.query('INSERT INTO "oauthAccessToken"(id,token,"clientId","userId","expiresAt","createdAt",scopes) VALUES($1,$2,$3,$4,now()+interval \'1 hour\',now(),\'["mikka"]\')',[id(),createHash('sha256').update(secret).digest('base64url'),client,u])
 }
 for(const [w,u]of [[w1,owner],[w2,outsider]])await ws.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'Retained visibility fixture\')',[w,u])
 for(const [w,u]of [[w1,owner],[w1,member],[w2,outsider]])await ws.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,\'member\',\'active\')',[w,u,u+'@example.invalid'])
 await ws.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,\'Fixture\',\'VIS\')',[team,w1,owner])
 for(const [issue,scope]of [[shared,'workspace'],[personal,'personal']]){
  await app.query('INSERT INTO issues(id,"userId",title,content,status,priority,scope) VALUES($1,$2,\'Synthetic task\',\'{"type":"doc","content":[]}\',\'todo\',\'normal\',$3)',[issue,owner,scope])
  await ws.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)',[issue,team,w1,owner])
  await app.query('INSERT INTO issue_members("issueId","userId","memberId") VALUES($1,$2,$3)',[issue,owner,member])
 }
 await app.query('INSERT INTO agents(id,"userId",harness,name,instructions) VALUES($1,$2,\'codex\',\'private-agent-marker\',\'private-instructions-marker\')',[agent,owner])
 for(const [r,issue]of [[run,shared],[privateRun,personal]]){
  await app.query('INSERT INTO agent_runs(id,"userId","agentId","issueId",status,prompt,error,"stopReason",report) VALUES($1,$2,$3,$4,\'running\',\'private-prompt-marker\',\'private-error-marker\',\'private-stop-marker\',\'{"summary":"private-report-marker"}\')',[r,owner,agent,issue])
  await app.query('INSERT INTO run_chunks(id,"runId",seq,chunk) VALUES($1,$2,1,\'{"type":"text-delta","delta":"private-transcript-marker"}\')',[id(),r])
  await app.query('INSERT INTO run_messages(id,"runId","userId",text) VALUES($1,$2,$3,\'private-message-marker\')',[id(),r,owner])
 }
 const projected=await value(member,'get_run',{runId:run});assert.deepEqual(projected.recentEvents,[])
 const allowed=['id','issueId','agent','harness','status','stopReason','error','summary','startedAt','finishedAt','recentEvents'].sort()
 assert.deepEqual(Object.keys(projected).sort(),allowed);assert.equal(projected.agent,'codex');assert.equal(projected.summary,null);assert.ok(!JSON.stringify(projected).includes('private-'))
 assert.equal((await value(member,'list_runs',{issueId:shared})).length,1)
 assert.equal((await call(member,'get_run_events',{runId:run})).error,true)
 for(const user of [member,outsider]){assert.equal((await call(user,'get_issue',{issueId:personal})).error,true);assert.equal((await call(user,'get_run',{runId:privateRun})).error,true)}
 assert.equal((await call(outsider,'get_run',{runId:run})).error,true)
 const full=await value(owner,'get_run',{runId:run});assert.equal(full.summary,'private-report-marker');assert.ok(full.recentEvents[0].includes('private-transcript-marker'))
 evidence.checks.push('active teammate receives exact metadata allowlist; personal stale invitation/team link stays private; other workspace denied; owner retains report/transcript; core suite separately verifies messages')
 const updated=await call(owner,'update_issue',{issueId:shared,title:'Actor attributed MCP task',actorType:'user',actorId:outsider})
 assert.equal(updated.error,false)
 const actorRow=(await app.query('SELECT actor_type,actor_id FROM issue_versions WHERE "issueId"=$1 ORDER BY revision DESC LIMIT 1',[shared])).rows[0]
 assert.deepEqual(actorRow,{actor_type:'agent',actor_id:clients.get(owner)})
 evidence.checks.push('actual OAuth MCP write ignores forged actor fields and records verified client identity')
 await ws.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2',[w1,member])
 assert.equal((await call(member,'get_run',{runId:run})).error,true);assert.deepEqual(await value(member,'list_runs',{issueId:shared}),[])
 await ws.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2',[w1,member])
 await app.query('UPDATE issues SET scope=\'personal\' WHERE id=$1',[shared]);assert.equal((await call(member,'get_run',{runId:run})).error,true)
 evidence.checks.push('membership suspension immediately removes HTTP metadata; personal scope flip removes restored member access')
 // Existing linked-workspace execution fence also applies to owner-personal
 // tasks with stale links; authenticating a worker lists tools without executing.
 const worker='mkw_'+randomBytes(32).toString('base64url')
 await app.query('INSERT INTO run_tokens(id,"runId","userId","tokenHash","expiresAt") VALUES($1,$2,$3,$4,now()+interval \'1 hour\')',[id(),privateRun,owner,createHash('sha256').update(worker).digest('hex')])
 const workerAuth=()=>fetch(new URL('/mikka/api/mcp',origin),{method:'POST',headers:{authorization:'Bearer '+worker,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:id(),method:'tools/list',params:{}})})
 assert.equal((await workerAuth()).status,200)
 await ws.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2',[w1,owner])
 assert.equal((await workerAuth()).status,401)
 assert.equal((await value(owner,'get_run',{runId:privateRun})).summary,'private-report-marker')
 await ws.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2',[w1,owner])
 evidence.checks.push('owner-personal worker HTTP authentication refuses after linked-workspace revocation while owner history stays readable')
 // Existing daemon authority is independent of OAuth metadata reads.
 const raw='orv_'+randomBytes(32).toString('hex')
 await app.query('INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,\'Retained synthetic device\')',[device,owner])
 await app.query('INSERT INTO device_tokens(id,"userId","tokenHash") VALUES($1,$2,$3)',[deviceTokenId,owner,createHash('sha256').update(raw).digest('hex')])
 const hb=()=>fetch(new URL(`/mikka/v1/devices/${device}/heartbeat`,origin),{method:'POST',headers:{authorization:'Bearer '+raw,'content-type':'application/json'},body:JSON.stringify({harnesses:[],runs:[],worktreeDiskBytes:0})})
 assert.equal((await hb()).status,200)
 await app.query('UPDATE device_tokens SET "revokedAt"=now(),"revokedBy"=$2 WHERE id=$1',[deviceTokenId,owner])
 assert.equal((await hb()).status,401)
 evidence.checks.push('existing daemon HTTP heartbeat accepts synthetic token then denies after persisted revocation; full owner revoke flow separately covered by daemon suite')
 evidence.finishedAt=new Date().toISOString();mkdirSync('test-results/visibility',{recursive:true});writeFileSync('test-results/visibility/http-evidence.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence))
}finally{await app.end();await ws.end()}
