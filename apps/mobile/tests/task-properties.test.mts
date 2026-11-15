import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mobileMessages } from '../lib/messages.ts'
import { agoWhen } from '../lib/clock.ts'
import { pullRef, taskCreator, taskProperties } from '../features/tasks/model/task-properties.ts'

const task = { id: 'task', identifier: 'T-1', title: 'Task', status: 'todo', priority: 'normal', workOwner: null } as never

test('a task with nothing optional set shows only status, priority and assignee, in Capy\'s order', () => {
  assert.deepEqual(taskProperties({ task, activity: [] }).map(row => row.id), ['status', 'priority', 'assignee'])
  const rows = taskProperties({ task, activity: [{ kind: 'created', by: 'Older', createdAt: '2026-11-15T00:00:00Z' }], work: { version: 1, linkedChats: [],
    connections: [{ id: 'r', identifier: null, title: 'Related', kinds: ['related'] }, { id: 'c', identifier: 'T-2', title: 'Child', kinds: ['child'] }, { id: 'p', identifier: 'T-0', title: 'Parent', kinds: ['parent'] }],
    conversations: [{ id: 'private', ownerName: 'Peer', detail: null, state: 'done', stopping: false }],
    pullRequests: [{ url: 'https://github.com/acme/app/pull/12', title: '  ', state: 'draft' }] } })
  assert.deepEqual(rows.map(row => row.id), ['parent', 'status', 'priority', 'assignee', 'createdBy', 'pullRequests', 'child', 'related'],
    'an unreadable thread is not a Threads row')
  assert.deepEqual(rows.find(row => row.id === 'pullRequests'), { id: 'pullRequests', pulls: [{ url: 'https://github.com/acme/app/pull/12', ref: 'app#12', title: null, state: 'draft' }] })
})

test('the creator is the first revision\'s actor; older servers fall back to the creation line', () => {
  const created = { kind: 'history', id: 'history:c', at: '2026-11-15T00:00:00Z', event: { id: 'c', at: '2026-11-15T00:00:00Z', kind: 'created', actor: { type: 'user', id: 'u', name: 'Alex' } } } as const
  assert.equal(taskCreator({ timeline: [created as never], activity: [{ kind: 'created', by: 'Older', createdAt: created.at }] }), 'Alex')
  assert.equal(taskCreator({ activity: [{ kind: 'created', by: 'Older', createdAt: created.at }] }), 'Older')
  assert.equal(taskCreator({ activity: [] }), null)
})

test('pull request refs and how long ago read as Capy writes them', () => {
  assert.equal(pullRef('https://github.com/acme/app/pull/7'), 'app#7')
  assert.equal(pullRef('https://example.com/acme/app/pull/7'), null)
  const now = Date.parse('2026-11-15T12:00:00Z'), words = mobileMessages.MobileCore.ago
  assert.equal(agoWhen('2026-11-15T12:00:30Z', now), words.now, 'a clock ahead of the phone reads as now')
  assert.equal(agoWhen('2026-11-15T11:55:00Z', now), words.minutes.replace('{count}', '5'))
  assert.equal(agoWhen('2026-11-15T09:00:00Z', now), words.hours.replace('{count}', '3'))
  assert.equal(agoWhen('2026-11-13T12:00:00Z', now), words.days.replace('{count}', '2'))
  assert.equal(agoWhen('not a date', now), '')
})
