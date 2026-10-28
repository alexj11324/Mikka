import { networkDomainSchema, type RunPolicy } from '@mikka/protocol/agent-policy'
import type { ToolApprovalRequest } from './tool-approval'
import { classifyWrite } from '../permissions'

/** Native CLI callbacks do not attest which Mikka action a shell command
 * performs. Do not infer authority from command text or ask for unrelated
 * approvals. Unsupported callback capabilities remain unavailable. */
export function toolApprovalDecision(request: Readonly<ToolApprovalRequest>, policy?: RunPolicy, worktree?: string): 'unavailable' | 'allow' | 'ask' | 'deny' {
  // This method is emitted only by the host-owned run proxy. Native CLI
  // callbacks use their own method namespace and cannot select this action.
  if (request.method === 'sandbox/network' && policy) {
    const value = request.input as { host?: unknown; port?: unknown } | null
    if (!value || typeof value.host !== 'string' || /[*/:]/.test(value.host) || !networkDomainSchema.safeParse(value.host).success || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535) return 'deny'
    return policy.permissions.network
  }
  if (request.method.startsWith('cli/') && policy && worktree) {
    const tool = request.method.slice(4)
    const input = request.input as {file_path?: unknown; path?: unknown} | null
    if (['Write','Edit','MultiEdit','NotebookEdit'].includes(tool)) {
      if (policy.readOnly) return 'deny'
      const path = input?.file_path
      if (typeof path !== 'string') return 'unavailable'
      // Resolve symlinks against the host-owned worktree. A callback cannot
      // expand the launcher's immutable filesystem ceiling.
      return classifyWrite(worktree,path) === 'write_in_worktree' ? 'allow' : 'unavailable'
    }
  }
  return 'unavailable'
}
