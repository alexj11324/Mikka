import assert from 'node:assert/strict'
import test from 'node:test'
import { findLabel, matchLabels, uniqueLabels } from './workspace-labels'

const labels = uniqueLabels([
  { name: '前端', color: 'blue' }, { name: 'bug', color: 'red' }, { name: 'Bug', color: 'green' }, { name: 'backend', color: 'violet' },
])

test('one label per name without case, first colour wins, sorted', () => {
  assert.deepEqual(labels, [{ name: 'backend', color: 'violet' }, { name: 'bug', color: 'red' }, { name: '前端', color: 'blue' }])
})

test('a rule finds its label without case; an unknown label finds nothing', () => {
  assert.deepEqual(findLabel(labels, ' BUG '), { name: 'bug', color: 'red' })
  assert.equal(findLabel(labels, 'design'), undefined)
})

test('typing narrows the list; nothing typed lists every label', () => {
  assert.deepEqual(matchLabels(labels, 'b').map(label => label.name), ['backend', 'bug'])
  assert.deepEqual(matchLabels(labels, '  ').map(label => label.name), ['backend', 'bug', '前端'])
})
