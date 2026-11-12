import type { TaskListPageInput } from '../../../../../lib/task-list-page'
import { api, apiConnection, ApiError } from '../../../lib/api'
import { apiCache } from '../../../lib/api-cache'
import type { Task, TaskDetail } from '../../../lib/types'
import { readPresentationPages, type PresentationBatch } from '../../../../../lib/task-presentation-batch'

type Presentation = Required<Pick<Task, 'group' | 'state' | 'reason' | 'blockedBy'>> & { primaryStatus: string; factoryTaskId?: string }

/** Keep both reads on the originating account. A moved workspace, revoked task
 * or unsupported projection cannot turn an old Run's state into current facts. */
function reader() {
  const connection = apiConnection()
  const context = apiCache.context()
  const get = <T>(path: string) => {
    if (context !== apiCache.context()) throw new ApiError(403, 'workspaceAccessDenied')
    return api<T>(path, {}, connection)
  }
  return {
    get,
    project: (workspaceId: string, ids: string[], factoryIdentity = false) => readPresentationPages(workspaceId, ids, input => {
      if (context !== apiCache.context()) throw new ApiError(403, 'workspaceAccessDenied')
      return api<PresentationBatch<Presentation>>('/api/mobile/task-presentations', { method: 'POST', body: factoryIdentity ? { ...input, includeFactoryIdentity: true } : input }, connection)
    }),
  }
}

export async function readPresentedTasks(path: string) {
  const read = reader()
  const list = await read.get<{ tasks: Task[]; workspaceId?: string; next?: TaskListPageInput['after'] | null }>(path)
  // The v1 projection shipped before the list exposed its selected tenant.
  const workspaceId = list.workspaceId ?? (await read.get<{ workspace: { id: string } }>('/api/mobile/home')).workspace.id
  const presentations = await read.project(workspaceId, list.tasks.map(task => task.id))
  return { workspaceId, ...(list.next !== undefined ? { next: list.next } : {}), tasks: list.tasks.flatMap(task => {
    const view = presentations.get(task.id)
    return view ? [{ ...task, ...view, status: view.primaryStatus }] : []
  }) }
}

export async function readPresentedTask(path: string): Promise<TaskDetail> {
  const read = reader()
  const detail = await read.get<TaskDetail>(path)
  const workspaceId = detail.live?.workspaceId
  if (!workspaceId) throw new ApiError(403, 'workspaceAccessDenied')
  const presentation = (await read.project(workspaceId, [detail.task.id], detail.live?.factoryActivityVersion === 1)).get(detail.task.id)
  if (!presentation) throw new ApiError(404, 'issueNotFound')
  const { factoryTaskId, ...view } = presentation
  const selected = { ...detail, task: { ...detail.task, ...view, status: view.primaryStatus } }
  if (!factoryTaskId) return selected
  try {
    const factory = await read.get<{ version?: number; task?: { id?: string; issueId?: string }; events?: unknown[] }>(
      `/api/factory/tasks/${encodeURIComponent(factoryTaskId)}/activity`)
    if (factory.version !== 1 || factory.task?.id !== factoryTaskId || factory.task?.issueId !== detail.task.id) throw new ApiError(409, 'factoryActivityUnavailable')
    return { ...selected, task: { ...selected.task, factoryTaskId }, factoryEvents: Array.isArray(factory.events) ? factory.events : [] }
  } catch (error) {
    // A Factory grant can be revoked between these two independently authorized
    // reads. The user may still read the Task, its own history and discussions.
    if (error instanceof ApiError && error.code !== 'workspaceAccessDenied' && (error.status === 403 || error.status === 404)) return selected
    throw error
  }
}
