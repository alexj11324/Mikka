import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {spawn,execFileSync} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp,writeFile,readFile} from 'node:fs/promises'
import {appendFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import test from 'node:test'
import {Pool} from 'pg'
import {QuotaStore} from '../lib/quota/store.ts'
const target=process.env.QUOTA_TEST_DATABASE_URL
if(target){const u=new URL(target);assert.ok(['localhost','127.0.0.1','[::1]'].includes(u.hostname));assert.match(u.pathname,/(?:_e2e|_quota215)$/)}
test('actual HTTP claim SQL fault rolls back activation and permits one safe retry',{skip:!target,timeout:180000},async t=>{
 const pool=new Pool({connectionString:target,max:5}),dir=await mkdtemp(join(tmpdir(),'mikka-claim-fault-'))
 const network=join(dir,'network.jsonl'),log=join(dir,'next.log');await writeFile(network,'');await writeFile(log,'')
 const owner=randomUUID(),workspace=randomUUID(),device=randomUUID(),agent=randomUUID(),repo=randomUUID(),issue=randomUUID(),run=randomUUID(),token=randomUUID()
 const evidence={sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),utc:new Date().toISOString(),environment:'http://localhost:3216/mikka',mode:process.env.QUOTA_TEST_SERVER_MODE??'production',owner,workspace,run,responses:[],runtimeLog:log}
 const args=['node_modules/next/dist/bin/next',...(process.env.QUOTA_TEST_SERVER_MODE==='dev'?['dev','--webpack']:['start']),'--port','3216']
 const child=spawn(process.execPath,args,{cwd:new URL('..',import.meta.url),env:{...process.env,MIKKA_DATABASE_URL:target,DATABASE_URL:target,BETTER_AUTH_URL:'http://localhost:3216',OPENCODE_API_KEY:'',AI_GATEWAY_API_KEY:'',COMPOSIO_API_KEY:'',NEXT_TELEMETRY_DISABLED:'1',NODE_OPTIONS:`--import=${new URL('./fixtures/quota-http-preload.mjs',import.meta.url).pathname}`,QUOTA_NETWORK_EVIDENCE:network},stdio:['ignore','pipe','pipe']})
 child.stdout.on('data',d=>appendFileSync(log,d));child.stderr.on('data',d=>appendFileSync(log,d))
 let cleanupPromise
 const cleanup=()=>cleanupPromise??=(async()=>{if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGTERM');await exit}evidence.blockedNetworkAttempts=(await readFile(network,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));await writeFile('quota-claim-fault-evidence.json',JSON.stringify(evidence,null,2));await pool.end()})()
 t.after(cleanup)
 try{
  let ready=false
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error('Claim test server exited');try{const r=await fetch('http://localhost:3216/mikka/api/agent',{method:'HEAD',signal:AbortSignal.timeout(2000)});if(r.status===401){ready=true;break}}catch{}await delay(100)}
  assert.ok(ready)
  await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,'Synthetic claim owner',$2,true,now(),now())`,[owner,`${owner}@example.invalid`])
  await pool.query(`INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,'Synthetic claim workspace')`,[workspace,owner])
  await pool.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,'Synthetic claim owner',$3,'admin','active')`,[workspace,owner,`${owner}@example.invalid`])
  const resources={'daemon.run':{units:1,unknownCostApproved:true}}
  await pool.query(`INSERT INTO quota_allocations(workspace_id,max_budget_units,max_concurrency,max_rate_limit,rate_window_seconds,resources,expires_at,granted_by,reason) VALUES($1,10,1,100,60,$2,now()+interval '1 hour','test-operator','synthetic claim fault')`,[workspace,resources])
  await pool.query(`INSERT INTO quota_tenants(workspace_id,window_start,window_end,budget_units,concurrency_limit,rate_limit,rate_window_seconds,resources) VALUES($1,now()-interval '1 minute',now()+interval '30 minutes',10,1,100,60,$2)`,[workspace,resources])
  await pool.query('INSERT INTO quota_owners(owner_id,workspace_id) VALUES($1,$2)',[owner,workspace])
  await pool.query('INSERT INTO device_tokens(id,"userId","tokenHash") VALUES($1,$2,$3)',[randomUUID(),owner,createHash('sha256').update(token).digest('hex')])
  await pool.query(`INSERT INTO devices(id,"ownerId",name,platform,arch,"daemonVersion") VALUES($1,$2,'synthetic fault device','linux','x64','0.0.1')`,[device,owner])
  await pool.query(`INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,'synthetic fault agent','codex',$3)`,[agent,owner,device])
  await pool.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath","baseBranch") VALUES($1,$2,$3,'/synthetic-no-execution','main')`,[repo,device,owner])
  await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority) VALUES($1,$2,'synthetic claim fault','{}','todo','normal')`,[issue,owner])
  await pool.query(`INSERT INTO agent_runs(id,"userId","agentId","deviceId","deviceRepoId","issueId",status) VALUES($1,$2,$3,$4,$5,$6,'queued')`,[run,owner,agent,device,repo,issue])
  await pool.query('CREATE TABLE IF NOT EXISTS quota_claim_test_faults(run_id uuid PRIMARY KEY,enabled boolean NOT NULL)')
  await pool.query('INSERT INTO quota_claim_test_faults VALUES($1,true)',[run])
  const suffix=randomUUID().replaceAll('-',''),functionName=`quota_claim_fault_${suffix}`
  await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='preparing' AND EXISTS(SELECT 1 FROM quota_claim_test_faults WHERE run_id=NEW.id AND enabled) THEN RAISE EXCEPTION 'synthetic claim CAS fault'; END IF; RETURN NEW; END $$`)
  await pool.query(`CREATE TRIGGER ${functionName} BEFORE UPDATE ON agent_runs FOR EACH ROW EXECUTE FUNCTION ${functionName}()`)
  const snapshot=async()=>({reservations:(await pool.query('SELECT id,state,request_key,units,settled_units,expires_at FROM quota_reservations WHERE owner_id=$1 ORDER BY created_at',[owner])).rows,run:(await pool.query('SELECT status,"quotaReservationId","startedAt","leaseExpiresAt" FROM agent_runs WHERE id=$1',[run])).rows[0],quota:(await pool.query('SELECT id,state,units,settled_units,expires_at FROM quota_reservations WHERE owner_id=$1 AND request_key=$2',[owner,`daemon:${run}`])).rows[0]})
  const claim=async()=>{const response=await fetch(`http://localhost:3216/mikka/v1/devices/${device}/runs/${run}/claim`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(30000)});let body;try{body=await response.json()}catch{body={error:'non-JSON server failure'}}const result={status:response.status,hasPayload:typeof body.prompt==='string',error:body.error};evidence.responses.push(result);return result}
  const failed=await claim();evidence.afterFault=await snapshot()
  await pool.query('UPDATE quota_claim_test_faults SET enabled=false WHERE run_id=$1',[run])
  // Model the persisted orphan from the older two-transaction claim version.
  // New claims roll the reservation back too; legacy state must also recover.
  const oldStore=new QuotaStore(pool,async(user,ws)=>Boolean((await pool.query(`SELECT 1 FROM mikka_workspace_members WHERE "userId"=$1 AND "workspaceId"=$2 AND status='active'`,[user,ws])).rowCount))
  const legacy=await oldStore.reserve({ownerId:owner,key:`daemon:${run}`,resource:'daemon.run',binding:{runId:run,issueId:issue,agentId:agent,repoId:repo}})
  evidence.legacyReservation=legacy.id
  await pool.query("UPDATE quota_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE owner_id=$1",[owner])
  evidence.beforeDelayedRetry=await snapshot()
  await pool.query('UPDATE agent_runs SET "startedAt"=clock_timestamp() WHERE id=$1',[run])
  const ambiguous=await claim();evidence.afterUnsafeHistory=await snapshot()
  assert.equal(ambiguous.status,409);assert.equal(ambiguous.error,'quotaUnsentProofFailed')
  assert.equal(evidence.afterUnsafeHistory.reservations.length,1)
  // Restore only the synthetic fixture after proving ambiguous history fails.
  await pool.query('UPDATE agent_runs SET "startedAt"=NULL WHERE id=$1',[run])
  const retried=await claim();evidence.afterRetry=await snapshot()
  if(retried.status!==200){await pool.query("UPDATE quota_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE owner_id=$1",[owner]);await claim();evidence.afterExpiredRetry=await snapshot()}
  assert.equal(failed.status,503);assert.equal(failed.hasPayload,false)
  assert.equal(evidence.afterFault.run.status,'queued');assert.equal(evidence.afterFault.run.quotaReservationId,null);assert.equal(evidence.afterFault.quota,undefined);assert.equal(evidence.afterFault.reservations.length,0)
  assert.equal(evidence.afterFault.run.startedAt,null);assert.equal(evidence.afterFault.run.leaseExpiresAt,null)
  assert.equal(retried.status,200);assert.equal(retried.hasPayload,true);assert.notEqual(evidence.afterRetry.run.quotaReservationId,legacy.id)
  assert.equal(evidence.afterRetry.quota.state,'refunded');assert.equal(evidence.afterRetry.quota.settled_units,'0')
  assert.equal(evidence.afterRetry.reservations.length,2)
  const bound=evidence.afterRetry.reservations.find(r=>r.id===evidence.afterRetry.run.quotaReservationId)
  assert.equal(bound.state,'executing');assert.equal(bound.request_key,`quota-unsent:${legacy.id}`)
  assert.equal(bound.expires_at.getTime(),evidence.afterRetry.run.leaseExpiresAt.getTime())
  assert.equal((await claim()).status,409)
 }finally{await cleanup()}
})
