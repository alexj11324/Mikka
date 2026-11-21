import assert from 'node:assert/strict'
import test from 'node:test'
import { ISSUE_PRIORITY_CODES, ISSUE_STATUS_CODES } from './issue-meta'
import { statusDots, statusTones } from './status-appearance'
import {
  ISSUE_PRIORITY_MARKS, ISSUE_STATUS_MARKS, MARK_SHAPE_NAMES, MARK_TONE_NAMES, MARK_TONE_STATUS, NEEDS_YOU_MARK, PULL_REQUEST_MARKS,
  RUN_MARKS, THREAD_MARKS, markOfValue, markToneClass, priorityMarkOf, pullRequestMarkOf, runMarkOf, stateMarkTone, statusMarkOf, threadMarkOf,
} from './state-mark'
import { THREAD_GROUPS } from './thread-groups'

const domains = { status: ISSUE_STATUS_MARKS, priority: ISSUE_PRIORITY_MARKS, thread: THREAD_MARKS, run: RUN_MARKS, pullRequest: PULL_REQUEST_MARKS }

test('the vocabulary is closed and named once', () => {
  assert.equal(new Set(MARK_SHAPE_NAMES).size, MARK_SHAPE_NAMES.length, 'a shape is named once')
  assert.equal(new Set(MARK_TONE_NAMES).size, MARK_TONE_NAMES.length, 'a tone is named once')
  // Six domains, one vocabulary: every row of every table is a shape and a tone the vocabulary knows.
  for (const [domain, table] of Object.entries(domains)) {
    for (const [key, mark] of Object.entries(table)) {
      assert.ok(MARK_SHAPE_NAMES.includes(mark.shape), `${domain}.${key} uses a shape of the vocabulary`)
      assert.ok(MARK_TONE_NAMES.includes(mark.tone), `${domain}.${key} uses a tone of the vocabulary`)
    }
  }
})

test('every status, priority, group, run and pull request resolves', () => {
  for (const status of ISSUE_STATUS_CODES) assert.deepEqual(statusMarkOf(status), ISSUE_STATUS_MARKS[status])
  for (const priority of ISSUE_PRIORITY_CODES) assert.deepEqual(priorityMarkOf(priority), ISSUE_PRIORITY_MARKS[priority])
  for (const group of THREAD_GROUPS) assert.equal(threadMarkOf(group).shape, THREAD_MARKS[group].shape)
  for (const indicator of ['working', 'waiting', 'error'] as const) assert.deepEqual(runMarkOf(indicator), RUN_MARKS[indicator])
  for (const state of ['open', 'draft', 'merged', 'closed'] as const) assert.deepEqual(pullRequestMarkOf(state), PULL_REQUEST_MARKS[state])
  // An unknown key falls back rather than throwing, and a key Object.prototype would answer for is not a key.
  assert.deepEqual(statusMarkOf('nope'), ISSUE_STATUS_MARKS.backlog)
  assert.deepEqual(statusMarkOf('toString'), ISSUE_STATUS_MARKS.backlog)
  assert.deepEqual(priorityMarkOf('nope'), ISSUE_PRIORITY_MARKS.low)
})

test('a mark has exactly one tint, and it is a tint the theme has', () => {
  for (const tone of MARK_TONE_NAMES) {
    const mark = { shape: 'empty' as const, tone }
    const status = stateMarkTone(mark)
    assert.equal(status, MARK_TONE_STATUS[tone])
    assert.ok(statusTones[status], `${tone} has a badge tint`)
    assert.ok(statusDots[status], `${tone} has a dot`)
    assert.match(markToneClass[tone], /^text-/)
  }
})

test('the chip and the dot on one row read the same mark', () => {
  // The defect this replaces: an amber 进行中 chip beside a green dot. One lookup, so they cannot disagree.
  for (const status of ISSUE_STATUS_CODES) assert.equal(stateMarkTone(markOfValue(status)), stateMarkTone(ISSUE_STATUS_MARKS[status]), `${status}'s dot and chip agree`)
  assert.equal(stateMarkTone(markOfValue('doing')), 'warning')
  assert.equal(stateMarkTone(markOfValue('running')), 'warning')
  assert.equal(stateMarkTone(markOfValue('failed')), 'destructive')
  assert.equal(stateMarkTone(markOfValue('done')), stateMarkTone(ISSUE_STATUS_MARKS.done))
  assert.equal(stateMarkTone(markOfValue('nonsense')), 'neutral')
})

test('低 is neutral, and 紧急 is the only amber priority', () => {
  assert.equal(stateMarkTone(priorityMarkOf('low')), 'neutral')
  assert.equal(stateMarkTone(priorityMarkOf('normal')), 'neutral')
  assert.equal(stateMarkTone(priorityMarkOf('high')), 'neutral')
  assert.equal(stateMarkTone(priorityMarkOf('urgent')), 'warning')
  assert.equal(ISSUE_PRIORITY_MARKS.urgent.shape, 'urgent')
})

test('等你 is the hand, and it is not a status', () => {
  assert.deepEqual(NEEDS_YOU_MARK, { shape: 'hand', tone: 'blue' })
  assert.deepEqual(THREAD_MARKS.waiting, NEEDS_YOU_MARK, 'a waiting thread shows the same hand')
  assert.ok(!(ISSUE_STATUS_CODES as readonly string[]).includes('needs-you'), 'no status draws it')
})
