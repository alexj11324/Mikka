import 'server-only'
import { hostedModel } from '@/lib/abuse/model'
import { hostedBillingScope } from '@/lib/abuse/context'
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

/** Chat only: selected owner's public role description only, no private standing instructions, tools or agent sessions,
 * credentials or device/issue execution. Group messages are quoted untrusted data.
 */
export const groupRuntime: GroupRuntime = {
  async agents(ownerId, ids, client) {
    if (!ids.length) return []
    // Reuse the execution connection: acquiring a second application-pool slot
    // while every group holds a session lock can exhaust the shared pool.
    const { rows } = await client.query<{ id: string; name: string; description: string }>('SELECT id,name,description FROM agents WHERE "userId"=$1 AND id=ANY($2::uuid[])', [ownerId, ids])
    return ids.flatMap(id => { const row = rows.find(a => a.id === id); return row ? [row] : [] })
  },
  async bots(ownerId, workspaceId, ids, client) {
    if (!ids.length) return []
    const { rows } = await client.query(`SELECT id,name,'' AS description,'bot' AS "memberType" FROM bots
      WHERE "ownerId"=$1 AND "workspaceId"=$2 AND id=ANY($3::uuid[])`, [ownerId, workspaceId, ids])
    return ids.flatMap(id => { const row = rows.find(b => b.id === id); return row ? [row] : [] })
  },
  prepareBot: (actor, scope, client) => freezeGroupBotModel({ ...scope, botId: actor.id }, client),
  async authorized(workspaceId, userId) {
    const rows = await workspaceDb.select({ id: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active'))).limit(1)
    return rows.length === 1
  },
  ...createGroupJudgment(invokeDecision),
  async generate(agent, input) {
    const scope = hostedBillingScope.getStore()
    if (!scope) throw new Error('verification_required')
    if (agent.memberType === 'bot' && !scope.ownerId) throw new Error('verification_required')
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
        ? await resolveGroupBotModel({ ownerId: scope.ownerId!, workspaceId: scope.workspaceId, botId: agent.id }, input.modelRuntime ?? (() => { throw Error('group_bot_model_unavailable') })(), signal)
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
      if (agent.memberType === 'bot') return await streamText(options).output
      return (await generateText(options)).output
    } catch (error) {
      // The SDK's final NoOutput error can hide the actual stream failure or timeout.
      if (signal.aborted) throw new Error('group_generation_interrupted', { cause: signal.reason })
      throw streamFailure ?? error
    }
  },
}
