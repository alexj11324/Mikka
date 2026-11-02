import type { listIssues } from '@/app/actions/issues'
import type { TaskRun } from '@/app/actions/task-runs'
import { threadGroup, type GroupIssue } from '@/lib/thread-groups'
import { ISSUE_STATUSES, type IssueStatus } from '@/components/workspace/issue-properties'

export type BoardTask = Awaited<ReturnType<typeof listIssues>>[number]
export type BoardColumns = Record<string, BoardTask[]>
/** Every status is a column (Figma 714:5283); 已取消 and 重复 start hidden in the 已隐藏 lane. */
export const BOARD_COLUMNS = ISSUE_STATUSES
export const DEFAULT_HIDDEN_COLUMNS: IssueStatus[] = ['canceled', 'duplicate']
export const boardColumnOf = (status: string) => BOARD_COLUMNS.some(column => column.value === status) ? status : null

/** What a card shows; the 显示 popover toggles these (Figma 86:2). */
export const CARD_PROPERTIES = ['identifier', 'priority', 'assignee', 'labels', 'pullRequests', 'subtasks', 'agentState', 'project', 'dueDate', 'createdAt'] as const
export type CardProperty = typeof CARD_PROPERTIES[number]
export const DEFAULT_CARD_PROPERTIES: CardProperty[] = ['identifier', 'priority', 'assignee', 'labels', 'pullRequests', 'subtasks', 'agentState', 'dueDate']

/** Who works a task beyond its assignee: the Bot of its newest thread and the coding agents of its threads. */
export type RunOwner = Pick<TaskRun, 'bot' | 'harnesses'>

/** The task's newest thread, by its group in the right column (R-52); a settled thread (空闲, 已解决) shows nothing. */
export type AgentState = 'running' | 'waiting' | 'blocked'
export const AGENT_STATES: AgentState[] = ['running', 'waiting', 'blocked']
export function agentStateOf(run: Pick<TaskRun, 'status' | 'outcome'> | undefined, issue: GroupIssue | undefined): AgentState | null {
  if (!run) return null
  const group = threadGroup({ id: '', status: run.status, issueId: null, createdAt: '', outcome: run.outcome }, issue)
  return group === 'running' || group === 'waiting' || group === 'blocked' ? group : null
}
