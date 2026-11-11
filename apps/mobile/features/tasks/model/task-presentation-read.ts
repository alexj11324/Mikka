import { api, apiConnection, ApiError } from '../../../lib/api'
import { apiCache } from '../../../lib/api-cache'
import type { Task, TaskDetail } from '../../../lib/types'
import { readPresentationPages, type PresentationBatch } from '../../../../../lib/task-presentation-batch'

type Presentation = Required<Pick<Task, 'group' | 'state' | 'reason' | 'blockedBy'>> & { primaryStatus: string }

/** Keep both reads on the originating account. A moved workspace, revoked task
 * or unsupported projection cannot turn an old Run's state into current facts. */
function reader() {
  const connection = apiConnection()
  const context = apiCache.context()
  return {
    get: <T>(path: string) => api<T>(path, {}, connection),
    project: (workspaceId: string, ids: string[]) => readPresentationPages(workspaceId, ids, input => {
      if (context !== apiCache.context()) throw new ApiError(403, 'workspaceAccessDenied')
      return api<PresentationBatch<Presentation>>('/api/mobile/task-presentations', { method: 'POST', body: input }, connection)
    }),
  }
}

export async function readPresentedTasks(path: string) {
  const read = reader()
  const list = await read.get<{ tasks: Task[]; workspaceId?: string }>(path)
  // The v1 projection shipped before the list exposed its selected tenant.
  const workspaceId = list.workspaceId ?? (await read.get<{ workspace: { id: string } }>('/api/mobile/home')).workspace.id
  const presentations = await read.project(workspaceId, list.tasks.map(task => task.id))
  return { workspaceId, tasks: list.tasks.flatMap(task => {
    const view = presentations.get(task.id)
    return view ? [{ ...task, ...view, status: view.primaryStatus }] : []
  }) }
}

export async function readPresentedTask(path: string): Promise<TaskDetail> {
  const read = reader()
  const detail = await read.get<TaskDetail>(path)
  const workspaceId = detail.live?.workspaceId
  if (!workspaceId) throw new ApiError(403, 'workspaceAccessDenied')
  const presentation = (await read.project(workspaceId, [detail.task.id])).get(detail.task.id)
  if (!presentation) throw new ApiError(404, 'issueNotFound')
  return { ...detail, task: { ...detail.task, ...presentation, status: presentation.primaryStatus } }
}
