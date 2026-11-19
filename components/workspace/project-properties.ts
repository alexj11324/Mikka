import { CircleDashed, Circle, CircleDot, CirclePause, CircleCheck, CircleX, Minus } from '@/components/icons'
import { PRIORITY_ICONS, STATUS_ICONS } from './state-mark'

// A project's status and priority are drawn from the one mark registry (`lib/state-mark.ts`), so 已完成, 已取消 and
// 紧急 look the same wherever they appear; `none` has no mark and keeps its dash.
export const PROJECT_PRIORITIES = [
  { value: 'none', icon: Minus },
  { value: 'urgent', icon: PRIORITY_ICONS.urgent },
  { value: 'high', icon: PRIORITY_ICONS.high },
  { value: 'normal', icon: PRIORITY_ICONS.normal },
  { value: 'low', icon: PRIORITY_ICONS.low },
] as const
export const PROJECT_COLORS = [
  { value: 'green', className: 'text-success-foreground', surface: 'bg-success/10' },
  { value: 'purple', className: 'text-info-foreground', surface: 'bg-info/10' },
  { value: 'yellow', className: 'text-warning-foreground', surface: 'bg-warning/10' },
  { value: 'gray', className: 'text-muted-foreground', surface: 'bg-muted' },
] as const
export const PROJECT_ICON_COLORS = { green: 'bg-success/10 text-success-foreground', purple: 'bg-info/10 text-info-foreground', yellow: 'bg-warning/10 text-warning-foreground', gray: 'bg-muted text-muted-foreground' } as const
export const PROJECT_ICON_TINTS = { green: 'text-success-foreground', purple: 'text-info-foreground', yellow: 'text-warning-foreground', gray: 'text-muted-foreground' } as const
export const PROJECT_HEALTH = [
  { value: 'none', icon: CircleDashed },
  { value: 'onTrack', icon: CircleCheck },
  { value: 'atRisk', icon: CirclePause },
  { value: 'offTrack', icon: CircleX },
] as const
export type ProjectControlField = 'status' | 'priority' | 'lead' | 'members' | 'startDate' | 'targetDate' | 'labels' | 'dependencyIds' | 'health'

import type { listProjects } from '@/app/actions/projects'
type ProjectListRow = Awaited<ReturnType<typeof listProjects>>[number]
export type Project = Omit<ProjectListRow, 'taskCounts'> & Partial<Pick<ProjectListRow, 'taskCounts'>>
export type ProjectTaskPaging = { hasMore: boolean; loading: boolean; failed: boolean; loadMore: () => Promise<void> }

/** Older servers have no summary. Only display a percentage if every linked Task is present. */
export function projectTaskCounts(project: Project, tasks: readonly { id: string; status: string }[]) {
  if (project.taskCounts) return project.taskCounts
  const ids = new Set(project.issueIds)
  const linked = tasks.filter(task => ids.has(task.id))
  return linked.length === ids.size ? { total: linked.length, done: linked.filter(task => task.status === 'done').length } : null
}
export const PROJECT_STATUSES = [
  { value: 'backlog', icon: STATUS_ICONS.backlog },
  { value: 'planned', icon: STATUS_ICONS.todo },
  { value: 'started', icon: STATUS_ICONS.doing },
  { value: 'paused', icon: STATUS_ICONS.review },
  // 已完成 and 已取消 are the task statuses' own marks: one status, one drawing (decision 2026-11-19-1600).
  { value: 'completed', icon: STATUS_ICONS.done },
  { value: 'canceled', icon: STATUS_ICONS.canceled },
] as const
