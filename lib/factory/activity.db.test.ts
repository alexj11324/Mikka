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
  } finally {
    await pool.end()
    await dropTestDatabase(admin,name)
    await admin.end()
  }
})
