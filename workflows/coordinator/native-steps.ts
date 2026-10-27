import type { CoordinatorRuntime, NativeCoordinatorJob } from '@mikka/protocol/coordinator'
import { nativeCoordinatorEnabled, nativeCoordinatorStore } from '@/lib/coordinator/native'
import { loadConversation } from '@/lib/coordinator/store'
import { instructionsWithMemory, promptMessages } from '@/lib/coordinator/context'
import { nativeCoordinatorContext, personalCoordinatorInstructions } from '@/lib/coordinator/native-prompt'
import { botInstructions } from '@/lib/coordinator/bot-instructions'

export async function runtime(userId: string): Promise<CoordinatorRuntime> {
  'use step'
  return nativeCoordinatorEnabled() ? nativeCoordinatorStore.runtime(userId) : { harness: 'ai_sdk' }
}
export async function enqueue(userId: string, holder: string, round: number, selected: Exclude<CoordinatorRuntime, { harness: 'ai_sdk' }>, tools: NativeCoordinatorJob['tools'], botId: string | null = null) {
  'use step'
  const { summary, memory, messages } = await loadConversation(userId, botId)
  return nativeCoordinatorStore.enqueue(userId,holder,round,selected,{
    instructions: instructionsWithMemory(await botInstructions(userId, botId, personalCoordinatorInstructions()), memory),
    context: nativeCoordinatorContext(promptMessages(summary,messages)), tools,
  })
}
export async function poll(userId: string, holder: string, turnId: string) {
  'use step'
  return nativeCoordinatorStore.poll(userId,holder,turnId)
}
export async function finishTool(userId: string, holder: string, turnId: string, callId: string, output: unknown) {
  'use step'
  await nativeCoordinatorStore.finishTool(userId,holder,turnId,callId,output)
}
export async function close(userId: string, holder: string, turnId: string) {
  'use step'
  await nativeCoordinatorStore.close(userId,holder,turnId)
}
