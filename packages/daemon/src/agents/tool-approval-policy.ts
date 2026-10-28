import type { RunPolicy } from '@mikka/protocol/agent-policy'
import type { ToolApprovalRequest } from './tool-approval'

/** Native CLI callbacks do not attest which Mikka action a shell command
 * performs. Do not infer authority from command text or ask for unrelated
 * approvals. Unsupported callback capabilities remain unavailable. */
export function toolApprovalDecision(_request: Readonly<ToolApprovalRequest>, _policy?: RunPolicy): 'unavailable' {
  return 'unavailable'
}
