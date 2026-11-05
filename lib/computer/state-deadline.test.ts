import assert from 'node:assert/strict'
import test from 'node:test'
import { computerLiveState, computerReadDeadline } from './state-deadline'
import { computerStateSchema } from '@mikka/protocol/computer'

const workspaceId = '30000000-0000-4000-8000-000000000001'
test('computer deadlines choose the earliest observed expiry with a server-relative delay', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z')
  assert.deepEqual(computerLiveState(workspaceId, [new Date(now + 900_000), null, new Date(now + 300_000), new Date(now + 8_000)], now), {
    workspaceId, deadline: { at: '2030-01-01T00:00:08.000Z', afterMs: 8_000 },
  })
  assert.deepEqual(computerLiveState(workspaceId, [], now), { workspaceId })
  assert.deepEqual(computerLiveState(workspaceId, [new Date(now - 1_000)], now), {
    workspaceId, deadline: { at: '2029-12-31T23:59:59.000Z', afterMs: 0 },
  }, 'an elapsed observation has one stable deadline key, not a new periodic timer')
})

test('wire parsing preserves deadline metadata and remains compatible with mock or older responses', () => {
  const legacy = { machine: 'sleeping', control: 'idle' }
  assert.deepEqual(computerStateSchema.parse(legacy), legacy)
  const live = computerLiveState(workspaceId, [new Date('2030-01-01T00:00:08.000Z')], Date.parse('2030-01-01T00:00:00.000Z'))
  assert.deepEqual(computerStateSchema.parse({ ...legacy, live }), { ...legacy, live })
  assert.equal(computerStateSchema.safeParse({ ...legacy, live: { workspaceId: 'not-a-workspace' } }).success, false)
})

test('slow transport, cached remounts and a changed wall clock cannot restart an observed deadline', () => {
  const read = { machine: 'running' as const, control: 'agent' as const, requestedAt: 1_000,
    live: { workspaceId, deadline: { at: '2030-01-01T00:00:10.000Z', afterMs: 10_000 } } }
  assert.deepEqual(computerReadDeadline(read, 7_000), { at: read.live.deadline.at, afterMs: 4_000, observation: 1_000 })
  assert.deepEqual(computerReadDeadline(read, 10_000), { at: read.live.deadline.at, afterMs: 1_000, observation: 1_000 })
  assert.deepEqual(computerReadDeadline(read, 12_000), { at: read.live.deadline.at, afterMs: 0, observation: 1_000 })
  assert.deepEqual(computerReadDeadline({ ...read, requestedAt: undefined }, 12_000), { at: read.live.deadline.at, afterMs: 0 })
  assert.equal(computerReadDeadline({ machine: 'sleeping', control: 'idle' }, 12_000), undefined)
})

test('only a fresh response that still observes a future expiry can rearm the same deadline', () => {
  const at = '2030-01-01T00:00:10.000Z'
  const read = { machine: 'running' as const, control: 'agent' as const, requestedAt: 8_000,
    live: { workspaceId, deadline: { at, afterMs: 2_000 } } }
  assert.deepEqual(computerReadDeadline(read, 8_100), { at, afterMs: 1_900, observation: 8_000 })
  assert.deepEqual(computerReadDeadline(read, 8_500), { at, afterMs: 1_500, observation: 8_000 }, 'cached renders retain the consumed observation')
  const expired = { ...read, requestedAt: 10_500, live: { workspaceId, deadline: { at, afterMs: 0 } } }
  assert.deepEqual(computerReadDeadline(expired, 10_600), { at, afterMs: 0 }, 'an expired server observation cannot create a repeat-read loop')
})
