import { z } from 'zod'
import type { ComposioActionClient } from '../composio-actions'
import { OperationError } from './write-error'

/** Version of this adapter's request/response contract, not a claim that Slack
 * itself offers a version-pinned API. Bump when the stored snapshot changes. */
export const SLACK_CONVERSATION_READ_CONTRACT = 'slack-conversations-info-v1'
const response = z.object({ ok:z.literal(true), channel:z.object({ id:z.string().min(1) }).passthrough() }).passthrough()
export type SlackConversationReader = (ownerId:string, accountId:string, channelId:string) => Promise<Record<string, unknown>>
export function composioSlackConversationReader(client:ComposioActionClient | null): SlackConversationReader | undefined {
  if (!client) return undefined
  return async (ownerId,accountId,channelId) => {
    const result=await client.tools.proxyExecute({ endpoint:'/conversations.info',method:'GET',userId:ownerId,connectedAccountId:accountId,parameters:[{in:'query',name:'channel',value:channelId}] })
    const parsed=response.safeParse(result.data)
    if (result.status !== 200 || !parsed.success || parsed.data.channel.id !== channelId) throw new OperationError('integrationTargetUnavailable')
    return parsed.data.channel
  }
}
