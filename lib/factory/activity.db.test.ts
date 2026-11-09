import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { assertE2eTarget, disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { dropTestDatabase } from '../../tests/support/drop-test-database'
import { seedUser, seedWorkspace, seedBot, seedAgent, seedIssue } from '../../tests/support/workspace-admin-db'
import { createFactoryStore } from './store'
import { readFactoryActivity } from './activity'
import { handleFactoryActivity } from './activity-http'
import { observePoolCommits } from '../db/commit-effects'
import { createRequestDatabaseScope } from '../db'
import { bindFixtureWorkspaceDatabase } from '../../tests/helpers/workspace-database'
import { syncFactoryPresentation } from './stage-progress'
import { authorizeFactoryTaskCapture } from './task-media'
import { createCaptureDownloads } from '../captures/private-download'
import { readArtifactContent } from '../artifacts/store'
import { tokenWorkspace } from '../tokens/principal'
import { loadIssueDocument, readIssueThreads } from '../linear-sync/document'
import { captureArtifact, readFactoryArtifact, runCaptureEvidence } from './evidence'
import type { FactoryEvidence } from './contract'
import { createFactoryDispatch, defaultFactoryDispatchAdapters, factoryBinding, type FactoryQueue } from './dispatch'
import { factoryCheckGates } from './checks'
import { factoryCheckIndependent } from './check-independence'
import { createFactoryReconciler } from './reconcile'
import { reconcileFactoryCheck } from './reconcile-check'
import { createFactoryApprovalGates, createFactoryApprovals, deferPublication } from './approval'
import { PublicationDeferred } from './publication-operation'
import { freezeWorkerDefinition } from '../agent-kit/worker'
import { prepareFactoryPublicationEvidence, withFactoryPublicationEvidence } from '../captures/publication'

const base = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(base && disposableDatabase(), 'isolated database is required')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCZkAAAAASUVORK5CYII=', 'base64')

test('Factory activity: one owner-scoped SQL read model for every run, computer interval and artifact', { skip: !base, timeout: 120_000 }, async t => {
  assert.ok(disposableDatabase())
  const adminUrl = assertE2eTarget(base!), name = `activity_${randomUUID().replaceAll('-', '')}_e2e`
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 })
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template0`)
  const target = new URL(adminUrl); target.pathname = `/${name}`
  const pool = new Pool({ connectionString: target.toString(), max: 4 })
  observePoolCommits(pool)
  const application = createRequestDatabaseScope(target.toString())
  const closeWorkspace = await bindFixtureWorkspaceDatabase(pool)
  try {
    assert.equal((await pool.query('SHOW server_version_num')).rows[0].server_version_num.slice(0, 2), '17')
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const file of orderMigrations((await readdir(dir)).filter(file => file.endsWith('.sql'))))
      await pool.query(await readFile(new URL(file, dir), 'utf8'))
    const owner = await seedUser(pool, 'activity-owner'), other = await seedUser(pool, 'activity-other')
    const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
    const bot = await seedBot(pool, workspace.id, owner), agent = await seedAgent(pool, owner)
    const device = randomUUID()
    await pool.query('INSERT INTO devices(id,"ownerId",name,kind) VALUES($1,$2,\'Build server\',\'cloud\')', [device, owner])
    const authorize = async (userId: string, issueId: string, tx: { query: Pool['query'] }) =>
      (await tx.query(`SELECT id FROM issues WHERE id=$1 AND "userId"=$2 AND content #>> '{attrs,mikka,deletedAt}' IS NULL`, [issueId, userId])).rowCount === 1
    const store = createFactoryStore(pool, authorize, bot)
    const fixture = async () => {
      const issueId = await seedIssue(pool, owner, workspace.id), source = randomUUID()
      await pool.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload)
        VALUES($1::uuid,$2,$3,'user_message',$1::text,'{"text":"Synthetic sidebar task"}')`, [source, owner, bot])
      const task = (await store.route(owner, { issueId, sourceEventId: source, eventId: randomUUID(),
        rationale: 'Synthetic task', missingInformation: [], missingPermissions: [], needsSpec: false })).task
      return { task, issueId, source }
    }
    const run = async (f: Awaited<ReturnType<typeof fixture>>, position: number, stage = 'execute', action?: string) => {
      const runId = randomUUID(), attemptId = position === 1 ? f.task.attemptId : randomUUID()
      const start = new Date(Date.UTC(2026, 10, 1, 0, position)), finish = new Date(start.getTime() + 30_000)
      await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId",status,kind,"startedAt","finishedAt",report,"agentDefinition","botId")
        VALUES($1,$2,$3,$4,$5,'succeeded',$6,$7,$8,$9,$10,$11)`, [runId, owner, f.issueId, agent, device,
        stage === 'spec' ? 'plan' : stage === 'review' ? 'review' : 'implement', start, finish,
        JSON.stringify({ summary: `Completed step ${position} API_TOKEN=synthetic-hidden\nprivate second line`, private: 'NO_RAW_REPORT' }),
        JSON.stringify({ name: 'Frozen coder', harness: 'codex', model: 'gpt-6-luna', private: 'NO_RAW_DEFINITION' }),bot])
      const tx = await pool.connect()
      try {
        await tx.query('BEGIN')
        if (position === 1) await tx.query(`UPDATE factory_attempts SET stage=$2,status='passed',"runId"=$3,"finishedAt"=$4,output=$5 WHERE id=$1`,
          [attemptId, stage, runId, finish, JSON.stringify({ requestEpoch: f.source })])
        else await tx.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"runId",reason,"createdAt","finishedAt",output)
          VALUES($1,$2,$3,$4,$4,'passed',$5,'Finished fixture',$6,$7,$8)`,
          [attemptId, f.task.id, stage, position, runId, start, finish, JSON.stringify({ requestEpoch: f.source })])
        await tx.query(`UPDATE factory_tasks SET "attemptId"=$2,stage=$3,status='passed',revision=$4 WHERE id=$1`, [f.task.id, attemptId, stage, position + 1])
        if (action) await tx.query(`INSERT INTO factory_events("taskId","eventId",request,result,"createdAt") VALUES($1,$2,$3,$4,$5)`,
          [f.task.id, randomUUID(), JSON.stringify({ change: { action }, binding: { taskId: f.task.id, revision: position } }),
            JSON.stringify({ task: { id: f.task.id, attemptId, stage, status: 'running', revision: position + 1 } }), start])
        await tx.query('COMMIT')
      } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
      return { runId, attemptId, start, finish }
    }
    const capture = async (issueId: string, runId: string, userId = owner) => {
      const id = randomUUID()
      await pool.query(`INSERT INTO run_captures(id,"userId","runId","issueId",kind,"contentType",source,status,title,"storageKey","inlineContent",size,sha256)
        VALUES($1,$2,$3,$4,'image','image/png','local','ready','Unreferenced screenshot',$5,$6,$7,$8)`,
        [id,userId,runId,issueId,`fixture/${id}.png`,png,png.length,createHash('sha256').update(png).digest('hex')])
      return id
    }
    const f = await fixture(), first = await run(f, 1), review = await run(f, 2, 'review', 'advance')
    const fix = await run(f, 3, 'execute', 'repair'), retry = await run(f, 4, 'execute', 'adopt_retry')
    for (let i = 5; i <= 24; i++) await run(f, i, 'execute', 'retry')
    const oldCapture = await capture(f.issueId, first.runId), reviewCapture = await capture(f.issueId, review.runId)
    const another = await fixture(), anotherRun = await run(another, 1)
    const foreignCapture = await capture(another.issueId, anotherRun.runId)
    const misboundCapture = await capture(another.issueId, first.runId)
    await pool.query(`INSERT INTO computer_run_bindings("runId","ownerId","workspaceId","botId") VALUES($1,$2,$3,$4)`, [first.runId,owner,workspace.id,bot])
    await pool.query(`INSERT INTO thread_machines("runId","ownerId","workspaceId","botId","sandboxId","snapshotId","operationId",state,"runningSince")
      VALUES($1,$2,$3,$4,'activity-vm','codex',$5,'running',$6)`, [first.runId,owner,workspace.id,bot,randomUUID(),first.start])
    await pool.query(`UPDATE thread_machines SET state='paused',"runningSince"=NULL WHERE "runId"=$1`, [first.runId])
    await pool.query(`UPDATE thread_machines SET state='running',"runningSince"=now() WHERE "runId"=$1`, [first.runId])
    await t.test('all 24 runs and unreferenced historical media appear without loading private report fields', async () => {
      const view = await readFactoryActivity(pool, store, owner, f.task.id)
      assert.equal(view.agents.length, 24)
      assert.equal(view.timeline.attempts.length, 24)
      assert.equal(view.agents.find(item => item.runId === first.runId)?.role, 'implement')
      assert.equal(view.agents.find(item => item.runId === review.runId)?.role, 'review')
      assert.equal(view.agents.find(item => item.runId === fix.runId)?.role, 'fix')
      assert.equal(view.agents.find(item => item.runId === fix.runId)?.revisionOf, first.attemptId)
      assert.equal(view.agents.find(item => item.runId === retry.runId)?.role, 'fix', 'infra retry retains its parent role')
      assert.deepEqual(view.artifacts.map(item => item.id), [oldCapture,reviewCapture])
      assert.ok(!view.artifacts.some(item => item.id === foreignCapture || item.id === misboundCapture))
      assert.equal(view.timeline.computers.length, 2)
      assert.ok(view.timeline.computers[0].endedAt)
      assert.equal(view.timeline.computers[1].endedAt, null)
      assert.equal(view.task.startedAt, first.start.toISOString())
      assert.equal(view.task.endedAt, null)
      const serialized = JSON.stringify(view)
      for (const forbidden of ['synthetic-hidden','private second line','NO_RAW_REPORT','NO_RAW_DEFINITION','storageKey','sessionId','tokens','cost'])
        assert.ok(!serialized.includes(forbidden), forbidden)
      assert.equal(view.agents[0].harness, 'codex')
      assert.equal(view.agents[0].model, 'gpt-6-luna')
      assert.deepEqual(view.agents[0].artifactIds, [oldCapture])
    })
    await t.test('reads are read-only and a different owner or a mismatched source cannot see the task', async () => {
      const tables = ['factory_events','factory_attempts','artifacts','artifact_versions','run_capture_posters','thread_machine_sessions']
      const snapshot = async () => Promise.all(tables.map(async table => (await pool.query(`SELECT row_to_json(t) FROM ${table} t ORDER BY row_to_json(t)::text`)).rows))
      const before = await snapshot()
      await readFactoryActivity(pool, store, owner, f.task.id)
      assert.deepEqual(await snapshot(), before)
      assert.equal((await handleFactoryActivity(pool,store,{ userId:other,taskId:f.task.id })).status,404)
      assert.equal((await handleFactoryActivity(pool,store,{ userId:null,taskId:f.task.id })).status,401)
      assert.equal((await handleFactoryActivity(pool,store,{ userId:owner,taskId:'not-a-uuid' })).status,404)
      await pool.query('UPDATE coordinator_events SET "userId"=$2 WHERE id=$1',[f.source,other])
      assert.equal((await handleFactoryActivity(pool,store,{ userId:owner,taskId:f.task.id })).status,404)
      await pool.query('UPDATE coordinator_events SET "userId"=$2 WHERE id=$1',[f.source,owner])
    })
    await t.test('a foreign run binding never becomes an unbound control attempt or an attention interval', async () => {
      const historical = await fixture(), foreignRun = randomUUID(), eventId = randomUUID()
      // Both issues and the run have valid persisted tenancy. Only the old
      // attempt receipt is misbound; no database constraint is disabled.
      await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","botId",status,kind)
        VALUES($1,$2,$3,$4,$5,'succeeded','review')`,[foreignRun,owner,another.issueId,agent,bot])
      await pool.query(`UPDATE factory_attempts SET "runId"=$2,stage='review',status='blocked',output=$3 WHERE id=$1`,
        [historical.task.attemptId,foreignRun,JSON.stringify({completion:{reviewVerdict:'changes_requested',summary:'FOREIGN_REVIEW_TITLE'}})])
      await pool.query(`UPDATE factory_tasks SET stage='review',status='blocked',revision=2 WHERE id=$1`,[historical.task.id])
      await pool.query(`INSERT INTO factory_events("taskId","eventId",request,result,"createdAt")
        VALUES($1,$2,$3,$4,'2026-11-01T04:00:00Z')`,[historical.task.id,eventId,
        JSON.stringify({change:{action:'finish'}}),JSON.stringify({task:{id:historical.task.id,attemptId:historical.task.attemptId,stage:'review',status:'blocked',revision:2}})])
      const view = await readFactoryActivity(pool,store,owner,historical.task.id)
      assert.deepEqual(view.agents,[])
      assert.deepEqual(view.timeline.attempts,[])
      assert.deepEqual(view.timeline.waits,[],'both persisted attention and its current fallback stay hidden')
      assert.equal(view.task.review,null)
      assert.equal(view.task.needsYou?.kind,'blocked','task attention remains the canonical flow state')
      for(const hidden of [foreignRun,historical.task.attemptId,'FOREIGN_REVIEW_TITLE','boundRunId'])
        assert.ok(!JSON.stringify(view).includes(hidden),hidden)
      const control = await fixture()
      await pool.query(`UPDATE factory_attempts SET status='blocked' WHERE id=$1`,[control.task.attemptId])
      await pool.query(`UPDATE factory_tasks SET status='blocked' WHERE id=$1`,[control.task.id])
      const unbound = await readFactoryActivity(pool,store,owner,control.task.id)
      assert.equal(unbound.timeline.attempts[0].id,control.task.attemptId)
      assert.equal(unbound.timeline.attempts[0].runId,null)
      assert.equal(unbound.timeline.waits[0].attemptId,control.task.attemptId,'a genuinely unbound control stage retains its attention interval')
    })
    await t.test('historical execution questions use escalation and answer times without exposing the question', async () => {
      const q = randomUUID(), event = randomUUID()
      await pool.query(`INSERT INTO factory_questions(id,"userId","issueId","taskId","attemptId",stage,"originRunId","originSessionId",
        "originRevision","waitingBinding",kind,question,context,request,status,reason,"sourceEventId","createdAt","updatedAt","answeredAt","escalationEventId")
        VALUES($1,$2,$3,$4,$5,'execute',$6,'private-session',1,'{}','decision','NO_PRIVATE_QUESTION','NO_PRIVATE_CONTEXT','{}','resolved','fixture',$7,
        '2026-11-01T01:00:00Z','2026-11-01T03:00:00Z','2026-11-01T02:30:00Z',$8)`,
        [q,owner,f.issueId,f.task.id,first.attemptId,first.runId,f.source,randomUUID()])
      await pool.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey","issueId","runId",payload,"createdAt")
        VALUES($1,$2,$3,'run_question',$4,$5,$6,$7,'2026-11-01T02:00:00Z')`,
        [event,owner,bot,`question-escalated:${q}`,f.issueId,first.runId,JSON.stringify({questionId:q,taskId:f.task.id,needsUser:true,question:'NO_PRIVATE_QUESTION'})])
      const view = await readFactoryActivity(pool,store,owner,f.task.id)
      const wait = view.timeline.waits.find(item => item.id === `question:${q}`)
      assert.deepEqual(wait,{id:`question:${q}`,kind:'question',attemptId:first.attemptId,runId:first.runId,
        startedAt:'2026-11-01T02:00:00.000Z',endedAt:'2026-11-01T02:30:00.000Z',durationMs:1_800_000})
      assert.ok(!JSON.stringify(view).includes('NO_PRIVATE_'))
      await pool.query('UPDATE coordinator_events SET "userId"=$2 WHERE id=$1',[event,other])
      assert.ok(!(await readFactoryActivity(pool,store,owner,f.task.id)).timeline.waits.some(item => item.id === `question:${q}`))
      await pool.query('UPDATE coordinator_events SET "userId"=$2 WHERE id=$1',[event,owner])
      await pool.query(`UPDATE factory_questions SET status='waiting_user',"answeredAt"=NULL,"expiresAt"='2026-11-01T04:00:00Z' WHERE id=$1`,[q])
      const expired = await readFactoryActivity(pool,store,owner,f.task.id)
      assert.equal(expired.timeline.waits.find(item => item.id === `question:${q}`)?.endedAt,'2026-11-01T04:00:00.000Z')
      assert.ok(!expired.timeline.waits.some(item => item.kind === 'question' && item.endedAt === null))
      await pool.query(`UPDATE factory_questions SET status='cancelled',"updatedAt"='2026-11-01T02:45:00Z' WHERE id=$1`,[q])
      assert.equal((await readFactoryActivity(pool,store,owner,f.task.id)).timeline.waits.find(item => item.id === `question:${q}`)?.endedAt,
        '2026-11-01T02:45:00.000Z','a cancellation before expiry ends waiting earlier')
    })
    await t.test('cancel uses the actual persisted cancellation event, preserving a much earlier run finish', async () => {
      const cancelledAt = '2026-11-02T12:00:00.000Z'
      await pool.query(`UPDATE factory_tasks SET status='cancelled',"updatedAt"='2026-11-03' WHERE id=$1`,[f.task.id])
      await pool.query(`INSERT INTO factory_events("taskId","eventId",request,result,"createdAt") VALUES($1,$2,$3,$4,$5)`,
        [f.task.id,randomUUID(),JSON.stringify({ change:{ action:'cancel' } }),JSON.stringify({ task:{ id:f.task.id,status:'cancelled',stage:'execute',revision:100,attemptId:retry.attemptId } }),cancelledAt])
      const view = await readFactoryActivity(pool,store,owner,f.task.id)
      assert.equal(view.task.endedAt,cancelledAt)
      assert.equal(view.task.endedAtSource,'cancelled')
      assert.equal(view.agents[0].endedAt,first.finish.toISOString())
      assert.equal(view.task.stage,'cancelled')
    })
    await t.test('a historical cancellation without an event remains unknown instead of guessing from updatedAt', async () => {
      await pool.query(`UPDATE factory_tasks SET status='cancelled' WHERE id=$1`,[another.task.id])
      const view = await readFactoryActivity(pool,store,owner,another.task.id)
      assert.equal(view.task.endedAt,null)
      assert.equal(view.task.endedAtSource,null)
    })
    await t.test('completion is bound to the current candidate and its owner for merged and accepted deliverables', async () => {
      const done = await fixture(), implementation = await run(done,1), candidate = randomUUID(), stale = randomUUID()
      for (const id of [candidate,stale]) await pool.query(`INSERT INTO factory_candidates(id,"taskId",sha,repository,environment,scope,"runId") VALUES($1,$2,$3,'owner/repo','fixture','fixture',$4)`,
        [id,done.task.id,'a'.repeat(40),implementation.runId])
      await pool.query(`UPDATE factory_tasks SET "candidateId"=$2,stage='approval',status='pending' WHERE id=$1`,[done.task.id,candidate])
      const merge = async (id:string,userId:string) => pool.query(`INSERT INTO factory_merges(id,"taskId","candidateId","userId","eventId","pullRequestUrl",sha,status,source,"finishedAt")
        VALUES($1,$2,$3,$4,$5,'https://github.com/owner/repo/pull/1',$6,'merged','github','2026-11-04T12:00:00Z')`,[randomUUID(),done.task.id,id,userId,randomUUID(),'a'.repeat(40)])
      await merge(stale,owner)
      assert.equal((await readFactoryActivity(pool,store,owner,done.task.id)).task.endedAt,null)
      await merge(candidate,other)
      assert.equal((await readFactoryActivity(pool,store,owner,done.task.id)).task.endedAt,null)
      await pool.query('UPDATE factory_merges SET "userId"=$2 WHERE "taskId"=$1 AND "candidateId"=$3',[done.task.id,owner,candidate])
      const merged = await readFactoryActivity(pool,store,owner,done.task.id)
      assert.equal(merged.task.endedAt,'2026-11-04T12:00:00.000Z')
      assert.equal(merged.task.endedAtSource,'merged')
      await pool.query(`UPDATE factory_candidates SET kind='report' WHERE id=$1`,[candidate])
      await pool.query(`INSERT INTO factory_deliverable_acceptances(id,"taskId","candidateId","userId","sessionId","eventId","createdAt")
        VALUES($1,$2,$3,$4,'fixture',$5,'2026-11-05T12:00:00Z')`,[randomUUID(),done.task.id,candidate,owner,randomUUID()])
      const accepted = await readFactoryActivity(pool,store,owner,done.task.id)
      assert.equal(accepted.task.completion,'accepted')
      assert.equal(accepted.task.endedAt,'2026-11-05T12:00:00.000Z')
      await pool.query(`UPDATE factory_candidates SET kind='deliverable',sha=NULL WHERE id=$1`,[candidate])
      assert.equal((await readFactoryActivity(pool,store,owner,done.task.id)).task.endedAt,'2026-11-05T12:00:00.000Z')
    })
    await t.test('canonical publication retry refuses missing producer media after a real approval and failed publication', async () => application.run(async () => {
      const f = await fixture(), localDevice = randomUUID(), localAgent = randomUUID(), repo = randomUUID(), sha = 'e'.repeat(40)
      const repository = 'https://github.com/acme/visual-retry-fixture.git'
      await pool.query(`INSERT INTO devices(id,"ownerId",name,"lastSeenAt",harnesses)
        VALUES($1,$2,'Publication retry fixture',now(),'[{"harness":"codex","installed":true}]')`, [localDevice,owner])
      await pool.query(`INSERT INTO agents(id,"userId","deviceId",name,harness) VALUES($1,$2,$3,'Publication retry fixture','codex')`, [localAgent,owner,localDevice])
      await pool.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath","remoteUrl","verifyCommand") VALUES($1,$2,$3,'/fixture/visual-retry',$4,'node --version')`, [repo,localDevice,owner,repository])
      const canonical = createFactoryStore(pool,authorize,bot,{independent:factoryCheckIndependent,
        gates:{...factoryCheckGates,...createFactoryApprovalGates()}})
      const queue: FactoryQueue = async (tx,userId,input,runtimeBot) => {
        const runId = randomUUID()
        await tx.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",status,prompt)
          VALUES($1,$2,$3,$4,$5,$6,$7,'queued','Isolated PostgreSQL publication retry fixture')`,
        [runId,userId,input.issueId,input.agentId,localDevice,input.deviceRepoId,runtimeBot])
        return {runId}
      }
      const dispatch = createFactoryDispatch(pool,canonical,queue,{...defaultFactoryDispatchAdapters,
        freeze:async(tx,task,runId)=>{
          const {rows:[queued]} = await tx.query('SELECT prompt FROM agent_runs WHERE id=$1',[runId])
          await tx.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1',[runId,
            JSON.stringify(freezeWorkerDefinition({harness:'codex',instructions:'Isolated fixture',prompt:queued.prompt,
              parent:null,executionId:null,readOnly:task.stage==='review'}))])
        }})
      const reconcile = createFactoryReconciler(pool,canonical,undefined,{review:reconcileFactoryCheck,verify:reconcileFactoryCheck},bot)
      const producer = await dispatch(owner,{binding:factoryBinding(f.task),agentId:localAgent,deviceRepoId:repo})
      const captureId = await capture(f.issueId,producer.runId)
      await pool.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"=$2,
        "startedAt"=now()-interval '1 minute',"finishedAt"=clock_timestamp(),report=$3 WHERE id=$1`,
      [producer.runId,`publication-producer-${producer.runId}`,JSON.stringify({summary:'Synthetic producer observation',publish:{commit:sha},
        filesChanged:['fixture.txt'],verify:{status:'passed'},criteria:[{text:'Fixture result',passed:true,evidence:'Stored screenshot'}],
        visualEvidence:[{captureId,publicSafe:true}]})])
      await reconcile.run(owner,producer.runId)
      const reviewPending = (await canonical.read(owner,f.task.id)).task
      assert.equal(reviewPending.stage,'review')
      assert.equal(reviewPending.status,'pending')
      const publicReceipt = await prepareFactoryPublicationEvidence(pool,
        {userId:owner,issueId:f.issueId,runId:producer.runId,sha},'https://evidence.example.invalid')
      // GitHub acknowledgement is the external fixture boundary. The current
      // capture, share locks, receipt digest and all Factory transitions are real.
      await withFactoryPublicationEvidence(pool,publicReceipt,async()=>{
        await pool.query(`INSERT INTO run_publications("runId","userId","issueId","remoteUrl","remoteKey",status,"pullRequest")
          VALUES($1,$2,$3,$4,'acme/visual-retry-fixture','published',$5)`,[producer.runId,owner,f.issueId,repository,
          JSON.stringify({url:'https://github.com/acme/visual-retry-fixture/pull/1',state:'open',evidenceDigest:publicReceipt.digest})])
      })
      const reviewer = await dispatch(owner,{binding:factoryBinding(reviewPending),agentId:localAgent,deviceRepoId:repo})
      await pool.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"=$2,
        "startedAt"=now()-interval '1 minute',"finishedAt"=clock_timestamp(),report=$3 WHERE id=$1`,
      [reviewer.runId,`publication-review-${reviewer.runId}`,JSON.stringify({summary:'Synthetic independent review observation',
        check:{sha,readOnly:true},filesChanged:[],criteria:[{text:'Fixture result',passed:true,evidence:'Checked the producer screenshot'}],
        verify:{status:'passed',command:'node --version',exitCode:0,timedOut:false,signal:null}})])
      await reconcile.run(owner,reviewer.runId)
      const ready = await canonical.read(owner,f.task.id)
      assert.equal(ready.task.stage,'approval',JSON.stringify(ready.task))
      assert.equal(ready.task.status,'pending')
      assert.deepEqual(ready.attempts.filter(a=>a.runId).map(a=>a.status),['passed','passed'])
      const sessionId = randomUUID()
      await pool.query(`INSERT INTO "session"(id,"userId",token,"expiresAt","createdAt","updatedAt")
        VALUES($1,$2,$3,now()+interval '1 hour',now(),now())`,[sessionId,owner,randomUUID()])
      await pool.query(`INSERT INTO account(id,"accountId","providerId","userId","createdAt","updatedAt")
        VALUES($1,$2,'github',$3,now(),now())`,[randomUUID(),randomUUID(),owner])
      const actor = {userId:owner,sessionId}, approvals = createFactoryApprovals(pool,authorize,canonical)
      const proof = await approvals.evidence(actor,f.task.id)
      const approval = await approvals.approve(actor,{binding:proof.binding,eventId:randomUUID(),candidate:proof.manifest.candidate,
        action:'deploy_preview',target:'synthetic-preview',targetEnvironment:'preview'})
      const publication = (await pool.query('SELECT * FROM factory_publications WHERE "approvalId"=$1',[approval.approvalId])).rows[0]
      assert.equal(publication.status,'reserved')
      assert.equal((await canonical.read(owner,f.task.id)).task.stage,'publish')
      await assert.rejects(()=>deferPublication(pool,publication.id,new PublicationDeferred(publication.id,'failed')),
        (error:unknown)=>error instanceof PublicationDeferred && error.state==='failed')
      await pool.query('DELETE FROM run_captures WHERE id=$1',[captureId])
      const before = await canonical.read(owner,f.task.id)
      const previous = (await pool.query('SELECT to_jsonb(p) AS value FROM factory_publications p WHERE id=$1',[publication.id])).rows[0].value
      const eventId = randomUUID(), binding = factoryBinding(before.task)
      const change = {action:'retry_publication' as const,publicationId:publication.id,reason:'Retry the failed publication after media loss'}
      const blocked = await canonical.apply(owner,binding,eventId,change)
      assert.equal(blocked.task.stage,'publish')
      assert.equal(blocked.task.status,'blocked')
      assert.equal(blocked.task.candidateId,before.task.candidateId)
      assert.equal(blocked.task.attemptId,before.task.attemptId)
      assert.equal(blocked.refusal?.code,'factory_visual_evidence_required')
      assert.equal(blocked.attempts.length,before.attempts.length,'the retry creates no new approval attempt')
      assert.deepEqual(blocked.attempts.filter(a=>a.id!==before.task.attemptId),before.attempts.filter(a=>a.id!==before.task.attemptId))
      assert.deepEqual((await pool.query('SELECT to_jsonb(p) AS value FROM factory_publications p WHERE id=$1',[publication.id])).rows[0].value,previous)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM factory_approvals WHERE "taskId"=$1',[f.task.id])).rows[0].n,1)
      assert.deepEqual(await canonical.apply(owner,binding,eventId,change),blocked,'the failed retry receipt is immutable and idempotent')
    }))

    await t.test('visual refusal, resumed handoff, activity and private file reads use the same candidate evidence', async () => application.run(async () => {
      const evidenceTask = await fixture(), producer = await run(evidenceTask,1), reviewer = await run(evidenceTask,2,'review','advance')
      const candidateId = randomUUID(), sha = 'd'.repeat(40), sessionId = `activity-producer-${producer.runId}`
      const evidenceStore = createFactoryStore(pool,authorize,bot,{onTransition:syncFactoryPresentation})
      await pool.query(`UPDATE agent_runs SET "sessionId"=$2,"stopReason"='submitted',report=$3 WHERE id=$1`,
        [producer.runId,sessionId,JSON.stringify({sourceCommit:sha,summary:'Observed the local API response.',filesChanged:[],
          criteria:[{criterionId:'api',text:'API response',status:'passed',passed:true,evidence:'Local API returned the expected result.'}],verify:{status:'passed'}})])
      await pool.query(`UPDATE agent_runs SET "sessionId"=$2,"stopReason"='submitted',report=$3 WHERE id=$1`,
        [reviewer.runId,`activity-review-${reviewer.runId}`,JSON.stringify({summary:'Reviewed the API observations.',filesChanged:[],criteria:[],verify:{status:'passed'}})])
      await pool.query(`INSERT INTO factory_candidates(id,"taskId",kind,sha,repository,environment,scope,"runId")
        VALUES($1,$2,'report',$3,'','fixture',$4,$5)`,[candidateId,evidenceTask.task.id,sha,`issue:${evidenceTask.issueId}`,producer.runId])
      await pool.query(`UPDATE factory_attempts SET "candidateId"=$2,"sessionId"=$3 WHERE id=$1`,[producer.attemptId,candidateId,sessionId])
      await pool.query(`UPDATE factory_attempts SET "candidateId"=$2,"sessionId"=$3 WHERE id=$1`,[reviewer.attemptId,candidateId,`activity-review-${reviewer.runId}`])
      await pool.query('UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1',[evidenceTask.task.id,candidateId])
      const initial = (await pool.query<{revision:number}>('SELECT revision FROM factory_tasks WHERE id=$1',[evidenceTask.task.id])).rows[0]
      const blocked = await evidenceStore.apply(owner,{taskId:evidenceTask.task.id,revision:initial.revision},randomUUID(),
        {action:'advance',stage:'approval',reason:'Hand over reviewed API observations'})
      assert.equal(blocked.task.status,'blocked')
      assert.equal(blocked.refusal?.code,'factory_visual_evidence_required')
      const refused = await handleFactoryActivity(pool,evidenceStore,{userId:owner,taskId:evidenceTask.task.id})
      assert.equal(refused.status,200)
      assert.ok('task' in refused.body)
      assert.equal(refused.body.task.needsYou?.kind,'blocked')
      assert.equal(refused.body.task.acceptance,null)

      const wrongIssueCaptureId = await capture(another.issueId,producer.runId)
      const evidence: FactoryEvidence = { artifact:captureArtifact(wrongIssueCaptureId),kind:'screenshot',runId:producer.runId,
        sessionId,candidateId,sha,environment:'fixture',recordedAt:new Date().toISOString() }
      const tx = await pool.connect()
      try {
        await tx.query('BEGIN')
        const task = await evidenceStore.lockTask(tx,owner,evidenceTask.task.id)
        await assert.rejects(()=>readFactoryArtifact(tx,task,evidence),{code:'factoryArtifactMissing'},
          'the evidence reader refuses a capture that names another issue')
        assert.deepEqual(await runCaptureEvidence(tx,{id:producer.runId,userId:owner},evidence),[],
          'automatic completion collection cannot introduce a misbound capture')
        await tx.query(`UPDATE factory_tasks SET stage='execute',status='running',"attemptId"=$2 WHERE id=$1`,[task.id,producer.attemptId])
        await tx.query(`UPDATE factory_attempts SET status='running' WHERE id=$1`,[producer.attemptId])
        await assert.rejects(()=>evidenceStore.apply(owner,{taskId:task.id,revision:task.revision},randomUUID(),
          {action:'finish',status:'passed',reason:'Submit a cross-issue capture',evidence:[evidence],output:{}},tx),
        {code:'factoryArtifactMissing'},'explicit completion evidence must satisfy the same issue boundary')
      } finally {await tx.query('ROLLBACK');tx.release()}
      assert.equal((await evidenceStore.resumeEvidenceHandoff(owner,producer.runId))?.task.status,'blocked',
        'a stored capture naming a different issue cannot satisfy the handoff gate')
      const screenshotId = await capture(evidenceTask.issueId,producer.runId)
      const videoId = randomUUID(), video = await readFile(new URL('../../tests/fixtures/factory-visual-evidence.mp4',import.meta.url))
      await pool.query(`INSERT INTO run_captures(id,"userId","runId","issueId",kind,"contentType",source,status,title,"storageKey","inlineContent",size,sha256,"durationMs")
        VALUES($1,$2,$3,$4,'video','video/mp4','local','ready','API result recording',$5,$6,$7,$8,1200)`,
        [videoId,owner,producer.runId,evidenceTask.issueId,`fixture/${videoId}.mp4`,video,video.length,createHash('sha256').update(video).digest('hex')])
      const resumed = await evidenceStore.resumeEvidenceHandoff(owner,producer.runId)
      assert.equal(resumed?.task.stage,'approval')
      assert.equal(resumed?.task.status,'pending')
      const reader = await pool.connect()
      try {
        assert.deepEqual((await runCaptureEvidence(reader,{id:producer.runId,userId:owner},evidence)).map(item=>item.artifact).sort(),
          [captureArtifact(screenshotId),captureArtifact(videoId)].sort())
        const source = await readFactoryArtifact(reader,resumed!.task,{...evidence,artifact:captureArtifact(screenshotId),recordedAt:new Date().toISOString()})
        assert.equal(source.capture?.captureId,screenshotId)
      } finally {reader.release()}
      assert.equal(await evidenceStore.resumeEvidenceHandoff(owner,producer.runId),null,'the same evidence event cannot repeat handoff')
      const response = await handleFactoryActivity(pool,evidenceStore,{userId:owner,taskId:evidenceTask.task.id})
      assert.equal(response.status,200)
      assert.ok('artifacts' in response.body)
      const view = response.body, acceptance = view.task.acceptance
      assert.ok(acceptance)
      assert.equal(acceptance.candidateId,candidateId)
      assert.equal(acceptance.runId,producer.runId)
      assert.deepEqual(acceptance.media.map(item=>item.captureId).sort(),[screenshotId,videoId].sort(),
        'a capture misbound to a different issue cannot enter the report or its activity projection')
      const files = view.artifacts.filter((item): item is Extract<typeof item,{captureId:string}> => 'captureId' in item)
      assert.deepEqual(files.map(item=>item.captureId).sort(),[screenshotId,videoId].sort())
      const report = view.artifacts.find(item=>item.kind==='acceptance')
      assert.ok(report && report.kind==='acceptance')
      assert.equal(report.artifactId,acceptance.artifactId)
      assert.equal(report.version,acceptance.version)
      assert.equal(report.candidateId,candidateId)
      assert.equal(report.runId,producer.runId)
      assert.match(report.downloadUrl,new RegExp(`/api/artifacts/${report.artifactId}/versions/${report.version}/download$`))
      const content = await readArtifactContent({id:owner,[tokenWorkspace]:workspace.id},report.artifactId,report.version)
      assert.ok(content)
      assert.ok(content.content.includes(candidateId) && content.content.includes(producer.runId))
      for (const item of acceptance.media) {
        assert.ok(content.content.includes(item.url))
        assert.equal(item.candidateId,candidateId)
        assert.equal(item.appliesToCurrentCandidate,true)
      }
      assert.ok(!content.content.includes(wrongIssueCaptureId))
      assert.equal(await readArtifactContent({id:other,[tokenWorkspace]:workspace.id},report.artifactId,report.version),null)
      const unrelatedWorkspace = await seedWorkspace(pool,owner,[{userId:owner,role:'admin'}])
      assert.equal(await readArtifactContent({id:owner,[tokenWorkspace]:unrelatedWorkspace.id},report.artifactId,report.version),null)

      const download = createCaptureDownloads(pool)
      for (const file of files) {
        await authorizeFactoryTaskCapture(pool,evidenceStore,owner,evidenceTask.task.id,file.captureId)
        const read = await download(new Request(new URL(file.url,'http://127.0.0.1')),owner,file.captureId)
        assert.ok(read)
        assert.equal(read.status,200)
        assert.equal(read.headers.get('content-type'),file.contentType)
        assert.deepEqual(Buffer.from(await read.arrayBuffer()),file.kind==='video'?video:png)
      }
      const recording = files.find(item=>item.kind==='video')!
      const range = await download(new Request(new URL(recording.url,'http://127.0.0.1'),{headers:{range:'bytes=0-31'}}),owner,videoId)
      assert.equal(range?.status,206)
      assert.deepEqual(Buffer.from(await range!.arrayBuffer()),video.subarray(0,32),'the returned recording can seek to its stored bytes')
      await assert.rejects(()=>authorizeFactoryTaskCapture(pool,evidenceStore,owner,evidenceTask.task.id,wrongIssueCaptureId),{code:'factoryNotFound'})
      await assert.rejects(()=>authorizeFactoryTaskCapture(pool,evidenceStore,other,evidenceTask.task.id,videoId),{code:'factoryNotFound'})
      const saved = (await pool.query('SELECT state FROM issue_documents WHERE "issueId"=$1',[evidenceTask.issueId])).rows[0]
      const document = loadIssueDocument(saved.state,{type:'doc',content:[]})
      try {
        const messages = readIssueThreads(document).flatMap(thread=>thread.messages)
        const handoff = messages.find(message=>message.body.includes(`?artifact=${report.artifactId}`))
        assert.ok(handoff)
        for (const item of acceptance.media) assert.ok(handoff.body.includes(item.url))
        assert.ok(!handoff.body.includes(wrongIssueCaptureId))
      } finally {document.destroy()}
    }))
  } finally {
    await application.close()
    await closeWorkspace()
    await pool.end()
    await dropTestDatabase(admin,name)
    await admin.end()
  }
})
