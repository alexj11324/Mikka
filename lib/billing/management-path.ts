import type { BillingScope } from './management-contract'

/** Shared REST path for Web, Desktop and native clients; contains no platform imports. */
export function billingManagementPath(scope: BillingScope, budgetWorkspaceId?: string | null) {
  const path = `/api/${scope.kind === 'organization' ? 'organizations' : 'workspaces'}/${encodeURIComponent(scope.id)}/billing`
  return budgetWorkspaceId ? `${path}?budgetWorkspace=${encodeURIComponent(budgetWorkspaceId)}` : path
}
