// Proposed safe diagnostic excerpt; port and verify against the authoritative peer patch.
import { CodedError, logCodedError } from '@mikka/protocol/coded-error'
import type { DueKind } from './due-timer'

type Detail = 'holder_scope' | 'candidate_scope' | 'force_unsupported' | 'claim_lost' | 'predecessor_scope' | 'predecessor_active'
type Diagnostic = { kind: DueKind; runId?: string; deploymentId?: string; holderRunId?: string; holderDeploymentId?: string; holderSpecVersion?: number; forceSupported?: boolean; previousRunId?: string; previousDeploymentId?: string; previousStatus?: string }
const safeId = (value: string | undefined) => value && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : undefined
function unavailable(detail: Detail, fields: Diagnostic) {
  const error = new CodedError('due_timer_unavailable', { detail })
  logCodedError(error, {
    event: 'due_timer_claim_rejected', kind: fields.kind,
    runId: safeId(fields.runId), deploymentId: safeId(fields.deploymentId),
    holderRunId: safeId(fields.holderRunId), holderDeploymentId: safeId(fields.holderDeploymentId),
    holderSpecVersion: fields.holderSpecVersion !== undefined && Number.isFinite(fields.holderSpecVersion) ? fields.holderSpecVersion : undefined,
    forceSupported: fields.forceSupported, previousRunId: safeId(fields.previousRunId),
    previousDeploymentId: safeId(fields.previousDeploymentId), previousStatus: safeId(fields.previousStatus),
  })
  return error
}

