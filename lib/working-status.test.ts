import assert from 'node:assert/strict'
import test from 'node:test'
import { agentIsWorking, workersKey, workingAvatars, workingLabel } from './working-status'

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
