import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pushReasons } from './push-reasons'

test('a reply to the person is never pushed', () => {
  assert.deepEqual(pushReasons([{ kind: 'user_message', tier: 'attention' }, { kind: 'run_question', tier: 'attention' }]), [])
})

test('an event that needs the person is a decision', () => {
  assert.deepEqual(pushReasons([{ kind: 'run_blocked', tier: 'attention' }]), ['decide'])
})

test('a finished run or handed-over artifact is a finished push', () => {
  assert.deepEqual(pushReasons([{ kind: 'run_finished', tier: 'result' }, { kind: 'artifact_submitted', tier: 'result' }]), ['finished'])
})

test('background events push nothing', () => {
  assert.deepEqual(pushReasons([{ kind: 'run_report', tier: 'background' }, { kind: 'issue_done', tier: 'background' }]), [])
})

test('both reasons when a turn answers both', () => {
  assert.deepEqual(pushReasons([{ kind: 'run_finished', tier: 'result' }, { kind: 'run_question', tier: 'attention' }]).sort(), ['decide', 'finished'])
})

test('the morning briefing is a briefing push, a handed-over matter a decision', () => {
  assert.deepEqual(pushReasons([{ kind: 'daily_briefing', tier: 'attention' }]), ['briefing'])
  assert.deepEqual(pushReasons([{ kind: 'matter_handoff', tier: 'attention' }]), ['decide'])
})
