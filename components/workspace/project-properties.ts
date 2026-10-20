import { CircleDashed, Circle, CircleDot, CirclePause, CircleCheck, CircleX } from 'lucide-react'
import type { listProjects } from '@/app/actions/projects'
export type Project = Awaited<ReturnType<typeof listProjects>>[number]
export const PROJECT_STATUSES = [
  { value: 'backlog', label: '待规划', icon: CircleDashed },
  { value: 'planned', label: '已计划', icon: Circle },
  { value: 'started', label: '进行中', icon: CircleDot },
  { value: 'paused', label: '已暂停', icon: CirclePause },
  { value: 'completed', label: '已完成', icon: CircleCheck },
  { value: 'canceled', label: '已取消', icon: CircleX },
] as const
