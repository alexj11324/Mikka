import assert from 'node:assert/strict'
import test from 'node:test'
import en from '../messages/en.json' with { type: 'json' }
import zh from '../messages/zh-CN.json' with { type: 'json' }
import { pullRequestActivityEvents, activityLineParts, activityRunId, taskHistoryLabel, type ActivityLabels, type ActivityPiece, type ActivityStretch, type IssueActivityEvent } from './task-activity-timeline'

const fill = (template: string, values: Record<string, string> = {}) => template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole)

function labels(catalog: typeof en): ActivityLabels {
  const activity = catalog.Workspace.activity
  return {
    activity: (key, values = {}) => fill(activity[key], values),
    status: value => ({ review: 'In review', done: 'Done' } as Record<string, string>)[value] ?? value,
    priority: value => ({ high: 'High' } as Record<string, string>)[value] ?? value,
  }
}

const ada = { type: 'user' as const, id: 'u1', name: 'Ada', avatarUrl: null }
const claude = { type: 'agent' as const, id: 'a1', name: 'Claude Code', avatarUrl: null }
const subject = { taskId: 'task-1', code: 'CAP-12', title: 'Retry does not refresh', status: 'review', priority: 'high', refs: { 'task-2': { code: 'CAP-13', title: 'Child' } } }
const conversations: ActivityStretch[] = [
  { at: '2026-11-14T14:00:00.000Z', runId: 'run-1', agentId: 'a1', linked: true, title: 'Refresh after retry', harness: 'claude_code', result: 'Done' },
  { at: '2026-11-14T15:00:00.000Z', runId: 'run-2', agentId: 'a2', linked: false, title: 'Hidden' },
]
type EventInput = Omit<IssueActivityEvent, 'id' | 'at'> & Partial<Pick<IssueActivityEvent, 'id' | 'at'>>
const event = (partial: EventInput): IssueActivityEvent => ({ id: 'e', at: '2026-11-14T15:30:00.000Z', ...partial })
const words = (parts: ActivityPiece[]) => parts.map(part => part.text).join('')

test('each sentence reads as Capy\'s English, actor first', () => {
  const line = (partial: EventInput) => words(activityLineParts(event({ actor: ada, ...partial }), labels(en), subject))
  assert.equal(line({ kind: 'created' }), 'Ada created CAP-12')
  assert.equal(line({ kind: 'status', status: 'done' }), 'Ada moved CAP-12 to Done')
  assert.equal(line({ kind: 'priority', priority: 'high' }), 'Ada set priority to High')
  assert.equal(line({ kind: 'title', title: 'New name' }), 'Ada renamed the task to New name')
  assert.equal(line({ kind: 'description' }), 'Ada edited the description')
  assert.equal(line({ kind: 'assigned', assigneeName: 'Maya' }), 'Ada assigned Maya')
  assert.equal(line({ kind: 'unassigned', assigneeName: 'Maya' }), 'Ada unassigned Maya')
  assert.equal(line({ kind: 'parent', targetId: 'task-2' }), 'Ada set the parent to CAP-13')
  assert.equal(line({ kind: 'parent', removed: true }), 'Ada removed the parent')
  assert.equal(line({ kind: 'subtask', targetId: 'task-2' }), 'Ada added sub-issue CAP-13')
  assert.equal(line({ kind: 'relation', relation: 'blockedBy', targetId: 'task-2' }), 'Ada marked CAP-12 as blocked by CAP-13')
  assert.equal(line({ kind: 'relation', relation: 'related', targetId: 'task-2' }), 'Ada marked CAP-12 as related to CAP-13')
  assert.equal(line({ kind: 'relation', relation: 'related', targetId: 'task-2', removed: true }), 'Ada removed the relation to CAP-13')
  assert.equal(line({ kind: 'pull', pull: { label: 'app#12', href: 'https://github.com/acme/app/pull/12', action: 'linked' } }), 'Ada linked app#12')
})

test('an Agent\'s change is said by its conversation, a chip that opens it', () => {
  const parts = activityLineParts(event({ kind: 'status', status: 'review', actor: claude, at: '2026-11-14T14:30:00.000Z', source: { kind: 'revision', id: 'revision-1', revision: 2, runId: 'run-1' } }), labels(en), subject, conversations)
  assert.deepEqual(parts[0], { kind: 'thread', text: 'Refresh after retry', runId: 'run-1', harness: 'claude_code', title: 'Refresh after retry', result: 'Done' })
  assert.equal(words(parts), 'Refresh after retry moved CAP-12 to In review')
  assert.ok(!words(parts).includes('Claude Code'), 'the Agent\'s name is never the actor')
  assert.deepEqual(parts.find(part => part.kind === 'task'), { kind: 'task', text: 'CAP-12', taskId: 'task-1', title: 'Retry does not refresh', status: 'review', priority: 'high' })
})

test('a person is text, no actor is Mikka, an unmatched Agent is an untitled thread', () => {
  assert.deepEqual(activityLineParts(event({ kind: 'created', actor: ada }), labels(en), subject)[0], { kind: 'text', text: 'Ada', name: true })
  assert.equal(words(activityLineParts(event({ kind: 'created', actor: null }), labels(en), subject)), 'Mikka created CAP-12')
  const early = event({ kind: 'created', actor: claude, at: '2026-11-14T13:00:00.000Z' })
  assert.equal(words(activityLineParts(early, labels(en), subject, conversations)), 'Untitled thread created CAP-12')
})

test('a merged pull request is its own line with no actor, as Capy\'s PR rows', () => {
  const merged = event({ kind: 'pull', actor: ada, pull: { label: 'app#12', href: 'https://github.com/acme/app/pull/12', title: 'Fix the retry', action: 'merged' } })
  const parts = activityLineParts(merged, labels(en), subject)
  assert.equal(words(parts), 'Merged app#12 Fix the retry')
  assert.deepEqual(parts.find(part => part.kind === 'pull'), { kind: 'pull', text: 'app#12', href: 'https://github.com/acme/app/pull/12' })
})

test('Chinese follows the same sentences', () => {
  const line = (partial: EventInput) => words(activityLineParts(event({ actor: ada, ...partial }), labels(zh as unknown as typeof en), subject))
  assert.equal(line({ kind: 'created' }), 'Ada 创建了 CAP-12')
  assert.equal(line({ kind: 'status', status: 'done' }), 'Ada 把 CAP-12 移到了Done')
  assert.equal(line({ kind: 'relation', relation: 'blockedBy', targetId: 'task-2' }), 'Ada 把 CAP-12 标记为被 CAP-13 阻塞')
  assert.equal(line({ kind: 'unassigned' }), 'Ada 取消了这个任务的指派')
})

test('a task this page cannot name is "a task", never a dead chip', () => {
  const parts = activityLineParts(event({ kind: 'parent', targetId: 'unknown', actor: ada }), labels(en), subject)
  assert.equal(words(parts), 'Ada set the parent to a task')
  assert.equal(parts.some(part => part.kind === 'task'), false)
  assert.equal(taskHistoryLabel(event({ kind: 'created' }), labels(en), { taskId: 't', code: null }), 'created the task')
})

test('a source run id, not a unique actor/time guess, identifies a conversation', () => {
  const at = '2026-11-14T14:30:00.000Z'
  assert.equal(activityRunId(at, claude, conversations), null, 'an Agent may write outside the only known run')
  assert.equal(activityRunId(at, claude, conversations, 'run-1'), 'run-1')
  assert.equal(activityRunId(at, claude, conversations, 'run-2'), null, 'the recorded run must have the same Agent and be visible')
  assert.equal(activityRunId(at, ada, conversations, 'run-1'), null)
  const parts = activityLineParts(event({ kind: 'status', actor: claude, at }), labels(en), subject, conversations)
  assert.notEqual(parts[0].kind, 'thread', 'a revision without a recorded run is not linked')
})

test('renders supported task-attribute changes in English and Chinese', () => {
  assert.equal(taskHistoryLabel(event({ id: 'due', at: 't', kind: 'dueDateChanged', dueDate: '2026-11-30' }), labels(en)), 'set the due date to 2026-11-30')
  assert.equal(taskHistoryLabel(event({ id: 'estimate', at: 't', kind: 'estimateChanged', estimate: 5 }), labels(en)), 'set the estimate to 5')
  assert.equal(taskHistoryLabel(event({ kind: 'parent', removed: true }), labels(zh)), '移除了父任务')
  assert.equal(taskHistoryLabel(event({ kind: 'relation', targetId: 'task-2', relation: 'blockedBy' }), labels(zh), subject), '把 CAP-12 标记为被 CAP-13 阻塞')
})

test('missing, mismatched, hidden or duplicate source runs cannot open a conversation', () => {
  const at = '2026-11-14T14:30:00.000Z'
  const visible = [{ at, runId: 'run-1', agentId: 'a1', linked: true }]
  assert.equal(activityRunId(at, claude, visible, null), null)
  assert.equal(activityRunId(at, { ...claude, id: null }, visible, 'run-1'), null)
  assert.equal(activityRunId(at, { ...claude, id: 'another' }, visible, 'run-1'), null)
  assert.equal(activityRunId(at, claude, [{ ...visible[0], linked: false }], 'run-1'), null)
  assert.equal(activityRunId(at, claude, [...visible, ...visible], 'run-1'), null)
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
