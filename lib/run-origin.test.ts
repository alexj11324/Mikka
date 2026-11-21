import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveRunOrigin, RUN_ORIGINS, runOriginEntrySchema, runOriginRefSchema, slackRunOriginRef, telegramRunOriginRef,
} from './run-origin'

test('the origin enum is closed and keeps `web` as the app default', () => {
  assert.deepEqual([...RUN_ORIGINS], ['web', 'slack', 'telegram', 'linear', 'github', 'api', 'automation', 'schedule', 'factory'])
  for (const origin of RUN_ORIGINS) assert.equal(runOriginEntrySchema.safeParse({ origin }).success, true, origin)
  for (const origin of ['', 'carrier_pigeon', 'Web', 'WEB']) assert.equal(runOriginEntrySchema.safeParse({ origin }).success, false, origin)
})

test('each ref kind carries only opaque ids and must match its origin', () => {
  const refs = {
    slack: { kind: 'slack', teamId: 'T123', channelId: 'C123', threadTs: '1700000000.000001' },
    telegram: { kind: 'telegram', chatId: '42', messageId: 7 },
    linear: { kind: 'linear', issueId: 'issue-1', commentId: 'comment-1' },
    github: { kind: 'github', repo: 'octo/repo', issueNumber: 12, pullRequest: 13, commentId: 'comment-1' },
    api: { kind: 'api', clientId: 'client-1', workspaceId: 'workspace-1' },
    automation: { kind: 'automation', automationId: 'automation-1', runId: 'run-1' },
    schedule: { kind: 'schedule', scheduleId: 'schedule-1', occurrenceId: 'occurrence-1' },
  } as const
  for (const [kind, ref] of Object.entries(refs)) {
    assert.equal(runOriginRefSchema.safeParse(ref).success, true, kind)
    assert.equal(runOriginEntrySchema.safeParse({ origin: kind, originRef: ref }).success, true, kind)
    assert.equal(runOriginEntrySchema.safeParse({ origin: kind === 'api' ? 'web' : 'api', originRef: ref }).success, false, kind)
  }
  // The minimal forms accept an omitted optional id.
  for (const ref of [{ kind: 'linear', issueId: 'issue-1' }, { kind: 'github', repo: 'octo/repo' }, { kind: 'api' },
    { kind: 'automation', automationId: 'automation-1' }]) assert.equal(runOriginRefSchema.safeParse(ref).success, true)
  // web/factory have no ref kind of their own.
  for (const origin of ['web', 'factory'] as const) {
    assert.equal(runOriginEntrySchema.safeParse({ origin, originRef: null }).success, true)
    assert.equal(runOriginEntrySchema.safeParse({ origin, originRef: { kind: 'api' } }).success, false)
  }
})

test('ref validation rejects text, empty, overlong and unknown fields', () => {
  const valid = { kind: 'slack', teamId: 'T123', channelId: 'C123', threadTs: '1' }
  assert.equal(runOriginRefSchema.safeParse(valid).success, true)
  for (const value of [
    { ...valid, teamId: '' },
    { ...valid, channelId: '   ' },
    { ...valid, threadTs: 'x'.repeat(257) },
    { ...valid, prompt: 'the person’s message text' },
    { ...valid, title: 'a task title' },
    { kind: 'telegram', chatId: '42', messageId: -1 },
    { kind: 'telegram', chatId: '42', messageId: 1.5 },
    { kind: 'telegram', chatId: '42', messageId: Number.MAX_SAFE_INTEGER + 1 },
    { kind: 'schedule', scheduleId: 'schedule-1' },
    { kind: 'unknown', id: 'x' },
    'slack',
    null,
  ]) assert.equal(runOriginRefSchema.safeParse(value).success, false, JSON.stringify(value))
  assert.equal(runOriginRefSchema.safeParse({ ...valid, teamId: 'x'.repeat(256) }).success, true, 'the cap is inclusive')
})

test('resolveRunOrigin prefers the explicit entry, then the source run, then the default', () => {
  const slackRef = { kind: 'slack' as const, teamId: 'T1', channelId: 'C1', threadTs: '1.1' }
  assert.deepEqual(resolveRunOrigin({ explicit: { origin: 'slack', originRef: slackRef }, sourceRun: { origin: 'telegram' }, defaultOrigin: 'factory' }),
    { origin: 'slack', originRef: slackRef })
  assert.deepEqual(resolveRunOrigin({ sourceRun: { origin: 'telegram', originRef: { kind: 'telegram', chatId: '42', messageId: 7 } }, defaultOrigin: 'factory' }),
    { origin: 'telegram', originRef: { kind: 'telegram', chatId: '42', messageId: 7 } })
  assert.deepEqual(resolveRunOrigin({ defaultOrigin: 'factory' }), { origin: 'factory', originRef: null })
  assert.deepEqual(resolveRunOrigin({}), { origin: 'web', originRef: null })
  // A stored legacy/unknown value never becomes 'web' by inference.
  assert.deepEqual(resolveRunOrigin({ sourceRun: { origin: null, originRef: null } }), { origin: 'web', originRef: null })
  assert.deepEqual(resolveRunOrigin({ sourceRun: { origin: null }, defaultOrigin: 'automation' }), { origin: 'automation', originRef: null })
  assert.deepEqual(resolveRunOrigin({ sourceRun: { origin: 'bogus', originRef: slackRef }, defaultOrigin: 'automation' }), { origin: 'automation', originRef: null })
  // A ref that does not match its own origin is not copied.
  assert.deepEqual(resolveRunOrigin({ sourceRun: { origin: 'slack', originRef: { kind: 'telegram', chatId: '42', messageId: 7 } }, defaultOrigin: 'automation' }),
    { origin: 'slack', originRef: null })
  assert.throws(() => resolveRunOrigin({ explicit: { origin: 'slack', originRef: { kind: 'telegram', chatId: '42', messageId: 7 } } }))
})

test('entry helpers read the event fields and never the text', () => {
  assert.deepEqual(slackRunOriginRef({ team_id: 'T1', channel: 'C1', ts: '1.0' }), { kind: 'slack', teamId: 'T1', channelId: 'C1', threadTs: '1.0' })
  assert.deepEqual(slackRunOriginRef({ team: 'T1', channel: 'C1', thread_ts: '2.0', ts: '3.0', text: 'secret' }),
    { kind: 'slack', teamId: 'T1', channelId: 'C1', threadTs: '2.0' })
  assert.equal(slackRunOriginRef({ team_id: 'T1', channel: 'C1' }), null)
  assert.equal(slackRunOriginRef({ team_id: 'T1', ts: '1.0' }), null)
  assert.equal(slackRunOriginRef(null), null)
  assert.deepEqual(telegramRunOriginRef({ threadId: '42', messageId: 7, telegramUserId: 'user-1', text: 'secret' }),
    { kind: 'telegram', chatId: '42', messageId: 7 })
  assert.equal(telegramRunOriginRef({ threadId: '42', messageId: 'seven' }), null)
  assert.equal(telegramRunOriginRef({ threadId: '', messageId: 7 }), null)
  assert.equal(telegramRunOriginRef(undefined), null)
})
