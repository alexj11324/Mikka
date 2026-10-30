import type { Pool } from 'pg'
import { approvalRequest } from '../../lib/factory/approval-contract'
import { createFactoryApprovalGates, createFactoryApprovals, type PublicationAdapter } from '../../lib/factory/approval'
import type { FactoryApprovalStore, FactoryAuthorize } from '../../lib/factory/approval-dependencies'
import { factoryCheckIndependent } from '../../lib/factory/check-independence'

export const factoryTestLifecycle = { independent: factoryCheckIndependent }
/** Test ports use the same human-session approval path as production. */
export function createFactoryTestAuthority() {
  return {
    gates: createFactoryApprovalGates(),
    approvals(pool: Pool, authorize: FactoryAuthorize, store: FactoryApprovalStore, adapters: PublicationAdapter[] = []) {
      return createFactoryApprovals(pool, authorize, store, adapters)
    },
    request(_ownerId: string, input: unknown, _evidence: unknown) {
      return approvalRequest.parse(input)
    },
  }
}
