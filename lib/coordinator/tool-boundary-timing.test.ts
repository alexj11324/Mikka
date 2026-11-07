import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { withCoordinatorStopTiming, withCoordinatorWebSearchTiming, type CoordinatorStopTiming, type CoordinatorWebSearchTiming } from './tool-boundary-timing'

const identity = async () => ({ workflowRunId: 'wrun_tool_boundary', stepId: 'step_web_search', attempt: 1 })
const PRIVATE = 'PRIVATE_TOOL_INPUT_RESULT_OR_ERROR'

test('web search records the actual body interval and a hashed call without changing its result', async () => {
  const lines: CoordinatorWebSearchTiming[] = []
  let clock = 100, calls = 0
  const result = { ok: true, results: [PRIVATE] }
  const actual = await withCoordinatorWebSearchTiming(async () => { calls++; clock = 220; return result }, PRIVATE,
    () => clock, line => lines.push(line), async () => { clock = 900; return identity() })
  assert.equal(actual, result); assert.equal(calls, 1)
  assert.deepEqual(lines, [{ msg: 'coordinator_tool_timing', tool: 'web_search', workflowRunId: 'wrun_tool_boundary',
    stepId: 'step_web_search', attempt: 1, callRef: createHash('sha256').update(PRIVATE).digest('hex').slice(0, 12),
    startedAt: 100, endedAt: 220, outcome: 'ok' }])
  assert.equal(JSON.stringify(lines).includes(PRIVATE), false)
})

test('unavailability and thrown failures remain distinct and no error or result content is logged', async () => {
  const lines: CoordinatorWebSearchTiming[] = []
  const unavailable = { ok: false, error: PRIVATE }
  assert.equal(await withCoordinatorWebSearchTiming(async () => unavailable, undefined, () => 1, line => lines.push(line), identity), unavailable)
  const failure = new Error(PRIVATE)
  await assert.rejects(withCoordinatorWebSearchTiming(async () => { throw failure }, 'call', () => 2, line => lines.push(line), identity), error => error === failure)
  assert.deepEqual(lines.map(line => line.outcome), ['unavailable', 'threw'])
  assert.equal(lines[0].callRef, null); assert.equal(JSON.stringify(lines).includes(PRIVATE), false)
})

test('a missing identity or broken tool logger never retries or replaces the underlying result/failure', async () => {
  let calls = 0
  const work = async () => { calls++; return { ok: true } }
  assert.deepEqual(await withCoordinatorWebSearchTiming(work, 'call', Date.now, () => { throw new Error(PRIVATE) }, identity), { ok: true })
  assert.deepEqual(await withCoordinatorWebSearchTiming(work, 'call', Date.now, () => assert.fail('identity failed'), async () => { throw new Error(PRIVATE) }), { ok: true })
  const original = new Error('original')
  await assert.rejects(withCoordinatorWebSearchTiming(async () => { calls++; throw original }, 'call', Date.now, () => { throw new Error(PRIVATE) }, identity), error => error === original)
  assert.equal(calls, 3)
})

test('Stop records only the server delivery interval, retaining return values and failure behavior', async () => {
  let clock = 300, deliveries = 0
  const lines: CoordinatorStopTiming[] = []
  const result = { delivered: true }
  assert.equal(await withCoordinatorStopTiming('wrun_tool_boundary', async () => { deliveries++; clock = 350; return result }, () => clock, line => lines.push(line)), result)
  assert.deepEqual(lines, [{ msg: 'coordinator_stop_timing', workflowRunId: 'wrun_tool_boundary', requestedAt: 300, acknowledgedAt: 350, outcome: 'accepted' }])
  const original = new Error(PRIVATE)
  await assert.rejects(withCoordinatorStopTiming('wrun_tool_boundary', async () => { deliveries++; throw original }, () => clock, line => lines.push(line)), error => error === original)
  assert.equal(lines.length, 1)
  assert.equal(await withCoordinatorStopTiming('wrun_tool_boundary', async () => { deliveries++; return true }, () => clock, () => { throw new Error(PRIVATE) }), true)
  assert.equal(deliveries, 3); assert.equal(JSON.stringify(lines).includes(PRIVATE), false)
})
