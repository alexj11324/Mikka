import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceMutationSession } from '@/lib/governance/http'
import { taskLabelsResponse } from '@/lib/task-labels/http'
import { mergeWorkspaceTaskLabels } from '@/lib/task-labels/store'

type Context = { params: Promise<{ workspaceId: string; labelId: string }> }
export const POST = freshSessionRoute((request: Request, context: Context) => taskLabelsResponse(async () => {
  const { workspaceId, labelId } = await context.params
  const session = await governanceMutationSession(request, workspaceId)
  return mergeWorkspaceTaskLabels(session.user, workspaceId, labelId, await governanceJson(request))
}))
