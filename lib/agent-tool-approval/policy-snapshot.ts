import {
  applyApprovalMode,
  approvalModeSchema,
  gitPushRestriction,
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
  const policy = resolveAgentSettings(workspace, undefined, source.environment).policy
  // A stored git_push only restricts: push itself is the GitHub App grant, which
  // claim adds for an admitted run (decision 2026-11-01-1215). Unset, or an ask
  // stored before that decision, does not deny.
  policy.permissions.git_push = gitPushRestriction(workspace?.permissions)
  return applyApprovalMode(policy, personal)
}
