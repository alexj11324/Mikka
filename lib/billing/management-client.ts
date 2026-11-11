import { withBasePath } from '@/lib/base-path'
import type { BillingManagementOperation, BillingManagementView, BillingScope } from './management-contract'
import { billingManagementPath } from './management-path'
export { billingManagementPath } from './management-path'
export class BillingManagementError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); this.name = 'BillingManagementError' }
}
export async function billingManagementRequest<T = BillingManagementView>(scope: BillingScope, operation?: BillingManagementOperation, budgetWorkspaceId?: string | null): Promise<T> {
  const response = await fetch(withBasePath(billingManagementPath(scope, budgetWorkspaceId)), { method: operation ? 'POST' : 'GET',
    credentials: 'same-origin', cache: 'no-store', ...(operation ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(operation) } : {}) })
  const result = await response.json()
  if (!response.ok) throw new BillingManagementError(typeof result?.error === 'string' ? result.error : 'generic', response.status)
  return result as T
}
