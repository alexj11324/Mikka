import { deploymentSwitch } from '@/lib/deployment-switches'
import { SCHEDULE_INSTRUCTIONS } from '@/lib/schedules/contract'
import { FACTORY_QUESTION_INSTRUCTIONS, FACTORY_CHECK_RECOVERY_INSTRUCTIONS } from '@/lib/factory/instructions'
import { personalMailboxEnabled } from '@/lib/personal-mailbox-config'
import { personalMailboxInstructions } from '@/lib/personal-mailbox-instructions'
import { snapshotMailboxTools } from '@/lib/personal-mailbox-capability'
import type { MailboxToolName } from '@mikka/protocol/mailbox'
import { definitionInstructions, type DefinitionSnapshot } from '@/lib/agent-kit/definition'
import { executionInstructions } from '@/lib/agent-kit/execution-instructions'
import { cachedContextLines, promptWithCachedContext } from '@/lib/coordinator/context'
import { COORDINATOR_INSTRUCTIONS } from '@/lib/coordinator/instructions'
import { withPersonalInstructionText } from '@/lib/coordinator/personal-instructions'
import { botInstructions } from '@/lib/coordinator/bot-instructions'
import { withCoordinatorPresentation } from '@/lib/coordinator/native-prompt'
import { loadProductPromptContext } from '@/lib/coordinator/prompt-context'

/** Product context only: eve supplies history and owns pruning and compaction. */
export async function composeEveInstructions(userId: string, botId: string, snapshot?: DefinitionSnapshot, nativeTurn?: { sessionId: string; turnId: string }, nativePolicy?: Pick<DefinitionSnapshot, 'definition' | 'effectiveTools' | 'personalPlugins'>) {
  snapshot = snapshot ? { ...snapshot, personalPlugins: snapshot.personalPlugins ? { ...snapshot.personalPlugins, skills: [] } : undefined } : undefined
  const policy = nativePolicy ?? snapshot
  const conversation = await loadProductPromptContext(userId, botId)
  const { memory } = conversation
  const mailboxTools: readonly MailboxToolName[] = []
  const githubScope = { hosted: true, readOnly: false, effectiveTools: policy?.effectiveTools }
  // The hosted Coordinator renders OpenUI like the native one, so it gets the same presentation rules and catalog.
  const host = snapshot ? executionInstructions(snapshot) : await botInstructions(userId, botId, COORDINATOR_INSTRUCTIONS)
  const base = withCoordinatorPresentation(nativePolicy ? definitionInstructions(host, nativePolicy.definition) : host)
  const instructions = personalMailboxEnabled() && policy ? personalMailboxInstructions(base, snapshotMailboxTools(policy).filter(name => mailboxTools.includes(name))) : base
  const factoryPolicy = deploymentSwitch('factoryRouting') && deploymentSwitch('factoryLifecycle') ? FACTORY_QUESTION_INSTRUCTIONS + FACTORY_CHECK_RECOVERY_INSTRUCTIONS : ''
  // The person's 个人指令 sit after the rules and before the memory, marked as theirs.
  // The person's own GitHub account, so the Bot looks a repository up instead of asking which account it is under.
  const { githubPromptContext } = await import('@/lib/coordinator/github-context')
  const { executionContextParts } = await import('@/lib/coordinator/execution-context')
  const { memoryForBotPrompt } = await import('@/lib/profile/memory')
  const [execution, rules, github, approvedFacts] = await Promise.all([
    executionContextParts(userId, botId),
    withPersonalInstructionText(userId, instructions, conversation.personalInstructions, policy ? { ...policy.personalPlugins ?? { servers: [] }, skills: [] } : undefined),
    githubPromptContext(userId, githubScope, undefined, undefined, botId),
    conversation.memoryEnabled ? memoryForBotPrompt(userId, botId, conversation.memoryEnabled, nativeTurn) : Promise.resolve(''),
  ])
  // What Mikka has learnt about the person (R-73). It reaches only the chat's own
  // repositories' facts, so one project's habits never surface in another's
  // conversation. A profile read that fails leaves the section out; it never
  // fails the turn. The `memory` switch governs it exactly as it governs the
  // person's own notes: with 记忆 off, conversationWithMemory already emptied
  // `memory`, and nothing learnt is stated either.
  const profile = memory ? await (async () => {
    const [{ profilePromptSection }, { usedRepositoriesForBot }] = await Promise.all([
      import('@/lib/profile/store'), import('@/lib/coordinator/github-context'),
    ])
    return profilePromptSection(userId, await usedRepositoriesForBot(userId, botId))
  })().catch(() => '') : ''
  // Rules keep an earlier cache breakpoint. This context contains current model facts and either lazy GitHub discovery
  // guidance or the complete legacy/fallback repository context; it can change between turns (lib/prompt-cache.ts).
  // The person's memory and what Mikka knows about them ride together just after it, then live model availability.
  const prompt = promptWithCachedContext(rules, cachedContextLines(github, execution.models), [memory, approvedFacts].filter(Boolean).join('\n'), factoryPolicy + '\n' + SCHEDULE_INSTRUCTIONS + (execution.live ? '\n' + execution.live : ''), profile)
  return prompt.instructions
}
