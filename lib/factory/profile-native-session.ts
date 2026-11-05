import type { WorkerDefinitionSnapshot } from '@/lib/agent-kit/worker'
import { entryKey } from '@/lib/model-order-plan'

type NativeDefinition = Partial<Pick<WorkerDefinitionSnapshot, 'harness' | 'model' | 'agentProfile' | 'subscription' | 'apiKey'>> | null | undefined

/** A new run can retain files and ancestry while starting a new native session.
 * A frozen role or provider change must never inherit the old native SID. */
export function profileNativeSessionMatches(source: NativeDefinition, target: NativeDefinition): boolean {
  const before = source?.agentProfile, after = target?.agentProfile
  if (!before && !after) return true // Preserve historical runs without Profile metadata.
  if (!before || !after) return false
  return before.profileId === after.profileId && before.version === after.version && before.digest === after.digest &&
    before.effort === after.effort && entryKey(before.targetEntry) === entryKey(after.targetEntry) &&
    source?.harness === target?.harness && source?.model === target?.model &&
    source?.subscription?.bindingId === target?.subscription?.bindingId && source?.apiKey?.keyId === target?.apiKey?.keyId
}
