import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceMutationSession, governanceSession } from '@/lib/governance/http'
import { taskLabelsResponse } from '@/lib/task-labels/http'
import { createWorkspaceTaskLabel, readWorkspaceTaskLabels } from '@/lib/task-labels/store'

type Context = { params: Promise<{ workspaceId: string }> }
export const GET = freshSessionRoute((request: Request, context: Context) => taskLabelsResponse(async () => {
  const { workspaceId } = await context.params
  return readWorkspaceTaskLabels((await governanceSession(request, workspaceId)).user, workspaceId)
}))
export const POST = freshSessionRoute((request: Request, context: Context) => taskLabelsResponse(async () => {
  const { workspaceId } = await context.params
  const session = await governanceMutationSession(request, workspaceId)
  return createWorkspaceTaskLabel(session.user, workspaceId, await governanceJson(request))
}))
