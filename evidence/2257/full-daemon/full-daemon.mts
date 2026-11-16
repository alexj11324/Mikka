import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { Pool } from 'pg'
import { isTerminalRunState } from '@mikka/protocol/run-state'
import { seedWorkspace } from '../../tests/support/workspace-admin-db'
import { acquireTestAccounts } from '../../scripts/test-accounts/session.mjs'
import { loadEnvironment } from '../../scripts/test-accounts/environment.mjs'
import { apiKeyWorkerDefinition } from '../../lib/agent-kit/worker'
import { pool, db } from '../../lib/db'
import { withTaskWorkspace } from '../../lib/task-workspace'
import { createIssueForUserInTransaction } from '../../lib/issue-create'
import { userActor } from '../../lib/activity-actor'
import { ensureDeviceRepository } from '../../lib/device-repositories'
import { acceptLocalRun } from '../../lib/run-admission-store'
import { queueFactoryTask } from '../../lib/factory/task-dispatch'
import { withProjectResourceLease } from '../../lib/project-resources/store'
import { addApiKey } from '../../lib/model-api-keys'
import { threadDeliveryView } from '../../lib/thread-delivery-queue'

const dir = process.env.E_CODEX_QA!, origin = process.env.BETTER_AUTH_URL!
const modelDir = process.env.E_MODEL_QA_DIR ?? dir
const gateDir = process.env.E_GATE_QA_DIR ?? modelDir
const model = 'SmolLM2-135M-Instruct-Q4_K_M'
const source = process.env.E_RUN_SOURCE
const native = process.env.E_DESKTOP_WINDOW === '1'
assert.equal(origin, 'https://127.0.0.1:3859')
const url = new URL(process.env.E2E_DATABASE_URL!)
assert.deepEqual([url.hostname,url.port,url.pathname],['127.0.0.1','15471','/mikka_e2e'])
const observer = new Pool({connectionString:url.href, max:2})
const trace = { revision:source, interface:native ? 'packaged-electron' : 'owner-http', success:false, checks:[] as unknown[], diagnostic:{} as Record<string,unknown> }
const write = () => writeFileSync(join(dir,'proof.json'),JSON.stringify(trace,null,2),{mode:0o600})
const record = (phase:string, fields:Record<string,unknown>={}) => {trace.checks.push({phase,at:new Date().toISOString(),...fields});write()}
const ident = () => randomUUID()
const hash = (text:string) => createHash('sha256').update(text).digest('hex')
const mark = (s:string) => 'E2262_QA_BEGIN '+s+' E2262_QA_END'
const cli = 'packages/daemon/bin/mikka.ts'
const daemonDir = process.env.E_DEVICE_DATA_DIR ?? join(dir,'daemon')
const program = process.env.E_DEVICE_LAUNCH ?? process.execPath
const launcherArgs = process.env.E_DEVICE_LAUNCH ? [process.execPath] : []
const cliArgs = [...launcherArgs,'--import','tsx',cli,'daemon']
const cliLog = openSync(join(dir,'daemon.log'),'a',0o600)
const daemonEnv = Object.fromEntries(['PATH','HOME','LANG','TERM','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','GIT_CONFIG_GLOBAL'].map(name=>[name,process.env[name]]))
Object.assign(daemonEnv,{MIKKA_TEST_MODE:'1',CI:'true',GIT_TERMINAL_PROMPT:'0',
  ...(process.env.E_DEVICE_GIT_CONFIG?{GIT_CONFIG_GLOBAL:process.env.E_DEVICE_GIT_CONFIG}:{}),
  ...(process.env.E_DEVICE_TRUST?{SSL_CERT_FILE:process.env.E_DEVICE_TRUST,NODE_EXTRA_CA_CERTS:process.env.E_DEVICE_TRUST}:{})})
let scope:any, daemon:ReturnType<typeof spawn>|undefined, owner:string, workspaceId:string, deviceId:string
let lastRun:string|undefined, tokenId:string|undefined, stage='start'
async function until<T>(test:()=>Promise<T>, name:string, seconds=75):Promise<NonNullable<T>> {
  stage=name
  const end=Date.now()+seconds*1000
  while (Date.now()<end) { const result=await test(); if(result) return result as NonNullable<T>; await wait(200) }
  throw Error(name)
}
async function rpc(account:any,action:string,args:unknown[]){const res=await account.request('/api/rpc',{method:'POST',headers:{'content-type':'application/json','x-mikka-rpc':'1','sec-fetch-site':'same-origin'},body:JSON.stringify({version:1,action,args})});assert.equal(res.status,200);const body=await res.json();assert.equal(body.ok,true);return body.result}
async function row(id:string) {return (await observer.query('select id,status,"sessionId","stopReason","deviceId","workspaceId","continuesRunId","lastReply",prompt from agent_runs where id=$1 and "userId"=$2',[id,owner])).rows[0]}
async function queued(requestId:string){return (await observer.query('select id,status,"sentRunId","claimMode" from thread_queued_messages where "requestId"=$1 and "userId"=$2 and "workspaceId"=$3',[requestId,owner,workspaceId])).rows[0]}
async function expectedStopped(runId:string, phase:string, seconds:number) {
  const final = await until(async () => {
    const run = await row(runId)
    return run && isTerminalRunState(run.status) && run
  }, phase, seconds)
  assert.equal(final.status, 'stopped')
  assert.ok(final.sessionId)
  return final
}
function failureMetadata(error:unknown) {
  const cause = error as {stack?:string, code?:string} | null
  const location = String(cause?.stack ?? '').match(/full-daemon\.mts:\d+:\d+/)?.[0]
  const code = /^[A-Z_0-9]{2,60}$/.test(cause?.code ?? '') ? cause?.code : undefined
  return { location, code }
}
// Read-only inspection of just this fixture's freshly created task. Stop through the
// normal Owner action; finals or delivery claims can commit during that action.
async function drainCase(issueId:string, rootRun:string) {
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    const { rows: attempts } = await observer.query(
      'SELECT id,status,"stopRequestedAt" FROM agent_runs WHERE "issueId"=$1 AND "workspaceId"=$2 AND "userId"=$3',
      [issueId, workspaceId, owner])
    const { rows: pending } = await observer.query(
      `SELECT id,status FROM thread_queued_messages WHERE "rootRunId"=$1 AND "workspaceId"=$2
       AND "userId"=$3 AND status IN ('queued','delivering')`, [rootRun, workspaceId, owner])
    if (attempts.every(run => isTerminalRunState(run.status)) && !pending.length) return
    for (const message of pending.filter(message => message.status === 'queued')) {
      const result = await rpc(scope.owner, 'agents.changeQueuedThreadReply', [
        { issueId, runId: rootRun, messageId: message.id, action: 'cancel' }])
      assert.ok(['cancelled','tooLate'].includes(result.status))
    }
    if (attempts.some(run => !isTerminalRunState(run.status) && !run.stopRequestedAt)) {
      try { await rpc(scope.owner, 'agents.stopRun', [rootRun]) }
      catch (error) {
        const active = await observer.query(
          'SELECT status FROM agent_runs WHERE "issueId"=$1 AND "workspaceId"=$2 AND "userId"=$3',
          [issueId,workspaceId,owner])
        if (active.rows.some(run => !isTerminalRunState(run.status))) throw error
      }
    }
    await wait(250)
  }
  throw Error('case_cleanup_timeout')
}
async function revokeDevice(id:string, afterDesktopSignOut:boolean) {
  const revoke = () => scope.owner.request('/api/device-tokens/'+id+'/revoke',{method:'POST'})
  let response=await revoke()
  if(afterDesktopSignOut && response.status===401) {
    await response.body?.cancel()
    await scope.owner.reauthenticate()
    record('same_lease_owner_reauthenticated')
    response=await revoke()
  }
  if(response.status!==200) {
    record('device_revoke_rejected',{status:response.status})
    await response.body?.cancel()
    throw Error('device_revoke_rejected')
  }
  assert.equal((await response.json()).tokenId,id)
  record('device_credential_revoked')
}
async function fullWork(window?:any){
  const agents=(await observer.query('select id,harness from agents where "deviceId"=$1 and "userId"=$2',[deviceId,owner])).rows
  const remote='https://github.com/mikka-e2e/core-loop.git'
  const repo=await ensureDeviceRepository(owner,deviceId,remote)
  const keys:any={}
  for (const harness of ['codex','claude_code']) {
    const claude=harness==='claude_code'
    keys[harness]=await addApiKey(pool,owner,{provider:'custom',name:claude?'Isolated Anthropic CPU':'Isolated Responses CPU',baseUrl:'http://127.0.0.1:3860'+(claude?'':'/v1'),protocol:claude?'anthropic':'openai',apiKey:process.env.E_LOOPBACK_KEY!})
    assert.ok(keys[harness].models.includes(model));if(!claude)assert.ok(keys[harness].responsesApi)
  }
  record('both_authenticated_catalogues')
  if(window)record('packaged_application',{platform:window.platform})
  let failed = false
  for(const mode of ['steer','interrupt','queue','sendNow'] as const){
    const activeSteer=mode==='steer'||mode==='sendNow'
    const harness=activeSteer?'codex':'claude_code'
    const runId=ident()
    let issueId:string|undefined
    const release=()=>writeFileSync(join(gateDir,runId+'.release'),'',{mode:0o600})
    lastRun=runId
    stage=mode+'_admission'
    await scope.assertActive()
    try {
      const agent=agents.find(a=>a.harness===harness);assert.ok(agent)
      // The relay binds the frame to this run. Keep the original marked model instruction.
      const prompt='Case '+runId+'. '+mark(mode==='queue'?'The user wants the finished report delivered. Choose submit, not answer. The report should say which color a clear daytime sky is.':'List twenty vegetables with a sentence about each.')
      const follow=mark(mode==='interrupt'?'What color is a ripe banana? Answer in one short sentence.':'Name the capital of France in one short sentence.')
      const resultsFile = join(modelDir,activeSteer?'results.jsonl':'claude-results.jsonl')
      const initialResults = existsSync(resultsFile) ? readFileSync(resultsFile,'utf8').length : 0
      const caseOutputs = () => readFileSync(resultsFile,'utf8').slice(initialResults).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))
      const issue=await withTaskWorkspace(owner,workspaceId,()=>db.transaction(tx=>createIssueForUserInTransaction(tx,owner,{title:'Isolated live '+mode,content:{type:'doc',content:[]},priority:'normal',status:'todo'},userActor(owner),{workspaceId})))
      assert.ok(issue?.id);issueId=issue.id
      const definition=apiKeyWorkerDefinition({schemaVersion:1,kind:'worker',harness,instructions:'Answer only the synthetic test request.',definitionDigest:hash(prompt),promptDigest:hash(prompt),model,modelSource:'native-default',parent:null,readOnly:true} as never,prompt,{keyId:keys[harness].id,model})
      const input={id:runId,userId:owner,issueId,agentId:agent.id,deviceId,deviceRepoId:repo.id,botId:null,origin:'web' as const,prompt,promptTaskStart:0,promptTaskLength:[...prompt].length,definition,dispatch:{issueId,agentId:agent.id,deviceRepoId:repo.id,requestKey:ident()}}
      writeFileSync(join(gateDir,'current-gate.json'),JSON.stringify({id:runId,marker:prompt}),{mode:0o600})
      if(mode==='interrupt')await withProjectResourceLease(owner,workspaceId,()=>queueFactoryTask(pool,owner,{issueId,botId:null,agentId:agent.id,deviceRepoId:repo.id,note:prompt,key:ident(),queue:(tx,userId,_request,botId,context)=>acceptLocalRun({...input,userId,botId,factoryContext:context},tx)}));else await acceptLocalRun(input)
      record('ordinary_run_admitted',{mode,harness,runId,issueId,deviceId})
      await until(async()=>existsSync(join(gateDir,runId+'.observed'))&&((await row(runId))?.status==='running'),mode+'_genuine_first_frame',95)
      const modes=await threadDeliveryView(pool,owner,runId,runId);assert.ok(modes.modes.includes(activeSteer?'steer':mode));assert.equal(modes.modes.includes('steer'),harness==='codex')
      const grant=(await observer.query('select harness,model,"sourceKind" from model_gateway_tokens where "runId"=$1 and "ownerId"=$2 and "workspaceId"=$3 and "keyId"=$4',[runId,owner,workspaceId,keys[harness].id])).rows
      assert.ok(grant.some(g=>g.harness===harness&&g.model===model&&g.sourceKind==='api_key'))
      const target={issueId,runId,ownerId:owner,workspaceId,harness}
      const send=async(account:any,delivery:string,text:string,requestId:string)=>rpc(account,'agents.sendIssueThreadReply',[{issueId,runId,expectedOwnerId:account.userId,expectedWorkspaceId:workspaceId,text,delivery,requestId}])
      const ui=window?await window.openThread(target):{submit:async(delivery:string,text:string)=>{const id=ident();const sent=await send(scope.owner,delivery,text,id);assert.equal(sent.runId,runId);return id},changeQueued:async(text:string,action:string)=>{const queue=(await threadDeliveryView(pool,owner,runId,runId)).queued;const message=queue.find(m=>m.text===text);assert.ok(message);const result=await rpc(scope.owner,'agents.changeQueuedThreadReply',[{issueId,runId,messageId:message.id,action}]);assert.ok(['cancelled','sent'].includes(result.status));return message.id}}
      const refused=await send(scope.peer,mode==='sendNow'?'steer':mode,follow,ident());assert.ok(refused.error)
      record('live_turn_before_owner_action',{runId,harness,modes:modes.modes,peerDenied:true,runBoundGrant:true,firstFrame:JSON.parse(readFileSync(join(gateDir,runId+'.observed'),'utf8'))})
      stage=mode+'_desktop_or_http_writer'
      if(window&&mode==='steer')await ui.expectDefaultQueue()
      const cancelText='Remove this synthetic queued note.'
      const cancelId=await ui.submit('queue',cancelText);if(window)await ui.expectQueued(cancelText)
      await ui.changeQueued(cancelText,'cancel');assert.equal((await queued(cancelId)).status,'cancelled');if(window)await ui.expectNoPendingRow(cancelText)
      const heldText=mark('Do not deliver this earlier question to a replacement.')
      let heldId
      if(mode==='interrupt'){heldId=await ui.submit('queue',heldText);assert.equal((await queued(heldId)).status,'queued')}
      const sendId=await ui.submit(mode==='sendNow'?'queue':mode,follow)
      if(mode==='sendNow'){const pending=await queued(sendId);assert.equal(pending.status,'queued');if(window)await ui.expectQueued(follow);const id=await ui.changeQueued(follow,'sendNow');assert.equal(id,pending.id);const posted=await queued(sendId);assert.deepEqual([posted.status,posted.claimMode,posted.sentRunId],['sent','steer',runId])}
      if(mode==='queue')assert.equal((await queued(sendId)).status,'queued')
      if(activeSteer){
        // Steer acknowledgement is written only after the assigned native CLI accepts the new input.
        const stored=await until(async()=>{const r=await observer.query('select id,"deliveredAt",failure from run_messages where "runId"=$1 and text=$2',[runId,follow]);return r.rows.find(m=>m.deliveredAt&&!m.failure)},'native_steer_ack',25)
        record('native_steer_ack',{mode,runId,messageId:stored.id,at:stored.deliveredAt})
      }
      release()
      if(activeSteer){
        const final=await expectedStopped(runId, 'codex_terminal_result', 75)
        const results=caseOutputs();
        const matches=results.findLast(s=>mark(s.prompt)===follow&&s.outputTokens>0&&final.lastReply?.includes(s.result));assert.ok(matches)
        record('steer_terminal_readback',{mode,runId,deviceId,sessionId:final.sessionId,status:final.status,outputSha256:hash(matches.result)})
      }else{
        const next=await until(async()=>{const rows=(await observer.query('select id from agent_runs where "continuesRunId"=$1 and "workspaceId"=$2 and "userId"=$3',[runId,workspaceId,owner])).rows;assert.ok(rows.length<=1);return rows[0]?.id},mode+'_child_admission',90)
        const child=await expectedStopped(next, mode+'_child_native_result', 90)
        const prior=await row(runId);assert.equal(prior.deviceId,deviceId);assert.equal(child.deviceId,deviceId);assert.ok(child.prompt.includes(follow));assert.ok(child.lastReply)
        const actual=caseOutputs().findLast(s=>mark(s.prompt)===follow&&s.output_tokens>0&&child.lastReply.includes(s.output));assert.ok(actual)
        if(mode==='queue'){const q=await queued(sendId);assert.deepEqual([q.status,q.claimMode,q.sentRunId],['sent','afterRun',next]);assert.equal(prior.status,'succeeded')}
        if(mode==='interrupt'){const q=await queued(heldId);assert.equal(q.status,'failed');assert.equal(q.sentRunId,null);assert.ok(!child.prompt.includes(heldText));assert.equal(prior.status,'cancelled')}
        record('terminal_and_native_continuation_readback',{mode,runId,childId:next,deviceId,sessionId:child.sessionId,prior:prior.status,status:child.status,outputSha256:hash(actual.output)})
      }
      record('case_passed',{mode,harness,runId,issueId})
    } catch (error) {
      failed = true
      const failedStage = stage
      const failedRun = await row(runId).catch(() => null)
      record('case_failed',{mode,harness,runId,issueId,stage:failedStage,
        ...failureMetadata(error),state:failedRun?.status,reason:failedRun?.stopReason,
        sessionPresent:Boolean(failedRun?.sessionId)})
      release()
      if (issueId) {
        try { await drainCase(issueId,runId) }
        catch (cleanupError) {
          record('case_cleanup_failed',{mode,harness,runId,issueId,...failureMetadata(cleanupError)})
          throw cleanupError
        }
      }
    } finally { release() }
  }
  if (failed) process.exitCode=1
}
try {
  const environment=await loadEnvironment();assert.equal(environment.deploymentSha,source)
  const pg=(await observer.query('show server_version_num')).rows[0].server_version_num;assert.match(pg,/^17/)
  scope=await acquireTestAccounts({database:observer,environment,runId:'e2257-'+ident(),workerId:'full-daemon',requestId:ident(),ttlMs:300000,stateDirectory:join(dir,'lease')})
  owner=scope.owner.userId;assert.notEqual(owner,scope.peer.userId)
  const ws=await seedWorkspace(observer,owner,[{userId:owner,role:'admin'},{userId:scope.peer.userId,role:'member'}]);workspaceId=ws.id
  for(const account of [scope.owner,scope.peer]){await rpc(account,'workspace.switchWorkspace',[workspaceId]);const boot=await(await account.request('/api/workspace')).json();assert.deepEqual([boot.workspace.id,boot.currentUserId],[workspaceId,account.userId])}
  record('isolated_target_and_two_active_accounts',{workspaceId,pg,environmentId:environment.id,lease:scope.lease.id})
  stage='official_registration_login'
  const enrolled=await scope.owner.request('/api/devices/enrollment',{method:'POST'});assert.equal(enrolled.status,200)
  const {token}=await enrolled.json();assert.ok(token)
  const common=['--server',origin+'/mikka','--data-dir',daemonDir]
  const login=spawn(program,[...cliArgs,'login','--registration-token-stdin','--workspace',workspaceId,...common],{env:daemonEnv,stdio:['pipe',cliLog,cliLog]});const logged=once(login,'exit');login.stdin.end(token);assert.equal((await logged)[0],0)
  const found=await(await scope.owner.request('/api/device-tokens')).json();assert.equal(found.tokens.length,1);tokenId=found.tokens[0].id
  daemon=spawn(program,[...cliArgs,...common,'--no-auto-update','--retain-resources'],{env:daemonEnv,stdio:['ignore',cliLog,cliLog]})
  const device=await until(async()=>{const owned=await(await scope.owner.request('/api/devices/enrollment')).json();assert.equal(owned.ownerId,owner);assert.ok(owned.deviceIds.length<=1);const id=owned.deviceIds[0];if(!id)return;const listed=await rpc(scope.owner,'agents.pollDevices',[]);return listed.devices.find((d:any)=>d.id===id&&d.online)},'official_daemon_registered')
  deviceId=device.id
  const daemonReport=(await observer.query('select harnesses from devices where id=$1 and "ownerId"=$2',[deviceId,owner])).rows[0].harnesses
  const versions=Object.fromEntries(daemonReport.filter((r:any)=>['codex','claude_code'].includes(r.harness)&&r.installed).map((r:any)=>[r.harness,r.version]));assert.deepEqual(versions,{codex:'0.163.0',claude_code:'2.1.309'})
  record('one_registered_full_device_with_pinned_harnesses',{deviceId,versions,registration:'one-use HTTPS enrollment'})
  if(native){const {withPackagedDeliveryWindow}=await import('../../apps/desktop/test/self-hosted-delivery.mjs');await withPackagedDeliveryWindow({scope,authorityCertificate:join(dir,'ephemeral-ca.pem'),workspaceDirectory:dir},fullWork)}else await fullWork()
  trace.success=process.exitCode !== 1
}catch(error){const location=String(error?.stack??'').match(/full-daemon\.mts:\d+:\d+/)?.[0];const named=String(error?.code??'');trace.diagnostic={stage,location,code:/^[A-Z_0-9]{2,60}$/.test(named)?named:undefined};if(lastRun){const run=await row(lastRun).catch(()=>null);if(run)Object.assign(trace.diagnostic,{run:lastRun,state:run.status,reason:run.stopReason,sessionPresent:Boolean(run.sessionId),tokens:(await observer.query('select count(*)::int as n from model_gateway_tokens where "runId"=$1',[lastRun])).rows[0].n})};process.exitCode=1}
finally{
  // Never skip the lease release because a different cleanup action failed.
  async function clean(step:string, action:()=>Promise<void>) {
    try { await action() }
    catch (error) {
      record('cleanup_failed',{step,...failureMetadata(error)})
      process.exitCode=1;trace.success=false
    }
  }
  await clean('daemon_process', async()=>{
    if(!daemon?.pid || daemon.exitCode!==null || daemon.signalCode!==null)return
    const end=once(daemon,'exit')
    daemon.kill('SIGTERM')
    const timer=setTimeout(()=>daemon?.kill('SIGKILL'),8000)
    try { await end } finally { clearTimeout(timer) }
  })
  await clean('device_credential',async()=>{
    if(tokenId) await revokeDevice(tokenId,native)
  })
  await clean('account_lease',async()=>{
    if(!scope)return
    const result=await scope.release({outcome:'dirty'})
    record('lease_closed',{state:result.state})
  })
  closeSync(cliLog);write();await observer.end();const {workspacePool}=await import('../../lib/workspace-db');await Promise.all([pool.end(),workspacePool.end()]);const {builtinGateway}=await import('../../lib/builtin-gateway/runtime');await builtinGateway()?.stop()
}
