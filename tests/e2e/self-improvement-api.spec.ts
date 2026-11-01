import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { REPO_ORIGIN_HEADER } from '@mikka/protocol/device'
import { remoteKey } from '@mikka/protocol/repository'
import { SKILL_ARTIFACT_HEADER, skillSlug } from '@mikka/protocol/skill'
import { verifySkillAssignment } from '../../packages/daemon/src/agents/skill-artifact'
import { RunContext } from '../../packages/daemon/src/agents/run-context'
import { test,expect,register,app,leavePage } from './fixtures'

// Actual built Next routes + cookie/device authentication + real PG/mount.
// Terminal report/session are explicitly synthetic; no CLI/model is invoked.
test('Skill baseline selection, actual claim receipt and feedback provenance use real authenticated routes',async({page,playwright,baseURL},info)=>{
  test.skip(process.env.CI!=='true'||process.env.GITHUB_ACTIONS!=='true','Disposable CI only')
  const target=new URL(process.env.E2E_DATABASE_URL!)
  expect(target.hostname).toBe('127.0.0.1');expect(target.pathname).toBe('/mikka_e2e')
  const {email}=await register(page),pool=new Pool({connectionString:target.toString(),max:2})
  await leavePage(page)
  const deviceId=randomUUID(),agentId=randomUUID(),repoId=randomUUID(),issueId=randomUUID(),runId=randomUUID()
  const deviceToken=`orv_${randomBytes(32).toString('base64url')}`
  const headers={authorization:`Bearer ${deviceToken}`,[REPO_ORIGIN_HEADER]:'1'}
  // Both clients speak the current daemon/repository protocol; only the Skill
  // artifact capability differs, so the negative case reaches that boundary.
  const old=await playwright.request.newContext({baseURL,extraHTTPHeaders:headers})
  const supported=await playwright.request.newContext({baseURL,extraHTTPHeaders:{...headers,[SKILL_ARTIFACT_HEADER]:'1'}})
  const harnesses=[{harness:'codex',installed:true,version:'synthetic-skill-http',toolApproval:true}]
  const remoteUrl=`https://github.com/mikka-e2e/skill-http-${repoId}.git`
  const origin=new URL(baseURL!).origin
  try {
    const userId=(await pool.query('SELECT id FROM "user" WHERE email=$1',[email])).rows[0].id
    await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority) VALUES($1,$2,'Synthetic Skill HTTP fixture','{}','todo','normal')`,[issueId,userId])
    await pool.query(`INSERT INTO devices(id,"ownerId",name,enabled,"protocolVersion",harnesses,"lastSeenAt") VALUES($1,$2,'Synthetic Skill HTTP device',true,$3,$4,now())`,[deviceId,userId,DAEMON_PROTOCOL_VERSION,JSON.stringify(harnesses)])
    await pool.query(`INSERT INTO device_tokens(id,"userId","tokenHash") VALUES($1,$2,$3)`,[randomUUID(),userId,createHash('sha256').update(deviceToken).digest('hex')])
    await pool.query(`INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,'Synthetic Skill HTTP agent','codex',$3)`,[agentId,userId,deviceId])
    await pool.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath","remoteUrl") VALUES($1,$2,$3,$4,$5)`,[repoId,deviceId,userId,remoteKey(remoteUrl),remoteUrl])
    async function queue(id:string) {
      await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId",status) VALUES($1,$2,$3,$4,$5,$6,'queued')`,[id,userId,issueId,agentId,deviceId,repoId])
    }
    await queue(runId)
    const api=app('/api/self-improvement'),claim=app(`/v1/devices/${deviceId}/runs/${runId}/claim`)
    expect((await page.request.post(api,{headers:{origin},data:{action:'select_baseline',runId,sha256:'0'.repeat(64)}})).status()).toBe(422)
    expect((await page.request.post(api,{headers:{origin},data:{action:'select_baseline',runId}})).status()).toBe(200)
    const unsupported=await old.post(claim)
    expect(unsupported.status()).toBe(409)
    expect(await unsupported.json()).toEqual({error:'workerCapabilityRequired'})
    expect((await pool.query('SELECT status FROM agent_runs WHERE id=$1',[runId])).rows[0].status).toBe('queued')
    expect((await pool.query(`SELECT (SELECT count(*)::int FROM improvement_skill_receipts WHERE "runId"=$1) AS receipts,
      (SELECT count(*)::int FROM run_tokens WHERE "runId"=$1) AS tokens`,[runId])).rows[0]).toEqual({receipts:0,tokens:0})
    const claimed=await supported.post(claim);expect(claimed.status()).toBe(200)
    const assignment=await claimed.json();verifySkillAssignment(assignment)
    expect({runId:assignment.runId,issueId:assignment.issueId,deviceId:assignment.deviceId,repoId:assignment.repoId,
      expectedRepoRemote:assignment.expectedRepoRemote,gitPush:assignment.policy?.permissions?.git_push})
      // No admitted publication: claim sends deny, never ask (decision 2026-11-01-1215).
      .toEqual({runId,issueId,deviceId,repoId,expectedRepoRemote:remoteUrl,gitPush:'deny'})
    expect(assignment.skillReceipt.runId).toBe(runId)
    expect((await pool.query('SELECT receipt FROM improvement_skill_receipts WHERE "runId"=$1',[runId])).rows[0].receipt.id).toBe(assignment.skillReceipt.id)
    const receiptPath=app(`/v1/runs/${runId}/skill-receipt?receiptId=${assignment.skillReceipt.id}`)
    expect((await supported.get(receiptPath)).status()).toBe(200)
    expect((await old.get(receiptPath)).status()).toBe(409)
    const heartbeatPath=app(`/v1/devices/${deviceId}/heartbeat`)
    const heartbeat={harnesses,runs:[{runId,lastProgressAt:new Date().toISOString()}],worktreeDiskBytes:0}
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
    await info.attach('skill-assignment-layer-result',{contentType:'application/json',body:JSON.stringify({actualNextRoutes:true,actualClaimReceipt:true,actualMountedDigest:true,terminalReport:'synthetic',modelCalls:0,productionAcceptance:false})})
  }finally{await old.dispose();await supported.dispose();await pool.end()}
})
