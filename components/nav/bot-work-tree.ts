import type { Thread } from '@/app/actions/task-runs'
import type { listIssues } from '@/app/actions/issues'
import { localTaskState, type TaskReason, type TaskState } from '@/hooks/use-bot-tasks'
import { issueIdentifier } from '@/components/workspace/issue-properties'
import { compactTaskTitle } from '@/lib/short-title'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]
export type BotWorkRun = { id: string; name: string; harness: string | null }
export type BotWorkTask = { id: string; issueId: string | null; name: string; fullName: string; state: TaskState | null; reason: TaskReason | null; runs: BotWorkRun[] }

/** The workspace's already authorized task/run lists, grouped without another read. */
export function botWorkTree(workspaceId: string | null, botIds: readonly string[], threads: readonly Thread[], issues: readonly Issue[]) {
  const tree = new Map<string, BotWorkTask[]>()
  if (!workspaceId) return tree
  const allowed = new Set(botIds)
  const tasks = new Map(issues.map(issue => [issue.id, issue]))
  const newest = new Map<string, Thread>()
  for (const run of threads) {
    if (!run.issueId || !tasks.has(run.issueId)) continue
    const previous = newest.get(run.issueId)
    if (!previous || run.createdAt > previous.createdAt || (run.createdAt === previous.createdAt && run.id > previous.id)) newest.set(run.issueId, run)
  }
  const grouped = new Map<string, Map<string, BotWorkTask>>()
  for (const run of threads) {
    if (run.source === 'mcp') continue
    const issue = run.issueId ? tasks.get(run.issueId) : undefined
    if (run.issueId && !issue) continue
    // Runs are owner-wide, while the Bot roster is workspace-scoped. A legacy
    // null-Bot run cannot prove which workspace dispatched it, so omit it here.
    const botId = run.botId
    if (!botId || !allowed.has(botId)) continue
    const rows = grouped.get(botId) ?? new Map<string, BotWorkTask>()
    grouped.set(botId, rows)
    const id = issue?.id ?? run.id
    let row = rows.get(id)
    if (!row) {
      const own = issue ? localTaskState(issue, newest.get(issue.id)) : null
      const runTitle = run.prompt.split('\n').find(line => line.trim())?.trim() || run.agentName
      row = { id, issueId: issue?.id ?? null,
        name: issue ? [issueIdentifier(issue), compactTaskTitle(issue)].filter(Boolean).join(' ') : compactTaskTitle({ title: runTitle }),
        fullName: issue ? [issueIdentifier(issue), issue.title].filter(Boolean).join(' ') : runTitle,
        state: own?.state ?? null, reason: own?.reason ?? null, runs: [] }
      rows.set(id, row)
    }
    row.runs.push({ id: run.id, name: run.agentName, harness: run.harness })
  }
  const createdAt = new Map(threads.map(run => [run.id, run.createdAt]))
  for (const [botId, rows] of grouped) {
    for (const row of rows.values()) row.runs.sort((a, b) => (createdAt.get(b.id) ?? '').localeCompare(createdAt.get(a.id) ?? '') || b.id.localeCompare(a.id))
    tree.set(botId, [...rows.values()])
  }
  return tree
}
