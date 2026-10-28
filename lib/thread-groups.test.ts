import assert from 'node:assert/strict'
import test from 'node:test'
import { activityLabel, groupThreads, lastActivity, lastReplyUpdate, pullRequestsOf, replyLine, threadGroup, type GroupIssue } from './thread-groups'

const thread = (status: string, issueId: string | null = 'task', extra: { superseded?: boolean; createdAt?: string; id?: string } = {}) =>
  ({ id: extra.id ?? status, status, issueId, createdAt: extra.createdAt ?? '2026-10-28T10:00:00Z', superseded: extra.superseded ?? false })
const pr = (number: number, state: 'open' | 'merged' | 'closed') => ({ url: `https://github.com/acme/app/pull/${number}`, state })
const task = (status: string, ...pullRequests: ReturnType<typeof pr>[]): GroupIssue => ({ status, metadata: { pullRequests } })
const group = (t: ReturnType<typeof thread>, issue?: GroupIssue, newest = true) => threadGroup(t, issue, newest)

test('等待回复: waiting for input', () => {
  assert.equal(group(thread('waiting_input'), task('doing')), 'waiting')
  assert.equal(group(thread('waiting_input', null)), 'waiting')
})

test('等待回复: a failed thread nothing replaced', () => {
  assert.equal(group(thread('failed'), task('doing')), 'waiting')
  assert.equal(group(thread('failed', null)), 'waiting')
})

test('已解决: a failed thread that was retried or is not the newest on its task', () => {
  assert.equal(group(thread('failed', 'task', { superseded: true }), task('doing')), 'resolved')
  assert.equal(group(thread('failed', null, { superseded: true })), 'resolved')
  assert.equal(group(thread('failed'), task('doing'), false), 'resolved')
})

test('等待回复: finished with an open PR on its task, or its task in review', () => {
  assert.equal(group(thread('succeeded'), task('doing', pr(1, 'open'))), 'waiting')
  assert.equal(group(thread('succeeded'), task('review')), 'waiting')
  assert.equal(group(thread('succeeded'), task('doing', pr(1, 'merged'), pr(2, 'open'))), 'waiting')
})

test('进行中: queued, preparing, running, finishing', () => {
  for (const status of ['queued', 'preparing', 'running', 'finishing']) assert.equal(group(thread(status), task('done')), 'running', status)
})

test('空闲: the newest thread on an open task, finished or stopped, no PR waiting', () => {
  for (const status of ['backlog', 'todo', 'doing']) {
    assert.equal(group(thread('succeeded'), task(status)), 'idle', status)
    assert.equal(group(thread('stopped'), task(status)), 'idle', status)
    assert.equal(group(thread('succeeded'), task(status, pr(3, 'closed'))), 'idle', status)
  }
})

test('空闲: a stopped thread without a task', () => {
  assert.equal(group(thread('stopped', null)), 'idle')
})

test('已解决: cancelled', () => {
  assert.equal(group(thread('cancelled'), task('doing', pr(1, 'open'))), 'resolved')
  assert.equal(group(thread('cancelled', null)), 'resolved')
})

test('已解决: its task is done, cancelled or a duplicate', () => {
  for (const status of ['done', 'canceled', 'duplicate']) {
    assert.equal(group(thread('succeeded'), task(status, pr(1, 'open'))), 'resolved', status)
    assert.equal(group(thread('failed'), task(status)), 'resolved', status)
    assert.equal(group(thread('stopped'), task(status)), 'resolved', status)
  }
})

test('已解决: its PR is merged', () => {
  assert.equal(group(thread('succeeded'), task('doing', pr(1, 'merged'))), 'resolved')
  assert.equal(group(thread('stopped'), task('todo', pr(1, 'merged'))), 'resolved')
})

test('已解决: a newer thread on its task replaced it', () => {
  assert.equal(group(thread('succeeded'), task('review'), false), 'resolved')
  assert.equal(group(thread('stopped'), task('doing'), false), 'resolved')
})

test('已解决: finished without a task', () => {
  assert.equal(group(thread('succeeded', null)), 'resolved')
})

test('groupThreads finds the newest thread on each task by creation time', () => {
  const older = thread('succeeded', 'a', { id: 'older', createdAt: '2026-10-27T10:00:00Z' })
  const newer = thread('stopped', 'a', { id: 'newer', createdAt: '2026-10-28T10:00:00Z' })
  const groups = groupThreads([older, newer, thread('running', 'b', { id: 'run' })], id => id === 'a' ? task('doing') : task('todo'))
  assert.deepEqual(groups.idle.map(item => item.id), ['newer'])
  assert.deepEqual(groups.resolved.map(item => item.id), ['older'])
  assert.deepEqual(groups.running.map(item => item.id), ['run'])
})

test('a reply opening is one plain line', () => {
  assert.equal(replyLine('## 修好了\n\n**PR 已开**，见 [#247](https://github.com/a/b/pull/247)。\n- `pnpm test` 通过'), '修好了 PR 已开，见 #247。 pnpm test 通过')
  assert.equal(replyLine('Infisical 里 MIKKA_R2_ACCESS_KEY 没设'), 'Infisical 里 MIKKA_R2_ACCESS_KEY 没设')
  assert.equal(replyLine('看了 [[run:11111111-1111-4111-8111-111111111111]] 的日志'), '看了 的日志')
  assert.equal(replyLine(' \n '), null)
  assert.equal(replyLine(null), null)
})

test('a batch replaces the last reply when its text part starts there, else appends', () => {
  assert.deepEqual(lastReplyUpdate([{ type: 'text-start', id: 'a' }, { type: 'text-delta', id: 'a', delta: '修好了，' }, { type: 'text-delta', id: 'a', delta: 'PR 已开' }, { type: 'text-end', id: 'a' }]),
    { part: 'a', text: '修好了，PR 已开', replace: true })
  assert.deepEqual(lastReplyUpdate([{ type: 'text-delta', id: 'a', delta: '，三条检查' }]), { part: 'a', text: '，三条检查', replace: false })
  // The last part with text wins; a part with no text yet changes nothing.
  assert.deepEqual(lastReplyUpdate([{ type: 'text-start', id: 'a' }, { type: 'text-delta', id: 'a', delta: 'one' }, { type: 'text-start', id: 'b' }, { type: 'text-delta', id: 'b', delta: '' }]),
    { part: 'a', text: 'one', replace: true })
  assert.equal(lastReplyUpdate([{ type: 'text-start', id: 'a' }, { type: 'tool-input-available' }]), null)
})

test('a row\'s time: 刚刚, 昨天, else relative; the last reply\'s time first', () => {
  const now = new Date(2026, 9, 28, 9, 30)
  assert.equal(activityLabel(new Date(2026, 9, 28, 9, 29, 30), now), 'justNow')
  assert.equal(activityLabel(new Date(2026, 9, 28, 9, 25), now), 'relative')
  assert.equal(activityLabel(new Date(2026, 9, 27, 23, 50), now), 'yesterday')
  assert.equal(activityLabel(new Date(2026, 9, 26, 12, 0), now), 'relative')
  assert.equal(lastActivity({ lastReplyAt: '2026-10-28T09:00:00Z', updatedAt: '2026-10-28T09:10:00Z' }), '2026-10-28T09:00:00Z')
  assert.equal(lastActivity({ lastReplyAt: null, updatedAt: '2026-10-28T09:10:00Z' }), '2026-10-28T09:10:00Z')
})

test('a bot\'s PRs come from the tasks its threads worked on', () => {
  const issues = [
    { id: 'a', metadata: { pullRequests: [pr(247, 'open')] } },
    { id: 'b', metadata: { pullRequests: [pr(251, 'open'), pr(250, 'closed')] } },
    { id: 'c', metadata: { pullRequests: [pr(240, 'merged')] } },
    { id: 'other', metadata: { pullRequests: [pr(9, 'open')] } },
  ]
  const rows = pullRequestsOf([thread('succeeded', 'a'), thread('running', 'b'), thread('succeeded', 'c'), thread('succeeded', 'b'), thread('running', null)], issues)
  assert.deepEqual(rows.map(row => [row.number, row.group, row.issueId]), [[247, 'review', 'a'], [251, 'running', 'b'], [240, 'merged', 'c']])
})
