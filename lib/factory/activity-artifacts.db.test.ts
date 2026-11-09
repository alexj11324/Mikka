import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { factory194Target } from '../../tests/helpers/factory194-target'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { actingContext } from '../activity-actor'
import { readFactoryActivityDocuments } from './activity-artifacts'

const url = process.env.E2E_DATABASE_URL
const allowed = Boolean(url && isE2eTarget(url) && process.env.DATABASE_URL === url && process.env.MIKKA_DATABASE_URL === url)
if (!allowed && process.env.REQUIRE_DB === '1') throw new Error('Activity documents require matching isolated loopback *_e2e databases')
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

test('activity document versions follow the actual submitting run and pinned plan/report receipts', { skip: !allowed }, async t => {
  const config = factory194Target(url!,false), admin = new Pool(config)
  const schema = `activity_documents_${randomUUID().replaceAll('-','')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({...config,options:`-c search_path=${schema}`})
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() })
  assert.equal((await pool.query('SHOW server_version_num')).rows[0].server_version_num.slice(0,2),'17')
  await pool.query(`
    CREATE TABLE bots(id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL);
    CREATE TABLE agent_runs(id uuid PRIMARY KEY,"userId" text NOT NULL,"issueId" uuid,"botId" uuid);
    CREATE TABLE computer_run_bindings("runId" uuid PRIMARY KEY,"workspaceId" uuid NOT NULL);
    CREATE TABLE mikka_team_issues("issueId" uuid PRIMARY KEY,"workspaceId" uuid NOT NULL);
    CREATE TABLE mikka_workspaces(id uuid PRIMARY KEY,"userId" text NOT NULL,kind text NOT NULL);
    CREATE TABLE factory_attempts(id uuid PRIMARY KEY,"taskId" uuid NOT NULL,"runId" uuid UNIQUE,"candidateId" uuid,stage text NOT NULL,output jsonb NOT NULL DEFAULT '{}');
    CREATE TABLE artifacts(id uuid PRIMARY KEY,"userId" text NOT NULL,"workspaceId" uuid,"runId" uuid,"issueId" uuid,kind text NOT NULL,title text NOT NULL,"latestVersion" integer NOT NULL DEFAULT 1);
    CREATE TABLE artifact_versions("artifactId" uuid REFERENCES artifacts ON DELETE CASCADE,version integer NOT NULL,size integer NOT NULL,sha256 text NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),PRIMARY KEY("artifactId",version));
    CREATE TABLE coordinator_events(id uuid PRIMARY KEY,"userId" text NOT NULL,"runId" uuid,"issueId" uuid,kind text NOT NULL,"dedupeKey" text NOT NULL UNIQUE,payload jsonb NOT NULL);
    CREATE TABLE factory_candidates(id uuid PRIMARY KEY,"taskId" uuid NOT NULL,"runId" uuid NOT NULL);
    CREATE TABLE factory_acceptance_artifacts("taskId" uuid PRIMARY KEY,"artifactId" uuid NOT NULL,"candidateId" uuid NOT NULL,"runId" uuid NOT NULL,sha256 text NOT NULL);
  `)
  const owner = 'document-owner', peer = 'document-peer', issue = randomUUID(), otherIssue = randomUUID(), taskId = randomUUID(), otherTask = randomUUID()
  const candidate = randomUUID(), workspaceA=randomUUID(), task = {id:taskId,userId:owner,issueId:issue,candidateId:candidate,workspaceId:workspaceA}
  const attempts = Array.from({length:6},()=>({id:randomUUID(),runId:randomUUID()}))
  for (const [index,attempt] of attempts.entries()) {
    await pool.query('INSERT INTO agent_runs(id,"userId","issueId") VALUES($1,$2,$3)',[attempt.runId,index===3?peer:owner,index===4?otherIssue:issue])
    await pool.query('INSERT INTO factory_attempts(id,"taskId","runId",stage) VALUES($1,$2,$3,$4)',
      [attempt.id,index===5?otherTask:taskId,attempt.runId,index===0?'spec':'execute'])
  }
  const artifact = async (run: string, options: {owner?:string;issue?:string;kind?:string;workspaceId?:string|null}={}) => {
    const id=randomUUID()
    await pool.query('INSERT INTO artifacts(id,"userId","runId","issueId",kind,title,"workspaceId") VALUES($1,$2,$3,$4,$5,$6,$7)',
      [id,options.owner??owner,run,options.issue??issue,options.kind??'markdown','Mutable latest title',options.workspaceId===undefined?workspaceA:options.workspaceId])
    return id
  }
  const version = async (id:string,n:number,title:string) => {
    const sha=digest(`${id}:${n}:${title}`)
    await pool.query('INSERT INTO artifact_versions("artifactId",version,size,sha256,"createdAt") VALUES($1,$2,$3,$4,$5)',
      [id,n,100+n,sha,new Date(Date.UTC(2026,10,1,0,n))])
    await pool.query('UPDATE artifacts SET "latestVersion"=$2,title=$3 WHERE id=$1',[id,n,title])
    return sha
  }
  const receipt = async (id:string,n:number|string,run:string,title:string,options:{owner?:string;issue?:string;dedupe?:string}={}) =>
    pool.query('INSERT INTO coordinator_events VALUES($1,$2,$3,$4,\'artifact_submitted\',$5,$6)',
      [randomUUID(),options.owner??owner,run,options.issue??issue,options.dedupe??`artifact_submitted:${id}:${n}`,JSON.stringify({artifactId:id,version:n,title,kind:'markdown'})])
  const plan=await artifact(attempts[0].runId), planSha=await version(plan,1,'Original plan')
  await receipt(plan,1,attempts[0].runId,'Original plan')
  await version(plan,2,'Rewritten plan'); await receipt(plan,2,attempts[2].runId,'Rewritten plan')
  const ref={artifactId:plan,version:1,runId:attempts[0].runId,sha256:planSha}
  await pool.query('UPDATE factory_attempts SET output=$2 WHERE id=$1',[attempts[0].id,JSON.stringify({specArtifact:ref})])
  const report=await artifact(attempts[1].runId)
  await version(report,1,'Acceptance first'); await receipt(report,1,attempts[1].runId,'Acceptance first')
  const reportSha=await version(report,2,'Acceptance repair'); await receipt(report,2,attempts[2].runId,'Acceptance repair')
  await version(report,3,'A different task updated the document'); await receipt(report,3,attempts[5].runId,'A different task updated the document')
  await pool.query('INSERT INTO factory_candidates VALUES($1,$2,$3)',[candidate,taskId,attempts[2].runId])
  await pool.query('INSERT INTO factory_acceptance_artifacts VALUES($1,$2,$3,$4,$5)',[taskId,report,candidate,attempts[2].runId,reportSha])
  const legacy=await artifact(attempts[1].runId)
  await version(legacy,1,'Legacy first'); await version(legacy,2,'Unattributed later version')

  await t.test('retains each actual submitted version with unique stable ids and fixed downloads',async()=>{
    const documents=await readFactoryActivityDocuments(pool,task)
    const plans=documents.filter(document=>document.artifactId===plan), reports=documents.filter(document=>document.artifactId===report)
    assert.deepEqual(plans.map(document=>[document.version,document.runId,document.kind,document.title]),
      [[1,attempts[0].runId,'plan','Original plan'],[2,attempts[2].runId,'document','Rewritten plan']])
    assert.deepEqual(reports.map(document=>[document.version,document.runId,document.kind,document.title]),
      [[1,attempts[1].runId,'document','Acceptance first'],[2,attempts[2].runId,'acceptance','Acceptance repair']])
    assert.equal(reports[1].attemptId,attempts[2].id)
    assert.equal(reports[1].candidateId,candidate,'the report retains its producer candidate, even if the attempt has none')
    assert.equal(new Set(documents.map(document=>document.id)).size,documents.length)
    assert.deepEqual((await readFactoryActivityDocuments(pool,task)).map(document=>document.id),documents.map(document=>document.id))
    assert.deepEqual(documents.filter(document=>document.artifactId===legacy).map(document=>document.version),[1])
    assert.equal(plans[0].createdAt,'2026-11-01T00:01:00.000Z')
    assert.match(plans[0].downloadUrl,new RegExp(`/api/artifacts/${plan}/versions/1/download$`))
    assert.ok(!JSON.stringify(documents).includes('A different task updated'))
    for(const key of ['sha256','output','payload','creatorRunId','scopeRunId','scopeIssueId','botWorkspace','bindingWorkspace'])
      assert.ok(!JSON.stringify(documents).includes(`"${key}":`))
  })
  await t.test('plan classification requires the complete immutable ref, including numeric version, producer and SHA',async()=>{
    for(const changed of [{...ref,version:'1'},{...ref,version:2},{...ref,runId:attempts[2].runId},{...ref,sha256:'f'.repeat(64)}]){
      await pool.query('UPDATE factory_attempts SET output=$2 WHERE id=$1',[attempts[0].id,JSON.stringify({specArtifact:changed})])
      assert.ok(!(await readFactoryActivityDocuments(pool,task)).some(document=>document.kind==='plan'))
    }
    await pool.query('UPDATE factory_attempts SET output=$2 WHERE id=$1',[attempts[0].id,JSON.stringify({specArtifact:ref})])
    await pool.query('DELETE FROM coordinator_events WHERE "dedupeKey"=$1',[`artifact_submitted:${plan}:1`])
    assert.equal((await readFactoryActivityDocuments(pool,task)).find(document=>document.artifactId===plan&&document.version===1)?.kind,'plan',
      'historical plan backfill intentionally emits no new submission event')
    await receipt(plan,1,attempts[0].runId,'Original plan')
  })
  await t.test('acceptance classification rejects stale candidates, mismatched producers and changed hashes',async()=>{
    assert.ok(!(await readFactoryActivityDocuments(pool,{...task,candidateId:randomUUID()})).some(document=>document.kind==='acceptance'))
    await pool.query('UPDATE factory_acceptance_artifacts SET "runId"=$2 WHERE "taskId"=$1',[taskId,attempts[1].runId])
    assert.ok(!(await readFactoryActivityDocuments(pool,task)).some(document=>document.kind==='acceptance'))
    await pool.query('UPDATE factory_acceptance_artifacts SET "runId"=$2,sha256=$3 WHERE "taskId"=$1',[taskId,attempts[2].runId,'f'.repeat(64)])
    assert.ok(!(await readFactoryActivityDocuments(pool,task)).some(document=>document.kind==='acceptance'))
    await pool.query('UPDATE factory_acceptance_artifacts SET sha256=$2 WHERE "taskId"=$1',[taskId,reportSha])
  })
  await t.test('foreign or malformed receipts never become legacy creator fallbacks',async()=>{
    const excluded:string[]=[]
    for(const [index,options] of [{owner:peer},{issue:otherIssue},{}].entries()){
      const id=await artifact(attempts[1].runId); excluded.push(id)
      await version(id,1,'Do not expose')
      await receipt(id,index===2?'1':1,attempts[1].runId,'Do not expose',options)
    }
    const foreign=await artifact(attempts[1].runId,{owner:peer}); excluded.push(foreign)
    await version(foreign,1,'Foreign owner'); await receipt(foreign,1,attempts[1].runId,'Foreign owner')
    for(const index of [3,4,5]){
      const id=await artifact(attempts[index].runId,{owner:index===3?peer:owner,issue:index===4?otherIssue:issue}); excluded.push(id)
      await version(id,1,'Unrelated run'); await receipt(id,1,attempts[index].runId,'Unrelated run',{owner:index===3?peer:owner,issue:index===4?otherIssue:issue})
    }
    const documents=await readFactoryActivityDocuments(pool,task)
    assert.ok(!documents.some(document=>excluded.includes(document.artifactId)))
    assert.equal(documents.length,5)
  })
  await t.test('persisted Artifact tenancy rejects foreign and quarantined legacy receipts while preserving same-tenant versions',async()=>{
    const workspaceB=randomUUID(), personal=randomUUID(), botA=randomUUID(), botB=randomUUID()
    const sameWorkspaceIssue=randomUUID(), producerB=randomUUID(), producerA=randomUUID()
    await pool.query('INSERT INTO mikka_workspaces VALUES($1,$4,\'team\'),($2,$4,\'team\'),($3,$4,\'personal\')',[workspaceA,workspaceB,personal,owner])
    await pool.query('INSERT INTO mikka_team_issues VALUES($1,$4),($2,$5),($3,$4)',[issue,otherIssue,sameWorkspaceIssue,workspaceA,workspaceB])
    await pool.query('INSERT INTO bots VALUES($1,$3),($2,$4)',[botA,botB,workspaceA,workspaceB])
    await pool.query('UPDATE agent_runs SET "botId"=$1 WHERE "issueId"=$2',[botA,issue])
    await pool.query('INSERT INTO agent_runs VALUES($1,$3,$4,$6),($2,$3,$5,$7)',[producerB,producerA,owner,otherIssue,sameWorkspaceIssue,botB,botA])
    const crossWorkspace=await artifact(producerB,{issue:otherIssue,workspaceId:workspaceB}), sameWorkspace=await artifact(producerA,{issue:sameWorkspaceIssue})
    for(const id of [crossWorkspace,sameWorkspace]){
      await version(id,1,'Original elsewhere'); await receipt(id,1,id===crossWorkspace?producerB:producerA,'Original elsewhere',{issue:id===crossWorkspace?otherIssue:sameWorkspaceIssue})
      await version(id,2,'Submitted to this task'); await receipt(id,2,attempts[2].runId,'Submitted to this task')
    }
    const withoutRun=await artifact(producerB,{issue:otherIssue,workspaceId:workspaceB}), unbound=await artifact(producerB,{workspaceId:null})
    for(const id of [withoutRun,unbound]){
      await version(id,1,'Owned document'); await receipt(id,1,attempts[2].runId,'Owned document')
      await pool.query('UPDATE artifacts SET "runId"=NULL WHERE id=$1',[id])
    }
    await pool.query('UPDATE artifacts SET "issueId"=NULL WHERE id=$1',[unbound])
    const browser=await readFactoryActivityDocuments(pool,task)
    assert.ok(browser.some(document=>document.artifactId===sameWorkspace))
    for(const id of [crossWorkspace,withoutRun,unbound]) assert.ok(!browser.some(document=>document.artifactId===id))
    const scoped=(workspaceId:string)=>actingContext.run({userId:owner,tokenWorkspaceId:workspaceId},()=>readFactoryActivityDocuments(pool,task))
    const team=await scoped(workspaceA)
    assert.ok(team.some(document=>document.artifactId===sameWorkspace&&document.version===2),'same workspace reuse is allowed')
    for(const id of [crossWorkspace,withoutRun,unbound]) assert.ok(!team.some(document=>document.artifactId===id))
    assert.deepEqual(await scoped(personal),[],'a different selected tenant cannot read this task projection')
    assert.deepEqual(await scoped(workspaceB),[])
    assert.deepEqual(await readFactoryActivityDocuments(pool,{...task,workspaceId:null}),[],'unresolved task tenancy grants no document access')
    await pool.query('INSERT INTO computer_run_bindings VALUES($1,$2)',[producerA,workspaceB])
    assert.ok((await scoped(workspaceA)).some(document=>document.artifactId===sameWorkspace),
      'an old computer binding cannot move an Artifact out of its immutable tenant')
    await pool.query('UPDATE artifacts SET "runId"=NULL,"issueId"=NULL WHERE id=$1',[sameWorkspace])
    assert.ok((await scoped(workspaceA)).some(document=>document.artifactId===sameWorkspace&&document.version===2),
      'retiring creator links preserves the authorized historical submission and its tenant')
  })
})
