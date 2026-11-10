import 'server-only'
import { z } from 'zod'
import { auth, apiWorkspaceAllowed } from '@/lib/api-auth'
import { desktopSameOriginRequest } from '@/lib/desktop-auth'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { requireEnterpriseOrganization } from '@/lib/enterprise/access'
import { GovernanceError } from '@/lib/governance/errors'
import { governanceJson } from '@/lib/governance/http'
import { WorkspaceError } from '@/lib/workspace-access'
import { isActionErrorCode } from '@/lib/workspace-admin/action'
import { billingManagementView, mutateBillingManagement } from './management'
import type { BillingScope } from './management-contract'

export async function billingManagementResponse(request: Request, scope: BillingScope) {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store' } })
  try {
    const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
    if (!session) return json({ error: 'authRequired' }, 401)
    if (scope.kind === 'workspace' ? !apiWorkspaceAllowed(session, scope.id) : Boolean(session.tokenWorkspaceId)) throw new WorkspaceError('workspaceAccessDenied')
    if (scope.kind === 'organization') await requireEnterpriseOrganization(session.user.id, z.uuid().parse(scope.id), session.session.id)
    if (request.method === 'GET') return json(await billingManagementView(session.user.id, scope,
      new URL(request.url).searchParams.get('budgetWorkspace'), session.user[enterprisePrincipal]))
    if (!desktopSameOriginRequest(request) || !request.headers.get('content-type')?.startsWith('application/json')) throw new WorkspaceError('workspaceAccessDenied')
    return json(await mutateBillingManagement(session.user.id, scope, await governanceJson(request), session.user[enterprisePrincipal]))
  } catch (error) {
    if (error instanceof z.ZodError) return json({ error: 'validationGeneric' }, 400)
    if (error instanceof GovernanceError) return json({ error: error.detail === 'access_denied' ? 'workspaceAccessDenied' : error.detail === 'invalid_request' ? 'validationGeneric' : 'billingPolicyChanged' }, error.detail === 'access_denied' ? 403 : error.detail === 'invalid_request' ? 400 : 409)
    if (error instanceof WorkspaceError) return json({ error: isActionErrorCode(error.code) ? error.code : 'generic' }, error.code === 'workspaceAccessDenied' ? 403 : 409)
    console.error('billing_management_failed', { name: error instanceof Error ? error.name : 'UnknownError' })
    return json({ error: 'generic' }, 500)
  }
}
