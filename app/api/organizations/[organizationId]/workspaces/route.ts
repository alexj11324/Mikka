import { z } from 'zod'
import { freshSessionRoute } from '@/lib/fresh-session'
import { attachOrganizationWorkspace, detachOrganizationWorkspace } from '@/lib/governance/organizations'
import { governanceJson, governanceResponse, governanceSession } from '@/lib/governance/http'
export const runtime = 'nodejs'
type Context = { params: Promise<{ organizationId: string }> }
const input = z.object({ workspaceId: z.uuid() }).strict()

export const POST = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const session = await governanceSession(request)
  const { workspaceId } = input.parse(await governanceJson(request))
  await attachOrganizationWorkspace((await context.params).organizationId, workspaceId, session.user.id)
  return { attached: true }
}))
export const DELETE = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const session = await governanceSession(request)
  const { workspaceId } = input.parse(await governanceJson(request))
  await detachOrganizationWorkspace((await context.params).organizationId, workspaceId, session.user.id)
  return { detached: true }
}))
