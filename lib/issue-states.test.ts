import assert from 'node:assert/strict'
import test from 'node:test'
import { createIssueStateInput, filterIssueStates, groupIssueStates, issueStateForDigit, issueStateLabel, issueStateType, taskIssueState, updateIssueStateInput, type IssueStateView } from './issue-states'
import type { IssueStatus } from './issue-meta'

const state = (id: string, category: IssueStatus, position: number, extra: Partial<IssueStateView> = {}): IssueStateView => ({
  id, name: null, icon: 'empty', color: 'gray', category, type: issueStateType(category), isDefault: true, position, taskCount: 0, ...extra,
})
const label = (category: IssueStatus) => ({ backlog: 'Backlog', todo: 'Todo', doing: 'In Progress', review: 'In Review', done: 'Done', canceled: 'Canceled', duplicate: 'Duplicate' })[category]

// Decision 2026-11-19-2115: Open is backlog…review, Closed is done, canceled and duplicate.
test('a state type follows its category', () => {
  assert.deepEqual((['backlog', 'todo', 'doing', 'review', 'done', 'canceled', 'duplicate'] as const).map(issueStateType), ['open', 'open', 'open', 'open', 'closed', 'closed', 'closed'])
})

test('the picker lists Open then Closed in position order, and 1–9 pick in that order', () => {
  const states = [state('done', 'done', 5000), state('todo', 'todo', 2000), state('building', 'doing', 9000, { name: 'Building', isDefault: false }), state('doing', 'doing', 3000), state('canceled', 'canceled', 6000)]
  const { open, closed } = groupIssueStates(states)
  assert.deepEqual(open.map(item => item.id), ['todo', 'doing', 'building'])
  assert.deepEqual(closed.map(item => item.id), ['done', 'canceled'])
  assert.equal(issueStateForDigit(states, '3')?.id, 'building')
  assert.equal(issueStateForDigit(states, '4')?.id, 'done')
  assert.equal(issueStateForDigit(states, '9'), undefined)
  assert.equal(issueStateForDigit(states, '0'), undefined)
  assert.equal(issueStateForDigit(states, 'a'), undefined)
})

test('a state shows its own name, else its category’s; search matches what it shows', () => {
  const states = [state('todo', 'todo', 1), state('building', 'doing', 2, { name: 'Building' })]
  assert.equal(issueStateLabel(states[0], label), 'Todo')
  assert.equal(issueStateLabel(states[1], label), 'Building')
  assert.deepEqual(filterIssueStates(states, ' build ', label).map(item => item.id), ['building'])
  assert.deepEqual(filterIssueStates(states, 'TODO', label).map(item => item.id), ['todo'])
  assert.equal(filterIssueStates(states, '', label).length, 2)
})

test('a task shows its own state, else its category’s default', () => {
  const states = [state('doing', 'doing', 1), state('building', 'doing', 2, { isDefault: false })]
  assert.equal(taskIssueState(states, { stateId: 'building', status: 'doing' })?.id, 'building')
  assert.equal(taskIssueState(states, { stateId: null, status: 'doing' })?.id, 'doing')
  assert.equal(taskIssueState(states, { stateId: 'gone', status: 'doing' })?.id, 'doing')
  assert.equal(taskIssueState(states, { status: 'done' }), undefined)
})

test('inputs: names are trimmed and bounded, the category is fixed once created', () => {
  const workspaceId = '10000000-0000-4000-8000-000000000001', id = '10000000-0000-4000-8000-000000000002'
  assert.equal(createIssueStateInput.parse({ workspaceId, name: '  Building ', category: 'doing', icon: 'half', color: 'blue' }).name, 'Building')
  assert.throws(() => createIssueStateInput.parse({ workspaceId, name: '   ', category: 'doing', icon: 'half', color: 'blue' }))
  assert.throws(() => createIssueStateInput.parse({ workspaceId, name: 'x'.repeat(61), category: 'doing', icon: 'half', color: 'blue' }))
  assert.throws(() => createIssueStateInput.parse({ workspaceId, name: 'Needs you', category: 'needs_you', icon: 'hand', color: 'red' }))
  assert.throws(() => createIssueStateInput.parse({ workspaceId, name: 'Bars', category: 'todo', icon: 'bars-1', color: 'gray' }), 'priority bars are not states')
  assert.equal(updateIssueStateInput.parse({ workspaceId, id, name: null }).name, null)
  assert.throws(() => updateIssueStateInput.parse({ workspaceId, id, category: 'done' }))
})
