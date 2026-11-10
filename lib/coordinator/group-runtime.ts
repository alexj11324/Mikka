import 'server-only'
import { hostedModel } from '@/lib/abuse/model'
import { hostedBillingScope } from '@/lib/abuse/context'
import { CodedError } from '@mikka/protocol/coded-error'
import { COORDINATOR_MODEL } from './model'
import { generateText, streamText, Output } from 'ai'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import type { GroupRuntime } from './group-turns'
import { createGroupJudgment } from './group-judgment'
import { invokeDecision } from './decide'
import { freezeGroupBotModel, resolveGroupBotModel } from './group-bot-model'
import { groupReplySystemPrompt } from './group-reply-prompt'
import { splitChatFiles } from '@mikka/protocol/chat-attachments'
import type { UserModelMessage } from 'ai'
import { groupBotCatalog } from './group-member-catalog'
import { withAiMetadata } from '@/lib/tracing/ai'

const judgment = createGroupJudgment(invokeDecision)

/** Group replies read only public duties and host capabilities. Actual work is
 * delegated through Factory with requester-owned resources; chat generation
 * never imports private standing instructions or another member's sessions.
 */
export const groupRuntime: GroupRuntime = {
  async agents(ownerId, ids, client) {
    if (!ids.length) return []
    // Reuse the execution connection: acquiring a second application-pool slot
    // while every group holds a session lock can exhaust the shared pool.
    const { rows } = await client.query<{ id: string; name: string; description: string }>('SELECT id,name,description FROM agents WHERE "userId"=$1 AND id=ANY($2::uuid[])', [ownerId, ids])
    return ids.flatMap(id => { const row = rows.find(a => a.id === id); return row ? [{...row,role:row.description || null,capabilities:['answer'],executionAvailable:false,executionReason:'use_factory_bot_for_execution'}] : [] })
  },
  async bots(ownerId, workspaceId, ids, client) {
    if (!ids.length) return []
    const availability=new Map<string,{available:boolean;reason?:string}>()
    return groupBotCatalog(client,ownerId,workspaceId,ids,async(bot)=>{
      const { pool,withDatabaseClient }=await import('@/lib/db')
      const { agentProfileDispatchAvailability }=await import('@/lib/factory/agent-profile')
      return withDatabaseClient(client,async()=>{
        const executionBotId=bot.ownerId===ownerId ? bot.id : await (await import('./coordinator-bot')).chatBotId(ownerId,null,workspaceId)
        const key=JSON.stringify([executionBotId,bot.repository])
        const cached=availability.get(key)
        if (cached) return cached
        if (bot.repository && !await (await import('@/lib/workspace-admin/bots')).repositoryAvailable(workspaceId,bot.repository)) return {available:false,reason:'repositoryNotFound'}
        const result=await agentProfileDispatchAvailability(pool,{ownerId,workspaceId,botId:executionBotId},{location:bot.repository?undefined:'cloud',cloudPurpose:bot.repository?'task':'desktop'},{deferStaleQuota:true})
        availability.set(key,result)
        return result
      })
    },userId=>groupRuntime.authorized(workspaceId,userId))
  },
  prepareBot: (actor, scope, client) => freezeGroupBotModel({ ...scope, botId: actor.id }, client),
  async authorized(workspaceId, userId) {
    const rows = await workspaceDb.select({ id: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active'))).limit(1)
    return rows.length === 1
  },
  ...judgment,
  routeMention: judgment.route,
  async tasks(scope,client) { return (await import('./group-factory')).groupTaskReferences(client,scope) },
  async delegate(scope,client) { return (await import('./group-factory')).delegateGroupTask(client,scope) },
  async generate(agent, input) {
    const scope = hostedBillingScope.getStore()
    // Same code the chat shows today; the detail tells the two missing scopes apart in the stored error and logs.
    if (!scope) throw new CodedError('verification_required', { detail: 'billing_scope_missing' })
    if (agent.memberType === 'bot' && (!scope.ownerId || !scope.actorId)) throw new CodedError('verification_required', { detail: 'billing_actor_missing' })
    // 停止 in the group aborts it too (lib/coordinator/group-turns.ts).
    const signal = input.signal ? AbortSignal.any([AbortSignal.timeout(20000), input.signal]) : AbortSignal.timeout(20000)
    let streamFailure: unknown
    const prompt = JSON.stringify({ message: input.message, currentMembers: input.members, earlierReplies: input.earlier, responseGuidance: input.followUp, clarificationAgentId: input.ask, privatePeer: input.privatePeer })
    let content: UserModelMessage['content'] = prompt
    if (splitChatFiles(input.message.text).files.length) {
      if (!input.attachmentContext) throw Error('attachmentContextRequired')
      const { chatFileContent } = await import('@/lib/chat-attachments/store')
      const parts = await chatFileContent(input.attachmentContext.userId, { kind: 'group', id: input.attachmentContext.conversationId }, input.message.text)
      content = [{ type: 'text', text: prompt }, ...parts.slice(1)]
    }
    const options = {
      model: agent.memberType === 'bot'
        ? await resolveGroupBotModel({ ownerId: scope.ownerId!, actorId: scope.actorId!, workspaceId: scope.workspaceId, botId: agent.id }, input.modelRuntime ?? (() => { throw Error('group_bot_model_unavailable') })(), signal)
        : await hostedModel(scope.workspaceId,COORDINATOR_MODEL,undefined,scope.ownerId),
      system: groupReplySystemPrompt(agent),
      messages: [{ role: 'user' as const, content }],
      output: Output.object({ schema: z.object({ text: z.string().max(32000), mentions: z.array(z.string().uuid()).max(100), privateTo: z.uuid().nullable() }) }),
      maxOutputTokens: 4000, maxRetries: 0, abortSignal: signal,
      onError: ({ error }: { error: unknown }) => { streamFailure = error },
    }
    // Existing subscription transports are streaming-only. Never switch the
    // selected Bot to the generic Coordinator's paid model on refusal.
    try {
      if (agent.memberType === 'bot') return await withAiMetadata({ operation: 'bot' }, () => streamText(options).output)
      return (await withAiMetadata({ operation: 'coordinator' }, () => generateText(options))).output
    } catch (error) {
      // The SDK's final NoOutput error can hide the actual stream failure or timeout.
      if (signal.aborted) throw new Error('group_generation_interrupted', { cause: signal.reason })
      throw streamFailure ?? error
    }
  },
}
