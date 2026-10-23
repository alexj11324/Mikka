import assert from 'node:assert/strict'
import test from 'node:test'
import { agentIsWorking, COALESCE_MS, createCoalescer, workersFromActiveAgents, nextTrackedWorkers, workersKey, workingAvatars, workingLabel } from './working-status'

test('workingLabel picks the key and params by count', () => {
  assert.equal(workingLabel([]), null)
  assert.deepEqual(workingLabel(['A']), { key: 'one', values: { a: 'A' } })
  assert.deepEqual(workingLabel(['A', 'B']), { key: 'two', values: { a: 'A', b: 'B' } })
  assert.deepEqual(workingLabel(['A', 'B', 'C']), { key: 'three', values: { a: 'A', b: 'B', c: 'C' } })
  assert.deepEqual(workingLabel(['A', 'B', 'C', 'D']), { key: 'many', values: { a: 'A', b: 'B', count: 2 } })
  assert.deepEqual(workingLabel(['A', 'B', 'C', 'D', 'E', 'F']), { key: 'many', values: { a: 'A', b: 'B', count: 4 } })
})

test('workingAvatars caps at three and counts the rest', () => {
  assert.deepEqual(workingAvatars([1, 2]), { shown: [1, 2], overflow: 0 })
  assert.deepEqual(workingAvatars([1, 2, 3]), { shown: [1, 2, 3], overflow: 0 })
  assert.deepEqual(workingAvatars([1, 2, 3, 4, 5]), { shown: [1, 2, 3], overflow: 2 })
})

test('agentIsWorking reads pending turns', () => {
  assert.equal(agentIsWorking(undefined), false)
  assert.equal(agentIsWorking({ turns: [{ id: '1', prompt: '', completion: '', status: 'complete', error: null }] }), false)
  assert.equal(agentIsWorking({ turns: [{ id: '1', prompt: '', completion: '', status: 'pending', error: null }] }), true)
})

test('workersKey is order sensitive and stable', () => {
  assert.equal(workersKey([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]), 'a|b')
  assert.equal(workersKey([]), '')
})

test('nextTrackedWorkers adds at once and removes after two missing polls', () => {
  const a = { id: 'a', name: 'A' }
  const b = { id: 'b', name: 'B' }
  let state = nextTrackedWorkers([], [a])
  assert.deepEqual(state.map(w => w.id), ['a'])
  state = nextTrackedWorkers(state, [a, b])
  assert.deepEqual(state.map(w => w.id), ['a', 'b'])
  state = nextTrackedWorkers(state, [b])
  assert.deepEqual(state.map(w => [w.id, w.misses]), [['a', 1], ['b', 0]])
  state = nextTrackedWorkers(state, [a, b])
  assert.deepEqual(state.map(w => [w.id, w.misses]), [['a', 0], ['b', 0]], 'a reappearing resets its misses')
  state = nextTrackedWorkers(state, [b])
  state = nextTrackedWorkers(state, [b])
  assert.deepEqual(state.map(w => w.id), ['b'])
  state = nextTrackedWorkers(state, [])
  state = nextTrackedWorkers(state, [])
  assert.deepEqual(state, [])
})

test('workersFromActiveAgents adapts the MIK-7 shape', () => {
  assert.deepEqual(workersFromActiveAgents(undefined), [])
  assert.deepEqual(workersFromActiveAgents({ agents: [{ id: 'x', name: 'X', avatarUrl: '/a.png', startedAt: '2026-10-22T00:00:00Z' }] }),
    [{ id: 'x', name: 'X', avatarUrl: '/a.png', startedAt: '2026-10-22T00:00:00Z' }])
})

test('createCoalescer only settles the last value within 300ms', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const settled: string[] = []
  const coalescer = createCoalescer<string>(COALESCE_MS, value => settled.push(value))
  coalescer.push('a')
  t.mock.timers.tick(100)
  coalescer.push('a|b')
  t.mock.timers.tick(299)
  coalescer.push('b')
  t.mock.timers.tick(299)
  assert.deepEqual(settled, [])
  t.mock.timers.tick(1)
  assert.deepEqual(settled, ['b'])
  coalescer.push('c')
  t.mock.timers.tick(300)
  assert.deepEqual(settled, ['b', 'c'])
  coalescer.push('d')
  coalescer.cancel()
  t.mock.timers.tick(1000)
  assert.deepEqual(settled, ['b', 'c'])
})
