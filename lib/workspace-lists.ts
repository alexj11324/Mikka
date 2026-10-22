import type { listIssues } from '@/app/actions/issues'
import type { listProjects } from '@/app/actions/projects'
import { withBasePath } from '@/lib/base-path'

type IssueList = Awaited<ReturnType<typeof listIssues>>
type ProjectList = Awaited<ReturnType<typeof listProjects>>
type DatedRow = { createdAt: Date; updatedAt: Date }
type WireRow<T extends DatedRow> = Omit<T, 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string }

async function fetchList<T extends DatedRow>(kind: 'issues' | 'projects'): Promise<T[]> {
  const response = await fetch(withBasePath(`/api/workspace/lists?kind=${kind}`), { cache: 'no-store', credentials: 'same-origin' })
  if (!response.ok) throw new Error('workspaceListReadFailed')
  const rows = await response.json() as WireRow<T>[]
  return rows.map(row => ({ ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) }) as T)
}

export function fetchWorkspaceIssues(): Promise<IssueList> {
  return fetchList<IssueList[number]>('issues')
}

export function fetchWorkspaceProjects(): Promise<ProjectList> {
  return fetchList<ProjectList[number]>('projects')
}
