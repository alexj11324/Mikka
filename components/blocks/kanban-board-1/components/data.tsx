import type { listIssues } from '@/app/actions/issues'
import { ISSUE_STATUSES } from '@/components/workspace/issue-properties'

export type BoardTask = Awaited<ReturnType<typeof listIssues>>[number]
export type BoardColumns = Record<string, BoardTask[]>
// The board keeps the four working columns (Figma 57:2); backlog items sit in 待办, canceled and duplicate ones stay off the board.
export const BOARD_COLUMNS = ISSUE_STATUSES.filter(status => ['todo', 'doing', 'review', 'done'].includes(status.value))
export const boardColumnOf = (status: string) => status === 'backlog' ? 'todo' : BOARD_COLUMNS.some(column => column.value === status) ? status : null
