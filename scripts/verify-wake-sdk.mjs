// Actual installed Workflow SDK + compiled Next workflow. No model/provider.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Pool } from 'pg'
import { start } from 'workflow/api'
import { getWorld } from 'workflow/runtime'
import { CoordinatorInbox, isolatedInboxOptions, wakeFixture } from '../lib/coordinator/wake-test-helpers.ts'

const url = process.env.WAKE_TEST_DATABASE_URL,
  origin = process.env.WORKFLOW_LOCAL_BASE_URL
if (
  !url ||
  new URL(url).hostname !== '127.0.0.1' ||
  !new URL(url).pathname.endsWith('_176') ||
  process.env.WORKFLOW_TARGET_WORLD !== 'local' ||
  origin !== 'http://127.0.0.1:3177/mikka' ||
  !['/workspace/176-private-evidence/', '/tmp/mikka-sdk-176-'].some((prefix) =>
    process.env.WORKFLOW_LOCAL_DATA_DIR?.startsWith(prefix),
  ) ||
  [
    'VERCEL',
    'AI_GATEWAY_API_KEY',
    'DECISION_GATEWAY_API_KEY',
    'OPENCODE_API_KEY',
    'OPENAI_API_KEY',
    'COMPOSIO_API_KEY',
  ].some((k) => process.env[k])
)
  throw new Error('isolated keyless Local World only')
const manifest = JSON.parse(readFileSync('.next/diagnostics/workflows-manifest.json', 'utf8'))
const reference = manifest.workflows['workflows/coordinator/workflow.ts'].coordinatorTurn
assert.ok(reference.workflowId)
const pool = new Pool({ connectionString: url }),
  members = new Pool({ connectionString: url }),
  world = await getWorld(),
  runs = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = (data) => console.log(JSON.stringify({ at: new Date().toISOString(), ...data }))
const inbox = new CoordinatorInbox(
  pool,
  isolatedInboxOptions(pool, members, () => new Date()),
)
async function wait(fn, label, ms = 45000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return
    await sleep(100)
  }
  throw new Error(`timeout: ${label}`)
}
async function ready() {
  await wait(
    async () => {
      try {
        return (await fetch(`${origin}/api/auth/get-session`)).status === 200
      } catch {
        return false
      }
    },
    'Next ready',
    15000,
  )
}
async function fixture() {
  const f = await wakeFixture(pool),
    holder = randomUUID()
  const receipt = await inbox.take(f.owner, holder)
  assert.ok(receipt.delivery)
  await inbox.checkpoint(f.owner, holder, receipt.delivery, [
    {
      role: 'assistant',
      content: 'Controlled pre-existing checkpoint; actual Workflow publication, no model generation.',
    },
  ])
  await inbox.fail(f.owner, holder, receipt.delivery)
  await sleep(150)
  const c = await inbox.claim(f.owner)
  assert.ok(c && 'delivery' in c)
  return { ...f, delivery: c.delivery }
}
async function launch(f) {
  const run = await start({ workflowId: reference.workflowId }, [f.owner, f.delivery])
  runs.push(run)
  return run
}
async function completed(run) {
  await wait(async () => {
    const status = await run.status
    if (['failed', 'cancelled'].includes(status)) throw new Error(`actual Workflow ${run.runId} ${status}`)
    return status === 'completed'
  }, run.runId)
  const steps = (await world.steps.list({ runId: run.runId, resolveData: 'none' })).data
  assert.ok(
    steps.every(
      (s) =>
        !s.stepName.includes('doGenerateStep') &&
        !s.stepName.includes('doStreamStep') &&
        !s.stepName.endsWith('//preparePrompt'),
    ),
  )
  return steps.map((s) => ({ name: s.stepName, status: s.status }))
}
async function oneResult(f) {
  const e = (
    await pool.query('SELECT wake_status,processed_at,wake_checkpoint_digest FROM coordinator_events WHERE id=$1', [
      f.eventId,
    ])
  ).rows[0]
  assert.equal(e.wake_status, 'completed')
  assert.ok(e.processed_at)
  assert.equal(
    (
      await pool.query(
        `SELECT count(*)::int n FROM coordinator_messages WHERE source_event_id=$1 AND message->>'role'='assistant'`,
        [f.eventId],
      )
    ).rows[0].n,
    1,
  )
  return e
}
try {
  await ready()
  log({
    phase: 'actual Local World ready',
    workflowVersion: JSON.parse(readFileSync('node_modules/workflow/package.json', 'utf8')).version,
    workflowId: reference.workflowId,
    cloudWorkflow: false,
    realModel: false,
    sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    nextBuildId: readFileSync('.next/BUILD_ID', 'utf8').trim(),
  })
  const duplicate = await fixture(),
    duplicates = await Promise.all(Array.from({ length: 10 }, () => launch(duplicate)))
  const duplicateSteps = await Promise.all(duplicates.map(completed))
  await oneResult(duplicate)
  log({
    phase: 'ten actual Workflow SDK starts; one logical publication',
    eventId: duplicate.eventId,
    runIds: duplicates.map((r) => r.runId),
    steps: duplicateSteps,
  })
  const restart = await fixture(),
    suffix = randomUUID().replaceAll('-', ''),
    sequence = `wake_sdk_seq_${suffix}`,
    fault = `wake_sdk_fault_${suffix}`
  await pool.query(`CREATE SEQUENCE ${sequence}`)
  await pool.query(
    `CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_event_id='${restart.eventId}'::uuid AND NEW.message->>'role'='assistant' THEN IF nextval('${sequence}')=1 THEN PERFORM pg_sleep(8); END IF; END IF; RETURN NEW; END $$`,
  )
  await pool.query(
    `CREATE TRIGGER ${fault} BEFORE INSERT ON coordinator_messages FOR EACH ROW EXECUTE FUNCTION ${fault}()`,
  )
  const run = await launch(restart)
  await wait(
    async () => (await pool.query(`SELECT is_called FROM ${sequence}`)).rows[0].is_called,
    'actual appendMessages reached publication',
  )
  execFileSync('docker', ['kill', '--signal', 'KILL', 'mikka176-sdk-next'], { stdio: 'ignore' })
  log({
    phase: 'actual Next Workflow worker SIGKILL during formal publication transaction',
    eventId: restart.eventId,
    runId: run.runId,
  })
  execFileSync('docker', ['start', 'mikka176-sdk-next'], { stdio: 'ignore' })
  await ready()
  // Do not cancel/terminate PostgreSQL: the dead Node connection must roll back
  // its transaction itself. Disabling the isolated sleep trigger waits for it.
  await pool.query(`ALTER TABLE coordinator_messages DISABLE TRIGGER ${fault}`)
  const steps = await completed(run)
  const result = await oneResult(restart)
  log({
    phase: 'same actual Workflow run recovered after OS restart; immutable checkpoint reused',
    eventId: restart.eventId,
    runId: run.runId,
    result,
    steps,
  })
  const deferred = await wakeFixture(pool),
    reservation = await inbox.claim(deferred.owner)
  assert.ok(reservation && 'delivery' in reservation)
  const deferredRun = await launch({ ...deferred, delivery: reservation.delivery }),
    deferredSteps = await completed(deferredRun)
  const state = (
    await pool.query(
      'SELECT wake_status,wake_error,wake_attempts,wake_generation_state,processed_at FROM coordinator_events WHERE id=$1',
      [deferred.eventId],
    )
  ).rows[0]
  assert.equal(state.wake_status, 'pending')
  assert.equal(state.wake_error, 'wakeAdmissionDeferred')
  assert.equal(state.wake_attempts, 0)
  assert.equal(state.wake_generation_state, 'not_started')
  assert.equal(state.processed_at, null)
  log({
    phase: 'actual Workflow defers without installed resource policy; no model and no retry spent',
    eventId: deferred.eventId,
    runId: deferredRun.runId,
    state,
    steps: deferredSteps,
  })
  const stopped = await wakeFixture(pool),
    device = randomUUID(),
    agent = randomUUID(),
    stoppedRun = randomUUID()
  await pool.query('INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,\'SDK stop fixture\')', [device, stopped.owner])
  await pool.query(
    'INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,\'SDK stop fixture\',\'codex\',$3)',
    [agent, stopped.owner, device],
  )
  await pool.query(
    'INSERT INTO agent_runs(id,"userId","agentId","deviceId",status,"stopRequestedAt") VALUES($1,$2,$3,$4,\'cancelled\',now())',
    [stoppedRun, stopped.owner, agent, device],
  )
  await pool.query('UPDATE coordinator_events SET "runId"=$2 WHERE id=$1', [stopped.eventId, stoppedRun])
  const stoppedClaim = await inbox.claim(stopped.owner)
  assert.ok(stoppedClaim && 'delivery' in stoppedClaim)
  const stoppedWorkflow = await launch({ ...stopped, delivery: stoppedClaim.delivery }),
    stoppedSteps = await completed(stoppedWorkflow)
  await oneResult(stopped)
  log({
    phase: 'actual Workflow publishes deterministic stopped notice without model or admission',
    eventId: stopped.eventId,
    runId: stoppedWorkflow.runId,
    steps: stoppedSteps,
  })
  log({
    result:
      'PASS actual installed Workflow SDK Local World + compiled Next steps; no cloud Workflow/model/harness call',
  })
} finally {
  for (const run of runs) {
    try {
      if (['pending', 'running'].includes(await run.status)) await run.cancel()
    } catch {}
  }
  await pool.end()
  await members.end()
}
