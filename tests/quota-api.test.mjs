import assert from 'node:assert/strict'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'

const target=process.env.QUOTA_TEST_DATABASE_URL
if(target){
  const url=new URL(target)
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname))
  assert.match(url.pathname,/(?:_e2e|_quota215)$/)
}

test('actual Next HTTP Agent, Coordinator, administrator and daemon quota gates', {skip:!target,timeout:120000},async t=>{
  const pool=new Pool({connectionString:target,max:15})
  const directory=await mkdtemp(join(tmpdir(),'mikka-quota-http-'))
  const network=join(directory,'external-attempts.jsonl');await writeFile(network,'')
  const secret=process.env.BETTER_AUTH_SECRET
  assert.ok(secret?.length>=32,'Ephemeral auth secret required')
  const origin='http://localhost:3215',base=`${origin}/mikka`
  const results=[]
  const evidence={utc:new Date().toISOString(),sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),environment:base,fixtures:[],requests:[],migration:'20261025165100_tenant_quotas.sql',results}
  let log=''
  const child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--port','3215'],{cwd:new URL('..',import.meta.url),env:{...process.env,
    MIKKA_DATABASE_URL:target,DATABASE_URL:target,BETTER_AUTH_URL:origin,
    // Synthetic non-secrets. The egress sentinel rejects external requests.
    OPENCODE_API_KEY:'synthetic-quota-test-no-provider-access',AI_GATEWAY_API_KEY:'synthetic-quota-test-no-provider-access',
    QUOTA_NETWORK_EVIDENCE:network,NODE_OPTIONS:`${process.env.NODE_OPTIONS??''} --import=${new URL('./fixtures/quota-network-guard.mjs',import.meta.url).pathname}`,
  },stdio:['ignore','pipe','pipe']})
  child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d)
  try{
    let ready=false
    for(let i=0;i<120;i++){
      if(child.exitCode!==null)throw new Error(`Next exited: ${log}`)
      try{await fetch(`${base}/api/agent`,{method:'HEAD'});ready=true;break}catch{}
      await delay(250)
    }
    assert.ok(ready,'Next must start')
    const fixture=async()=>{
      const owner=randomUUID(),workspace=randomUUID(),token=randomUUID()
      await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Quota test',$2,true,now(),now())`,[owner,`${owner}@example.invalid`])
      await pool.query(`INSERT INTO session(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES ($1,$2,$3,now()+interval '1 hour',now(),now())`,[randomUUID(),token,owner])
      await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES ($1,$2,\'Quota isolated workspace\')',[workspace,owner])
      await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES ($1,$2,\'Quota test\',$3,\'admin\',\'active\')',[workspace,owner,`${owner}@example.invalid`])
      const signature=createHmac('sha256',secret).update(token).digest('base64')
      const headers={cookie:`better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,origin,'content-type':'application/json'}
      evidence.fixtures.push({owner,workspace})
      const request=async(path,body,method='POST')=>{
        const response=await fetch(`${base}${path}`,{method:method==='PUT'?'PUT':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)})
        evidence.requests.push({owner,workspace,path,method,status:response.status,utc:new Date().toISOString()})
        return response
      }
      const policy={windowStart:new Date(Date.now()-60000).toISOString(),windowEnd:new Date(Date.now()+3600000).toISOString(),budgetUnits:0,concurrencyLimit:1,rateLimit:100,rateWindowSeconds:60,
        resources:{'agent.turn':{units:1,unknownCostApproved:true},'coordinator.submit':{units:1,unknownCostApproved:true},'coordinator.model':{units:1,unknownCostApproved:true},'daemon.run':{units:1,unknownCostApproved:true}},paused:false,owners:[owner],override:null}
      await pool.query(`INSERT INTO quota_allocations(workspace_id,max_budget_units,max_concurrency,max_rate_limit,rate_window_seconds,resources,expires_at,granted_by,reason)
        VALUES ($1,100,100,1000,60,$2,now()+interval '2 hours','test-operator','isolated synthetic allocation')`,[workspace,policy.resources])
      const configure=changes=>request(`/api/workspaces/${workspace}/quota`,{...policy,...changes},'PUT')
      const configured=await configure({});assert.equal(configured.status,200,await configured.text())
      return{owner,workspace,request,configure,policy,headers}
    }
    const check=async(name,action)=>{
      await t.test(name,async()=>{try{await action();results.push({name,result:'passed',utc:new Date().toISOString()})}catch(error){results.push({name,result:'failed',message:String(error.message).slice(0,500),utc:new Date().toISOString()});throw error}})
    }
    await check('ordinary Agent 10-way budget denial returns 429 and leaves no running turns',async()=>{
      const f=await fixture()
      const responses=await Promise.all(Array.from({length:10},()=>f.request('/api/agent',{prompt:'isolated quota admission',sessionId:randomUUID(),turnId:randomUUID()})))
      for(const response of responses){assert.equal(response.status,429);assert.ok(Number(response.headers.get('retry-after'))>0);assert.equal((await response.json()).error,'quotaBudgetExhausted')}
      assert.equal(Number((await pool.query("SELECT count(*) n FROM agent_turns WHERE \"userId\"=$1 AND status='pending'",[f.owner])).rows[0].n),0)
      assert.equal(Number((await pool.query('SELECT count(*) n FROM quota_reservations WHERE owner_id=$1',[f.owner])).rows[0].n),0)
    })
    await check('Coordinator HTTP admission rejects before enqueue',async()=>{
      const f=await fixture(),r=await f.request('/api/coordinator/messages',{text:'isolated quota test'})
      assert.equal(r.status,429);assert.equal((await r.json()).error,'quotaBudgetExhausted')
      assert.equal(Number((await pool.query('SELECT count(*) n FROM coordinator_events WHERE "userId"=$1',[f.owner])).rows[0].n),0)
    })
    await check('actual durable Coordinator model fails closed at its provider boundary',async()=>{
      const f=await fixture()
      await pool.query(`UPDATE quota_allocations SET resources=jsonb_set(resources,'{coordinator.submit,units}','0') WHERE workspace_id=$1`,[f.workspace])
      assert.equal((await f.configure({resources:{...f.policy.resources,'coordinator.submit':{units:0,unknownCostApproved:true}}})).status,200)
      const response=await f.request('/api/coordinator/messages',{text:'isolated model gate test'})
      assert.equal(response.status,202)
      let error
      for(let i=0;i<120;i++){
        error=(await pool.query('SELECT "lastError" FROM coordinator_sessions WHERE "userId"=$1',[f.owner])).rows[0]?.lastError
        if(error)break
        await delay(250)
      }
      assert.match(error??'',/quotaBudgetExhausted/)
    })
    await check('expired override, suspended membership, foreign workspace and non-admin cannot enable execution',async()=>{
      const f=await fixture()
      assert.equal((await f.configure({override:{units:5,until:new Date(Date.now()-1000).toISOString(),reason:'expired test'}})).status,400)
      assert.equal((await f.configure({budgetUnits:101})).status,403)
      assert.equal((await f.configure({resources:{'unapproved.resource':{units:0,unknownCostApproved:true}}})).status,403)
      const other=await fixture()
      assert.equal((await f.request(`/api/workspaces/${other.workspace}/quota`,f.policy,'PUT')).status,403)
      await pool.query('UPDATE mikka_workspace_members SET role=\'member\' WHERE "workspaceId"=$1 AND "userId"=$2',[f.workspace,f.owner])
      assert.equal((await f.configure({budgetUnits:5})).status,403)
      await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2',[f.workspace,f.owner])
      const response=await f.request('/api/agent',{prompt:'revoked quota test'})
      assert.equal(response.status,403);assert.equal((await response.json()).error,'quotaAccessDenied')
    })
    await check('daemon 10-way claims share concurrency; replay never returns another execution payload',async()=>{
      const f=await fixture();assert.equal((await f.configure({budgetUnits:10})).status,200)
      const device=randomUUID(),agent=randomUUID(),repo=randomUUID(),issue=randomUUID(),deviceToken=randomUUID()
      await pool.query('INSERT INTO device_tokens(id,"userId","tokenHash") VALUES ($1,$2,$3)',[randomUUID(),f.owner,createHash('sha256').update(deviceToken).digest('hex')])
      await pool.query(`INSERT INTO devices(id,"ownerId",name,platform,arch,"daemonVersion") VALUES ($1,$2,'quota synthetic device','linux','x64','0.0.1')`,[device,f.owner])
      await pool.query(`INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES ($1,$2,'quota agent','codex',$3)`,[agent,f.owner,device])
      await pool.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath","baseBranch") VALUES ($1,$2,$3,'/quota-no-execution','main')`,[repo,device,f.owner])
      await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority) VALUES ($1,$2,'quota issue','{}','todo','normal')`,[issue,f.owner])
      const runs=Array.from({length:10},()=>randomUUID())
      for(const run of runs)await pool.query(`INSERT INTO agent_runs(id,"userId","agentId","deviceId","deviceRepoId","issueId",status) VALUES ($1,$2,$3,$4,$5,$6,'queued')`,[run,f.owner,agent,device,repo,issue])
      const daemon=async(path,body)=>{
        const response=await fetch(`${base}${path}`,{method:'POST',headers:{authorization:`Bearer ${deviceToken}`,'content-type':'application/json'},body:JSON.stringify(body??{})})
        evidence.requests.push({owner:f.owner,workspace:f.workspace,path,method:'POST',status:response.status,utc:new Date().toISOString()})
        return response
      }
      const responses=await Promise.all(runs.map(run=>daemon(`/v1/devices/${device}/runs/${run}/claim`)))
      assert.equal(responses.filter(r=>r.status===200).length,1)
      assert.equal(responses.filter(r=>r.status===429).length,9)
      const winner=await responses.find(r=>r.status===200).json()
      const duplicate=await daemon(`/v1/devices/${device}/runs/${winner.runId}/claim`)
      assert.equal(duplicate.status,409)
      assert.equal(Number((await pool.query("SELECT count(*) n FROM agent_runs WHERE \"userId\"=$1 AND status='preparing'",[f.owner])).rows[0].n),1)
      // No daemon process is launched and no harness/provider is invoked.
      const quotaId=(await pool.query('SELECT "quotaReservationId" FROM agent_runs WHERE id=$1',[winner.runId])).rows[0].quotaReservationId
      const completed=await daemon(`/v1/runs/${winner.runId}/complete`,{stopReason:'cancelled'})
      assert.equal(completed.status,204,await completed.text())
      assert.equal((await daemon(`/v1/runs/${winner.runId}/complete`,{stopReason:'cancelled'})).status,204)
      assert.equal((await pool.query('SELECT settled_units FROM quota_reservations WHERE id=$1',[quotaId])).rows[0].settled_units,'1')
      const next=runs.find(id=>id!==winner.runId)
      assert.equal((await daemon(`/v1/devices/${device}/runs/${next}/claim`)).status,200)
      const leaseBefore=(await pool.query('SELECT "leaseExpiresAt" FROM agent_runs WHERE id=$1',[next])).rows[0].leaseExpiresAt.toISOString()
      await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`,[f.workspace,f.owner])
      const heartbeat=await daemon(`/v1/devices/${device}/heartbeat`,{harnesses:[],runs:[{runId:next,lastProgressAt:new Date().toISOString()}],worktreeDiskBytes:0})
      assert.equal(heartbeat.status,200)
      const heartbeatBody=await heartbeat.json();assert.deepEqual(heartbeatBody.leases,{});assert.ok(heartbeatBody.revoked.includes(next))
      assert.equal((await pool.query('SELECT "leaseExpiresAt" FROM agent_runs WHERE id=$1',[next])).rows[0].leaseExpiresAt.toISOString(),leaseBefore)

    })
    const external=await readFile(network,'utf8')
    assert.equal(external,'',`External provider calls were attempted: ${external}`)
    evidence.externalNetworkAttempts=0
    evidence.syntheticRecordsRetained=true
  }finally{
    const exit=once(child,'exit');child.kill('SIGTERM');await exit
    await writeFile(join(directory,'next-runtime.log'),log)
    evidence.runtimeLog=join(directory,'next-runtime.log')
    await writeFile('quota-api-evidence.json',JSON.stringify(evidence,null,2))
    await pool.end()
  }
})
