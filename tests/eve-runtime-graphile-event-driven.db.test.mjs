import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'

const databaseUrl = process.env.E2E_DATABASE_URL
const safeDatabase = disposableDatabase()
const worldEntry = fileURLToPath(new URL('../apps/eve/node_modules/@workflow/world-postgres/dist/queue.js', import.meta.url))
const worldRequire = createRequire(realpathSync(worldEntry))

test('Graphile event-driven workers wake on jobs, delayed run_at, retries and listener recovery without idle claims', {
  skip: !safeDatabase,
}, async () => {
  const { Pool } = worldRequire('pg')
  const { makeWorkerUtils } = worldRequire('graphile-worker')
  const { run } = worldRequire('graphile-worker')
  const pgPool = new Pool({ connectionString: databaseUrl, max: 12 })
  const schema = `graphile_event_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  const utils = await makeWorkerUtils({ pgPool, schema })
  const events = new EventEmitter()
  let claims = 0
  let retryAttempts = 0
  let listenerSuccesses = 0
  let listenerErrors = 0
  let listenerPid = null
  const completed = new Set()
  const waitUntil = async (predicate, timeoutMs = 10_000) => {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (predicate()) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.fail(`timed out waiting for Graphile event; completed=${[...completed].join(',')}`)
  }
  events.on('worker:getJob:start', () => { claims++ })
  events.on('pool:listen:success', ({ client }) => { listenerSuccesses++; listenerPid = client.processID })
  events.on('pool:listen:error', () => { listenerErrors++ })
  const taskList = {
    record: async payload => { completed.add(payload.id) },
    retry_once: async payload => {
      retryAttempts++
      if (retryAttempts === 1) throw new Error('expected first attempt to fail')
      completed.add(payload.id)
    },
  }
  let runner
  try {
    await utils.migrate()
    runner = await run({ pgPool, schema, pollInterval: 0, concurrency: 2, taskList, events, noHandleSignals: true })
    await waitUntil(() => listenerSuccesses > 0 && claims >= 2)
    await new Promise(resolve => setTimeout(resolve, 300))
    const idleClaims = claims
    await new Promise(resolve => setTimeout(resolve, 500))
    assert.equal(claims, idleClaims, 'idle workers must not repeat database job claims')

    await utils.addJob('record', { id: 'idle-enqueue' })
    await waitUntil(() => completed.has('idle-enqueue'))

    const drained = ['drain-1', 'drain-2', 'drain-3']
    await Promise.all(drained.map(id => utils.addJob('record', { id }, { queueName: 'event-drain' })))
    await waitUntil(() => drained.every(id => completed.has(id)))

    const dueAt = Date.now() + 700
    await utils.addJob('record', { id: 'delayed' }, { runAt: new Date(dueAt) })
    await waitUntil(() => completed.has('delayed'), 5_000)
    assert.ok(Date.now() >= dueAt - 100, 'delayed job must not run before run_at')

    await utils.addJob('retry_once', { id: 'retry' })
    await waitUntil(() => completed.has('retry'), 8_000)
    assert.equal(retryAttempts, 2, 'failed jobs must wake again at their durable retry run_at')

    await pgPool.query('select pg_terminate_backend($1)', [listenerPid])
    await waitUntil(() => listenerErrors > 0)
    const previousSuccesses = listenerSuccesses
    await utils.addJob('record', { id: 'reconnect-catchup' })
    await waitUntil(() => listenerSuccesses > previousSuccesses, 10_000)
    await waitUntil(() => completed.has('reconnect-catchup'))

    // run_at is the durable due event: process restart after its deadline must
    // recover it on the initial claim without any prior NOTIFY or idle polling.
    const restartDueAt = Date.now() + 500
    await utils.addJob('record', { id: 'process-restart-catchup' }, { runAt: new Date(restartDueAt) })
    await runner.stop()
    runner = undefined
    await new Promise(resolve => setTimeout(resolve, Math.max(0, restartDueAt - Date.now()) + 100))
    runner = await run({ pgPool, schema, pollInterval: 0, concurrency: 2, taskList, events, noHandleSignals: true })
    await waitUntil(() => completed.has('process-restart-catchup'))
  } finally {
    if (runner) await runner.stop().catch(() => {})
    await utils.release().catch(() => {})
    await pgPool.query(`drop schema if exists "${schema}" cascade`).catch(() => {})
    await pgPool.end()
  }
})


test('Postgres World wrapper defaults to zero idle claim polling', {
  skip: !safeDatabase,
}, async () => {
  const { Pool } = worldRequire('pg')
  const worldQueuePath = fileURLToPath(new URL('../apps/eve/node_modules/@workflow/world-postgres/dist/queue.js', import.meta.url))
  const { createQueue } = await import(pathToFileURL(worldQueuePath).href)
  const pgPool = new Pool({ connectionString: databaseUrl, max: 12 })
  const originalLocalBase = process.env.WORKFLOW_LOCAL_BASE_URL
  // A non-loopback test URL makes the World start its runner without waiting for
  // a local Workflow HTTP process; this test only exercises its idle queue path.
  process.env.WORKFLOW_LOCAL_BASE_URL = 'https://event-driven-test.invalid'
  let claims = 0
  let queue
  const connect = pgPool.connect.bind(pgPool)
  const instrument = client => {
    const query = client.query.bind(client)
    client.query = (...queryArgs) => {
      const statement = typeof queryArgs[0] === 'string' ? queryArgs[0] : queryArgs[0]?.text
      if (statement?.includes('with j as (') && statement.includes('_private_jobs')) claims++
      return query(...queryArgs)
    }
    return client
  }
  pgPool.connect = (...args) => {
    // pg exposes both Promise and callback connect overloads; preserve both.
    if (typeof args[0] === 'function') {
      return connect((error, client, release) => args[0](error, client ? instrument(client) : client, release))
    }
    return connect(...args).then(instrument)
  }
  const waitUntil = async predicate => {
    const end = Date.now() + 10_000
    while (Date.now() < end) {
      if (predicate()) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.fail(`timed out waiting for World worker; claimCount=${claims}`)
  }
  const waitForStableClaims = async (stableMs = 1_000) => {
    const end = Date.now() + 12_000
    let previous = claims
    let stableSince = Date.now()
    while (Date.now() < end) {
      await new Promise(resolve => setTimeout(resolve, 25))
      if (claims !== previous) {
        previous = claims
        stableSince = Date.now()
      } else if (Date.now() - stableSince >= stableMs) return
    }
    assert.fail(`World queue claims did not become idle; claimCount=${claims}`)
  }
  try {
    queue = createQueue({ queueConcurrency: 2, applicationManagedShutdown: true }, pgPool)
    await queue.start()
    await waitUntil(() => claims > 0)
    // World starts many workers asynchronously. Wait for all startup claims to
    // settle, then watch longer than the previous five-second idle interval.
    await waitForStableClaims()
    const startupClaims = claims
    await new Promise(resolve => setTimeout(resolve, 5_500))
    assert.equal(claims, startupClaims, 'the packaged Postgres World must not re-claim an empty queue on a timer')
  } finally {
    await queue?.close().catch(() => {})
    await pgPool.end()
    if (originalLocalBase === undefined) delete process.env.WORKFLOW_LOCAL_BASE_URL
    else process.env.WORKFLOW_LOCAL_BASE_URL = originalLocalBase
  }
})
