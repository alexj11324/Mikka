import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Run after the official World setup in the disposable self-hosted PG17 lane.
const eveRequire = createRequire(new URL('../../apps/eve/package.json', import.meta.url))
const worldEntry = eveRequire.resolve('@workflow/world-postgres')
const worldRequire = createRequire(worldEntry)
const { Pool } = worldRequire('pg')
const { ulid } = worldRequire('ulid')
const { createEventsStorage } = await import(pathToFileURL(join(dirname(worldEntry), 'storage.js')))
const { createClient } = await import(pathToFileURL(join(dirname(worldEntry), 'drizzle/index.js')))

function fixture(t) {
  assert.equal(process.platform, 'linux', 'The World regression requires the isolated Linux acceptance environment')
  assert.equal(process.env.MIKKA_SELF_HOSTED_ACCEPTANCE, '1', 'Disposable acceptance target required')
  assert.ok(URL.canParse(process.env.WORKFLOW_POSTGRES_URL), 'An explicit Workflow Postgres URL is required')
  const target = new URL(process.env.WORKFLOW_POSTGRES_URL)
  assert.ok(['postgres:', 'postgresql:'].includes(target.protocol))
  assert.ok(['postgres', '127.0.0.1', 'localhost'].includes(target.hostname), 'Only the disposable local PostgreSQL fixture is allowed')
  assert.equal(target.pathname, '/mikka', 'Use the self-hosted acceptance database')
  const options = { connectionString: target.href, max: 2, connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000, query_timeout: 8_000 }
  const reader = new Pool(options), writer = new Pool(options)
  const runId = 'wrun_' + ulid()
  t.after(async () => {
    try {
      await writer.query('delete from workflow.workflow_events where run_id = $1', [runId])
      await writer.query('delete from workflow.workflow_event_slots where run_id = $1', [runId])
      await writer.query('delete from workflow.workflow_runs where id = $1', [runId])
    } finally {
      await Promise.all([reader.end(), writer.end()])
    }
  })
  return { reader, writer, runId, events: createEventsStorage(createClient(writer)) }
}

async function assertPg17(pool) {
  const { rows } = await pool.query("select current_setting('server_version_num')::integer as version")
  assert.equal(Math.floor(rows[0].version / 10_000), 17, 'This regression runs against PostgreSQL 17')
}

const creation = specVersion => ({ eventType: 'run_created', specVersion,
  eventData: { workflowName: 'workflow//mikka//startup-race', deploymentId: 'startup-race-test', input: Uint8Array.of(1) } })

test('a spec 9 run committed between the first fence read and event listing includes a coherent fence', { timeout: 30_000 }, async t => {
  const { reader, writer, runId, events } = fixture(t)
  await assertPg17(writer)
  const query = reader.query.bind(reader)
  let committedBetweenReads = false
  reader.query = async (...args) => {
    const result = await query(...args)
    const statement = typeof args[0] === 'string' ? args[0] : args[0].text
    if (!committedBetweenReads && statement.includes('"workflow_event_slots"') && statement.includes('"seq_in_band"')) {
      assert.equal(result.rows.length, 0, 'The reader must observe the run before its creation commits')
      // Preserve the actual empty result, but commit the real creation before
      // Drizzle can issue its next statement on the independent reader pool.
      await events.create(runId, creation(9))
      committedBetweenReads = true
    }
    return result
  }
  const page = await createEventsStorage(createClient(reader)).list({ runId, pagination: { limit: 10, sortOrder: 'asc' } })
  assert.equal(committedBetweenReads, true, 'The concurrent creation barrier must have run')
  assert.equal(page.data.length, 1)
  assert.equal(page.data[0].runId, runId)
  assert.equal(page.data[0].eventType, 'run_created')
  assert.equal(page.data[0].specVersion, 9)
  assert.deepEqual(page.snapshot, { seq: 1, seqInBand: 1 })
})

test('a retained pre-slot event log still omits the fence snapshot', { timeout: 30_000 }, async t => {
  const { writer, runId, events } = fixture(t)
  await assertPg17(writer)
  await events.create(runId, creation(8))
  // Match persisted pre-slot history: ULID event ids and no slot marker.
  await writer.query('update workflow.workflow_events set id = $1 where run_id = $2', ['wevt_' + ulid(), runId])
  await writer.query('delete from workflow.workflow_event_slots where run_id = $1', [runId])
  const page = await events.list({ runId, pagination: { limit: 10, sortOrder: 'asc' } })
  assert.equal(page.data.length, 1)
  assert.equal(page.data[0].eventType, 'run_created')
  assert.equal(page.snapshot, undefined)
})
