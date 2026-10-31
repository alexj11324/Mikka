import type { listIssues } from '@/app/actions/issues'
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

/** The latest agent run on a task, folded into the three states a card shows. */
export type AgentState = 'running' | 'waiting' | 'failed'
export const AGENT_STATES: AgentState[] = ['running', 'waiting', 'failed']
export function agentStateOf(status: string | undefined): AgentState | null {
  if (!status) return null
  if (['queued', 'preparing', 'running', 'finishing'].includes(status)) return 'running'
  if (status === 'waiting_input') return 'waiting'
  if (status === 'failed') return 'failed'
  return null
}
