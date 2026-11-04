import { applyApprovalMode, CONFIGURABLE_ACTIONS, intersectNetworkDomains, isNoLooserThan, runPolicySchema, type PermissionDecision, type RunPolicy } from '@mikka/protocol/agent-policy'

const rank: Record<PermissionDecision, number> = { deny: 0, ask: 1, allow: 2 }

/** A host-frozen continuation ceiling can only remove capabilities from the
 * live target policy. Keep the original domain algebra, including wildcard
 * and port bounds; network=allow never removes either hard ceiling. */
export function intersectRunPolicy(current: RunPolicy, frozen: unknown): RunPolicy {
  if (frozen === undefined) return current
  const ceiling = runPolicySchema.parse(frozen)
  const permissions = { ...current.permissions }
  for (const action of CONFIGURABLE_ACTIONS) {
    // The parsed push policy has only allow/deny; preserve that narrower type.
    if (action === 'git_push') {
      if (ceiling.permissions.git_push === 'deny') permissions.git_push = 'deny'
      continue
    }
    const limit = ceiling.permissions[action]
    // Computer authority is separately granted by the broker. A CLI-only
    // ceiling omits it; a read-only or independent-check ceiling can deny it.
    if (limit && rank[limit] < rank[permissions[action] ?? 'ask']) permissions[action] = limit
  }
  const networkCeiling = current.networkCeiling === undefined ? ceiling.networkCeiling
    : ceiling.networkCeiling === undefined ? current.networkCeiling : intersectNetworkDomains(current.networkCeiling, ceiling.networkCeiling)
  let networkAllow = current.permissions.network === 'allow' ? [...ceiling.networkAllow]
    : ceiling.permissions.network === 'allow' ? [...current.networkAllow] : intersectNetworkDomains(current.networkAllow, ceiling.networkAllow)
  if (current.permissions.network === 'allow' && ceiling.permissions.network === 'allow') networkAllow = [...current.networkAllow]
  if (networkCeiling !== undefined) networkAllow = intersectNetworkDomains(networkAllow, networkCeiling)
  const policy: RunPolicy = { ...current, permissions, networkAllow,
    ...(networkCeiling !== undefined ? { networkCeiling: [...networkCeiling] } : {}),
    ...(current.readOnly || ceiling.readOnly ? { readOnly: true } : {}) }
  return policy.readOnly ? applyApprovalMode(policy, 'read_only') : policy
}

/** A frozen check/benchmark may narrow the live policy, never replace a denial.
 * Keep its exact bytes for the execution-evidence digest; configuration drift
 * rejects the assignment instead of silently changing the recorded experiment. */
export function constrainedAssignmentPolicy(current: RunPolicy, frozen: unknown): RunPolicy {
  if (frozen === undefined) return current
  const next = runPolicySchema.parse(frozen)
  if (!isNoLooserThan(current, next) || next.networkAllow.some(domain => !current.networkAllow.includes(domain)))
    throw new Error('Frozen assignment policy exceeds the current policy')
  return next
}
