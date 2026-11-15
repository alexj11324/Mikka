import type { listIssues } from '@/app/actions/issues'
import type { TaskRun } from '@/app/actions/task-runs'
import type { TaskState } from '@/hooks/use-bot-tasks'
import { runIndicatorOf, type RunIndicator } from '@/lib/task-state'
import { threadGroup, type GroupIssue } from '@/lib/thread-groups'
import { CircleStop } from 'lucide-react'
import { ISSUE_STATUSES, type IssueStatus } from '@/components/workspace/issue-properties'
import { taskBlock, type BlockRun, type TaskBlock } from '@/lib/task-blocked'

export type BoardTask = Awaited<ReturnType<typeof listIssues>>[number]
export type BoardColumns = Record<string, BoardTask[]>
/** 受阻 is a column but not a status (lib/task-blocked.ts): a task in it keeps its own status. */
export const BLOCKED_COLUMN = 'blocked'
export type BoardColumn = IssueStatus | typeof BLOCKED_COLUMN
const BLOCKED = { value: BLOCKED_COLUMN, label: 'Blocked', icon: CircleStop, indicatorClassName: 'text-destructive-foreground' } as const
/**
 * Every status is a column (Figma 714:5283), with 受阻 after 进行中 (Linear's custom
 * "Blocked" sits in its Started group); 已取消 and 重复 start hidden in the 已隐藏 lane.
 */
export const BOARD_COLUMNS: readonly { value: BoardColumn; icon: typeof CircleStop; indicatorClassName: string }[] = ISSUE_STATUSES.flatMap((status): { value: BoardColumn; icon: typeof CircleStop; indicatorClassName: string }[] => status.value === 'doing' ? [status, BLOCKED] : [status])
export const DEFAULT_HIDDEN_COLUMNS: BoardColumn[] = ['canceled', 'duplicate']
/** The column a task is in: 受阻 while something stops it, else its status. */
export const boardColumnOf = (status: string, blocked = false): BoardColumn | null => blocked ? BLOCKED_COLUMN : BOARD_COLUMNS.some(column => column.value === status) ? status as BoardColumn : null

/** Each task's 受阻, from its newest thread (listTaskRuns) and the tasks it is blocked by. */
export function boardBlocks(issues: readonly BoardTask[], runs: readonly (BlockRun & { issueId: string })[] | undefined): Map<string, TaskBlock> {
  const runOf = new Map((runs ?? []).map(run => [run.issueId, run] as const))
  const byId = new Map(issues.map(issue => [issue.id, issue] as const))
  const isOpen = (id: string) => { const blocker = byId.get(id); return !!blocker && !['done', 'canceled', 'duplicate'].includes(blocker.status) }
  return new Map(issues.flatMap(issue => {
    const block = taskBlock(issue, runOf.get(issue.id), isOpen)
    return block ? [[issue.id, block.blockerId ? { ...block, blockerIdentifier: byId.get(block.blockerId)?.identifier ?? null } : block] as const] : []
  }))
}

/** What a card shows; the 显示 popover toggles these (Figma 86:2). */
export const CARD_PROPERTIES = ['identifier', 'priority', 'assignee', 'labels', 'pullRequests', 'subtasks', 'agentState', 'project', 'dueDate', 'createdAt'] as const
export type CardProperty = typeof CARD_PROPERTIES[number]
export const DEFAULT_CARD_PROPERTIES: CardProperty[] = ['identifier', 'priority', 'assignee', 'labels', 'pullRequests', 'subtasks', 'agentState', 'dueDate']

/** Who works a task beyond its assignee: the Bot of its newest thread and the coding agents of its threads. */
export type RunOwner = Pick<TaskRun, 'bot' | 'harnesses'>

/** What a task's Agent is doing, as the card's small mark: running (working), waiting for the person, blocked (error). */
export type AgentState = 'running' | 'waiting' | 'blocked'
export const AGENT_STATES: AgentState[] = ['running', 'waiting', 'blocked']
/** The board's mark for what a task's Agent is doing (lib/task-state.ts runIndicatorOf): never a status or a column. */
export function runMarkKind(indicator: RunIndicator): AgentState {
  return indicator === 'working' ? 'running' : indicator === 'waiting' ? 'waiting' : 'blocked'
}

/** The Agent's mark for a task's presented state; null when no run is under way, waiting or failed. */
export function cardStateKind(state: TaskState): AgentState | null {
  const indicator = runIndicatorOf(state)
  return indicator ? runMarkKind(indicator) : null
}

export function agentStateOf(run: Pick<TaskRun, 'status' | 'outcome'> | undefined, issue: GroupIssue | undefined): AgentState | null {
  if (!run) return null
  const group = threadGroup({ id: '', status: run.status, issueId: null, createdAt: '', outcome: run.outcome }, issue)
  return group === 'running' || group === 'waiting' || group === 'blocked' ? group : null
}
