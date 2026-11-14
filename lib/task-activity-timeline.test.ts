import assert from 'node:assert/strict'
import test from 'node:test'
import en from '../messages/en.json' with { type: 'json' }
import zhCN from '../messages/zh-CN.json' with { type: 'json' }
import { taskHistoryLabel, type IssueActivityEvent } from './task-activity-timeline'

function renderHistory(event: IssueActivityEvent, messages: typeof en.Workspace.activity) {
  return taskHistoryLabel(event, {
    created: 'created this issue',
    activity: (key, values = {}) => Object.entries(values).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, value),
      messages[key],
    ),
    status: value => value,
    priority: value => value,
  })
}

const cases: Array<[IssueActivityEvent, string, string]> = [
  [{ id: 's', at: '', kind: 'status', status: 'In progress' }, 'changed status to In progress', '将状态改为In progress'],
  [{ id: 'p', at: '', kind: 'priority', priority: 'High' }, 'changed priority to High', '将优先级改为High'],
  [{ id: 't', at: '', kind: 'title', title: 'Fix timeline' }, 'renamed this issue to “Fix timeline”', '将标题改为「Fix timeline」'],
  [{ id: 'a', at: '', kind: 'assigned', assigneeName: 'Ada' }, 'assigned to Ada', '指派给 Ada'],
  [{ id: 'u', at: '', kind: 'unassigned' }, 'cleared the assignee', '移除了负责人'],
  [{ id: 'd', at: '', kind: 'assigned', assignmentTarget: 'delegate', assigneeName: 'Codex' }, 'assigned Agent Codex', '指派 Agent Codex'],
  [{ id: 'ud', at: '', kind: 'unassigned', assignmentTarget: 'delegate' }, 'cleared the assigned Agent', '移除了指派的 Agent'],
  [{ id: 'st', at: '', kind: 'subtask', title: 'Add tests' }, 'added subtask: Add tests', '添加子任务：Add tests'],
  [{ id: 'la', at: '', kind: 'labelAdded', title: 'bug' }, 'added label bug', '添加标签 bug'],
  [{ id: 'lr', at: '', kind: 'labelRemoved', title: 'bug' }, 'removed label bug', '移除标签 bug'],
]

test('issue history summaries are concise and natural in English and Chinese', () => {
  for (const [event, english, chinese] of cases) {
    assert.equal(renderHistory(event, en.Workspace.activity), english, `English ${event.kind}`)
    assert.equal(renderHistory(event, zhCN.Workspace.activity), chinese, `Chinese ${event.kind}`)
  }
})

test('timeline controls and empty states explain what each view contains', () => {
  assert.deepEqual(
    [en.Workspace.activity.timelineAll, en.Workspace.activity.timelineUpdates, en.Workspace.activity.timelineWork, en.Workspace.activity.timelineComments],
    ['All', 'Changes', 'Agent runs', 'Discussion'],
  )
  assert.deepEqual(
    [zhCN.Workspace.activity.timelineAll, zhCN.Workspace.activity.timelineUpdates, zhCN.Workspace.activity.timelineWork, zhCN.Workspace.activity.timelineComments],
    ['全部', '变更', 'Agent 运行', '讨论'],
  )
  assert.match(en.Workspace.activity.timelineEmpty, /Status changes.*Agent runs.*discussion/)
  assert.equal(zhCN.Workspace.activity.timelineFilteredEmpty, '此筛选条件下没有匹配记录。')
})
