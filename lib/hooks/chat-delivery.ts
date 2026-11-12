'use client'

import { useTranslations } from 'next-intl'
import { checkPageBuildBeforeAction } from '@/lib/app-build'
import { useActionError } from '@/lib/use-action-error'
import { prepareThreadReply } from '@/lib/thread-submission-input'
import { useViewState } from './view-state'

import { useChatDeliveryState, type ChatDelivery, type ChatSubmission } from './chat-delivery-state'
export type { ChatDelivery, ChatSubmission } from './chat-delivery-state'

export function useChatDelivery<T extends ChatSubmission>(scope: string, uncertain: string) {
  const [rows, setRows] = useViewState<ChatDelivery<T>[]>(`chat-send:${scope}`, [])
  return useChatDeliveryState(rows, setRows, uncertain)
}

type BoundThreadReply = Pick<ChatSubmission, 'id' | 'text'> & { runId: string; expectedOwnerId?: string; expectedWorkspaceId?: string }
type OriginalSessionRetry = { retryOriginalSession: true; runId: string; text: string; questionWakeGeneration?: string }
type ThreadReplyReceipt = { status: 'accepted' } | { status: 'failed' | 'uncertain'; error: string }

/** Both the thread composer and a waiting Task in Inbox write through this command. */
export function useThreadReplyCommand() {
  const feedback = useTranslations('Coordinator')
  const actionError = useActionError()
  async function preflight() {
    if (navigator.onLine === false) return feedback('sendOffline')
    if (!await checkPageBuildBeforeAction()) return feedback('sendUpdateRequired')
    return null
  }
  async function submit(issueId: string | null, command: BoundThreadReply | OriginalSessionRetry): Promise<ThreadReplyReceipt> {
    try {
      const blocked = await preflight()
      if (blocked) return { status: 'failed', error: blocked }
      const request = 'retryOriginalSession' in command ? command : {
        requestId: command.id, runId: command.runId, text: command.text,
        expectedOwnerId: command.expectedOwnerId, expectedWorkspaceId: command.expectedWorkspaceId,
      }
      const { sendIssueThreadReply } = await import('@/app/actions/agents')
      const result = await sendIssueThreadReply({ issueId, ...request })
      return result.error ? { status: 'failed', error: actionError(result.error) } : { status: 'accepted' }
    } catch (error) {
      // The Web and Desktop action transports attach HTTP status to their Error. A lost response has no status.
      const status = error instanceof Error && 'status' in error ? error.status : undefined
      if (status === 401) return { status: 'failed', error: actionError('authRequired') }
      if (status === 403) return { status: 'failed', error: feedback('sendAccessDenied') }
      if (status === 426) return { status: 'failed', error: feedback('sendUpdateRequired') }
      if (status === 429) return { status: 'failed', error: feedback('sendRateLimited') }
      return { status: 'uncertain', error: feedback('sendUncertain') }
    }
  }
  return { preflight, submit }
}

type InboxReply = ChatSubmission & BoundThreadReply & { issueId: string }

/** Keep the Inbox card's original operation until acknowledgement, including across a remount. */
export function useInboxThreadReply(scope: { ownerId: string; workspaceId?: string } | null) {
  const feedback = useTranslations('Coordinator')
  const actionError = useActionError()
  const journal = useChatDelivery<InboxReply>('inbox:thread-replies', feedback('sendUncertain'))
  const writer = useThreadReplyCommand()
  return async (issueId: string, runId: string, text: string) => {
    if (!scope?.workspaceId) return { status: 'unavailable' as const, error: actionError('workspaceAccessDenied') }
    const words = text.trim()
    const previous = journal.rows.find(row => row.issueId === issueId && row.expectedOwnerId === scope.ownerId &&
      row.expectedWorkspaceId === scope.workspaceId && row.text === words)
    const request = prepareThreadReply(previous && { requestId: previous.id, runId: previous.runId, text: previous.text }, runId, words)
    const command = previous ?? { issueId, id: request.requestId, runId: request.runId, text: request.text, at: Date.now(),
      expectedOwnerId: scope.ownerId, expectedWorkspaceId: scope.workspaceId }
    if (!journal.begin(command)) return { status: 'uncertain' as const, error: feedback('sendUncertain') }
    const receipt = await writer.submit(issueId, command)
    journal.finish(command.id, receipt.status === 'accepted' ? {} : { error: receipt.error })
    if (receipt.status === 'accepted') journal.setRows(rows => rows.filter(row => row.id !== command.id))
    return receipt
  }
}
