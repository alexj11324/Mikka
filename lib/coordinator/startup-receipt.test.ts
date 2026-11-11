import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentKitError } from '../agent-kit/store'
import {
  decodeStoredStartupReceipt, encodeStoredStartupReceipt, readStartupReceipt,
  type CoordinatorStartupReceipt, type CoordinatorStartupSettings,
} from '@/tests/support/legacy-coordinator-startup'

// Exercise the real codec and schemas. No database, transport, model or module
// mocks are needed; all identifiers and text below are synthetic metadata.
function emptyReceipt(): CoordinatorStartupReceipt {
  return {
    settings: {
      computerEnabled: true, mailboxEnabled: false, writeEnabled: true, agentKitEnabled: true,
      switches: { issueTools: false, factoryRouting: true, factoryLifecycle: false },
      runtime: { harness: 'ai_sdk' }, coordinator: true,
    },
    inbox: {
      held: true, added: 0, telegramTargets: [], handoffMatterIds: [], handoffOnly: false,
      pushEvents: [], pushHidesText: false,
    },
  }
}

function completeReceipt(): CoordinatorStartupReceipt {
  const value = emptyReceipt()
  value.inbox = {
    held: true, added: 4,
    telegramTargets: [
      { threadId: 'thread-a', telegramUserId: 'telegram-a', sourceEventIds: ['event-b', 'event-a'] },
      { threadId: 'thread-b', telegramUserId: 'telegram-b', sourceEventIds: ['event-c'] },
    ],
    handoffMatterIds: ['matter-b', 'matter-a'], handoffOnly: false,
    pushEvents: [
      { kind: 'user_message', tier: null, runId: null, issueId: null },
      { kind: 'run_question', tier: 'attention', runId: 'run-a', issueId: 'issue-a' },
      { kind: 'run_finished', tier: 'result', runId: 'run-b', issueId: 'issue-b' },
      { kind: 'matter_handoff', tier: 'background', runId: null, issueId: null },
    ],
    pushHidesText: true, taskEventId: 'task-event', sourceEventId: 'source-event',
    attentionQuestions: [
      { eventId: 'question-event-a', taskId: 'task-a', issueId: 'issue-a', questionId: 'question-a', runId: 'run-a' },
      { eventId: 'question-event-b', taskId: 'task-b', issueId: 'issue-b', questionId: 'question-b', runId: 'run-b' },
    ],
    scheduledRead: {
      occurrenceId: 'occurrence-a', leaseToken: 'synthetic-lease', allowedActions: ['read-b', 'read-a'],
      prompt: 'Synthetic scheduled text: "quoted", \\ slash, 中文\nSecond line.',
    },
    origin: 'telegram',
    originRef: { kind: 'telegram', chatId: 'chat-a', messageId: 7 },
  }
  return value
}

const jsonCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function throughJSON(value: CoordinatorStartupReceipt): CoordinatorStartupReceipt {
  const stored = jsonCopy({ version: 1, ...encodeStoredStartupReceipt(value) })
  return decodeStoredStartupReceipt(stored.version, stored.settings, stored.inbox)
}
function rejects(work: () => unknown, label: string) {
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof AgentKitError, label)
    assert.equal(error.code, 'agentEventConflict', label)
    assert.ok(error.cause !== undefined, 'the original validation cause is retained: ' + label)
    return true
  }, label)
}

test('JSON receipt persistence preserves every canonical field, ordering and privacy flag', () => {
  for (const make of [emptyReceipt, completeReceipt]) {
    for (const handoffOnly of [false, true]) for (const pushHidesText of [false, true]) {
      const value = make()
      value.inbox.handoffOnly = handoffOnly
      value.inbox.pushHidesText = pushHidesText
      const before = jsonCopy(value)
      assert.deepEqual(readStartupReceipt(1, value.settings, value.inbox), before)
      assert.deepEqual(throughJSON(value), before)
      assert.deepEqual(value, before, 'encoding must not mutate the caller\'s metadata')
    }
  }
})

test('all 256 independent settings combinations survive JSON without conflating a setting', () => {
  let combinations: boolean[][] = [[]]
  for (let count = 0; count < 8; count++) combinations = combinations.flatMap(prefix => [[...prefix, false], [...prefix, true]])
  const distinctStoredSettings = new Set<string>()
  for (const [computerEnabled, mailboxEnabled, writeEnabled, agentKitEnabled, issueTools, factoryRouting, factoryLifecycle, coordinator] of combinations) {
    const settings: CoordinatorStartupSettings = {
      computerEnabled, mailboxEnabled, writeEnabled, agentKitEnabled,
      switches: { issueTools, factoryRouting, factoryLifecycle }, runtime: { harness: 'ai_sdk' }, coordinator,
    }
    const value = completeReceipt()
    value.settings = settings
    assert.deepEqual(throughJSON(value), value, JSON.stringify(settings))
    distinctStoredSettings.add(JSON.stringify(encodeStoredStartupReceipt(value).settings))
  }
  assert.equal(combinations.length, 256)
  assert.equal(distinctStoredSettings.size, 256, 'distinct canonical configurations cannot share a stored representation')
})

test('optional absence differs from an explicitly empty attention question list', () => {
  const absent = throughJSON(emptyReceipt())
  for (const key of ['taskEventId', 'sourceEventId', 'attentionQuestions', 'scheduledRead', 'origin', 'originRef'] as const) {
    assert.equal(Object.hasOwn(absent.inbox, key), false, key)
  }
  const explicit = emptyReceipt()
  explicit.inbox.attentionQuestions = []
  const decoded = throughJSON(explicit)
  assert.equal(Object.hasOwn(decoded.inbox, 'attentionQuestions'), true)
  assert.deepEqual(decoded.inbox.attentionQuestions, [])
  assert.deepEqual(decoded, explicit)
  assert.notDeepEqual(decoded.inbox, absent.inbox)
})

test('stored envelopes reject missing or unknown keys, unsupported versions and invalid scalar values', () => {
  const valid = encodeStoredStartupReceipt(emptyReceipt())
  const malformed: [string, unknown, unknown, unknown][] = [
    ['missing settings', 1, undefined, valid.inbox],
    ['null settings', 1, null, valid.inbox],
    ['array settings', 1, [], valid.inbox],
    ['missing settings bitmap', 1, { r: 'ai_sdk' }, valid.inbox],
    ['missing harness', 1, { f: 0 }, valid.inbox],
    ['unknown harness', 1, { ...valid.settings, r: 'other' }, valid.inbox],
    ['object harness', 1, { ...valid.settings, r: { harness: 'ai_sdk' } }, valid.inbox],
    ['unknown settings key', 1, { ...valid.settings, authority: true }, valid.inbox],
    ['missing inbox', 1, valid.settings, undefined],
    ['null inbox', 1, valid.settings, null],
    ['array inbox', 1, valid.settings, []],
    ['empty object inbox', 1, valid.settings, {}],
    ['missing added', 1, valid.settings, { f: 0 }],
    ['missing inbox bitmap', 1, valid.settings, { a: 0 }],
    ['unknown inbox key', 1, valid.settings, { ...valid.inbox, authority: true }],
    ['explicit held override', 1, valid.settings, { ...valid.inbox, held: false }],
  ]
  for (const version of [0, 2, '1', null, undefined]) malformed.push(['version ' + String(version), version, valid.settings, valid.inbox])
  for (const f of [-1, 0.5, 256, Number.MAX_SAFE_INTEGER, NaN, Infinity, '1', true, null, undefined]) {
    malformed.push(['settings bitmap ' + String(f), 1, { ...valid.settings, f }, valid.inbox])
  }
  for (const f of [-1, 0.5, 2048, Number.MAX_SAFE_INTEGER, NaN, Infinity, '1', true, null, undefined]) {
    malformed.push(['inbox bitmap ' + String(f), 1, valid.settings, { ...valid.inbox, f }])
  }
  for (const a of [-1, 0.5, NaN, Infinity, '0', true, null, undefined]) {
    malformed.push(['added ' + String(a), 1, valid.settings, { ...valid.inbox, a }])
  }
  for (const [label, version, settings, inbox] of malformed) rejects(() => decodeStoredStartupReceipt(version, settings, inbox), label)
})

test('the presence bitmap prevents deleting or injecting any stored metadata field', () => {
  const complete = encodeStoredStartupReceipt(completeReceipt())
  const empty = encodeStoredStartupReceipt(emptyReceipt())
  for (const key of ['t', 'm', 'p', 'k', 's', 'q', 'd', 'o', 'r'] as const) {
    const deleted: Record<string, unknown> = { ...complete.inbox }
    delete deleted[key]
    rejects(() => decodeStoredStartupReceipt(1, complete.settings, deleted), 'declared field deleted: ' + key)
    rejects(() => decodeStoredStartupReceipt(1, empty.settings, { ...empty.inbox, [key]: complete.inbox[key] }), 'undeclared field injected: ' + key)
    rejects(() => decodeStoredStartupReceipt(1, complete.settings, { ...complete.inbox, [key]: undefined }), 'declared undefined: ' + key)
    rejects(() => decodeStoredStartupReceipt(1, empty.settings, { ...empty.inbox, [key]: undefined }), 'undeclared own undefined: ' + key)
    rejects(() => decodeStoredStartupReceipt(1, complete.settings, { ...complete.inbox, [key]: null }), 'declared null: ' + key)
  }
  rejects(() => decodeStoredStartupReceipt(1, empty.settings, { ...empty.inbox, q: [] }), 'an explicit empty list also needs its presence declaration')
})

test('nested metadata retains its original strict validation instead of gaining compact-format defaults', () => {
  type RecordValue = Record<string, unknown>
  const first = (value: unknown) => (value as RecordValue[])[0]
  const malformed: [string, (inbox: RecordValue) => void][] = [
    ['empty stored telegram list', inbox => { inbox.t = [] }],
    ['empty stored handoff list', inbox => { inbox.m = [] }],
    ['empty stored push list', inbox => { inbox.p = [] }],
    ['missing telegram thread', inbox => { delete first(inbox.t).threadId }],
    ['empty telegram recipient', inbox => { first(inbox.t).telegramUserId = '' }],
    ['invalid telegram source id', inbox => { first(inbox.t).sourceEventIds = ['valid', 7] }],
    ['unknown telegram field', inbox => { first(inbox.t).forwardTo = 'other' }],
    ['empty handoff id', inbox => { inbox.m = [''] }],
    ['unknown event kind', inbox => { first(inbox.p).kind = 'unknown' }],
    ['unknown event tier', inbox => { first(inbox.p).tier = 'urgent' }],
    ['invalid push run id', inbox => { first(inbox.p).runId = 42 }],
    ['empty push issue id', inbox => { first(inbox.p).issueId = '' }],
    ['unknown push field', inbox => { first(inbox.p).showCode = true }],
    ['empty task event id', inbox => { inbox.k = '' }],
    ['numeric source event id', inbox => { inbox.s = 42 }],
    ['missing attention question id', inbox => { delete first(inbox.q).questionId }],
    ['null attention task id', inbox => { first(inbox.q).taskId = null }],
    ['unknown attention field', inbox => { first(inbox.q).permission = true }],
    ['missing schedule occurrence', inbox => { delete (inbox.d as RecordValue).occurrenceId }],
    ['empty schedule lease', inbox => { (inbox.d as RecordValue).leaseToken = '' }],
    ['invalid schedule actions', inbox => { (inbox.d as RecordValue).allowedActions = ['read', 1] }],
    ['invalid schedule prompt', inbox => { (inbox.d as RecordValue).prompt = false }],
    ['unknown schedule field', inbox => { (inbox.d as RecordValue).writeAllowed = true }],
    ['unknown origin', inbox => { inbox.o = 'carrier_pigeon' }],
    ['mismatched ref kind', inbox => { inbox.o = 'slack' }],
    ['ref without origin', inbox => { delete inbox.o }],
  ]
  for (const [label, corrupt] of malformed) {
    const stored = jsonCopy(encodeStoredStartupReceipt(completeReceipt()))
    const inbox: RecordValue = stored.inbox
    corrupt(inbox)
    rejects(() => decodeStoredStartupReceipt(1, stored.settings, inbox), label)
  }
})

test('writes reject malformed canonical input and every explicitly present undefined optional field', () => {
  const malformed: [string, (value: CoordinatorStartupReceipt) => void][] = [
    ['held false', value => { value.inbox.held = false }],
    ['unknown canonical setting', value => { Object.assign(value.settings, { other: true }) }],
    ['unknown canonical switch', value => { Object.assign(value.settings.switches, { other: true }) }],
    ['unknown runtime field', value => { Object.assign(value.settings.runtime, { credential: 'synthetic' }) }],
    ['unknown canonical inbox key', value => { Object.assign(value.inbox, { authority: true }) }],
    ['missing required array', value => { Reflect.deleteProperty(value.inbox, 'telegramTargets') }],
    ['malformed nested source', value => { value.inbox.telegramTargets[0].sourceEventIds = [''] }],
  ]
  for (const [label, corrupt] of malformed) {
    const value = completeReceipt()
    corrupt(value)
    rejects(() => encodeStoredStartupReceipt(value), label)
  }
  for (const key of ['taskEventId', 'sourceEventId', 'attentionQuestions', 'scheduledRead', 'origin', 'originRef'] as const) {
    const value = emptyReceipt()
    Object.assign(value.inbox, { [key]: undefined })
    assert.equal(Object.hasOwn(value.inbox, key), true)
    rejects(() => encodeStoredStartupReceipt(value), 'own undefined cannot silently disappear during persistence: ' + key)
  }
})

test('valid canonical objects never become a fallback storage format, including mixed representations', () => {
  for (const value of [emptyReceipt(), completeReceipt()]) {
    assert.deepEqual(readStartupReceipt(1, value.settings, value.inbox), value, 'the control is valid canonical data')
    const stored = encodeStoredStartupReceipt(value)
    rejects(() => decodeStoredStartupReceipt(1, value.settings, value.inbox), 'canonical pair')
    rejects(() => decodeStoredStartupReceipt(1, value.settings, stored.inbox), 'canonical settings mixed with compact inbox')
    rejects(() => decodeStoredStartupReceipt(1, stored.settings, value.inbox), 'compact settings mixed with canonical inbox')
  }
})
