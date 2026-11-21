import { ActionFailureError } from '@/lib/action-error'
import { freshSessionRoute } from '@/lib/fresh-session'
import { GovernanceError } from '@/lib/governance/errors'
import { governanceResponse, governanceSession } from '@/lib/governance/http'
import { readProjectEnvironmentVariable } from '@/lib/project-resources/store'

type Context = { params: Promise<{ workspaceId: string; projectId: string; name: string }> }

export const GET = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const params = await context.params
  const session = await governanceSession(request, params.workspaceId)
  try {
    return await readProjectEnvironmentVariable(session.user, params)
  } catch (error) {
    if (error instanceof ActionFailureError && error.code === 'projectNotFound') throw new GovernanceError('not_found', error)
    throw error
  }
}))
