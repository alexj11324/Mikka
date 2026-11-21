import { z } from 'zod'
import { listOrganizationFileLinks } from '@/lib/drive/organization-file-links'
import { organizationSession } from '@/lib/enterprise/http'
import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceResponse } from '@/lib/governance/http'


export const GET = freshSessionRoute(async (request: Request, context: { params: Promise<{ organizationId: string }> }) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  const page = z.coerce.number().int().min(1).max(2_147_483_647).parse(new URL(request.url).searchParams.get('page') ?? '1')
  return listOrganizationFileLinks(organizationId, session.user.id, session.session.id, page)
}))
