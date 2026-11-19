import { listOrganizationDriveVolumes } from '@/lib/drive/organization-volumes'
import { organizationSession } from '@/lib/enterprise/http'
import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceResponse } from '@/lib/governance/http'

export const runtime = 'nodejs'

export const GET = freshSessionRoute(async (request: Request, context: { params: Promise<{ organizationId: string }> }) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  return listOrganizationDriveVolumes(organizationId, session.user.id, session.session.id, new URL(request.url).searchParams)
}))
