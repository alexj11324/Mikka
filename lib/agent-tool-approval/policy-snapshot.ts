import {
  applyApprovalMode,
  approvalModeSchema,
  networkAllowSchema,
  resolveAgentSettings,
  storedPermissionsSchema,
  type RunPolicy,
} from '@mikka/protocol/agent-policy'

/** Values must be read and scoped by the trusted server, never from the model.
 * A malformed stored value is unavailable, not a default that may widen it. */
export function resolveTrustedRunPolicy(source: {
  workspace: { permissions: unknown; networkAllow: unknown; guidance?: string | null } | null
  personalApprovalMode: unknown
  environment?: 'local' | 'cloud'
}): RunPolicy {
  const workspace = source.workspace
  if (workspace && workspace.permissions != null && !storedPermissionsSchema.safeParse(workspace.permissions).success) throw new Error('agentPolicyUnavailable')
  if (workspace && workspace.networkAllow != null && !networkAllowSchema.safeParse(workspace.networkAllow).success) throw new Error('agentPolicyUnavailable')
  const personal = source.personalApprovalMode == null ? 'ask' : approvalModeSchema.parse(source.personalApprovalMode)
  return applyApprovalMode(resolveAgentSettings(workspace, undefined, source.environment).policy, personal)
}
