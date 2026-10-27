import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import worker, { runSchedule, SCHEDULES, type Env } from './index'

const env: Env = { MIKKA_URL: 'https://mikka.example.test/mikka/', CRON_SECRET: 'worker-test-cron-secret' }

function recorder(status = 200) {
  const calls: { url: string; authorization: string | null }[] = []
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') })
    return new Response('{}', { status })
  }) as typeof fetch
  return { calls, fetcher }
}

test('each cron calls its endpoint with the bearer secret', async () => {
  const { calls, fetcher } = recorder()
  await runSchedule('*/15 * * * *', env, fetcher)
  await runSchedule('0 * * * *', env, fetcher)
  assert.deepEqual(calls, [
    { url: 'https://mikka.example.test/mikka/api/cron/briefings', authorization: 'Bearer worker-test-cron-secret' },
    { url: 'https://mikka.example.test/mikka/api/cron/suggestions-reconcile', authorization: 'Bearer worker-test-cron-secret' },
  ])
})

test('the wrangler schedules match the endpoints', () => {
  const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
  const crons = JSON.parse(/"crons":\s*(\[[^\]]*\])/.exec(config)![1]) as string[]
  assert.deepEqual(crons.toSorted(), Object.keys(SCHEDULES).toSorted())
})

test('fails without configuration and calls nothing', async () => {
  const { calls, fetcher } = recorder()
  await assert.rejects(runSchedule('*/15 * * * *', { MIKKA_URL: env.MIKKA_URL }, fetcher))
  await assert.rejects(runSchedule('*/5 * * * *', env, fetcher))
  assert.equal(calls.length, 0)
})

test('a failed endpoint fails the run', async () => {
  const { fetcher } = recorder(401)
  await assert.rejects(runSchedule('0 * * * *', env, fetcher), /401/)
})

test('serves no HTTP routes', async () => {
  assert.equal(worker.fetch().status, 404)
})
