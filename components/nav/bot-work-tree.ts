import { pullRequestsState } from '@/lib/pull-request-appearance'
import type { Thread } from '@/app/actions/task-runs'
import type { listIssues } from '@/app/actions/issues'
import { conversationIndicatorOf, type RunIndicator, type TaskReason, type TaskState } from '@/lib/task-state'
import type { TaskPresentation } from '@/lib/task-presentation'
import { issueIdentifier } from '@/components/workspace/issue-properties'
import { compactTaskTitle, conversationTitle } from '@/lib/short-title'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]
export type BotWorkRun = { id: string; name: string; harness: string | null }
export type BotWorkTask = { pullState?: Thread['pullState']; unreadCount?: number; id: string; issueId: string | null; name: string; fullName: string; /** The task's status field; null for a run that has no task. */ status: string | null; /** What a conversation with no task is doing, for its one mark; null for a task row, whose one icon is its status. */ activity: RunIndicator | null; state: TaskState | null; reason: TaskReason | null; runs: BotWorkRun[] }

type Dispatch = NonNullable<TaskPresentation['botDispatches']>[number]
const taskRow = (issue: Issue, presentation: TaskPresentation, dispatch: Dispatch): BotWorkTask => ({
  id: issue.id, issueId: issue.id,
  name: [issueIdentifier(issue), compactTaskTitle(issue)].filter(Boolean).join(' '),
  fullName: [issueIdentifier(issue), issue.title].filter(Boolean).join(' '),
  status: issue.status, state: presentation.state, reason: presentation.reason, activity: null, runs: [{ id: dispatch.runId, name: dispatch.name, harness: dispatch.harness }],
})

/** Reuse the shell's authorized Task membership and state. Standalone Runs
 * remain independent navigation entries without a Task state. */
export function botWorkTree(workspaceId: string | null, botIds: readonly string[], threads: readonly Thread[],
  issues: readonly Issue[], presentations: Readonly<Record<string, TaskPresentation>>) {
  const tree = new Map<string, BotWorkTask[]>()
  if (!workspaceId) return tree
  const allowed = new Set(botIds)
  const tasks = new Map(issues.filter(issue => issue.workspaceId === workspaceId).map(issue => [issue.id, issue]))
  const grouped = new Map<string, Map<string, BotWorkTask>>()
  const rowsFor = (botId: string) => {
    let rows = grouped.get(botId)
    if (!rows) {
      rows = new Map()
      grouped.set(botId, rows)
    }
    return rows
  }
  for (const run of threads) {
    const botId = run.botId
    if (!botId || !allowed.has(botId) || run.source === 'mcp') continue
    const child = { id: run.id, name: run.agentName, harness: run.harness }
    if (!run.issueId) {
      // A conversation with no task is named by its own short title: the stored one (a rename shows here), else what it was asked.
      const title = conversationTitle({ title: run.title, name: run.prompt.split('\n').find(line => line.trim())?.trim() }) || run.agentName
      rowsFor(botId).set(run.id, { id: run.id, issueId: null, name: title, fullName: title,
        status: null, state: null, reason: null, activity: conversationIndicatorOf(run), runs: [child] })
      continue
    }
    const issue = tasks.get(run.issueId), projected = presentations[run.issueId]
    const dispatch = projected?.botDispatches?.find(item => item.botId === botId)
    if (!issue || !dispatch) continue
    const rows = rowsFor(botId)
    let row = rows.get(issue.id)
    if (!row) {
      row = taskRow(issue, projected, dispatch)
      rows.set(issue.id, row)
    }
    if (run.id !== dispatch.runId) row.runs.push(child)
  }
  for (const issue of tasks.values()) {
    const projected = presentations[issue.id]
    for (const dispatch of projected?.botDispatches ?? []) {
      const { botId } = dispatch
      if (!allowed.has(botId)) continue
      const rows = rowsFor(botId)
      if (!rows.has(issue.id)) rows.set(issue.id, taskRow(issue, projected, dispatch))
    }
  }
  const runStates = new Map(threads.map(run => [run.id, run.pullState]))
  const unread = new Set(threads.filter(run => run.unread).map(run => run.id))
  const createdAt = new Map(threads.map(run => [run.id, run.createdAt]))
  for (const [botId, rows] of grouped) {
    for (const row of rows.values()) {
      const unreadCount = row.runs.filter(run => unread.has(run.id)).length
      if (unreadCount) row.unreadCount = unreadCount
      const pulls = row.runs.flatMap(run => { const state = runStates.get(run.id); return state ? [{ state }] : [] })
      if (pulls.length) row.pullState = pullRequestsState(pulls)
      const [latest, ...older] = row.runs
      row.runs = [latest, ...older.sort((a, b) => (createdAt.get(b.id) ?? '').localeCompare(createdAt.get(a.id) ?? '') || b.id.localeCompare(a.id))]
    }
    tree.set(botId, [...rows.values()])
  }
  return tree
}
