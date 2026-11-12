import { DESKTOP_RPC_VERSION } from '../../../lib/desktop-rpc/wire'
import type { ChatSubmission } from '../../../lib/hooks/chat-delivery-state'
import type { mentionsIn } from './group'

type GroupTarget = { kind: 'group'; id: string }
type ThreadTarget = { kind: 'thread'; id: string; issueId: string | null }
export type ConversationTarget = GroupTarget | ThreadTarget
export type ConversationCommand = ChatSubmission & {
  target: ConversationTarget; expectedOwnerId: string; expectedWorkspaceId: string; mentions: ReturnType<typeof mentionsIn>
}

type Receipt = { id?: string; version?: number; ok?: boolean; result?: { sent?: boolean; runId?: string; error?: string }; error?: { code?: string } }
type Post = (path: string, init: { method: 'POST'; body: unknown }) => Promise<Receipt | null>

/** Keep the original target and payload on replay, including when a Task now has a newer run. */
export async function submitConversation(command: ConversationCommand, post: Post, storedId: string): Promise<void> {
  const { target, id: requestId, text, expectedOwnerId, expectedWorkspaceId } = command
  if (target.kind === 'group') {
    const receipt = await post(`/api/conversations/${target.id}/messages`, {
      method: 'POST', body: { body: text, mentions: command.mentions, requestId, expectedOwnerId, expectedWorkspaceId },
    })
    if (receipt?.id !== storedId) throw new Error('submissionUnconfirmed')
    return
  }
  const receipt = await post('/api/rpc', { method: 'POST', body: {
    version: DESKTOP_RPC_VERSION, action: 'agents.sendIssueThreadReply',
    args: [{ issueId: target.issueId, runId: target.id, text, requestId, expectedOwnerId, expectedWorkspaceId }],
  } })
  if (receipt?.version === DESKTOP_RPC_VERSION) {
    const code = receipt.ok ? receipt.result?.error : receipt.error?.code
    if (code) throw Object.assign(new Error(code), { code, status: 400 })
    if (receipt.ok && receipt.result?.sent === true && receipt.result.runId) return
  }
  throw new Error('submissionUnconfirmed')
}
