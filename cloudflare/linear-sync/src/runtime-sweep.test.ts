import { test } from 'node:test'
import assert from 'node:assert/strict'
import worker, { runRuntimeSweep } from './index'

test('shared minute tick is opt-in and never falls through to daily Linear', async () => {
  const waits: Promise<unknown>[] = []
  worker.scheduled({ cron: '* * * * *' }, {}, { waitUntil: promise => { waits.push(promise) } })
  assert.equal(waits.length, 0)
  worker.scheduled({ cron: '* * * * *' }, { MIKKA_RUNTIME_SWEEP_ENABLED: '1' }, { waitUntil: promise => { waits.push(promise) } })
  assert.equal(waits.length,1)
  await assert.rejects(waits[0],/runtimeSweepUnconfigured/)
})
test('runtime sweep targets an explicit HTTPS preview; auth cannot follow redirects', async () => {
  await assert.rejects(runRuntimeSweep({ CRON_SECRET: 'synthetic', MIKKA_RUNTIME_SWEEP_ORIGIN: 'http://localhost' }),/runtimeSweepOriginInvalid/)
  const previous = globalThis.fetch
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url),'https://frozen-preview.example/mikka/api/cron/runtime')
      assert.equal(init?.redirect,'error')
      assert.equal(new Headers(init?.headers).get('authorization'),'Bearer synthetic')
      return Response.json({ok:true})
    }
    await runRuntimeSweep({ CRON_SECRET:'synthetic',MIKKA_RUNTIME_SWEEP_ORIGIN:'https://frozen-preview.example' })
  } finally { globalThis.fetch=previous }
})
