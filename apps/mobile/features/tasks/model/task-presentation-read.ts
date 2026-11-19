import type { TaskListPageInput } from '../../../../../lib/task-list-page'
import { api, apiConnection, ApiError, ApiTransportError } from '../../../lib/api'
import { apiCache } from '../../../lib/api-cache'
import type { Task, TaskDetail } from '../../../lib/types'
import { readPresentationPages, type PresentationBatch } from '../../../../../lib/task-presentation-batch'
import { TASK_PRESENTATION_PARAM, TASK_PRESENTATION_VERSION, TASK_REFRESH_FAILURE_HEADER, type TaskRefreshFailure } from '../../../../../lib/mobile-task-refresh'

type Presentation = Required<Pick<Task, 'group' | 'state' | 'reason' | 'blockedBy'>> & { primaryStatus: string; factoryTaskId?: string }
type TaskPage = { tasks: Task[]; workspaceId?: string; next?: TaskListPageInput['after'] | null; presentationVersion?: number }

// One failure per active context, delivered on the next list request. A
// disconnected device never starts an extra request just to report an error.
let pendingFailure: { context: number; failure: TaskRefreshFailure } | undefined

function recordFailure(context: number, stage: TaskRefreshFailure['stage'], error: unknown) {
  if (context !== apiCache.context()) return
  if (error instanceof ApiError && error.status === 409 && error.code === 'issueStale') return
  const failure: TaskRefreshFailure = error instanceof ApiError
    ? { stage, reason: 'http', status: error.status, traceId: error.traceId }
    : error instanceof ApiTransportError
      ? { stage, reason: error.reason, traceId: error.traceId }
      : { stage, reason: 'invalid_response' }
  pendingFailure = { context, failure }
}

/** Keep both reads on the originating account. A moved workspace, revoked task
 * or unsupported projection cannot turn an old Run's state into current facts. */
function reader(diagnoseList = false) {
  const connection = apiConnection()
  const context = apiCache.context()
  const get = <T>(path: string, report?: TaskRefreshFailure) => {
    if (context !== apiCache.context()) throw new ApiError(403, 'workspaceAccessDenied')
    const diagnostics = diagnoseList ? { headers: report && { [TASK_REFRESH_FAILURE_HEADER]: JSON.stringify(report) } } : undefined
    return api<T>(path, { diagnostics }, connection).then(value => {
      if (context !== apiCache.context()) throw new ApiError(403, 'workspaceAccessDenied')
      return value
    })
  }
  return {
    get,
    project: (workspaceId: string, ids: string[], factoryIdentity = false) => readPresentationPages(workspaceId, ids, input => {
      if (context !== apiCache.context()) throw new ApiError(403, 'workspaceAccessDenied')
      return api<PresentationBatch<Presentation>>('/api/mobile/task-presentations', {
        method: 'POST', body: factoryIdentity ? { ...input, includeFactoryIdentity: true } : input, diagnostics: diagnoseList ? {} : undefined,
      }, connection)
    }),
  }
}

export async function readPresentedTasks(path: string) {
  const context = apiCache.context()
  const read = reader(true)
  const previous = pendingFailure?.context === context ? pendingFailure : undefined
  let stage: TaskRefreshFailure['stage'] = 'list'
  try {
    const list = await read.get<TaskPage>(path + (path.includes('?') ? '&' : '?') + `${TASK_PRESENTATION_PARAM}=${TASK_PRESENTATION_VERSION}`, previous?.failure)
    if (pendingFailure === previous) pendingFailure = undefined
    if (!Array.isArray(list?.tasks)) throw new Error('invalidTaskList')
    const continuation = list.next === undefined ? {} : { next: list.next }
    if (list.presentationVersion === TASK_PRESENTATION_VERSION && typeof list.workspaceId === 'string' && list.workspaceId)
      return { workspaceId: list.workspaceId, tasks: list.tasks, ...continuation }
    if (list.presentationVersion !== undefined) throw new Error('invalidTaskPresentationVersion')
    // Older self-hosted versions answer without the marker and retain the
    // same authorization and projection path they used before.
    stage = 'workspace'
    const workspaceId = list.workspaceId ?? (await read.get<{ workspace: { id: string } }>('/api/mobile/home')).workspace.id
    stage = 'presentation'
    const presentations = await read.project(workspaceId, list.tasks.map(task => task.id))
    return { workspaceId, ...continuation, tasks: list.tasks.flatMap(task => {
      const view = presentations.get(task.id)
      return view ? [{ ...task, ...view, status: view.primaryStatus }] : []
    }) }
  } catch (error) {
    recordFailure(context, stage, error)
    throw error
  }
}

export async function readPresentedTask(path: string): Promise<TaskDetail> {
  const read = reader()
  const detail = await read.get<TaskDetail>(path + (path.includes('?') ? '&' : '?') + 'work=1')
  const workspaceId = detail.live?.workspaceId
  if (!workspaceId) throw new ApiError(403, 'workspaceAccessDenied')
  if (detail.work?.version === 1) return detail
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
