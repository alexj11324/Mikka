import assert from 'node:assert/strict'
import test from 'node:test'
import { subscriptionNativeTiming } from './subscription-native-timing'

test('native timings retain fixed phases and durations without credentials or changing work', async () => {
  const lines: string[] = [], timing = subscriptionNativeTiming('request', 'private-run-identity', line => lines.push(line))
  const result = { body: 'private-provider-content' }
  assert.equal(await timing.measure('binding', async () => result), result)
  const original = new Error('private-provider-token')
  await assert.rejects(timing.measure('access', async () => { throw original }), error => error === original)
  timing.end('error'); timing.end('error')
  assert.equal(lines.length, 1)
  const record = JSON.parse(lines[0]!)
  assert.equal(record.operation, 'request')
  assert.match(record.runIdHash, /^[a-f0-9]{16}$/)
  assert.deepEqual(record.phases.map((row: { phase: string; outcome: string }) => [row.phase, row.outcome]), [['binding', 'ok'], ['access', 'error']])
  assert.ok(record.phases.every((row: { ms: number; startMs: number }) => row.ms >= 0 && row.startMs >= 0))
  assert.doesNotMatch(lines[0]!, /private-/)
})

test('unknown names, late callbacks and broken diagnostics do not change native work', async () => {
  const lines: string[] = [], timing = subscriptionNativeTiming('context', undefined, line => lines.push(line))
  assert.equal(await timing.measure('private-credential' as never, async () => 7), 7)
  timing.end('ok')
  await timing.measure('context', async () => 8)
  assert.deepEqual(JSON.parse(lines[0]!).phases, [])
  const unavailable = subscriptionNativeTiming('request', 'run', () => { throw new Error('logging unavailable') })
  assert.equal(await unavailable.measure('provider_headers', async () => 9), 9)
  assert.doesNotThrow(() => unavailable.end('ok'))
})

test('native timing receipts have a bounded size and mark omitted phases', async () => {
  const lines: string[] = [], timing = subscriptionNativeTiming('request', 'run', line => lines.push(line))
  for (let index = 0; index < 40; index++) await timing.measure('binding', async () => undefined)
  timing.end('ok')
  const record = JSON.parse(lines[0]!)
  assert.equal(record.phases.length, 32)
  assert.equal(record.truncated, true)
})
