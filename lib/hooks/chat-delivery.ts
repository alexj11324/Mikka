'use client'

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { checkPageBuildBeforeAction } from '@/lib/app-build'
import { useActionError } from '@/lib/use-action-error'
import { prepareThreadReply } from '@/lib/thread-submission-input'
import { RequestError } from '@/lib/factory/browser-request'
import { useViewState } from './view-state'

export type ChatSubmission = { id: string; text: string; at: number }
export type ChatDelivery<T extends ChatSubmission> = T & { phase: 'sending' | 'accepted' | 'failed'; error?: string; storedId?: string }
const inFlight = new Set<string>()

/** All chat entries journal the immutable command before starting asynchronous preflight or transport. */
export function useChatDelivery<T extends ChatSubmission>(scope: string, uncertain: string) {
  const [rows, setRows] = useViewState<ChatDelivery<T>[]>(`chat-send:${scope}`, [])
  // A page reload may interrupt the response. Only the originating command can recover its result.
  useEffect(() => {
    const interrupted = rows.filter(row => row.phase === 'sending' && !inFlight.has(row.id))
    if (interrupted.length) setRows(current => current.map(row => interrupted.some(item => item.id === row.id) && row.phase === 'sending' ? { ...row, phase: 'failed', error: uncertain } : row))
  }, [rows, setRows, uncertain])
  function begin(command: T) {
    if (inFlight.has(command.id)) return false
    inFlight.add(command.id)
    setRows(current => current.some(row => row.id === command.id)
      ? current.map(row => row.id === command.id ? { ...row, phase: 'sending', error: undefined } : row)
      : [...current, { ...command, phase: 'sending' }])
    return true
  }
  function finish(id: string, result: { error: string } | { storedId?: string }) {
    inFlight.delete(id)
    setRows(current => current.map(row => row.id !== id ? row : 'error' in result
      ? { ...row, phase: 'failed', error: result.error } : { ...row, phase: 'accepted', storedId: result.storedId }))
  }
  return { rows, setRows, begin, finish }
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
      if (error instanceof RequestError && error.status < 500) return { status: 'failed', error: error.status === 429 ? feedback('sendRateLimited') : actionError(error.code) }
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
