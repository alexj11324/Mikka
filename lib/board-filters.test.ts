import assert from 'node:assert/strict'
import test from 'node:test'
import { personFilters } from './board-filters'

const me = 'user-me'
const task = (ownerId: string, assignee: { id: string } | null) => ({ ownerId, metadata: { assignee } })

test('负责人 我 matches the assignee only, never the creator', () => {
  assert.equal(personFilters(task(me, null), me).assignee, false)
  assert.equal(personFilters(task(me, { id: 'user-other' }), me).assignee, false)
  assert.equal(personFilters(task(me, { id: 'agent-mine' }), me).assignee, false)
  assert.equal(personFilters(task('user-other', { id: me }), me).assignee, true)
})

test('我创建的 matches the tasks the person created, whoever is assigned', () => {
  assert.equal(personFilters(task(me, null), me).creator, true)
  assert.equal(personFilters(task(me, { id: 'user-other' }), me).creator, true)
  assert.equal(personFilters(task('user-other', { id: me }), me).creator, false)
})
