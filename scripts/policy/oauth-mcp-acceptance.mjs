import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'

// Only called by the loopback, separate _e2e database acceptance harness.
export async function oauthMcpAcceptance({ app, workspace, origin, client, signup, receipts, route }) {
  const admin = client(), member = client()
  const ownerId = await signup(admin), memberId = await signup(member), w = randomUUID()
  await workspace.query(`INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,'Synthetic OAuth MCP policy')`, [w, ownerId])
  await workspace.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,'Synthetic','oauth-admin@example.invalid','admin'),($1,$3,'Synthetic','oauth-member@example.invalid','member')`, [w, ownerId, memberId])
  const clientId = randomUUID(), tokenId = randomUUID(), token = `mka_${randomBytes(32).toString('base64url')}`
  await app.query(`INSERT INTO "oauthClient"(id,"clientId","userId","redirectUris",scopes) VALUES($1,$1,$2,'["http://127.0.0.1/synthetic"]','["mikka"]')`, [clientId,memberId])
  await app.query(`INSERT INTO "oauthAccessToken"(id,token,"clientId","userId","expiresAt","createdAt",scopes) VALUES($1,$2,$3,$4,now()+interval '1 hour',now(),'["mikka"]')`, [tokenId,createHash('sha256').update(token.slice(4)).digest('base64url'),clientId,memberId])
  const tools = [ ['search_notion_pages',{query:'synthetic'}], ['read_notion_page_blocks',{block_id:'synthetic'}], ['search_slack_messages',{query:'synthetic'}], ['read_slack_thread',{channel:'synthetic',ts:'1.0'}] ]
  let seq=0, version=0
  const payload=(name,input)=>JSON.stringify({jsonrpc:'2.0',id:++seq,method:'tools/call',params:{name,arguments:input}})
  async function call(name,input,expected) {
    const res=await fetch(new URL('/mikka/api/mcp',origin),{method:'POST',headers:{authorization:`Bearer ${token}`,accept:'application/json, text/event-stream','content-type':'application/json'},body:payload(name,input)})
    const body=await res.text(); assert.equal(res.status,200); if (expected === null) assert.ok(!body.includes('"isError":true'),body.slice(0,400)); else assert.ok(body.includes(expected),`${name} expected ${expected}: ${body.slice(0,400)}`)
    receipts.push({utc:new Date().toISOString(),method:'POST',path:'/api/mcp',status:res.status,probe:`oauth:${name}`,expected})
  }
  const doc=state=>({schemaVersion:1,state,offlineTtlSeconds:60,layers:[{scope:'workspace',id:w,ceiling:{git_push:'deny'},models:[route]}]})
  const publish=async state=>{const r=await admin.call(`/api/policy?workspaceId=${w}`,'POST',{expectedVersion:version,document:doc(state)});assert.equal(r.status,201);version++}
  for(const [name,input] of tools) await call(name,input,'composioNotConfigured')
  await delayed('oauth first enrollment after auth',()=>publish('enforce'),'toolEnforcementUnavailable')
  for(const [name,input] of tools) await call(name,input,'toolEnforcementUnavailable')
  // Caller-controlled scope/owner fields never select an unmanaged principal.
  await call('search_notion_pages',{query:'synthetic',userId:ownerId,workspaceId:randomUUID()},'toolEnforcementUnavailable')
  async function delayed(check,mutation,expected) {
    const requestId=randomUUID(), body=payload('search_notion_pages',{query:'delayed synthetic'})
    let send
    const response=new Promise((resolve,reject)=>{
      send=httpRequest(new URL('/mikka/api/mcp',origin),{method:'POST',headers:{authorization:`Bearer ${token}`,accept:'application/json, text/event-stream','content-type':'application/json','content-length':Buffer.byteLength(body),'x-request-id':requestId}},res=>{let text='';res.on('data',c=>{text+=c});res.on('end',()=>resolve({status:res.statusCode,body:text}))})
      send.on('error',reject);send.setTimeout(20000,()=>send.destroy(new Error('Delayed OAuth fixture timeout')))
    });void response.catch(()=>{})
    try {
      send.write(body.slice(0,1));send.flushHeaders()
      const deadline=Date.now()+15000
      while(!(await app.query(`SELECT 1 FROM security_audit_events WHERE event->>'action'='mcp.authenticated' AND event->>'requestId'=$1`,[requestId])).rowCount){assert.ok(Date.now()<deadline,'request auth audit timeout');await new Promise(r=>setTimeout(r,25))}
      await mutation();send.end(body.slice(1))
      const r=await response;assert.equal(r.status,200);assert.ok(r.body.includes(expected),`${check}: ${r.body.slice(0,400)}`)
      receipts.push({utc:new Date().toISOString(),method:'POST',path:'/api/mcp',status:r.status,probe:check,expected})
    } finally {send.destroy();await response.catch(()=>{})}
  }
  await delayed('oauth policy revoke after auth',()=>publish('revoked'),'policyRevoked')
  await delayed('oauth policy new version after auth',()=>publish('enforce'),'toolEnforcementUnavailable')
  await delayed('oauth member suspend after auth',()=>workspace.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`,[w,memberId]),'policyAccessDenied')
  await workspace.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"=$2`,[w,memberId])
  await delayed('oauth membership removed after auth',()=>workspace.query(`DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2`,[w,memberId]),'policyAccessDenied')
  await workspace.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,'Synthetic','oauth-member@example.invalid','member')`,[w,memberId])
  await delayed('oauth token expires after auth',()=>app.query(`UPDATE "oauthAccessToken" SET "expiresAt"=now()-interval '1 second' WHERE id=$1`,[tokenId]),'mcpAuthorizationRevoked')
  await app.query(`UPDATE "oauthAccessToken" SET "expiresAt"=now()+interval '1 hour' WHERE id=$1`,[tokenId])
  const session=(await app.query(`SELECT id,"expiresAt" FROM session WHERE "userId"=$1 ORDER BY "createdAt" DESC LIMIT 1`,[memberId])).rows[0]
  assert.ok(session)
  await app.query(`UPDATE "oauthAccessToken" SET "sessionId"=$1 WHERE id=$2`,[session.id,tokenId])
  await delayed('oauth session expires after auth',()=>app.query(`UPDATE session SET "expiresAt"=now()-interval '1 second' WHERE id=$1`,[session.id]),'mcpAuthorizationRevoked')
  await app.query(`UPDATE session SET "expiresAt"=$1 WHERE id=$2`,[session.expiresAt,session.id])
  await delayed('oauth token revoke after auth',()=>app.query(`UPDATE "oauthAccessToken" SET revoked=now() WHERE id=$1`,[tokenId]),'mcpAuthorizationRevoked')
  await app.query(`UPDATE "oauthAccessToken" SET revoked=null WHERE id=$1`,[tokenId])
  await delayed('oauth client disable after auth',()=>app.query(`UPDATE "oauthClient" SET disabled=true WHERE "clientId"=$1`,[clientId]),'mcpAuthorizationRevoked')
  await app.query(`UPDATE "oauthClient" SET disabled=false WHERE "clientId"=$1`,[clientId])
  // Six calls race a committed revoke. Every call must deny; none may reach the
  // unconfigured provider branch observed by the unmanaged baseline.
  let ready=0, release
  const barrier=new Promise(resolve=>{release=resolve})
  await Promise.all(Array.from({length:6},(_,i)=>delayed(`oauth concurrent revoke ${i+1}`,async()=>{
    ready++; if(ready===6) {await publish('revoked');release()} await barrier
  },'policyRevoked')))
  await call('list_issues',{},null) // Existing local reads remain available.
  const events=(await workspace.query(`SELECT event->>'reason' reason,count(*)::int count FROM security_audit_events WHERE tenant=$1 AND event->>'action'='policy.tool' GROUP BY 1`,[w])).rows
  assert.ok(events.some(r=>r.reason==='policyRevoked' && r.count>=7))
  return {workspaceId:w,versions:version,events,providerConfiguration:'absent; unmanaged returned composioNotConfigured; managed returned policy denial before client construction'}
}
