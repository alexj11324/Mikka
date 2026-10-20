import { CircleDashed, CircleDot, CircleCheck, Eye } from 'lucide-react'

export const ISSUE_STATUSES = [
  { value: 'todo', label: '待处理', icon: CircleDashed },
  { value: 'doing', label: '进行中', icon: CircleDot },
  { value: 'review', label: '待审阅', icon: Eye },
  { value: 'done', label: '已完成', icon: CircleCheck },
] as const

export const ISSUE_PRIORITIES = [
  { value: 'urgent', label: '紧急' },
  { value: 'high', label: '高优先级' },
  { value: 'normal', label: '普通优先级' },
  { value: 'low', label: '低优先级' },
] as const

export type IssueStatus = typeof ISSUE_STATUSES[number]['value']
export type IssueView = 'all' | 'mine' | 'shared' | IssueStatus
export const WORKSPACE_NAME = 'Orvilo3'

export function issueIdentifier(id: string) {
  return `ORV-${id.slice(0, 6).toUpperCase()}`
}
