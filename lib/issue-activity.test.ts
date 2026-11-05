import assert from 'node:assert/strict'
import test from 'node:test'
import type { JSONContent } from '@tiptap/core'
import { activityTimeline, deriveIssueActivity, groupActivityByMinute } from './issue-activity'

function content(assignee: { id: string; name: string } | null): JSONContent {
  return {
    type: 'doc',
    attrs: {
      mikka: {
        assignee: assignee ? { kind: 'member', id: assignee.id, name: assignee.name, image: null } : null,
      },
    },
  }
}

test('keeps creation and drops description-only autosaves', () => {
  const changed = content({ id: 'u', name: 'Ada' })
  const events = deriveIssueActivity([
    { id: 'v1', revision: 1, title: 'A', status: 'todo', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:00:00.000Z' },
    { id: 'v2', revision: 2, title: 'A', status: 'todo', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:01:00.000Z' },
    { id: 'v5', revision: 5, title: 'B', status: 'doing', priority: 'high', content: changed, createdAt: '2026-10-22T10:04:00.000Z' },
    { id: 'v3', revision: 3, title: 'B', status: 'doing', priority: 'high', content: changed, createdAt: '2026-10-22T10:02:00.000Z' },
  ], [
    { id: 'child', title: 'Sub', createdAt: '2026-10-22T10:03:00.000Z' },
  ])
  assert.deepEqual(events.map(event => event.kind).sort(), ['assigned', 'created', 'priority', 'status', 'subtask', 'title'])
  assert.equal(events.some(event => event.id.endsWith('v2') || event.id.endsWith('v5')), false)
  assert.equal(events.find(event => event.kind === 'assigned')?.assigneeName, 'Ada')
  assert.equal(events.find(event => event.kind === 'status')?.status, 'doing')
})

test('always keeps the created row when later events exceed the limit', () => {
  const versions = [{ id: 'v1', revision: 1, title: 'A', status: 'todo', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:00:00.000Z' }]
  for (let revision = 2; revision <= 16; revision += 1) {
    versions.push({ id: `v${revision}`, revision, title: `T${revision}`, status: 'todo', priority: 'normal', content: content(null), createdAt: `2026-10-22T11:${String(revision).padStart(2, '0')}:00.000Z` })
  }
  const events = deriveIssueActivity(versions, [], 3)
  assert.equal(events[0]?.kind, 'created')
  assert.equal(events.length, 4)
  assert.deepEqual(events.slice(1).map(event => event.title), ['T14', 'T15', 'T16'])
})

test('records label add and remove without a description-only row', () => {
  const labeled = content(null)
  labeled.attrs = { mikka: { assignee: null, labels: [{ name: 'QA-Bug', color: 'violet' }] } }
  const events = deriveIssueActivity([
    { id: 'v1', revision: 1, title: 'A', status: 'todo', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:00:00.000Z' },
    { id: 'v2', revision: 2, title: 'A', status: 'todo', priority: 'normal', content: labeled, createdAt: '2026-10-22T10:01:00.000Z' },
    { id: 'v3', revision: 3, title: 'A', status: 'todo', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:02:00.000Z' },
  ], [])
  assert.deepEqual(events.map(event => event.kind), ['created', 'labelAdded', 'labelRemoved'])
  assert.equal(events.find(event => event.kind === 'labelAdded')?.title, 'QA-Bug')
})

test('records clearing an assignee and ignores subtasks created before the parent', () => {
  const events = deriveIssueActivity([
    { id: 'v1', revision: 1, title: 'A', status: 'todo', priority: 'normal', content: content({ id: 'u', name: 'Ada' }), createdAt: '2026-10-22T10:00:00.000Z' },
    { id: 'v2', revision: 2, title: 'A', status: 'todo', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:05:00.000Z' },
  ], [
    { id: 'old', title: 'Older', createdAt: '2026-10-22T09:00:00.000Z' },
  ])
  assert.deepEqual(events.map(event => event.kind), ['created', 'unassigned'])
})

test('joins events in the same minute into one row', () => {
  const groups = groupActivityByMinute([
    { id: 'a', at: '2026-10-22T10:00:05.000Z', kind: 'created' },
    { id: 'b', at: '2026-10-22T10:00:40.000Z', kind: 'assigned', assigneeName: 'Ada' },
    { id: 'c', at: '2026-10-22T10:01:02.000Z', kind: 'status', status: 'doing' },
    { id: 'd', at: '2026-10-22T11:01:02.000Z', kind: 'priority', priority: 'high' },
  ])
  assert.deepEqual(groups.map(group => group.map(event => event.id)), [['a', 'b'], ['c'], ['d']])
})

test('events by different people in the same minute stay on separate rows', () => {
  const groups = groupActivityByMinute([
    { id: 'a', at: '2026-10-22T10:00:05.000Z', kind: 'created', actorKey: 'user:u1' },
    { id: 'b', at: '2026-10-22T10:00:20.000Z', kind: 'assigned', assigneeName: 'Ada', actorKey: 'user:u1' },
    { id: 'c', at: '2026-10-22T10:00:40.000Z', kind: 'status', status: 'doing', actorKey: 'agent:a1' },
  ])
  assert.deepEqual(groups.map(group => group.map(event => event.id)), [['a', 'b'], ['c']])
})

test('derived events carry the version actor', () => {
  const events = deriveIssueActivity([
    { id: 'v1', revision: 1, title: 'A', status: 'todo', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:00:00.000Z', actorType: 'user', actorId: 'u1' },
    { id: 'v2', revision: 2, title: 'A', status: 'doing', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:00:30.000Z', actorType: 'agent', actorId: 'a1' },
  ], [])
  assert.deepEqual(events.map(event => event.actorKey), ['user:u1', 'agent:a1'])
})

test('derived events carry the resolved actor for the row to name (R-63)', () => {
  const ada = { type: 'user' as const, id: 'u1', name: 'Ada', avatarUrl: '/avatars/blue.webp' }
  const events = deriveIssueActivity([
    { id: 'v1', revision: 1, title: 'A', status: 'todo', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:00:00.000Z', actorType: 'user', actorId: 'u1', actor: ada },
    { id: 'v2', revision: 2, title: 'A', status: 'doing', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:05:00.000Z' },
  ], [])
  assert.deepEqual(events.map(event => event.actor ?? null), [ada, null])
})

test('interleaves task events and dispatched threads by time (#1264)', () => {
  const events = deriveIssueActivity([
    { id: 'v1', revision: 1, title: 'A', status: 'todo', priority: 'normal', content: content(null), createdAt: '2026-11-04T20:44:00.000Z' },
    { id: 'v2', revision: 2, title: 'A', status: 'in_review', priority: 'normal', content: content(null), createdAt: '2026-11-04T20:49:30.000Z' },
  ], [])
  const rows = activityTimeline(events, [
    { id: 't3', createdAt: new Date('2026-11-04T20:51:00.000Z') },
    { id: 't1', createdAt: new Date('2026-11-04T20:45:00.000Z') },
    { id: 't2', createdAt: '2026-11-04T20:49:10.000Z' },
  ])
  assert.deepEqual(rows.map(row => row.id), ['created-v1', 'thread-t1', 'thread-t2', 'status-v2', 'thread-t3'])
})

test('keeps same-time rows in a stable order and splits a minute group around a thread', () => {
  const at = '2026-11-04T20:49:00.000Z'
  const event = (id: string, second: string) => ({ id, at: `2026-11-04T20:49:${second}.000Z`, kind: 'status' as const, actorKey: 'user:u' })
  const threads = [{ id: 'b', createdAt: at }, { id: 'a', createdAt: at }]
  const once = activityTimeline([event('e2', '00'), event('e1', '00')], threads)
  const again = activityTimeline([event('e1', '00'), event('e2', '00')], [...threads].reverse())
  assert.deepEqual(once.map(row => row.id), ['e1', 'thread-a', 'thread-b'])
  assert.deepEqual(once, again)
  assert.deepEqual(once[0]?.type === 'events' && once[0].events.map(item => item.id), ['e1', 'e2'])
  const split = activityTimeline([event('e1', '10'), event('e2', '50')], [{ id: 't', createdAt: '2026-11-04T20:49:30.000Z' }])
  assert.deepEqual(split.map(row => row.id), ['e1', 'thread-t', 'e2'])
})
