import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import worker, { ENDPOINT, runSchedule, SCHEDULE } from './index.mjs'

const env = { MIKKA_URL: 'https://mikka.example.test/mikka/', CRON_SECRET: 'worker-test-cron-secret' }

function recorder(status = 200) {
  const calls = []
  const fetcher = async (url, init) => {
    calls.push({ url, ...init })
    return new Response(env.CRON_SECRET, { status })
  }
  return { calls, fetcher }
}

test('the hourly schedule calls only GitHub backfill and logs no response body or secret', async t => {
  const logs = []
  t.mock.method(console, 'log', line => logs.push(line))
  const { calls, fetcher } = recorder()
  assert.equal(await runSchedule(SCHEDULE, env, fetcher), 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `https://mikka.example.test/mikka${ENDPOINT}`)
  assert.deepEqual(calls[0].headers, { authorization: `Bearer ${env.CRON_SECRET}` })
  assert.equal(calls[0].redirect, 'error')
  assert.ok(calls[0].signal instanceof AbortSignal)
  assert.deepEqual(logs, [`${ENDPOINT} 200`])
})

test('wrangler uploads the native module with only the hourly production schedule', () => {
  const source = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
  const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ''))
  assert.equal(config.main, 'src/index.mjs')
  assert.equal(config.workers_dev, false)
  assert.equal(config.preview_urls, false)
  assert.equal(config.routes, undefined)
  assert.deepEqual(config.triggers.crons, [SCHEDULE])
  assert.deepEqual(config.vars, { MIKKA_URL: 'https://app.aspectlylabs.com/mikka' })
})

test('unknown schedules and missing configuration fail without a request', async () => {
  const { calls, fetcher } = recorder()
  await assert.rejects(runSchedule('*/15 * * * *', env, fetcher), /Unknown/)
  await assert.rejects(runSchedule(SCHEDULE, { MIKKA_URL: env.MIKKA_URL }, fetcher), /must be set/)
  await assert.rejects(runSchedule(SCHEDULE, { CRON_SECRET: env.CRON_SECRET }, fetcher), /must be set/)
  assert.equal(calls.length, 0)
})

test('HTTP and network failures reject without exposing a body or underlying error', async () => {
  for (const status of [401, 503]) {
    const { fetcher } = recorder(status)
    await assert.rejects(runSchedule(SCHEDULE, env, fetcher), { message: `${ENDPOINT} answered ${status}` })
  }
  await assert.rejects(runSchedule(SCHEDULE, env, async () => { throw new Error(env.CRON_SECRET) }), { message: `${ENDPOINT} request failed` })
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
