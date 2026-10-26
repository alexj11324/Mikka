import { nativeCoordinatorStore } from '../../lib/coordinator/native'
import { NativeCoordinatorError } from '../../lib/coordinator/native-store'
import { FatalError } from 'workflow'

/** Host-owned execution identity, never part of a model's tool arguments. */
export interface NativeToolScope {
  holder: string
  turnId: string
  callId: string
}

/** Run within the business step, not a separate replayable authorization step. */
export async function assertNativeToolScope(userId: string, scope?: NativeToolScope): Promise<void> {
  if (!scope) return
  try {
    await nativeCoordinatorStore.assertToolActive(userId,scope.holder,scope.turnId,scope.callId)
  } catch (error) {
    if (error instanceof NativeCoordinatorError) throw new FatalError(error.message)
    throw error
  }
}
