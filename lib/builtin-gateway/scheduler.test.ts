import assert from 'node:assert/strict'
import test from 'node:test'
import { schedulerConfig, startBuiltinScheduler } from './scheduler'

const env = { BETTER_AUTH_URL: 'https://self.example', CRON_SECRET: 'fixture-cron-secret' }

test('external scheduler and cloud deployment never start an in-process cron', () => {
  assert.deepEqual(schedulerConfig(env), { MIKKA_URL: 'https://self.example/mikka', CRON_SECRET: 'fixture-cron-secret' })
  for (const patch of [{ MIKKA_EXTERNAL_CRON: '1' }, { MIKKA_EDITION: 'cloud' }, { VERCEL: '1' }, { CRON_SECRET: '' }]) assert.equal(schedulerConfig({ ...env, ...patch }), null)
})

test('the minute trigger preserves existing cadence, auth, failure isolation and zero idle-minute reads', async t => {
  let now = Date.UTC(2026, 10, 7, 12, 1), leadershipReads = 0
  const calls: string[] = []
  const scheduler = startBuiltinScheduler({ env, now: () => now, async leader() { leadershipReads++; return true },
    fetch: async (input, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-cron-secret')
      const url = new URL(String(input))
      assert.equal(url.origin, 'https://self.example')
      calls.push(url.pathname)
      return url.pathname.endsWith('/ops-monitor') ? new Response(null, { status: 503 }) : Response.json({ due: 0 })
    },
  })
  t.after(() => scheduler.stop())
  await scheduler.tick()
  assert.equal(leadershipReads, 0)
  assert.equal(calls.length, 0)
  now = Date.UTC(2026, 10, 7, 12, 15)
  await scheduler.tick()
  assert.equal(leadershipReads, 1)
  assert.deepEqual(calls.sort(), ['/mikka/api/cron/briefings', '/mikka/api/cron/ops-monitor', '/mikka/api/cron/reconcile'])
  await scheduler.tick()
  assert.equal(leadershipReads, 1)
})
