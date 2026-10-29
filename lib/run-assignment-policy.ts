import { isNoLooserThan, runPolicySchema, type RunPolicy } from '@mikka/protocol/agent-policy'

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
