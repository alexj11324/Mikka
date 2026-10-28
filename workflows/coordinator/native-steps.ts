import type { DefinitionSnapshot } from '@/lib/agent-kit/definition'
import { executionInstructions } from '@/lib/agent-kit/execution-instructions'
import type { CoordinatorRuntime, NativeCoordinatorJob } from '@mikka/protocol/coordinator'
import { nativeCoordinatorEnabled, nativeCoordinatorStore } from '@/lib/coordinator/native'
import { loadConversation } from '@/lib/coordinator/store'
import { instructionsWithMemory, promptMessages } from '@/lib/coordinator/context'
import { nativeCoordinatorContext, personalCoordinatorInstructions } from '@/lib/coordinator/native-prompt'
import { botInstructions } from '@/lib/coordinator/bot-instructions'
import { personalMailboxEnabled } from '@/lib/personal-mailbox-config'
import { personalMailboxInstructions } from '@/lib/personal-mailbox-instructions'
import { snapshotMailboxTools } from '@/lib/personal-mailbox-capability'

export async function runtime(userId: string): Promise<CoordinatorRuntime> {
  'use step'
  return nativeCoordinatorEnabled() ? nativeCoordinatorStore.runtime(userId) : { harness: 'ai_sdk' }
}
export async function enqueue(userId: string, holder: string, round: number, selected: Exclude<CoordinatorRuntime, { harness: 'ai_sdk' }>, tools: NativeCoordinatorJob['tools'], botId: string | null = null, snapshot?: DefinitionSnapshot) {
  'use step'
  const { summary, memory, messages } = await loadConversation(userId, botId)
  const base = snapshot ? executionInstructions(snapshot) : await botInstructions(userId, botId, personalCoordinatorInstructions())
  const permitted = snapshotMailboxTools(snapshot).filter(name => tools.some(tool => tool.name === name))
  return nativeCoordinatorStore.enqueue(userId,holder,round,selected,{
    instructions: instructionsWithMemory(personalMailboxEnabled() && snapshot ? personalMailboxInstructions(base, permitted) : base, memory),
    context: nativeCoordinatorContext(promptMessages(summary,messages,{ key: process.env.BETTER_AUTH_SECRET ?? '', scope: JSON.stringify([userId, botId]) })), tools,
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
