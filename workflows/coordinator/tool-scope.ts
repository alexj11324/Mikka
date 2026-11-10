import { nativeCoordinatorStore } from '../../lib/coordinator/native'
import { NativeCoordinatorError } from '../../lib/coordinator/native-store'
import { FatalError } from 'workflow'
import type { ScheduledRead } from '@/lib/schedules/contract'
import { SHARED_BOT_CHAT_TOOLS, type SharedBotChatScope } from '@/lib/collaboration/bot-chat-contract'

/** Host-owned execution identity, never part of a model's tool arguments. */
type ScheduledAuthority = { botId: string; occurrence: ScheduledRead }
export type NativeToolScope = {
  holder: string
  turnId: string
  callId: string
  scheduledRead?: ScheduledAuthority
  sharedChat?: never
} | {
  scheduledRead: ScheduledAuthority
  holder?: never
  turnId?: never
  callId?: never
  sharedChat?: never
} | {
  sharedChat: SharedBotChatScope
  scheduledRead?: never
  holder?: never
  turnId?: never
  callId?: never
}

/** Both authorities are checked within each business read step. A scheduled
 * SDK turn has its own occurrence authority; native turns retain theirs too. */
export async function assertNativeToolScope(userId: string, scope?: NativeToolScope, toolName?: string): Promise<void> {
  if (!scope) return
  try {
    if (scope.sharedChat) {
      if (!(SHARED_BOT_CHAT_TOOLS as readonly string[]).includes(toolName ?? '')) throw new FatalError('sharedBotToolNotAllowed')
      const [{ pool }, { liveBotChatAuthority }] = await Promise.all([import('@/lib/db'), import('@/lib/collaboration/bot-chat')])
      await liveBotChatAuthority(pool, scope.sharedChat.eventId, { ownerId: userId, botId: scope.sharedChat.botId })
      return
    }
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
