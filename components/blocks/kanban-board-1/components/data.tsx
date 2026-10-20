import type { listIssues } from '@/app/actions/issues'
import { ISSUE_STATUSES } from '@/components/workspace/issue-properties'

export type BoardTask = Awaited<ReturnType<typeof listIssues>>[number]
export type BoardColumns = Record<string, BoardTask[]>
export const BOARD_COLUMNS = ISSUE_STATUSES
