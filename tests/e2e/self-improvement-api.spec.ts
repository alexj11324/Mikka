import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { SKILL_ARTIFACT_HEADER, skillSlug } from '@mikka/protocol/skill'
import { verifySkillAssignment } from '../../packages/daemon/src/agents/skill-artifact'
import { createFactoryStore, type FactoryTask } from '../../lib/factory/store'
import { createFactoryDispatch } from '../../lib/factory/dispatch'
import { factoryDispatchDatabase } from '../../lib/factory/transaction'
import { insertRunOnce } from '../../lib/run-dispatch'
import { RunContext } from '../../packages/daemon/src/agents/run-context'
import { test,expect,register,app } from './fixtures'

// Actual built Next routes + cookie/device authentication + real PG/mount.
// Terminal report/session are explicitly synthetic; no CLI/model is invoked.
test('Skill baseline selection, actual claim receipt and feedback provenance use real authenticated routes',async({page,playwright,baseURL},info)=>{
  test.skip(process.env.CI!=='true'||process.env.GITHUB_ACTIONS!=='true','Disposable CI only')
  const target=new URL(process.env.E2E_DATABASE_URL!)
  expect(target.hostname).toBe('127.0.0.1');expect(target.pathname).toBe('/mikka_e2e')
  const {email}=await register(page),pool=new Pool({connectionString:target.toString(),max:2})
  const deviceId=randomUUID(),agentId=randomUUID(),repoId=randomUUID(),issueId=randomUUID(),runId=randomUUID()
  const deviceToken=`orv_${randomBytes(32).toString('base64url')}`
  const old=await playwright.request.newContext({baseURL,extraHTTPHeaders:{authorization:`Bearer ${deviceToken}`}})
  const supported=await playwright.request.newContext({baseURL,extraHTTPHeaders:{authorization:`Bearer ${deviceToken}`,[SKILL_ARTIFACT_HEADER]:'1'}})
  const origin=new URL(baseURL!).origin
  try {
    const userId=(await pool.query('SELECT id FROM "user" WHERE email=$1',[email])).rows[0].id
    await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority) VALUES($1,$2,'Synthetic Skill HTTP fixture','{}','todo','normal')`,[issueId,userId])
    await pool.query(`INSERT INTO devices(id,"ownerId",name,enabled) VALUES($1,$2,'Synthetic Skill HTTP device',true)`,[deviceId,userId])
    await pool.query(`INSERT INTO device_tokens(id,"userId","tokenHash") VALUES($1,$2,$3)`,[randomUUID(),userId,createHash('sha256').update(deviceToken).digest('hex')])
    await pool.query(`INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,'Synthetic Skill HTTP agent','codex',$3)`,[agentId,userId,deviceId])
    await pool.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath") VALUES($1,$2,$3,'/ci/skill-http')`,[repoId,deviceId,userId])
    async function queue(id:string,retryOf:string|null=null) {
      await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"retryOf") VALUES($1,$2,$3,$4,$5,$6,'queued',$7)`,[id,userId,issueId,agentId,deviceId,repoId,retryOf])
    }
    await queue(runId)
    const api=app('/api/self-improvement'),claim=app(`/v1/devices/${deviceId}/runs/${runId}/claim`)
    expect((await page.request.post(api,{headers:{origin},data:{action:'select_baseline',runId,sha256:'0'.repeat(64)}})).status()).toBe(422)
    expect((await page.request.post(api,{headers:{origin},data:{action:'select_baseline',runId}})).status()).toBe(200)
    expect((await old.post(claim)).status()).toBe(409)
    expect((await pool.query('SELECT status FROM agent_runs WHERE id=$1',[runId])).rows[0].status).toBe('queued')
    const claimed=await supported.post(claim);expect(claimed.status()).toBe(200)
    const assignment=await claimed.json();verifySkillAssignment(assignment)
    expect(assignment.skillReceipt.runId).toBe(runId)
    expect((await pool.query('SELECT receipt FROM improvement_skill_receipts WHERE "runId"=$1',[runId])).rows[0].receipt.id).toBe(assignment.skillReceipt.id)
    const receiptPath=app(`/v1/runs/${runId}/skill-receipt?receiptId=${assignment.skillReceipt.id}`)
    expect((await supported.get(receiptPath)).status()).toBe(200)
    expect((await old.get(receiptPath)).status()).toBe(409)
    const heartbeatPath=app(`/v1/devices/${deviceId}/heartbeat`)
    const heartbeat={harnesses:[],runs:[{runId,lastProgressAt:new Date().toISOString()}],worktreeDiskBytes:0}
    const oldHeartbeat=await old.post(heartbeatPath,{data:heartbeat})
    expect(oldHeartbeat.status()).toBe(200);expect((await oldHeartbeat.json()).revoked).toContain(runId)
    const renewed=await supported.post(heartbeatPath,{data:heartbeat})
    expect(renewed.status()).toBe(200);expect((await renewed.json()).leases[runId]).toBeTruthy()
    await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1',[runId])
    expect((await supported.get(receiptPath)).status()).toBe(409)
    const stopped=await supported.post(heartbeatPath,{data:heartbeat})
    expect(stopped.status()).toBe(200);expect((await stopped.json()).revoked).toContain(runId)
    // Clear only this synthetic fault-injection flag before the independent
    // feedback check. This is not a product cancellation/regrant operation.
    await pool.query('UPDATE agent_runs SET "stopRequestedAt"=NULL WHERE id=$1',[runId])
    const root=await mkdtemp(join(tmpdir(),'mikka-ci-skill-http-'))
    const context=new RunContext({harness:'codex',worktree:process.cwd(),runDir:join(root,'run'),privateDir:join(root,'private'),skills:assignment.skills,skillReceipt:assignment.skillReceipt})
    const bytes=await readFile(join(context.skillsDir,skillSlug(assignment.skills[0].name),'SKILL.md'))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(assignment.skillReceipt.artifact.sha256)
    expect((await supported.patch(app(`/v1/runs/${runId}`),{data:{state:'running',sessionId:'synthetic-http-session'}})).status()).toBe(204)
    // Avoid waking a paid Coordinator: terminal data below is a fixture, not
    // an actual Harness completion or independent verification.
    await pool.query(`UPDATE agent_runs SET status='failed',report='{"verify":{"status":"failed"}}',"finishedAt"=now() WHERE id=$1`,[runId])
    const feedback=await page.request.post(api,{headers:{origin},data:{action:'feedback',eventId:randomUUID(),runId,verdict:'negative',note:'untrusted synthetic feedback'}})
    expect(feedback.status()).toBe(200)
    const score=await feedback.json()
    expect(score.snapshot.skillUsage).toBe('assigned')
    expect(score.snapshot.skillReceipt.id).toBe(assignment.skillReceipt.id)
    expect(score.snapshot.usageClaim).toBe('server_prepared_assignment_not_execution')
    expect(score.snapshot.independentVerification).toBe(false)
    const legacyId=randomUUID();await queue(legacyId)
    expect((await old.post(app(`/v1/devices/${deviceId}/runs/${legacyId}/claim`))).status()).toBe(200)
    await pool.query(`UPDATE agent_runs SET status='failed',"sessionId"='synthetic-legacy',"finishedAt"=now(),report=$2 WHERE id=$1`,[legacyId,JSON.stringify({verify:{status:'failed'},skillReceipt:assignment.skillReceipt})])
    const legacy=await page.request.post(api,{headers:{origin},data:{action:'feedback',eventId:randomUUID(),runId:legacyId,verdict:'negative',note:''}})
    expect(legacy.status()).toBe(200);expect((await legacy.json()).snapshot.skillUsage).toBe('unrecorded')
    const factory=createFactoryStore(pool,async(u,i)=>u===userId&&i===issueId)
    const bind=(task:FactoryTask)=>({taskId:task.id,issueId,attemptId:task.attemptId,revision:task.revision,candidateId:task.candidateId})
    const dispatch=createFactoryDispatch(pool,factory,(tx,u,input)=>insertRunOnce(factoryDispatchDatabase(tx),u,input,{deviceId,baseBranch:'main',prompt:'Synthetic Factory Skill integration'}))
    const gateEvidence=[]
    for (const selected of [false,true]) for (const stop of ['cancel','revoke'] as const) for (const phase of ['claim','heartbeat-resume','retry']) {
      const source=randomUUID()
      await pool.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload) VALUES($1,$2,'user_message',$3,'{}')`,[source,userId,source])
      const task=(await factory.route(userId,{issueId,sourceEventId:source,eventId:randomUUID(),rationale:'Explicit integration fixture'})).task
      const original=(await dispatch(userId,{binding:bind(task),agentId,deviceRepoId:repoId})).runId
      let current=original, receiptId:string|undefined
      if(selected) expect((await page.request.post(api,{headers:{origin},data:{action:'select_baseline',runId:current}})).status()).toBe(200)
      if(phase==='heartbeat-resume') {
        const response=await supported.post(app(`/v1/devices/${deviceId}/runs/${current}/claim`));expect(response.status()).toBe(200)
        receiptId=(await response.json()).skillReceipt?.id
      }
      if(phase==='retry') {
        await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='device_lost' WHERE id=$1`,[original])
        // The lineage is part of creation; post-insert reparenting is correctly
        // rejected by the audit guard. This still exercises an unadopted retry.
        current=randomUUID();await queue(current,original)
        if(selected) expect((await page.request.post(api,{headers:{origin},data:{action:'select_baseline',runId:current}})).status()).toBe(200)
        expect((await supported.post(app(`/v1/devices/${deviceId}/runs/${current}/claim`))).status()).toBe(409)
      }
      const state=await factory.read(userId,task.id)
      const tx=await pool.connect()
      try {
        await tx.query('BEGIN')
        await factory.apply(userId,bind(state.task),randomUUID(),{action:stop,reason:'Cancellation owns task lock before HTTP operation'},tx)
        const pending=phase==='heartbeat-resume'
          ? supported.post(heartbeatPath,{data:{...heartbeat,runs:[{runId:current,lastProgressAt:new Date().toISOString()}]}})
          : supported.post(app(`/v1/devices/${deviceId}/runs/${current}/claim`))
        const resumed=receiptId?supported.get(app(`/v1/runs/${current}/skill-receipt?receiptId=${receiptId}`)):null
        const blocker=(await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        let blocked=false
        for(let poll=0;poll<100&&!blocked;poll++) {
          blocked=(await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS blocked',[blocker])).rows[0].blocked
          if(!blocked)await new Promise(resolve=>setTimeout(resolve,20))
        }
        await tx.query('COMMIT')
        const response=await pending
        // An already-unadopted retry may reject before waiting; all other
        // paths prove task-first lock serialization against cancellation.
        if(phase!=='retry')expect(blocked).toBe(true)
        if(phase==='heartbeat-resume') {
          expect(response.status()).toBe(200);const body=await response.json()
          expect(body.revoked).toContain(current);expect(body.leases[current]).toBeUndefined()
          if(resumed)expect((await resumed).status()).toBe(409)
        } else {
          expect(response.status()).toBe(409)
          expect((await pool.query('SELECT count(*)::int AS n FROM run_tokens WHERE "runId"=$1',[current])).rows[0].n).toBe(0)
          expect((await pool.query('SELECT count(*)::int AS n FROM improvement_skill_receipts WHERE "runId"=$1',[current])).rows[0].n).toBe(0)
        }
        if(receiptId)expect((await pool.query('SELECT receipt FROM improvement_skill_receipts WHERE "runId"=$1',[current])).rows[0].receipt.id).toBe(receiptId)
        gateEvidence.push({selected,stop,phase,blocked,status:response.status()})
      } finally {await tx.query('ROLLBACK');tx.release()}
      await pool.query(`UPDATE agent_runs SET status='cancelled' WHERE id=ANY($1::uuid[])`,[[original,current]])
    }
    await info.attach('factory-skill-gates',{contentType:'application/json',body:JSON.stringify(gateEvidence)})
    await info.attach('skill-assignment-layer-result',{contentType:'application/json',body:JSON.stringify({actualNextRoutes:true,actualClaimReceipt:true,actualMountedDigest:true,terminalReport:'synthetic',modelCalls:0,productionAcceptance:false})})
  }finally{await old.dispose();await supported.dispose();await pool.end()}
})
