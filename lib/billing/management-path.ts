import type { BillingScope } from './management-contract'

/** Shared REST path for Web, Desktop and native clients; contains no platform imports. */
export function billingManagementPath(scope: BillingScope, budgetWorkspaceId?: string | null, usageMemberId?: string | null) {
  const path = `/api/${scope.kind === 'organization' ? 'organizations' : 'workspaces'}/${encodeURIComponent(scope.id)}/billing`
  const query = new URLSearchParams()
  if (budgetWorkspaceId) query.set('budgetWorkspace', budgetWorkspaceId)
  if (usageMemberId) query.set('usageMember', usageMemberId)
  return query.size ? `${path}?${query}` : path
}
