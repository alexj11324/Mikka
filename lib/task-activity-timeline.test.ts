import assert from 'node:assert/strict'
import test from 'node:test'
import en from '../messages/en.json' with { type: 'json' }
import zh from '../messages/zh-CN.json' with { type: 'json' }
import { pullRequestActivityEvents, activityLineParts, activityRunId, taskHistoryLabel, taskHistoryPieces, type ActivityLabels, type ActivityStretch, type IssueActivityEvent } from './task-activity-timeline'

const fill = (template: string, values: Record<string, string> = {}) => template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole)

function labels(catalog: typeof en): ActivityLabels {
  const activity = catalog.Workspace.activity
  return {
    created: catalog.Workspace.detail.createdTask,
    activity: (key, values = {}) => fill(activity[key], values),
    status: value => value,
    priority: value => value,
  }
}

const subject = { taskId: 'task-1', code: 'MIK-12' }
const agent = { type: 'agent' as const, id: 'agent-a', name: 'Ada' }
const person = { type: 'user' as const, name: 'Ada' }
const stretches: ActivityStretch[] = [
  { at: '2026-11-14T14:00:00.000Z', runId: 'run-1', agentId: 'agent-a', linked: true },
  { at: '2026-11-14T15:00:00.000Z', runId: 'run-2', agentId: 'agent-b', linked: false },
  { at: '2026-11-14T16:00:00.000Z', runId: 'run-3', agentId: 'agent-a', linked: true },
]

function event(partial: IssueActivityEvent): IssueActivityEvent {
  return partial
}

test('an Agent status change names the task and opens that run', () => {
  const line = activityLineParts([
    event({ id: 's', at: '2026-11-14T14:02:00.000Z', kind: 'status', status: 'Done' }),
  ], labels(en), subject, en.Workspace.activity.separator, { ...agent, id: 'agent-a' }, stretches)
  assert.deepEqual(line, [
    { kind: 'thread', text: 'Ada', runId: 'run-1' },
    { kind: 'text', text: ' ' },
    { kind: 'text', text: 'moved ' },
    { kind: 'task', text: 'MIK-12', taskId: 'task-1' },
    { kind: 'text', text: ' to Done' },
  ])
  assert.equal(line.map(part => part.text).join(''), 'Ada moved MIK-12 to Done')
})

test('a person stays text, and the same minute keeps one name with every code', () => {
  const line = activityLineParts([
    event({ id: 'c', at: '2026-11-14T14:02:00.000Z', kind: 'created' }),
    event({ id: 'p', at: '2026-11-14T14:02:30.000Z', kind: 'priority', priority: 'high' }),
    event({ id: 'a', at: '2026-11-14T14:02:40.000Z', kind: 'assigned', assigneeName: 'Bob' }),
  ], labels(en), subject, en.Workspace.activity.separator, person, stretches)
  assert.equal(line.filter(part => part.kind === 'thread').length, 0)
  assert.deepEqual(line[0], { kind: 'text', text: 'Ada', name: true })
  assert.equal(line.map(part => part.text).join(''), 'Ada created MIK-12, set priority to high, assigned Bob')
  assert.deepEqual(line.filter(part => part.kind === 'task'), [{ kind: 'task', text: 'MIK-12', taskId: 'task-1' }])
})

test('chinese clauses name the code, the previous person, and the subtask', () => {
  const zhLabels = labels(zh)
  assert.equal(taskHistoryLabel(event({ id: 'c', at: 't', kind: 'created' }), zhLabels, subject), '创建了 MIK-12')
  assert.equal(taskHistoryLabel(event({ id: 'u', at: 't', kind: 'unassigned', assigneeName: 'Ada' }), zhLabels), '取消了 Ada 的负责')
  assert.equal(taskHistoryLabel(event({ id: 'd', at: 't', kind: 'unassigned', assignmentTarget: 'delegate', assigneeName: 'Ada' }), zhLabels), '不再交给 Ada')
  const subtask = taskHistoryPieces(event({ id: 's', at: 't', kind: 'subtask', title: 'Child', targetId: 'child', code: 'MIK-13' }), zhLabels, subject)
  assert.deepEqual(subtask, [
    { kind: 'text', text: '加了子任务 ' },
    { kind: 'task', text: 'MIK-13', taskId: 'child' },
  ])
})


test('renders supported task-attribute changes in English and Chinese', () => {
  assert.equal(taskHistoryLabel(event({ id: 'due', at: 't', kind: 'dueDateChanged', dueDate: '2026-11-30' }), labels(en)), 'set the due date to 2026-11-30')
  assert.equal(taskHistoryLabel(event({ id: 'estimate', at: 't', kind: 'estimateChanged', estimate: 5 }), labels(en)), 'set the estimate to 5')
  assert.equal(taskHistoryLabel(event({ id: 'parent', at: 't', kind: 'parentChanged' }), labels(zh)), '更改了父任务')
  assert.equal(taskHistoryLabel(event({ id: 'blocker', at: 't', kind: 'blockerAdded' }), labels(zh)), '添加了一个阻塞任务')
})

test('a missing code or an unmatched Agent does not invent a link', () => {
  assert.deepEqual(taskHistoryPieces(event({ id: 'c', at: 't', kind: 'created' }), labels(en), null), [
    { kind: 'text', text: 'Created the task' },
  ])
  assert.equal(activityRunId('2026-11-14T13:00:00.000Z', { ...agent, id: 'agent-a' }, stretches), null)
  assert.equal(activityRunId('2026-11-14T14:00:00.000Z', { ...agent, id: 'agent-a' }, [{ at: '2026-11-14T14:00:00Z', runId: 'run-1', agentId: 'agent-a', linked: true }]), 'run-1')
  assert.equal(activityRunId('2026-11-14T15:30:00.000Z', { ...agent, id: 'agent-a' }, stretches), null)
  assert.equal(activityRunId('2026-11-14T16:30:00.000Z', { ...agent, id: 'agent-a' }, stretches), null)
  assert.equal(activityRunId('2026-11-14T14:30:00.000Z', { ...agent, id: 'agent-a' }, stretches), 'run-1')
  assert.equal(activityRunId('2026-11-14T16:30:00.000Z', { ...agent, id: 'agent-b' }, stretches), null)
  assert.equal(activityRunId('2026-11-14T16:30:00.000Z', { ...agent, id: null }, stretches), null)
  assert.equal(activityRunId('2026-11-14T14:30:00.000Z', person, stretches), null)
  assert.equal(activityRunId('2026-11-14T14:30:00.000Z', { ...agent, id: 'agent-a' }, [
    { at: '2026-11-14T14:00:00Z', runId: 'run-1', agentId: 'agent-a', linked: true },
    { at: '2026-11-14T14:00:00Z', runId: 'run-2', agentId: 'agent-a', linked: true },
  ]), null)
  const title = taskHistoryPieces(event({ id: 's', at: 't', kind: 'subtask', title: 'Child', targetId: 'child' }), labels(en))
  assert.deepEqual(title, [
    { kind: 'text', text: 'added subtask ' },
    { kind: 'task', text: 'Child', taskId: 'child' },
  ])
})

test('pull request activity uses provider event timestamps and appears only when its source time exists', () => {
  const rows = pullRequestActivityEvents([
    { url: 'https://github.com/acme/app/pull/12', title: 'Better activity', state: 'merged', createdAt: '2026-10-26T09:30:00Z', mergedAt: '2026-10-27T11:00:00Z' },
    { url: 'https://github.com/acme/app/pull/13', title: 'No clocks', state: 'merged', createdAt: null, mergedAt: null },
    { url: 'https://github.com/acme/app/pull/14', title: null, state: 'open', createdAt: '2026-10-26T10:00:00Z', mergedAt: null },
    { url: 'https://github.com/acme/app/pull/15', title: 'Bad clock', state: 'open', createdAt: 'not-a-date', mergedAt: null },
  ], {
    opened: (repo, number, title) => `Opened ${repo}#${number} ${title}`,
    merged: (repo, number, title) => `Merged ${repo}#${number} ${title}`,
    time: at => at,
  })
  assert.deepEqual(rows.map(({ id, at, text }) => [id, at, text]), [
    ['pull:https://github.com/acme/app/pull/12:opened', '2026-10-26T09:30:00Z', 'Opened acme/app#12 Better activity'],
    ['pull:https://github.com/acme/app/pull/12:merged', '2026-10-27T11:00:00Z', 'Merged acme/app#12 Better activity'],
  ])
})
