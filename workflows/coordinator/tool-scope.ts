import { nativeCoordinatorStore } from '../../lib/coordinator/native'
import { NativeCoordinatorError } from '../../lib/coordinator/native-store'
import { FatalError } from 'workflow'
import type { ScheduledRead } from '@/lib/schedules/contract'

/** Host-owned execution identity, never part of a model's tool arguments. */
type ScheduledAuthority = { botId: string | null; occurrence: ScheduledRead }
export type NativeToolScope = {
  holder: string
  turnId: string
  callId: string
  scheduledRead?: ScheduledAuthority
} | {
  scheduledRead: ScheduledAuthority
  holder?: never
  turnId?: never
  callId?: never
}

/** Both authorities are checked within each business read step. A scheduled
 * SDK turn has its own occurrence authority; native turns retain theirs too. */
export async function assertNativeToolScope(userId: string, scope?: NativeToolScope): Promise<void> {
  if (!scope) return
  try {
    if (scope.holder !== undefined) await nativeCoordinatorStore.assertToolActive(userId,scope.holder,scope.turnId,scope.callId)
    if (scope.scheduledRead) {
      const { assertScheduledRead } = await import('@/lib/schedules/runtime')
      await assertScheduledRead(userId,scope.scheduledRead.botId,scope.scheduledRead.occurrence)
    } else if (scope.holder === undefined) throw new FatalError('toolScopeUnavailable')
  } catch (error) {
    if (error instanceof NativeCoordinatorError || (error instanceof Error && error.name === 'ScheduleError')) throw new FatalError(error.message)
    throw error
  }
}
