import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { skillMarkdown, SKILL_ARTIFACT_HEADER, TEAM_SKILL_HEADER } from '@mikka/protocol/skill'
import { dbUrl, seedBot, seedIssue, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { TeamSkillStore } from './team-skills'
import { createSkillAssignments } from './assignments'

test('team single-MD review, tenant-bound assignment and withdrawal use the existing receipt chain', { skip: !dbUrl }, async t=>{
  const pool=new Pool({connectionString:dbUrl,max:8}),store=new TeamSkillStore(pool)
  const assignments=createSkillAssignments(pool,async(userId,issueId,tx)=>Boolean((await tx.query('SELECT 1 FROM issues WHERE id=$1 AND "userId"=$2',[issueId,userId])).rowCount))
  const admin=await seedUser(pool,'team-admin'),member=await seedUser(pool,'team-member'),outsider=await seedUser(pool,'team-outsider')
  const workspace=await seedWorkspace(pool,admin,[{userId:admin,role:'admin'},{userId:member,role:'member'}])
  const other=await seedWorkspace(pool,outsider,[{userId:outsider,role:'admin'}])
  const scope={workspaceId:workspace.id,userId:admin},memberScope={...scope,userId:member},foreign={workspaceId:other.id,userId:outsider}
  const upload={name:'Team review',description:'Read changes before proposing edits.',instructions:'Review the changed code; platform permissions still apply.',
    source:'workspace-upload',license:'MIT',format:'single-skill-md-v1',permissions:[],dependencies:[]}
  const registered=await store.register(scope,upload),artifact=registered.artifact
  const directory=await mkdtemp(join(tmpdir(),'mikka-team-skill-'))
  t.after(async()=>{await rm(directory,{recursive:true,force:true});await pool.end();await(await import('../db')).pool.end();await(await import('../workspace-db')).workspacePool.end()})
  async function run(userId=member,workspaceId=workspace.id,harness='codex') {
    const botId=await seedBot(pool,workspaceId,userId),issueId=await seedIssue(pool,userId)
    const deviceId=randomUUID(),agentId=randomUUID(),repoId=randomUUID(),id=randomUUID()
    await pool.query('INSERT INTO devices(id,"ownerId",name,kind,enabled) VALUES($1,$2,\'Team fixture device\',\'local\',true)',[deviceId,userId])
    await pool.query('INSERT INTO agents(id,"userId","deviceId",harness,name) VALUES($1,$2,$3,$4,$5)',[agentId,userId,deviceId,harness,agentId])
    await pool.query('INSERT INTO device_repos(id,"userId","deviceId","repoPath","remoteUrl") VALUES($1,$2,$3,\'github.com/isolated/team-skill\',\'https://github.com/isolated/team-skill.git\')',[repoId,userId,deviceId])
    await pool.query('INSERT INTO agent_runs(id,"userId","issueId","agentId","botId","deviceId","deviceRepoId",status) VALUES($1,$2,$3,$4,$5,$6,$7,\'queued\')',[id,userId,issueId,agentId,botId,deviceId,repoId])
    return{id,userId,issueId,agentId,botId,deviceId,deviceRepoId:repoId}
  }
  const first=await run()
  await t.test('pending bytes require explicit admin review; members cannot publish and another tenant cannot read',async()=>{
    assert.equal(registered.status,'pending')
    await assert.rejects(store.register(memberScope,upload),{code:'notFound'})
    await assert.rejects(store.read(memberScope,artifact.versionId),{code:'sourceRequired'})
    await assert.rejects(assignments.selectTeam(member,first.id,artifact.versionId),{code:'sourceRequired'})
    await assert.rejects(store.read(foreign,artifact.versionId,true),{code:'notFound'})
    await assert.rejects(store.review(foreign,{versionId:artifact.versionId,sha256:artifact.sha256},'withdraw'),{code:'notFound'})
    await assert.rejects(store.review(scope,{versionId:artifact.versionId,sha256:'f'.repeat(64)},'approve'),{code:'sourceMismatch'})
    assert.equal((await store.read(scope,artifact.versionId,true)).status,'pending')
    await store.review(scope,{versionId:artifact.versionId,sha256:artifact.sha256},'approve')
    assert.equal((await store.list(memberScope)).length,1)
  })
  const queued=await run()
  let receiptId=''
  await t.test('a different team member gets the approved exact artifact through existing selection/claim',async()=>{
    await assignments.selectTeam(member,first.id,artifact.versionId)
    await assignments.selectTeam(member,queued.id,artifact.versionId)
    await assert.rejects(assignments.preflight(member,first.id,true,false),{code:'workerCapabilityRequired'})
    await assignments.preflight(member,first.id,true,true)
    const foreignRun=await run(outsider,other.id)
    await assert.rejects(assignments.selectTeam(outsider,foreignRun.id,artifact.versionId),{code:'notFound'})
    const started=new Date(),expiry=new Date(started.getTime()+90_000).toISOString()
    await pool.query('UPDATE agent_runs SET status=\'preparing\',"startedAt"=$2,"leaseExpiresAt"=$3 WHERE id=$1',[first.id,started,expiry])
    const assigned=await assignments.recordClaim(member,first.deviceId,first.id,expiry,true,true)
    assert.ok(assigned.skillReceipt)
    receiptId=assigned.skillReceipt.id
    assert.deepEqual(assigned.skillReceipt.artifact,artifact)
    assert.equal(Object.hasOwn(assigned,'policy'),false,'Skill guidance does not issue tool permissions')
    const {rows:[saved]}=await pool.query('SELECT artifact,markdown FROM improvement_skill_versions WHERE id=$1',[artifact.versionId])
    const bytes=skillMarkdown(assigned.skills![0])
    assert.equal(bytes,saved.markdown)
    assert.equal(createHash('sha256').update(bytes).digest('hex'),artifact.sha256)
    const file=join(directory,'SKILL.md');await writeFile(file,bytes)
    const{verifyMountedSkill}=await import('../../packages/daemon/src/agents/skill-artifact')
    verifyMountedSkill(file,assigned.skillReceipt)
    await writeFile(file,bytes+'unreviewed content');assert.throws(()=>verifyMountedSkill(file,assigned.skillReceipt!))
    await pool.query('UPDATE agent_runs SET status=\'running\' WHERE id=$1',[first.id])
    assert.ok(await assignments.revalidate(member,first.id,receiptId,true,true))
  })
  await t.test('new versions require another review and an unselected retry cannot discard its parent Skill',async()=>{
    const next=await store.register(scope,{...upload,skillId:artifact.skillId,instructions:upload.instructions+' Verify the result.'})
    const nextRun=await run()
    await assert.rejects(assignments.selectTeam(member,nextRun.id,next.artifact.versionId),{code:'sourceRequired'})
    const child=randomUUID()
    await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","botId","deviceId","deviceRepoId",status,"retryOf")
      SELECT $2,"userId","issueId","agentId","botId","deviceId","deviceRepoId",'queued',id FROM agent_runs WHERE id=$1`,[first.id,child])
    await assert.rejects(assignments.preflight(member,child,true,true),{code:'sourceRequired'})
  })
  await t.test('the actual authenticated receipt route accepts current Team support and refuses an old consumer',async()=>{
    const{issueDeviceToken}=await import('../device-link'),{GET}=await import('../../app/v1/runs/[runId]/skill-receipt/route')
    const token=await issueDeviceToken(member)
    const get=(team:boolean)=>GET(new Request(`http://localhost/mikka/v1/runs/${first.id}/skill-receipt?receiptId=${receiptId}`,{headers:{authorization:`Bearer ${token}`,[SKILL_ARTIFACT_HEADER]:'1',...(team?{[TEAM_SKILL_HEADER]:'1'}:{})}}),{params:Promise.resolve({runId:first.id})})
    assert.equal((await get(true)).status,200)
    assert.equal((await get(false)).status,409)
  })
  await t.test('withdrawal stops the selected run, fences its real token and refuses renew/resume/new assignment',async()=>{
    const{issueRunToken,verifyRunToken}=await import('../mcp/worker')
    const issued=await issueRunToken({id:first.id,userId:member})
    assert.ok(await verifyRunToken(new Request('http://localhost/mikka/api/mcp'),issued.token))
    await store.review(scope,{versionId:artifact.versionId,sha256:artifact.sha256},'withdraw')
    const{rows:[stopped]}=await pool.query('SELECT "stopRequestedAt","leaseExpiresAt" FROM agent_runs WHERE id=$1',[first.id])
    assert.ok(stopped.stopRequestedAt);assert.ok(stopped.leaseExpiresAt.getTime()<=Date.now())
    const{rows:[queuedStop]}=await pool.query('SELECT status,"finishedAt" FROM agent_runs WHERE id=$1',[queued.id])
    assert.equal(queuedStop.status,'stopped');assert.ok(queuedStop.finishedAt)
    await store.review(scope,{versionId:artifact.versionId,sha256:artifact.sha256},'withdraw')
    const{rows:[event]}=await pool.query('SELECT count(*)::int AS count FROM coordinator_events WHERE "runId"=$1 AND kind=\'run_finished\'',[queued.id])
    assert.equal(event.count,1)
    assert.equal(Boolean(await verifyRunToken(new Request('http://localhost/mikka/api/mcp'),issued.token)),false)
    await assert.rejects(assignments.revalidate(member,first.id,receiptId,true,true),{code:'runUnavailable'})
    const renewed=await assignments.renewHeartbeat(member,first.deviceId,[first.id],true,true)
    assert.deepEqual(renewed.revoked,[first.id]);assert.deepEqual(renewed.leases,{})
    const fresh=await run()
    await assert.rejects(assignments.selectTeam(member,fresh.id,artifact.versionId),{code:'runUnavailable'})
    assert.equal((await store.list(memberScope)).length,0)
    await assert.rejects(store.review(scope,{versionId:artifact.versionId,sha256:artifact.sha256},'approve'),{code:'runUnavailable'})
  })
  await t.test('removing current workspace membership refuses even an approved selected version',async()=>{
    const next=await store.register(scope,upload),attempt=await run()
    await store.review(scope,{versionId:next.artifact.versionId,sha256:next.artifact.sha256},'approve')
    await assignments.selectTeam(member,attempt.id,next.artifact.versionId)
    await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`,[workspace.id,member])
    await assert.rejects(assignments.preflight(member,attempt.id,true,true),{code:'notFound'})
    await assert.rejects(store.read(memberScope,next.artifact.versionId),{code:'notFound'})
  })
  await t.test('artifact/metadata are immutable and audit contains only version/digest/format',async()=>{
    await assert.rejects(pool.query('UPDATE improvement_skill_versions SET markdown=markdown||\'drift\' WHERE id=$1',[artifact.versionId]),{code:'P0001'})
    await assert.rejects(pool.query('UPDATE improvement_team_skill_metadata SET license=\'Other\' WHERE "versionId"=$1',[artifact.versionId]),{code:'P0001'})
    const{rows}=await pool.query('SELECT action,metadata FROM workspace_audit_events WHERE "workspaceId"=$1',[workspace.id])
    assert.ok(rows.some(row=>row.action==='skill.registered'));assert.ok(rows.some(row=>row.action==='skill.reviewed'));assert.ok(rows.some(row=>row.action==='skill.withdrawn'))
    assert.ok(rows.every(row=>Object.keys(row.metadata).sort().join(',')==='format,sha256,versionId'))
  })
})
