import assert from 'node:assert/strict'
import test from 'node:test'
import type { JSONContent } from '@tiptap/core'
import { deriveIssueActivity } from './issue-activity'

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

test('records clearing an assignee and ignores subtasks created before the parent', () => {
  const events = deriveIssueActivity([
    { id: 'v1', revision: 1, title: 'A', status: 'todo', priority: 'normal', content: content({ id: 'u', name: 'Ada' }), createdAt: '2026-10-22T10:00:00.000Z' },
    { id: 'v2', revision: 2, title: 'A', status: 'todo', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:05:00.000Z' },
  ], [
    { id: 'old', title: 'Older', createdAt: '2026-10-22T09:00:00.000Z' },
  ])
  assert.deepEqual(events.map(event => event.kind), ['created', 'unassigned'])
})
