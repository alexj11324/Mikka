import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { recordMonitorIncident } from '../lib/factory/monitor-incidents'
import { assertE2eTarget } from './helpers/e2e-target.mjs'

const target=process.env.E2E_DATABASE_URL
if(target){assertE2eTarget(target);assert.equal(process.env.MIKKA_DATABASE_URL,target);assert.equal(process.env.DATABASE_URL,target)}
if(!target&&process.env.REQUIRE_DB==='1')throw Error('Monitor follow-up tests require an isolated E2E database')

// Real current schema, issue creation, numbering and the production incident
// transaction. Upstream probe/approval validation has independent monitor tests.
test('completed deliveries create one private regression issue in the incident transaction', {skip:!target}, async t=>{
  const pool=new Pool({connectionString:target,max:12})
  t.after(async()=>{await pool.end();const {pool:appPool}=await import('../lib/db');await appPool.end()})
  await pool.query(await readFile(new URL('../drizzle/20261031045310_monitor_followup_issues.sql',import.meta.url),'utf8'))
  const owner=`monitor-followup-${randomUUID()}`
  await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',[owner,`${owner}@example.invalid`])
  const agentId=randomUUID()
  await pool.query('INSERT INTO agents(id,"userId",name,harness) VALUES($1,$2,\'Monitor fixture\',\'codex\')',[agentId,owner])
  async function seed(status='done'){
    const issueId=randomUUID(),taskId=randomUUID(),candidateId=randomUUID(),runId=randomUUID(),attemptId=randomUUID()
    const tx=await pool.connect()
    try{
      await tx.query('BEGIN')
      await tx.query('INSERT INTO issues(id,"userId",title,content,status,priority,scope) VALUES($1,$2,\'PRIVATE SOURCE TITLE\',$3,$4,\'normal\',\'personal\')',[issueId,owner,JSON.stringify({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'PRIVATE SOURCE LOG token=fixture-private'}]}]}),status])
      await tx.query('INSERT INTO agent_runs(id,"userId","issueId","agentId",status,"sessionId") VALUES($1,$2,$3,$4,\'succeeded\',$5)',[runId,owner,issueId,agentId,`monitor:${runId}`])
      await tx.query('INSERT INTO factory_tasks(id,"userId","issueId","sourceEventId",route,stage,status,"attemptId",reason) VALUES($1,$2,$3,$4,\'{}\',\'monitor\',\'running\',$5,\'Trusted monitor fixture\')',[taskId,owner,issueId,randomUUID(),attemptId])
      await tx.query('INSERT INTO factory_candidates(id,"taskId",sha,repository,environment,scope,"runId") VALUES($1,$2,repeat(\'a\',40),\'v2/github.com/mikka-ci/followup\',\'device:fixture\',\'fixture\',$3)',[candidateId,taskId,runId])
      await tx.query('INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"candidateId","runId","sessionId",reason) VALUES($1,$2,\'monitor\',1,1,\'running\',$3,$4,$5,\'Trusted monitor fixture\')',[attemptId,taskId,candidateId,runId,`monitor:${runId}`])
      await tx.query('UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1',[taskId,candidateId])
      await tx.query('COMMIT')
    }catch(error){await tx.query('ROLLBACK');throw error}finally{tx.release()}
    return {ownerId:owner,workspaceKey:`personal:${owner}`,fingerprint:'f'.repeat(64),checkKey:'c'.repeat(64),issueId,eventId:randomUUID(),outcome:'unhealthy' as const,publicationId:randomUUID(),candidateId,runId,evidenceDigest:'e'.repeat(64)}
  }
  async function write(input:Parameters<typeof recordMonitorIncident>[1],rollback=false){
    const tx=await pool.connect()
    try{await tx.query('BEGIN');const result=await recordMonitorIncident(tx,input);await tx.query(rollback?'ROLLBACK':'COMMIT');return result}
    catch(error){await tx.query('ROLLBACK');throw error}finally{tx.release()}
  }
  await t.test('ten replays create one follow-up; distinct events append to it and recovery retains it',async()=>{
    const input=await seed()
    const repeated=await Promise.all(Array.from({length:10},()=>write(input)))
    assert.equal(new Set(repeated.map(x=>x.incidentId)).size,1)
    assert.equal(repeated.filter(x=>!x.replayed).length,1)
    const incident=(await pool.query('SELECT * FROM factory_monitor_incidents WHERE id=$1',[repeated[0].incidentId])).rows[0]
    assert.equal(incident.issueId,input.issueId)
    assert.ok(incident.followupIssueId)
    assert.notEqual(incident.followupIssueId,input.issueId)
    const followup=(await pool.query('SELECT * FROM issues WHERE id=$1',[incident.followupIssueId])).rows[0]
    assert.equal(followup.userId,owner);assert.equal(followup.scope,'personal');assert.equal(followup.status,'todo');assert.equal(followup.linearSyncBlocked,true)
    assert.ok(JSON.stringify(followup.content).includes(input.issueId));assert.ok(JSON.stringify(followup.content).includes(input.candidateId))
    assert.equal(JSON.stringify(followup).includes('PRIVATE SOURCE'),false)
    assert.equal(JSON.stringify(followup).includes('fixture-private'),false)
    const version=(await pool.query('SELECT actor_type,actor_id FROM issue_versions WHERE "issueId"=$1',[followup.id])).rows[0]
    assert.deepEqual(version,{actor_type:'system',actor_id:'factory-monitor'})
    await Promise.all(Array.from({length:9},()=>write({...input,eventId:randomUUID()})))
    const after=(await pool.query('SELECT * FROM factory_monitor_incidents WHERE id=$1',[incident.id])).rows[0]
    assert.equal(after.occurrences,10);assert.equal(after.followupIssueId,followup.id)
    assert.equal((await pool.query('SELECT count(*)::int n FROM issue_versions WHERE "issueId"=$1',[followup.id])).rows[0].n,1)
    assert.equal((await pool.query('SELECT count(*)::int n FROM linear_sync_outbox WHERE "issueId"=$1',[followup.id])).rows[0].n,0)
    await write({...input,eventId:randomUUID(),outcome:'healthy'})
    assert.equal((await pool.query('SELECT status FROM factory_monitor_incidents WHERE id=$1',[incident.id])).rows[0].status,'recovered')
    assert.equal((await pool.query('SELECT status FROM issues WHERE id=$1',[followup.id])).rows[0].status,'todo')
    assert.equal((await pool.query('SELECT status FROM issues WHERE id=$1',[input.issueId])).rows[0].status,'done')
    const other=await seed()
    const isolated=await write({...other,workspaceKey:'workspace:another'})
    assert.notEqual(isolated.incidentId,incident.id)
    assert.notEqual((await pool.query('SELECT "followupIssueId" FROM factory_monitor_incidents WHERE id=$1',[isolated.incidentId])).rows[0].followupIssueId,followup.id)
  })
  await t.test('unfinished source reuses its issue even if it becomes done before another event',async()=>{
    const input={...await seed('todo'),fingerprint:'b'.repeat(64)}
    const first=await write(input)
    await pool.query('UPDATE issues SET status=\'done\' WHERE id=$1',[input.issueId])
    await write({...input,eventId:randomUUID()})
    assert.equal((await pool.query('SELECT "followupIssueId" FROM factory_monitor_incidents WHERE id=$1',[first.incidentId])).rows[0].followupIssueId,null)
  })
  await t.test('rollback leaves no issue, version, observation or consumed issue number',async()=>{
    const input={...await seed(),fingerprint:'d'.repeat(64)}
    const before=(await pool.query('SELECT "lastIssueNumber" FROM "user" WHERE id=$1',[owner])).rows[0].lastIssueNumber
    const count=(await pool.query('SELECT count(*)::int n FROM issues WHERE "userId"=$1',[owner])).rows[0].n
    await write(input,true)
    assert.equal((await pool.query('SELECT "lastIssueNumber" FROM "user" WHERE id=$1',[owner])).rows[0].lastIssueNumber,before)
    assert.equal((await pool.query('SELECT count(*)::int n FROM issues WHERE "userId"=$1',[owner])).rows[0].n,count)
    assert.equal((await pool.query('SELECT count(*)::int n FROM factory_monitor_incidents WHERE "userId"=$1 AND fingerprint=$2',[owner,input.fingerprint])).rows[0].n,0)
    assert.equal((await write(input)).replayed,false)
  })
})
