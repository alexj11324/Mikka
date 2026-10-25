// Real compiled Next HTTP acceptance on disposable cloud Linux databases only.
import assert from 'node:assert/strict'
import { continuationPolicyAcceptance } from './continuation-acceptance.mjs'
import { oauthMcpAcceptance } from './oauth-mcp-acceptance.mjs'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile, copyFile, readFile, mkdtemp, rm } from 'node:fs/promises'
import { Pool } from 'pg'
import { getMigrations } from 'better-auth/db/migration'
import { oauthProvider } from '@better-auth/oauth-provider'
import { chromium } from '@playwright/test'
const exec = promisify(execFile)
const origin = new URL(process.env.POLICY_HTTP_ORIGIN ?? 'http://127.0.0.1:3130')
assert.equal(origin.hostname,'127.0.0.1'); assert.equal(origin.protocol,'http:')
for (const key of ['MIKKA_DATABASE_URL','DATABASE_URL']) {
  const url=new URL(process.env[key]); assert.equal(url.hostname,'127.0.0.1'); assert.ok(url.pathname.endsWith('_e2e'))
}
assert.notEqual(process.env.MIKKA_DATABASE_URL,process.env.DATABASE_URL)
const sha=(await exec('git',['rev-parse','HEAD'])).stdout.trim()
assert.match(sha,/^[a-f0-9]{40}$/)
assert.equal((await readFile('.next/policy-source-sha','utf8')).trim(),sha,'compiled application must match frozen source SHA')
const evidence=process.env.POLICY_EVIDENCE_DIR ?? '/tmp/policy-230-http'
await mkdir(evidence,{recursive:true})
const app=new Pool({connectionString:process.env.MIKKA_DATABASE_URL}), workspace=new Pool({connectionString:process.env.DATABASE_URL})
const name=`mikka-policy-http-${randomUUID()}`
const dockerArgs=['--host=unix:///var/run/docker.sock']
const docker=(...args)=>exec('docker',[...dockerArgs,...args])
const receipts=[]
let browser, runtime
function client() {
  const jar=new Map()
  return { jar, async call(path,method='GET',body,extra={}) {
    const headers={...extra}, requestId=randomUUID()
    if(jar.size)headers.cookie=[...jar].map(([k,v])=>`${k}=${v}`).join('; ')
    if(body!==undefined){headers['content-type']='application/json';headers.origin??=origin.origin}
    const response=await fetch(new URL(`/mikka${path}`,origin),{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error'})
    for(const line of response.headers.getSetCookie()){const pair=line.split(';',1)[0],i=pair.indexOf('=');jar.set(pair.slice(0,i),pair.slice(i+1))}
    const text=await response.text(); let parsed;try{parsed=JSON.parse(text)}catch{parsed=text}
    receipts.push({requestId,method,path,status:response.status,utc:new Date().toISOString(),...(parsed?.error?{error:parsed.error}:{} )})
    return {status:response.status,body:parsed}
  }}
}
const owner=client(), member=client(), anonymous=client()
const route={provider:'opencode',model:'deepseek-v4.1-flash',endpoint:'https://opencode.ai/zen/go/v1/chat/completions',region:'unknown'}
const w=randomUUID(), other=randomUUID()
const doc=id=>({schemaVersion:1,state:'enforce',offlineTtlSeconds:60,layers:[{scope:'workspace',id,ceiling:{git_push:'deny'},models:[route]}]})
const policy=id=>`/api/policy?workspaceId=${id}`
const hash=value=>createHash('sha256').update(value).digest('hex')
async function waitReady() {
  for(let i=0;i<120;i++){try{if((await fetch(new URL('/mikka/api/policy',origin))).status===401)return}catch{}await new Promise(resolve=>setTimeout(resolve,500))}
  throw new Error('compiled Next did not become ready')
}
try {
  const migrations=await getMigrations({database:app,emailAndPassword:{enabled:true},plugins:[oauthProvider({loginPage:'/sign-in',consentPage:'/oauth/consent',disableJwtPlugin:true})]})
  await migrations.runMigrations()
  const isolatedSecret=randomBytes(32).toString('hex')
  // Docker runtime receives only these explicit synthetic settings; no provider/API keys.
  const env={...process.env,BETTER_AUTH_SECRET:isolatedSecret,BETTER_AUTH_URL:origin.origin,NODE_EXTRA_CA_CERTS:'/tmp/environment-proxy-ca.crt',NEXT_TELEMETRY_DISABLED:'1',CI:'true'}
  if(process.env.POLICY_EXTERNAL_SERVER !== '1') {
    const args=[...dockerArgs,'run','--name',name,'--network','host','--mount',`type=bind,source=${process.cwd()},target=/app`,'--mount','type=bind,source=/usr/local/share/ca-certificates/environment-proxy-ca.crt,target=/tmp/environment-proxy-ca.crt,readonly','--workdir','/app']
    for(const key of ['MIKKA_DATABASE_URL','DATABASE_URL','BETTER_AUTH_SECRET','BETTER_AUTH_URL','NODE_EXTRA_CA_CERTS','NEXT_TELEMETRY_DISABLED','CI'])args.push('--env',key)
    args.push('node:24-bookworm-slim','node','node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',origin.port)
    runtime=spawn('docker',args,{env,stdio:['ignore','ignore','ignore']})
    runtime.on('error',()=>{})
  }
  await waitReady()
  const signup=async c=>{
    const result=await c.call('/api/auth/sign-up/email','POST',{name:'Synthetic policy acceptance',email:`policy-${randomUUID()}@example.invalid`,password:randomBytes(32).toString('base64url')})
    assert.equal(result.status,200);return result.body.user.id
  }
  const oauthMcp = await oauthMcpAcceptance({app,workspace,origin,client,signup,receipts,route})
  const userId=await signup(owner), memberId=await signup(member)
  await workspace.query(`INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,'Synthetic policy acceptance'),($3,$2,'Synthetic second workspace')`,[w,userId,other])
  await workspace.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,'Synthetic','policy@example.invalid','admin'),($3,$2,'Synthetic','policy@example.invalid','admin'),($1,$4,'Synthetic','member@example.invalid','member')`,[w,userId,other,memberId])
  assert.equal((await anonymous.call(policy(w))).status,401)
  assert.equal((await owner.call(policy(w))).body.signed,null)
  assert.equal((await member.call(policy(w),'POST',{expectedVersion:0,document:doc(w)})).status,403)
  assert.equal((await owner.call(policy(w),'POST',{expectedVersion:0,document:doc(w)},{origin:'https://evil.invalid'})).status,403)
  assert.equal((await owner.call(policy(w),'POST',{expectedVersion:0,document:{...doc(w),unexpected:true}})).status,422)
  const publish=await owner.call(policy(w),'POST',{expectedVersion:0,document:doc(w)});assert.equal(publish.status,201)
  assert.equal((await owner.call('/api/agent','POST',{prompt:'Synthetic policy probe; no provider request should be sent.'})).body.error,'policyBudgetUnavailable')
  const contenders=await Promise.all(Array.from({length:8},()=>owner.call(policy(w),'POST',{expectedVersion:1,document:doc(w)})))
  assert.equal(contenders.filter(r=>r.status===201).length,1);assert.equal(contenders.filter(r=>r.status===409).length,7)
  const blocked=doc(other);blocked.layers[0].models=[]
  assert.equal((await owner.call(policy(other),'POST',{expectedVersion:0,document:blocked})).status,201)
  assert.equal((await owner.call('/api/agent','POST',{prompt:'Synthetic denied model probe.'})).body.error,'modelRouteDenied')
  const deviceId=randomUUID(),repoId=randomUUID(),agentId=randomUUID(),issueId=randomUUID(),runId=randomUUID(),teamId=randomUUID()
  const deviceToken=`synthetic_${randomBytes(32).toString('hex')}`, workerToken=`mkw_${randomBytes(32).toString('base64url')}`
  await app.query(`INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,'Synthetic policy worker')`,[deviceId,userId])
  await app.query(`INSERT INTO device_tokens(id,"userId","tokenHash") VALUES($1,$2,$3)`,[randomUUID(),userId,hash(deviceToken)])
  await app.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath") VALUES($1,$2,$3,'/synthetic/policy')`,[repoId,deviceId,userId])
  await app.query(`INSERT INTO agents(id,"userId",harness,name,"deviceId") VALUES($1,$2,'codex','Synthetic policy worker',$3)`,[agentId,userId,deviceId])
  await app.query(`INSERT INTO issues(id,"userId",title,content,status,priority,scope) VALUES($1,$2,'Synthetic policy issue','{"type":"doc","content":[]}','todo','normal','workspace')`,[issueId,userId])
  await workspace.query(`INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,'Synthetic','POLICY')`,[teamId,w,userId])
  await workspace.query(`INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)`,[issueId,teamId,w,userId])
  await app.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId",status,prompt,"leaseExpiresAt") VALUES($1,$2,$3,$4,$5,$6,'queued','Synthetic policy worker',now()+interval '90 seconds')`,[runId,userId,issueId,agentId,deviceId,repoId])
  const deviceHeaders={authorization:`Bearer ${deviceToken}`}
  const continuation = process.env.POLICY_AUDIT_REPAIR_SHA ? await continuationPolicyAcceptance({app,workspace,owner,userId,deviceId,repoId,agentId,workspaceId:w,teamId,deviceHeaders,anonymous,receipts}) : {status:'pending parent-reviewed audit integration; not independent deployment'}
  const claimed=await anonymous.call(`/v1/devices/${deviceId}/runs/${runId}/claim`,'POST',{},deviceHeaders)
  assert.equal(claimed.body.error,'workerEnforcementUnavailable')
  assert.equal((await app.query('SELECT status FROM agent_runs WHERE id=$1',[runId])).rows[0].status,'queued')
  assert.equal((await anonymous.call(`/v1/devices/${deviceId}/group-reviews`,'POST',{action:'poll'},deviceHeaders)).body.error,'toolEnforcementUnavailable')
  await app.query(`UPDATE agent_runs SET status='running' WHERE id=$1`,[runId])
  await app.query(`INSERT INTO run_tokens(id,"runId","userId","tokenHash","expiresAt") VALUES($1,$2,$3,$4,now()+interval '1 hour')`,[randomUUID(),runId,userId,hash(workerToken)])
  assert.equal((await anonymous.call('/v1/mailbox','POST',{action:'inbox'},{authorization:`Bearer ${workerToken}`})).status,401)
  assert.equal((await anonymous.call(`/v1/runs/${runId}/skill-receipt?receiptId=${randomUUID()}`,'GET',undefined,deviceHeaders)).body.error,'workerEnforcementUnavailable')
  const heartbeat=await anonymous.call(`/v1/devices/${deviceId}/heartbeat`,'POST',{harnesses:[],runs:[{runId,lastProgressAt:new Date().toISOString()}],worktreeDiskBytes:0},deviceHeaders)
  assert.equal(heartbeat.status,200);assert.ok(heartbeat.body.revoked.includes(runId));assert.deepEqual(heartbeat.body.leases,{})
  // Actual daemon + actual compiled HTTP: restarting the same journal twice cannot mint local lease grace.
  const {tsImport}=await import('tsx/esm/api')
  const {Daemon}=await tsImport('../../packages/daemon/src/main.ts',import.meta.url)
  const {HttpServerLink}=await tsImport('../../packages/daemon/src/server-link-http.ts',import.meta.url)
  const stateDir=await mkdtemp('/tmp/policy-daemon-')
  try {
    const assignment={runId,issueId,deviceId,repoId,baseBranch:'main',harness:'mock',prompt:'Synthetic policy restart probe.',leaseExpiresAt:new Date(Date.now()+60000).toISOString()}
    await writeFile(`${stateDir}/device.json`,JSON.stringify({deviceId,credential:deviceToken,repos:[{repoId,name:'Synthetic',path:stateDir}]}),{mode:0o600})
    await writeFile(`${stateDir}/runs.json`,JSON.stringify({version:1,runs:{[runId]:{assignment,state:'running',sessionId:'synthetic-session',worktree:null,lastSeq:0,error:null,updatedAt:new Date().toISOString()}}}),{mode:0o600})
    for(let restart=0;restart<2;restart++) {
      const link=new HttpServerLink(`${origin.origin}/mikka`,async(input,init)=>{
        const response=await fetch(input,init)
        receipts.push({requestId:randomUUID(),method:init?.method??'GET',path:new URL(input instanceof Request?input.url:String(input)).pathname,status:response.status,utc:new Date().toISOString(),probe:`daemon-restart-${restart+1}`})
        return response
      })
      let daemon
      try {
        daemon=await new Daemon({dataDir:stateDir,flavor:'dev',link,credential:deviceToken,harnesses:[{harness:'mock',installed:true,version:'test'}],heartbeatMs:60000,commandsWaitSeconds:0,quotaSource:null}).start()
        assert.deepEqual(daemon.supervisor.activeRunIds(),[])
        assert.equal(daemon.supervisor.get(runId).leaseExpiresAt,undefined)
        assert.match(daemon.supervisor.get(runId).error,/current online policy/)
      } finally {await daemon?.stop()}
    }
  } finally {await rm(stateDir,{recursive:true,force:true})}
  const revoked=await owner.call(policy(w),'POST',{expectedVersion:2,document:{...doc(w),state:'revoked'}});assert.equal(revoked.status,201)
  assert.equal((await owner.call(policy(w))).body.blocked,'policyRevoked')
  assert.equal((await owner.call('/api/agent','POST',{prompt:'Synthetic revocation probe.'})).body.error,'policyRevoked')
  const rollback=await owner.call(policy(w),'POST',{expectedVersion:3,rollbackOf:1});assert.equal(rollback.status,201);assert.equal(rollback.body.payload.version,4)
  assert.equal(rollback.body.payload.hash,publish.body.payload.hash)
  // Real unavailable audit writer: publication must roll back in the actual HTTP process.
  await workspace.query(`CREATE FUNCTION policy_http_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event->>'action'='policy.published' THEN RAISE EXCEPTION 'synthetic unavailable writer'; END IF; RETURN NEW; END $$; CREATE TRIGGER policy_http_fail BEFORE INSERT ON security_audit_events FOR EACH ROW EXECUTE FUNCTION policy_http_fail()`)
  try{assert.equal((await owner.call(policy(w),'POST',{expectedVersion:4,document:doc(w)})).status,503)}finally{await workspace.query('DROP TRIGGER policy_http_fail ON security_audit_events; DROP FUNCTION policy_http_fail()')}
  assert.equal((await owner.call(policy(w))).body.signed.payload.version,4)
  await workspace.query('ALTER TABLE organization_policy_heads RENAME TO policy_http_unavailable')
  try{assert.equal((await owner.call(policy(w))).status,503);assert.equal((await owner.call('/api/agent','POST',{prompt:'Synthetic unavailable store probe.'})).status,503)}finally{await workspace.query('ALTER TABLE policy_http_unavailable RENAME TO organization_policy_heads')}
  if(runtime){await docker('stop','--timeout','10',name);await docker('start',name);await waitReady();assert.equal((await owner.call(policy(w))).body.signed.payload.version,4)}
  await workspace.query(`UPDATE mikka_workspace_members SET role='member' WHERE "workspaceId"=$1 AND "userId"=$2`,[w,userId])
  assert.equal((await owner.call(policy(w),'POST',{expectedVersion:4,document:doc(w)})).status,403)
  await workspace.query(`UPDATE mikka_workspace_members SET role='admin' WHERE "workspaceId"=$1 AND "userId"=$2`,[w,userId])
  if(process.env.POLICY_RECORD_VIDEO === '1') {
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']})
    const context=await browser.newContext({viewport:{width:1280,height:800},recordVideo:{dir:evidence,size:{width:1280,height:800}}})
    await context.addCookies([...owner.jar].map(([name,value])=>({name,value,url:origin.origin,httpOnly:true,sameSite:'Lax'})))
    const page=await context.newPage(), video=page.video()
    const response=await page.goto(new URL(`/mikka${policy(w)}`,origin).toString());assert.equal(response.status(),200)
    await page.waitForTimeout(1200)
    await context.setExtraHTTPHeaders({authorization:'Bearer synthetic-forbidden-policy-publisher'})
    const denied=await page.reload();assert.equal(denied.status(),401)
    await page.waitForTimeout(1200)
    await context.setExtraHTTPHeaders({})
    const restored=await page.reload();assert.equal(restored.status(),200)
    await page.waitForTimeout(1200)
    await context.close();await copyFile(await video.path(),`${evidence}/policy-http-raw.webm`)
  }
  const versions=(await workspace.query('SELECT workspace_id,version,actor_id,rollback_of,published_at FROM organization_policy_versions WHERE workspace_id=ANY($1::uuid[]) ORDER BY workspace_id,version',[[w,other]])).rows
  const events=(await workspace.query(`SELECT tenant,seq,event,hash FROM security_audit_events WHERE tenant=ANY($1::text[]) AND event->>'action' LIKE 'policy.%' ORDER BY tenant,seq`,[[w,other]])).rows
  await writeFile(`${evidence}/acceptance.json`,JSON.stringify({sha,results:"passed",utc:new Date().toISOString(),environment:'dedicated cloud Linux; compiled Next; separate loopback PG17 databases; synthetic sessions; no external provider keys',requests:receipts,oauthMcp,continuation,versions,events,limitations:['not deployed Preview or production acceptance','no real OAuth/provider/CLI allowed path','#215 reservation and verified managed worker transport remain unavailable']},null,2))
  console.log(JSON.stringify({sha,requests:receipts.length,results:'passed',video:process.env.POLICY_RECORD_VIDEO==='1',evidence}))
} catch (error) {
  await writeFile(`${evidence}/failed-attempt.json`,JSON.stringify({sha,utc:new Date().toISOString(),error:error instanceof Error?error.message:"acceptanceFailed",requests:receipts},null,2));
  throw error
} finally {
  await browser?.close();if(runtime)await docker('stop','--timeout','10',name).catch(()=>{})
  await app.end();await workspace.end()
}
