import { freshSessionRoute } from '@/lib/fresh-session'
import { organizationAccountSession } from '@/lib/enterprise/http'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { GovernanceError } from '@/lib/governance/errors'
import { changePersonalProject } from '@/lib/project-input'
import { personalProjectSelectionFor } from '@/lib/resource-access/personal-project-selection'

type Context = { params: Promise<{ workspaceId: string }> }

export const GET = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const session = await organizationAccountSession(request)
  const reader = request.headers.get('x-mikka-reader-id')
  if (reader !== null && reader !== session.user.id) throw new GovernanceError('access_denied')
  return personalProjectSelectionFor(session.user, (await context.params).workspaceId)
}))

export const PUT = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const session = await organizationAccountSession(request)
  const change = changePersonalProject.parse(await governanceJson(request))
  return personalProjectSelectionFor(session.user, (await context.params).workspaceId, change)
}))
