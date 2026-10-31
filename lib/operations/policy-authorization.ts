import type { OperationAuthorize } from './ledger'
import { OperationError } from './write-error'
import { lockWritePolicy } from './write-policy-store'

/** Composes the existing domain binding and approval checks with live policy.
 * Callbacks are host implementations executed with the same locked transaction;
 * they must verify owner, account, target, payload and the exact approval. */
export function withWritePolicy(checkBinding: OperationAuthorize, checkApproval: OperationAuthorize, options: { allowCompleted?: boolean; readbackOnly?: boolean } = {}): OperationAuthorize {
  return async (tx, binding, runId, phase) => {
    if (options.readbackOnly && phase !== 'read' && phase !== 'reconcile') throw new OperationError('operationReadbackOnly')
    const scope = binding.policyScope
    const executionRunId = binding.executionRunId
    if (!scope || !executionRunId || (runId !== null && runId !== executionRunId)) throw new OperationError('writePolicyUnavailable')
    await checkBinding(tx, binding, runId, phase)
    const current = await lockWritePolicy(tx, { ownerId: binding.ownerId, botId: scope.botId, workspaceId: scope.workspaceId, runId: executionRunId, action: binding.action }, options)
    if (current.version !== scope.version) throw new OperationError('writePolicyChanged')
    if (current.decision === 'deny') throw new OperationError('writeDenied')
    if (current.decision === 'ask') await checkApproval(tx, binding, runId, phase)
  }
}
