import type { DefinitionSnapshot } from '@/lib/agent-kit/definition'
import { executionInstructions } from '@/lib/agent-kit/execution-instructions'
import type { CoordinatorRuntime, NativeCoordinatorJob } from '@mikka/protocol/coordinator'
import { nativeCoordinatorEnabled, nativeCoordinatorStore } from '@/lib/coordinator/native'
import { loadConversation } from '@/lib/coordinator/store'
import { cachedContextLines, promptMessages, promptWithCachedContext } from '@/lib/coordinator/context'
import { nativeCoordinatorContext, personalCoordinatorInstructions, withCoordinatorPresentation } from '@/lib/coordinator/native-prompt'
import { botInstructions } from '@/lib/coordinator/bot-instructions'
import { withPersonalInstructions } from '@/lib/coordinator/personal-instructions'
import { grantReadsPersonalSkill } from '@/lib/plugins/skill-prompt'
import { deploymentSwitch } from '@/lib/deployment-switches'
import { personalMailboxEnabled } from '@/lib/personal-mailbox-config'
import { personalMailboxInstructions } from '@/lib/personal-mailbox-instructions'
import { snapshotMailboxTools } from '@/lib/personal-mailbox-capability'
import { SCHEDULE_INSTRUCTIONS } from '@/lib/schedules/contract'

export async function runtime(userId: string): Promise<CoordinatorRuntime> {
  'use step'
  return nativeCoordinatorEnabled() ? nativeCoordinatorStore.runtime(userId) : { harness: 'ai_sdk' }
}
export async function enqueue(userId: string, holder: string, round: number, selected: Exclude<CoordinatorRuntime, { harness: 'ai_sdk' }>, tools: NativeCoordinatorJob['tools'], botId: string, snapshot?: DefinitionSnapshot) {
  'use step'
  const { summary, memory, messages } = await loadConversation(userId, botId)
  const { memoryForBotPrompt } = await import('@/lib/profile/memory')
  const profile = await memoryForBotPrompt(userId, botId)
  const base = snapshot ? withCoordinatorPresentation(executionInstructions(snapshot)) : await botInstructions(userId, botId, personalCoordinatorInstructions())
  const permitted = snapshotMailboxTools(snapshot).filter(name => tools.some(tool => tool.name === name))
  const { githubContext, usedRepositoriesForBot } = await import('@/lib/coordinator/github-context')
  const { executionContextParts } = await import('@/lib/coordinator/execution-context')
  const execution = await executionContextParts(userId, botId)
  // The same section the hosted path composes (workflows/coordinator/steps.ts), from the
  // same store read, so a chat gives the same answer whichever runtime runs it.
  const profile = memory ? await (async () => {
    const { profilePromptSection } = await import('@/lib/profile/store')
    return profilePromptSection(userId, await usedRepositoriesForBot(userId, botId))
  })().catch(() => '') : ''
  return nativeCoordinatorStore.enqueue(userId,holder,round,selected,{
    // The GitHub lines (the authorized repository list) and the allowed models list come before the memory, so the provider's prefix cache covers them.
    instructions: promptWithCachedContext(await withPersonalInstructions(userId, personalMailboxEnabled() && snapshot ? personalMailboxInstructions(base, permitted) : base, snapshot ? snapshot.personalPlugins ?? { servers: [], skills: [] } : undefined, {
      // The device's own tool list is what it can actually run this turn, so a
      // metadata-only section is only safe when the native grant carries the
      // tool it tells the model to call. A native round is never a scheduled
      // read here (those run on the hosted path).
      canReadPersonalSkill: deploymentSwitch('personalSkillOnDemand') && grantReadsPersonalSkill(snapshot?.effectiveTools) && tools.some(item => item.name === 'read_personal_skill'),
    }), cachedContextLines(await githubContext(userId, undefined, undefined, botId), execution.models), memory, '\n' + SCHEDULE_INSTRUCTIONS + (execution.live ? '\n' + execution.live : ''), profile).instructions,
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
