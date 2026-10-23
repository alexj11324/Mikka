import type { IssuePriority, IssueStatus } from '@/lib/issue-meta'

export type LinearStateType = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' | string
export interface LinearStateOption { id: string; name: string; type: LinearStateType; position?: number | null }

export function linearStateTypeForIssue(status: IssueStatus): string {
  if (status === 'backlog') return 'backlog'
  if (status === 'todo') return 'unstarted'
  if (status === 'doing' || status === 'review') return 'started'
  if (status === 'done') return 'completed'
  return 'canceled'
}

export function issueStatusForLinearType(type: string, current: IssueStatus, name = ''): IssueStatus {
  const stateName = name.trim().toLowerCase()
  if (type === 'started') return ['review', 'in review', 'code review'].includes(stateName) ? 'review' : 'doing'
  if (type === 'canceled') return stateName === 'duplicate' ? 'duplicate' : 'canceled'
  const mapped: IssueStatus | null = type === 'backlog' ? 'backlog' : type === 'unstarted' ? 'todo' : type === 'completed' ? 'done' : null
  return mapped ?? current
}

export function linearStateForIssue(status: IssueStatus, states: LinearStateOption[]) {
  const type = linearStateTypeForIssue(status)
  const exactNames: Record<IssueStatus, string[]> = {
    backlog: ['backlog'], todo: ['to do', 'todo', 'open'], doing: ['in progress', 'started', 'in development'],
    review: ['in review', 'review'], done: ['done', 'complete', 'completed'], canceled: ['canceled', 'cancelled'], duplicate: ['canceled', 'cancelled', 'duplicate'],
  }
  const candidates = states.filter(state => state.type === type).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  return candidates.find(state => exactNames[status].includes(state.name.trim().toLowerCase())) ?? candidates[0]
}

export function linearPriorityForIssue(priority: IssuePriority) {
  return priority === 'urgent' ? 1 : priority === 'high' ? 2 : priority === 'low' ? 4 : 3
}

export function issuePriorityForLinear(priority: number): IssuePriority {
  return priority === 1 ? 'urgent' : priority === 2 ? 'high' : priority === 4 ? 'low' : 'normal'
}

export function labelColorForLinear(color: string | null | undefined): 'violet' | 'blue' | 'green' | 'yellow' | 'red' | 'gray' {
  const hex = (color ?? '').toLowerCase()
  if (/(8b5cf6|a855f7|9333ea|violet|purple)/.test(hex)) return 'violet'
  if (/(3b82f6|2563eb|0ea5e9|blue|cyan)/.test(hex)) return 'blue'
  if (/(22c55e|16a34a|10b981|green|emerald)/.test(hex)) return 'green'
  if (/(eab308|f59e0b|facc15|yellow|amber)/.test(hex)) return 'yellow'
  if (/(ef4444|dc2626|f43f5e|red|rose)/.test(hex)) return 'red'
  return 'gray'
}
