import { z } from 'zod'
import { SpanStatusCode, trace } from '@opentelemetry/api'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { actAs } from '@/lib/acting-user'
import { ActionFailureError } from '@/lib/action-error'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { WorkspaceError } from '@/lib/workspace-error'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { nextTaskListCursor, taskListPageInput } from '@/lib/task-list-page'
import { countAssignedWorkspaceTasks, pollIssues, listWorkspaceIssues, listWorkspaceTaskPage } from '@/app/actions/issues'
import { getTaskPresentations } from '@/app/actions/task-domain'
import { json, mobileUser, unauthorized } from '@/lib/mobile-api'
import { boardBlocks } from '@/components/blocks/kanban-board-1/components/data'
import { newestTaskRuns, taskScheduleLabels } from '@/lib/task-block-runs'
import { taskStateOf } from '@/lib/task-state'
import { taskReviewSummaries } from '@/lib/coding-workspace/task-review/summaries'
import { readTaskRefreshFailure, TASK_PRESENTATION_PARAM, TASK_PRESENTATION_VERSION, TASK_REFRESH_FAILURE_HEADER } from '@/lib/mobile-task-refresh'

export const dynamic = 'force-dynamic'

function recordMobileRefreshFailure(request: Request) {
  if (request.headers.get('x-mikka-client-kind') !== 'mobile') return
  const report = readTaskRefreshFailure(request.headers.get(TASK_REFRESH_FAILURE_HEADER))
  if (!report) return
  // An error span is retained even when this recovery request succeeds.
  const span = trace.getTracer('mikka.mobile').startSpan('mobile.tasks.refresh.failure', { attributes: {
    'mikka.task_refresh.client_stage': report.stage,
    'mikka.task_refresh.reason': report.reason,
    ...(report.status === undefined ? {} : { 'mikka.task_refresh.http_status': report.status }),
    ...(report.traceId === undefined ? {} : { 'mikka.task_refresh.failed_trace_id': report.traceId }),
  } })
  span.setStatus({ code: SpanStatusCode.ERROR })
  span.end()
}

/** `GET /api/mobile/tasks`: the 任务 list: the person's tasks in this workspace, newest change first, each with its 受阻 (lib/task-blocked.ts). No board on mobile. */
async function handleGET(request: Request) {
  const span = trace.getActiveSpan()
  span?.setAttribute('mikka.task_refresh.server_stage', 'authentication')
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  try {
    return await actAs(user, async () => {
      const tokenWorkspaceId = (user as typeof user & { [tokenWorkspace]?: string })[tokenWorkspace]
      // Keep the selected workspace already resolved by the existing list read; no extra context query.
      const params = new URL(request.url).searchParams
      if (params.has('count')) {
        const workspace = params.get('workspaceId')
        if (params.get('count') !== 'assigned' || !workspace || !z.uuid().safeParse(workspace).success
          || [...params.keys()].some(key => key !== 'workspaceId' && key !== 'count')) return json({ error: 'invalidRequest' }, 400)
        return json(await countAssignedWorkspaceTasks(workspace))
      }
      const projected = params.get(TASK_PRESENTATION_PARAM) === String(TASK_PRESENTATION_VERSION)
      if (projected) recordMobileRefreshFailure(request)
      span?.setAttribute('mikka.task_refresh.server_stage', 'selection')
      const continuation = params.has('after') || params.has('updatedAt')
      const dispatchedBy = params.get('dispatchedBy')
      const parentId = params.get('parentId')
      const page = continuation || dispatchedBy !== null || parentId !== null ? taskListPageInput.safeParse({ workspaceId: params.get('workspaceId'),
        ...(dispatchedBy !== null ? { dispatchedBy } : {}), ...(parentId !== null ? { parentId } : {}), after: continuation ? { id: params.get('after'), updatedAt: params.get('updatedAt') } : null }) : null
      if (page && !page.success) return json({ error: 'validationGeneric' }, 400)
      const nextPage = page?.success ? await listWorkspaceTaskPage(page.data) : null
      if (nextPage?.reset) return json({ error: 'issueStale' }, 409)
      const { issues, workspaceId } = nextPage
        ? { issues: nextPage.items, workspaceId: nextPage.workspaceId }
        : tokenWorkspaceId ? { issues: await listWorkspaceIssues(tokenWorkspaceId), workspaceId: tokenWorkspaceId }
          : await pollIssues().then(snapshot => ({ issues: snapshot.items!, workspaceId: snapshot.live.selectedWorkspaceId }))
      // Recheck and hold the exact tenant before decorating or returning the
      // authorized list. A revocation that wins admission cannot return it.
      span?.setAttribute('mikka.task_refresh.server_stage', 'workspace')
      return withTaskWorkspace(user, workspaceId, async () => {
        span?.setAttribute('mikka.task_refresh.server_stage', 'decoration')
        const snapshots = await newestTaskRuns(user.id, issues.map(issue => issue.id), workspaceId, await taskScheduleLabels())
        const reviews = await taskReviewSummaries(user, snapshots.filter(row => row.codingReview).map(row => row.issueId), workspaceId)
        const runs = snapshots.flatMap(row => row.runId && row.status ? [{ ...row, runId: row.runId, status: row.status }] : [])
        const byIssue = new Map(snapshots.map(row => [row.issueId, row]))
        const runByIssue = new Map(runs.map(row => [row.issueId, row]))
        const blocks = boardBlocks(issues, runs)
        // Use the same bounded, authorized projection as the older POST. Do
        // this last so its fresh visibility check controls the returned rows.
        if (projected) span?.setAttribute('mikka.task_refresh.server_stage', 'presentation')
        const presentations = projected && issues.length
          ? (await getTaskPresentations({ workspaceId, issueIds: issues.map(issue => issue.id) })).items : null
        return json({
          ...(projected ? { presentationVersion: TASK_PRESENTATION_VERSION } : {}),
          workspaceId, next: nextTaskListCursor(issues),
          tasks: issues.flatMap(issue => {
            const view = presentations?.[issue.id]
            if (presentations && !view) return []
            const block = blocks.get(issue.id)
            return [{
              // The short title the small model wrote, while the task keeps the title it was written from (lib/short-title.ts).
              ...(dispatchedBy ? { dispatchedBy } : {}), id: issue.id, identifier: issue.identifier, title: issue.title, status: view?.primaryStatus ?? issue.status, priority: issue.priority,
              owner: issue.ownerName, updatedAt: issue.updatedAt,
              createdAt: issue.createdAt, ...(view ?? taskStateOf(issue, runByIssue.get(issue.id), { block, schedule: byIssue.get(issue.id)?.schedule })),
              bot: byIssue.get(issue.id)?.bot ?? null, schedule: byIssue.get(issue.id)?.schedule ?? null,
              blocked: block ? { reason: block.reason, blocker: block.blockerIdentifier ?? null } : null,
              review: reviews.get(issue.id) ?? null,
            }]
          }),
        })
      })
    })
  } catch (error) {
    if (error instanceof ActionFailureError && error.code === 'issueNotFound') return json({ error: 'issueNotFound' }, 404)
    if (error instanceof ActionFailureError && error.code === 'issueStale') return json({ error: 'issueStale' }, 409)
    if (error instanceof WorkspaceError || (error instanceof ActionFailureError && error.code === 'workspaceAccessDenied'))
      return json({ error: 'workspaceAccessDenied' }, 403)
    throw error
  }
}

export const GET = withRequestLog('/api/mobile/tasks', handleGET)
