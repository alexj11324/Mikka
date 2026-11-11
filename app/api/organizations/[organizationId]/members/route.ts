import { z } from 'zod'
import { freshSessionRoute } from '@/lib/fresh-session'
import { addOrganizationMember, updateOrganizationMember, removeOrganizationMember } from '@/lib/governance/organizations'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { organizationSession } from '@/lib/enterprise/http'

export const runtime = 'nodejs'
type Context = { params: Promise<{ organizationId: string }> }
export const POST = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  return addOrganizationMember(organizationId, session.user.id, await governanceJson(request))
}))
export const PATCH = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  await updateOrganizationMember(organizationId, session.user.id, await governanceJson(request))
  return { updated: true }
}))
export const DELETE = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  const { userId } = z.object({ userId: z.string().min(1).max(200) }).strict().parse(await governanceJson(request))
  await removeOrganizationMember(organizationId, session.user.id, userId)
  return { removed: true }
}))
