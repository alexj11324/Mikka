import assert from 'node:assert/strict'
import test from 'node:test'
import en from '../messages/en.json' with { type: 'json' }
import zhCN from '../messages/zh-CN.json' with { type: 'json' }
import { pullRequestActivityEvents, taskHistoryLabel, type IssueActivityEvent } from './task-activity-timeline'

function renderHistory(event: IssueActivityEvent, messages: typeof en.Workspace.activity) {
  return taskHistoryLabel(event, {
    created: messages.created,
    activity: (key, values = {}) => Object.entries(values).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, value),
      messages[key],
    ),
    status: value => value,
    priority: value => value,
    issueCode: null,
  })
}

const cases: Array<[IssueActivityEvent, string, string]> = [
  [{ id: 's', at: '', kind: 'status', status: 'In progress' }, 'moved the issue to In progress', '将 Issue 移至 In progress'],
  [{ id: 'p', at: '', kind: 'priority', priority: 'High' }, 'set priority to High', '将优先级设为 High'],
  [{ id: 't', at: '', kind: 'title', title: 'Fix timeline' }, 'renamed the issue to Fix timeline', '将 Issue 标题改为 Fix timeline'],
  [{ id: 'a', at: '', kind: 'assigned', assigneeName: 'Ada' }, 'assigned Ada', '指派了 Ada'],
  [{ id: 'u', at: '', kind: 'unassigned' }, 'unassigned the issue', '取消了 Issue 的负责人'],
  [{ id: 'd', at: '', kind: 'assigned', assignmentTarget: 'delegate', assigneeName: 'Codex' }, 'assigned Codex', '指派了 Codex'],
  [{ id: 'ud', at: '', kind: 'unassigned', assignmentTarget: 'delegate', assigneeName: 'Codex' }, 'unassigned Codex', '取消指派 Codex'],
  [{ id: 'st', at: '', kind: 'subtask', title: 'Add tests' }, 'added sub-issue Add tests', '添加了子 Issue「Add tests」'],
  [{ id: 'la', at: '', kind: 'labelAdded', title: 'bug' }, 'added label bug', '添加标签 bug'],
  [{ id: 'lr', at: '', kind: 'labelRemoved', title: 'bug' }, 'removed label bug', '移除标签 bug'],
]

test('issue history summaries are concise and natural in English and Chinese', () => {
  for (const [event, english, chinese] of cases) {
    assert.equal(renderHistory(event, en.Workspace.activity), english, `English ${event.kind}`)
    assert.equal(renderHistory(event, zhCN.Workspace.activity), chinese, `Chinese ${event.kind}`)
  }
})

test('created and status copy includes the issue code as Capy does', () => {
  const labels = (messages: typeof en.Workspace.activity, issueCode: string | null) => ({
    created: messages.created,
    issueCode,
    activity: (key: keyof typeof messages, values: Record<string, string> = {}) => Object.entries(values).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, value), messages[key],
    ),
    status: (value: string) => value,
    priority: (value: string) => value,
  })
  assert.equal(taskHistoryLabel({ id: 'c', at: '', kind: 'created' }, labels(en.Workspace.activity, 'MIK-284')), 'created MIK-284')
  assert.equal(taskHistoryLabel({ id: 's', at: '', kind: 'status', status: 'In progress' }, labels(en.Workspace.activity, 'MIK-284')), 'moved MIK-284 to In progress')
  assert.equal(taskHistoryLabel({ id: 'c', at: '', kind: 'created' }, labels(zhCN.Workspace.activity, 'MIK-284')), '创建了 MIK-284')
  assert.equal(taskHistoryLabel({ id: 's', at: '', kind: 'status', status: '进行中' }, labels(zhCN.Workspace.activity, 'MIK-284')), '将 MIK-284 移至进行中')
})

test('timeline labels use Capy’s activity filters and earlier-history control', () => {
  assert.deepEqual(
    [en.Workspace.activity.title, en.Workspace.activity.created, en.Workspace.activity.timelineAll, en.Workspace.activity.timelineComments, en.Workspace.activity.timelineBots],
    ['Activity', 'created the issue', 'All', 'Comments', 'Agents & bots'],
  )
  assert.deepEqual(
    [zhCN.Workspace.activity.title, zhCN.Workspace.activity.created, zhCN.Workspace.activity.timelineAll, zhCN.Workspace.activity.timelineComments, zhCN.Workspace.activity.timelineBots],
    ['活动', '创建了这个 Issue', '全部', '评论', 'Agent 与机器人'],
  )
  assert.equal(en.Workspace.activity.timelineEarlier, 'Show {count} earlier')
  assert.equal(zhCN.Workspace.activity.timelineEarlier, '再显示更早的 {count} 条')
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
