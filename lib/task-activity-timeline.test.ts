import assert from 'node:assert/strict'
import test from 'node:test'
import en from '../messages/en.json' with { type: 'json' }
import zh from '../messages/zh-CN.json' with { type: 'json' }
import { activityLineParts, activityRunId, taskHistoryLabel, taskHistoryPieces, type ActivityLabels, type ActivityStretch, type IssueActivityEvent } from './task-activity-timeline'

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
const agent = { type: 'agent' as const, name: 'Ada' }
const person = { type: 'user' as const, name: 'Ada' }
const stretches: ActivityStretch[] = [
  { at: '2026-11-14T14:00:00.000Z', runId: 'run-1', linked: true },
  { at: '2026-11-14T15:00:00.000Z', runId: 'run-2', linked: false },
  { at: '2026-11-14T16:00:00.000Z', runId: 'run-3', linked: true },
]

function event(partial: IssueActivityEvent): IssueActivityEvent {
  return partial
}

test('an Agent status change names the task and opens that run', () => {
  const line = activityLineParts([
    event({ id: 's', at: '2026-11-14T14:02:00.000Z', kind: 'status', status: 'Done' }),
  ], labels(en), subject, en.Workspace.activity.separator, agent, stretches)
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
  assert.deepEqual(line[0], { kind: 'text', text: 'Ada' })
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

test('a missing code or an unmatched Agent does not invent a link', () => {
  assert.deepEqual(taskHistoryPieces(event({ id: 'c', at: 't', kind: 'created' }), labels(en), null), [
    { kind: 'text', text: 'Created the task' },
  ])
  assert.equal(activityRunId('2026-11-14T13:00:00.000Z', agent, stretches), null)
  assert.equal(activityRunId('2026-11-14T14:00:00.000Z', agent, [{ at: '2026-11-14T14:00:00Z', runId: 'run-1', linked: true }]), 'run-1')
  assert.equal(activityRunId('2026-11-14T15:30:00.000Z', agent, stretches), 'run-1')
  assert.equal(activityRunId('2026-11-14T16:30:00.000Z', agent, stretches), 'run-3')
  assert.equal(activityRunId('2026-11-14T14:30:00.000Z', person, stretches), null)
  const title = taskHistoryPieces(event({ id: 's', at: 't', kind: 'subtask', title: 'Child', targetId: 'child' }), labels(en))
  assert.deepEqual(title, [
    { kind: 'text', text: 'added subtask ' },
    { kind: 'task', text: 'Child', taskId: 'child' },
  ])
})
