import { auth } from '@/lib/api-auth'
import { effectiveRequestWorkspace } from '@/lib/request-workspace'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { withRequestLog } from '@/lib/request-log'
import { ActionFailureError } from '@/lib/action-error'
import { GovernanceError } from '@/lib/governance/errors'
import { z } from 'zod'
import { json, writeAllowed, forbiddenOrigin, unauthorized } from '@/lib/mobile-api'
import { resourceCreationDefaults, setOrganizationCreationDefaults } from '@/lib/resource-access/creation-defaults'

export const dynamic = 'force-dynamic'

async function handle(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session) return unauthorized()
  if (request.method !== 'GET' && !writeAllowed(request)) return forbiddenOrigin()
  const workspaceId = await effectiveRequestWorkspace(session.user)
  if (!workspaceId) return json({ error: 'workspaceAccessDenied' }, 404)
  const reader = { id: session.user.id, [tokenWorkspace]: workspaceId, [enterprisePrincipal]: session.user[enterprisePrincipal] }
  try {
    return json(request.method === 'GET' ? await resourceCreationDefaults(reader, workspaceId)
      : await setOrganizationCreationDefaults(reader, workspaceId, await request.json().catch(() => null)))
  } catch (error) {
    if (error instanceof z.ZodError) return json({ error: 'validationGeneric' }, 400)
    if (error instanceof GovernanceError) return json({ error: 'workspaceAccessDenied' }, 403)
    if (error instanceof ActionFailureError) return json({ error: error.code }, error.code === 'issueOutdated' ? 409 : 404)
    throw error
  }
}

export const GET = withRequestLog('/api/resources/defaults', handle)
export const POST = withRequestLog('/api/resources/defaults', handle)
