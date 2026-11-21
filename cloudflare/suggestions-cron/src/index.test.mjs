import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import worker from './index.mjs'
import { runSchedule, QUARTER_HOUR } from './schedule.mjs'

const SCHEDULE = '0 * * * *'
const RECONCILE = '/api/cron/reconcile'
const SCHEDULES = { [QUARTER_HOUR]: RECONCILE, '*/15 * * * *': '/api/cron/briefings', [SCHEDULE]: '/api/cron/suggestions-reconcile', '30 * * * *': '/api/cron/user-facts' }
const ONE_PAST_HOUR = Date.UTC(2026, 0, 1, 0, 1)
// The half-hour tick runs the quarter-hour sweeps and user facts.
const HALF_PAST = Date.UTC(2026, 0, 1, 0, 30)
const HALF_PAST_EXTRA = ['/api/cron/ops-monitor', '/api/cron/briefings', '/api/cron/user-facts']

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
    const minuteTick = schedule === QUARTER_HOUR
    assert.equal(await runSchedule(schedule, env, fetcher, minuteTick ? HALF_PAST : ONE_PAST_HOUR), 200)
    const endpoints = minuteTick ? [RECONCILE, ...HALF_PAST_EXTRA] : [endpoint]
    assert.deepEqual(calls.slice(before).map(call => call.url), endpoints.map(path => `https://mikka.example.test/mikka${path}`))
    for (const call of calls.slice(before)) {
      assert.deepEqual(call.headers, { authorization: `Bearer ${env.CRON_SECRET}` })
      assert.equal(call.redirect, 'manual')
      assert.ok(call.signal instanceof AbortSignal)
    }
  }
  const endpoints = [RECONCILE, ...HALF_PAST_EXTRA, ...Object.entries(SCHEDULES).filter(([cron]) => cron !== QUARTER_HOUR).map(([, path]) => path)]
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
  await runSchedule(QUARTER_HOUR, env, fetcher, HALF_PAST)
  assert.deepEqual(logs, [RECONCILE, ...HALF_PAST_EXTRA].map(path => `${path} 200 {"due":3,"failed":1,"deferred":1,"started":1,"exhausted":2}`))
})

test('a failed safety-net sweep still waits for the other endpoints of that minute', async t => {
  t.mock.method(console, 'log', () => {})
  const calls = []
  let finishSchedules
  const held = new Promise(resolve => { finishSchedules = resolve })
  let settled = false
  const tick = runSchedule(QUARTER_HOUR, env, async url => {
    const path = new URL(url).pathname.replace('/mikka', '')
    calls.push(path)
    if (path === RECONCILE) return new Response(null, { status: 503 })
    if (path === HALF_PAST_EXTRA[0]) await held
    return Response.json({ owners: 1, materialized: 2, executed: 2, reported: 1 })
  }, HALF_PAST).finally(() => { settled = true })
  const failure = assert.rejects(tick, /reconcile answered 503/)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [RECONCILE, ...HALF_PAST_EXTRA])
  assert.equal(settled, false)
  finishSchedules()
  await failure
})

test('wrangler uses one native quarter-hour trigger for all existing production cadences', () => {
  const source = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
  const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ''))
  assert.equal(config.main, 'src/index.mjs')
  assert.equal(config.workers_dev, false)
  assert.equal(config.preview_urls, false)
  assert.equal(config.routes, undefined)
  assert.deepEqual(config.triggers.crons, ['0,15,30,45 * * * *'])
  assert.equal(config.triggers.crons[0], QUARTER_HOUR)
  assert.deepEqual(config.vars, {}, 'deployment supplies MIKKA_URL; source has no production target')
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
      await assert.rejects(runSchedule(schedule, env, fetcher, HALF_PAST), { message: `${endpoint} answered ${status}` })
    }
    await assert.rejects(runSchedule(schedule, env, async () => { throw new Error(env.CRON_SECRET) }, HALF_PAST), { message: `${endpoint} request failed` })
  }
})

test('scheduled execution reports its failure to Cloudflare and serves no public HTTP route', async t => {
  const { fetcher } = recorder(401)
  t.mock.method(globalThis, 'fetch', fetcher)
  await assert.rejects(worker.scheduled({ cron: SCHEDULE, scheduledTime: ONE_PAST_HOUR }, env), /401/)
  assert.equal(worker.fetch().status, 404)
})

test('a propagating legacy minute event retains cadences without duplicate endpoints', async t => {
  t.mock.method(console, 'log', () => {})
  for (const [minute, extra] of [
    [1, null],
    [15, ['/api/cron/ops-monitor', '/api/cron/briefings']],
    [30, ['/api/cron/ops-monitor', '/api/cron/briefings', '/api/cron/user-facts']],
    [45, ['/api/cron/ops-monitor', '/api/cron/briefings']],
    [0, ['/api/cron/ops-monitor', '/api/cron/briefings', '/api/cron/subscriptions', '/api/cron/suggestions-reconcile']],
  ]) {
    const { calls, fetcher } = recorder()
    await runSchedule('* * * * *', env, fetcher, Date.UTC(2026, 0, 1, 0, minute))
    const paths = calls.map(call => new URL(call.url).pathname.replace('/mikka', ''))
    assert.deepEqual(paths, extra ? [RECONCILE, ...extra] : [])
    assert.equal(new Set(paths).size, paths.length)
  }
})

test('scheduled dispatch uses the event timestamp even when wall time has advanced', async t => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(Date, 'now', () => Date.UTC(2026, 0, 1, 0, 31))
  const { calls, fetcher } = recorder()
  t.mock.method(globalThis, 'fetch', fetcher)
  await worker.scheduled({ cron: QUARTER_HOUR, scheduledTime: Date.UTC(2026, 0, 1, 0, 0) }, env)
  assert.deepEqual(calls.map(call => new URL(call.url).pathname.replace('/mikka', '')),
    [RECONCILE, '/api/cron/ops-monitor', '/api/cron/briefings', '/api/cron/subscriptions', '/api/cron/suggestions-reconcile'])
})

test('a complete UTC hour runs each reconciliation sweep and maintenance at its requested cadence', async t => {
  t.mock.method(console, 'log', () => {})
  const { calls, fetcher } = recorder()
  for (const minute of [0, 15, 30, 45]) {
    await runSchedule(QUARTER_HOUR, env, fetcher, Date.UTC(2026, 0, 1, 8, minute))
  }
  const counts = {}
  for (const call of calls) {
    const path = new URL(call.url).pathname.replace('/mikka', '')
    counts[path] = (counts[path] ?? 0) + 1
    assert.deepEqual(call.headers, { authorization: `Bearer ${env.CRON_SECRET}` })
    assert.equal(call.redirect, 'manual')
    assert.ok(call.signal instanceof AbortSignal)
  }
  assert.deepEqual(counts, {
    '/api/cron/reconcile': 4,
    '/api/cron/subscriptions': 1,
    '/api/cron/ops-monitor': 4,
    '/api/cron/briefings': 4,
    '/api/cron/suggestions-reconcile': 1,
    '/api/cron/user-facts': 1,
  })
})

test('maintenance failures still wait for every selected endpoint without leaking response content', async t => {
  t.mock.method(console, 'log', () => {})
  for (const [minute, failedPath] of [[15, '/api/cron/ops-monitor'], [0, '/api/cron/subscriptions']]) {
    const paths = []
    let finishSchedules
    const held = new Promise(resolve => { finishSchedules = resolve })
    let settled = false
    const tick = runSchedule(QUARTER_HOUR, env, async url => {
      const path = new URL(url).pathname.replace('/mikka', '')
      paths.push(path)
      if (path === RECONCILE) await held
      if (path === failedPath) return new Response(env.CRON_SECRET, { status: 503 })
      return Response.json({})
    }, Date.UTC(2026, 0, 1, 8, minute)).finally(() => { settled = true })
    const failure = assert.rejects(tick, { message: `${failedPath} answered 503` })
    await new Promise(resolve => setImmediate(resolve))
    const reconcile = minute === 0 ? ['/api/cron/suggestions-reconcile'] : []
    const hourly = minute === 0 ? ['/api/cron/subscriptions'] : []
    assert.deepEqual(paths, [RECONCILE, '/api/cron/ops-monitor', '/api/cron/briefings', ...hourly, ...reconcile])
    assert.equal(settled, false)
    finishSchedules()
    await failure
  }
})

test('the transition from the minute trigger preserves the same per-endpoint deliveries for a full hour', async t => {
  t.mock.method(console, 'log', () => {})
  const legacy = recorder(), current = recorder()
  for (let minute = 0; minute < 60; minute++) {
    const at = Date.UTC(2026, 0, 1, 8, minute)
    await runSchedule('* * * * *', env, legacy.fetcher, at)
    if (minute % 15 === 0) await runSchedule(QUARTER_HOUR, env, current.fetcher, at)
    assert.deepEqual(legacy.calls.map(c => c.url), current.calls.map(c => c.url))
  }
})

test('account deletion and audit retention are no longer swept on a schedule: their due timers and the safety net run them', async t => {
  t.mock.method(console, 'log', () => {})
  const { calls, fetcher } = recorder()
  for (let minute = 0; minute < 60; minute++) await runSchedule('* * * * *', env, fetcher, Date.UTC(2026, 0, 1, 8, minute))
  assert.equal(calls.filter(call => /\/api\/cron\/(account-deletions|audit-retention)$/.test(call.url)).length, 0)
})
