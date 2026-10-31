import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import worker, { runSchedule, SCHEDULES, MINUTE_ENDPOINTS } from './index.mjs'

const SCHEDULE = '0 * * * *'

const env = { MIKKA_URL: 'https://mikka.example.test/mikka/', CRON_SECRET: 'worker-test-cron-secret' }

function recorder(status = 200, summary = {}) {
  const calls = []
  const fetcher = async (url, init) => {
    calls.push({ url, ...init })
    return Response.json(summary, { status })
  }
  return { calls, fetcher }
}

test('each schedule calls its endpoints and logs only whitelisted numeric counts', async t => {
  const logs = []
  t.mock.method(console, 'log', line => logs.push(line))
  const { calls, fetcher } = recorder(200, {
    zones: 2, due: 1, written: 1, empty: 0, skipped: 0, failed: 0, deferred: 3, pushed: 1, people: 4,
    CRON_SECRET: env.CRON_SECRET, unrelated: 100, title: env.CRON_SECRET, read: { gmail: 3 },
  })
  for (const [schedule, endpoint] of Object.entries(SCHEDULES)) {
    const before = calls.length
    assert.equal(await runSchedule(schedule, env, fetcher), 200)
    const endpoints = schedule === '* * * * *' ? MINUTE_ENDPOINTS : [endpoint]
    assert.deepEqual(calls.slice(before).map(call => call.url), endpoints.map(path => `https://mikka.example.test/mikka${path}`))
    for (const call of calls.slice(before)) {
      assert.deepEqual(call.headers, { authorization: `Bearer ${env.CRON_SECRET}` })
      assert.equal(call.redirect, 'manual')
      assert.ok(call.signal instanceof AbortSignal)
    }
  }
  const endpoints = [...MINUTE_ENDPOINTS, ...Object.entries(SCHEDULES).filter(([cron]) => cron !== '* * * * *').map(([, path]) => path)]
  assert.equal(calls.length, endpoints.length)
  assert.deepEqual(logs, endpoints.map(path => `${path} 200 {"zones":2,"due":1,"written":1,"empty":0,"skipped":0,"failed":0,"deferred":3,"pushed":1,"people":4}`))
})

test('invalid count values and malformed responses never leak content to logs or errors', async t => {
  const logs = []
  t.mock.method(console, 'log', line => logs.push(line))
  const { fetcher } = recorder(200, { people: env.CRON_SECRET, failed: { github: 1 }, due: -1, pushed: 1.5, written: null })
  await runSchedule(SCHEDULE, env, fetcher)
  assert.deepEqual(logs, [`${SCHEDULES[SCHEDULE]} 200 {}`])
  await assert.rejects(runSchedule(SCHEDULE, env, async () => new Response(env.CRON_SECRET)), {
    message: `${SCHEDULES[SCHEDULE]} returned invalid JSON`,
  })
  assert.equal(logs.length, 1)
})

test('wake recovery exposes started and exhausted counts in existing Worker logs', async t => {
  const logs = []
  t.mock.method(console, 'log', line => logs.push(line))
  const { fetcher } = recorder(200, { due: 3, started: 1, failed: 1, deferred: 1, exhausted: 2, eventId: 'private-event-id' })
  await runSchedule('* * * * *', env, fetcher)
  assert.deepEqual(logs, MINUTE_ENDPOINTS.map(path => `${path} 200 {"due":3,"failed":1,"deferred":1,"started":1,"exhausted":2}`))
})

test('a failed wake sweep still waits for schedule execution and lease recovery', async t => {
  t.mock.method(console, 'log', () => {})
  const calls = []
  let finishSchedules
  const held = new Promise(resolve => { finishSchedules = resolve })
  let settled = false
  const tick = runSchedule('* * * * *', env, async url => {
    const path = new URL(url).pathname.replace('/mikka', '')
    calls.push(path)
    if (path === MINUTE_ENDPOINTS[0]) return new Response(null, { status: 503 })
    if (path === MINUTE_ENDPOINTS[1]) await held
    return Response.json({ owners: 1, materialized: 2, executed: 2, reported: 1 })
  }).finally(() => { settled = true })
  const failure = assert.rejects(tick, /coordinator-wakes answered 503/)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, MINUTE_ENDPOINTS)
  assert.equal(settled, false)
  finishSchedules()
  await failure
})

test('wrangler uploads the native module with every production schedule', () => {
  const source = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
  const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ''))
  assert.equal(config.main, 'src/index.mjs')
  assert.equal(config.workers_dev, false)
  assert.equal(config.preview_urls, false)
  assert.equal(config.routes, undefined)
  assert.deepEqual(config.triggers.crons, Object.keys(SCHEDULES))
  assert.deepEqual(config.vars, { MIKKA_URL: 'https://app.aspectlylabs.com/mikka' })
})

test('unknown schedules and missing configuration fail without a request', async () => {
  const { calls, fetcher } = recorder()
  await assert.rejects(runSchedule('*/5 * * * *', env, fetcher), /Unknown/)
  await assert.rejects(runSchedule(SCHEDULE, { MIKKA_URL: env.MIKKA_URL }, fetcher), /must be set/)
  await assert.rejects(runSchedule(SCHEDULE, { CRON_SECRET: env.CRON_SECRET }, fetcher), /must be set/)
  assert.equal(calls.length, 0)
})

test('HTTP and network failures reject without exposing a body or underlying error', async () => {
  for (const [schedule, endpoint] of Object.entries(SCHEDULES)) {
    for (const status of [301, 302, 303, 307, 308, 401, 503]) {
      const { fetcher } = recorder(status)
      await assert.rejects(runSchedule(schedule, env, fetcher), { message: `${endpoint} answered ${status}` })
    }
    await assert.rejects(runSchedule(schedule, env, async () => { throw new Error(env.CRON_SECRET) }), { message: `${endpoint} request failed` })
  }
})

test('scheduled execution passes its failure to waitUntil and serves no public HTTP route', async t => {
  const { fetcher } = recorder(401)
  t.mock.method(globalThis, 'fetch', fetcher)
  const pending = []
  worker.scheduled({ cron: SCHEDULE }, env, { waitUntil: promise => pending.push(promise) })
  assert.equal(pending.length, 1)
  await assert.rejects(pending[0], /401/)
  assert.equal(worker.fetch().status, 404)
})
