import { freshSessionRoute } from '@/lib/fresh-session'
import { GovernanceError } from '@/lib/governance/errors'
import { governanceResponse } from '@/lib/governance/http'
import { organizationAccountSession } from '@/lib/enterprise/http'
import { enterpriseLogoutTarget } from '@/lib/enterprise/logout-target'

export const runtime = 'nodejs'

export const GET = freshSessionRoute(async (request: Request) => governanceResponse(async () => {
  const session = await organizationAccountSession(request)
  if (new URL(request.url).searchParams.size) throw new GovernanceError('invalid_request')
  return { target: await enterpriseLogoutTarget(session) }
}))
