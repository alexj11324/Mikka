import { ActionFailureError } from '@/lib/action-error'
import { freshSessionRoute } from '@/lib/fresh-session'
import { GovernanceError } from '@/lib/governance/errors'
import { governanceResponse, governanceSession } from '@/lib/governance/http'
import { readOrganizationProjectEnvironmentVariable } from '@/lib/project-resources/store'

export const runtime = 'nodejs'
type Context = { params: Promise<{ organizationId: string; projectId: string; name: string }> }

export const GET = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const params = await context.params
  const session = await governanceSession(request)
  try {
    return await readOrganizationProjectEnvironmentVariable(session.user, params)
  } catch (error) {
    if (error instanceof ActionFailureError && ['projectNotFound', 'workspaceAccessDenied'].includes(error.code)) throw new GovernanceError('not_found', error)
    throw error
  }
}))
