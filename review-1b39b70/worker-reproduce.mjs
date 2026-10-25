import assert from 'node:assert/strict'
import {Pool} from 'pg'
import {randomUUID,randomBytes,createHash} from 'node:crypto'
import {readFile,writeFile} from 'node:fs/promises'
const origin='http://127.0.0.1:3110', evidence='/tmp/audit-210-http-1b39b70'
const context=JSON.parse(await readFile(`${evidence}/acceptance.json`,'utf8'))
const target=new URL(process.env.AUDIT_APP_TEST_URL)
assert.equal(target.hostname,'127.0.0.1');assert.ok(target.pathname.endsWith('_e2e'))
assert.equal(process.env.AUDIT_EXACT_SHA,context.sha)
const pool=new Pool({connectionString:target.href})
const device=randomUUID(),repo=randomUUID(),agent=randomUUID(),issue=randomUUID(),run=randomUUID(),tokenId=randomUUID()
const token='orv_'+randomBytes(32).toString('base64url')
const requests=[]
async function request(path,body,bearer=token) {
 const requestId=randomUUID(),res=await fetch(origin+'/mikka'+path,{method:'POST',headers:{authorization:'Bearer '+bearer,'content-type':'application/json','x-request-id':requestId},body:JSON.stringify(body)})
 requests.push({path,requestId,status:res.status,utc:new Date().toISOString()})
 return res
}
try{
 await pool.query('INSERT INTO device_tokens(id,"userId",name,"tokenHash") VALUES($1,$2,\'Synthetic audit\',$3)',[tokenId,context.ownerId,createHash('sha256').update(token).digest('hex')])
 await pool.query('INSERT INTO devices(id,"ownerId",name,"lastSeenAt") VALUES($1,$2,\'Synthetic audit\',now())',[device,context.ownerId])
 await pool.query('INSERT INTO device_repos(id,"deviceId","userId","repoPath") VALUES($1,$2,$3,\'/synthetic/audit\')',[repo,device,context.ownerId])
 await pool.query('INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,$3,\'codex\',$4)',[agent,context.ownerId,agent,device])
 await pool.query('INSERT INTO issues(id,"userId",title,content,status,priority,scope) VALUES($1,$2,\'Synthetic audit\',\'{}\',\'todo\',\'normal\',\'workspace\')',[issue,context.ownerId])
 const tx=await pool.connect()
 try{
  await tx.query('BEGIN');await tx.query("SELECT set_config('mikka.audit_workspace',$1,true)",[context.workspaceId])
  await tx.query('INSERT INTO agent_runs(id,"userId","agentId","deviceId","deviceRepoId","issueId",prompt) VALUES($1,$2,$3,$4,$5,$6,\'synthetic-private-prompt-not-for-audit\')',[run,context.ownerId,agent,device,repo,issue])
  await tx.query('COMMIT')
 }catch(e){await tx.query('ROLLBACK');throw e}finally{tx.release()}
 const claimPath=`/v1/devices/${device}/runs/${run}/claim`
 const claim=await request(claimPath,{});assert.equal(claim.status,200)
 const assignment=await claim.json();assert.equal(assignment.runId,run);assert.ok(assignment.mcp.token.startsWith('mkw_'))
 assert.equal((await request(claimPath,{})).status,409)
 assert.equal((await request(`/v1/runs/${run}/complete`,{stopReason:'turn_ended'})).status,204)
 assert.equal((await request(`/v1/runs/${run}/complete`,{stopReason:'turn_ended'})).status,204)
 assert.equal((await request('/api/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'},assignment.mcp.token)).status,401)
 const rows=(await pool.query("SELECT seq,event,hash FROM security_audit_events WHERE tenant=$1 AND event->>'runId'=$2 ORDER BY seq",[context.workspaceId,run])).rows
 assert.equal(rows.filter(r=>r.event.action==='worker.claim').length,1)
 const terminal=rows.find(r=>r.event.action==='agent_runs.update'&&r.event.reason==='stopped')
 assert.equal(terminal.event.actorId,tokenId);assert.equal(terminal.event.actorType,'worker');assert.ok(terminal.event.requestId)
 assert.ok(rows.every(r=>!JSON.stringify(r).includes(token)&&!JSON.stringify(r).includes(assignment.mcp.token)&&!JSON.stringify(r).includes('synthetic-private-prompt-not-for-audit')))
 await writeFile(`${evidence}/worker-acceptance.json`,JSON.stringify({sha:context.sha,origin,utc:new Date().toISOString(),layer:'real Next HTTP and PG with synthetic credential; no daemon/CLI/provider execution',deviceId:device,runId:run,issueId:issue,actorRecordId:tokenId,workspaceId:context.workspaceId,requests,rows,status:'passed'},null,2))
 console.log(JSON.stringify({status:'passed',sha:context.sha,runId:run,requests:requests.length,events:rows.length}))
}finally{await pool.end()}
