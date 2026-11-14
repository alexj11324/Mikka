import { DESKTOP_RPC_VERSION } from '../../../lib/desktop-rpc/version'
import type { ChatSubmission } from '../../../lib/hooks/chat-delivery-state'
import type { mentionsIn } from './group'

type GroupTarget = { kind: 'group'; id: string }
type ThreadTarget = { kind: 'thread'; id: string; issueId: string | null; delivery?: import('../../../lib/thread-delivery').ThreadDeliveryMode }
export type ConversationTarget = GroupTarget | ThreadTarget
export type ConversationCommand = ChatSubmission & {
  target: ConversationTarget; expectedOwnerId: string; expectedWorkspaceId: string; mentions: ReturnType<typeof mentionsIn>
}

export function sameConversationCommand(command: ConversationCommand, target: ConversationTarget, text: string, mentions: ConversationCommand['mentions']) {
  return command.text === text && command.target.kind === target.kind && command.target.id === target.id &&
    (command.target.kind !== 'thread' || (target.kind === 'thread' && command.target.issueId === target.issueId && command.target.delivery === target.delivery)) &&
    command.mentions.length === mentions.length && command.mentions.every((item, i) => item.memberId === mentions[i]?.memberId && item.memberType === mentions[i]?.memberType)
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
    args: [{ issueId: target.issueId, runId: target.id, ...(target.delivery ? { delivery: target.delivery } : {}), text, requestId, expectedOwnerId, expectedWorkspaceId }],
  } })
  if (receipt?.version === DESKTOP_RPC_VERSION) {
    const code = receipt.ok ? receipt.result?.error : receipt.error?.code
    if (code) throw Object.assign(new Error(code), { code, status: 400 })
    if (receipt.ok && receipt.result?.sent === true && receipt.result.runId) return
  }
  throw new Error('submissionUnconfirmed')
}

export async function changeMobileQueuedReply(target: ThreadTarget, messageId: string, action: 'cancel' | 'sendNow', post: Post) {
  const receipt = await post('/api/rpc', { method: 'POST', body: {
    version: DESKTOP_RPC_VERSION, action: 'agents.changeQueuedThreadReply', args: [{ issueId: target.issueId, runId: target.id, messageId, action }],
  } })
  const result = receipt?.result as { status?: string; error?: string } | undefined
  if (receipt?.version !== DESKTOP_RPC_VERSION) throw Error('submissionUnconfirmed')
  const code = receipt.ok ? result?.error : receipt.error?.code
  if (code) throw Object.assign(Error(code), { code })
  if (!receipt.ok || !['cancelled','sent','tooLate'].includes(result?.status ?? '')) throw Error('submissionUnconfirmed')
  return result?.status
}
