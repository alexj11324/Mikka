import assert from 'node:assert/strict'
import test from 'node:test'
import { scopeFromProbability, scopeQuestions, scopeState, WORKSPACE_THRESHOLD } from './issue-scope'

test('only a confident judgment makes a workspace task', () => {
  assert.equal(scopeFromProbability(0.95), 'workspace')
  assert.equal(scopeFromProbability(WORKSPACE_THRESHOLD), 'workspace')
  assert.equal(scopeFromProbability(0.6), 'personal')
  assert.equal(scopeFromProbability(0), 'personal')
})

test('the question is one predicate named workspace', () => {
  const [question] = scopeQuestions()
  assert.equal(question.type, 'predicate')
  assert.equal(question.name, 'workspace')
})

test('earlier corrections go along as examples', () => {
  const state = scopeState({ title: 'Fix login', description: '', source: 'Telegram', linearTeam: { key: 'MIK', name: 'Mikka' }, examples: [{ title: 'Dentist', scope: 'personal' }, { title: 'Ship v2', scope: 'workspace' }] })
  assert.equal(state.linearTeam, 'MIK (Mikka)')
  assert.equal(state.earlierCorrections, '"Dentist" is a personal task; "Ship v2" is a workspace task')
  assert.equal(scopeState({ title: 'x', description: '', source: 'app', linearTeam: { key: 'MIK', name: 'Mikka' }, examples: [] }).earlierCorrections, undefined)
})
