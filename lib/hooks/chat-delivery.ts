'use client'

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { checkPageBuildBeforeAction } from '@/lib/app-build'
import { useActionError } from '@/lib/use-action-error'
import { prepareThreadReply } from '@/lib/thread-submission-input'
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

type InboxReply = ChatSubmission & { issueId: string; runId: string; ownerId: string; workspaceId: string }

/** A waiting Task in Inbox replies to its original thread, including after a lost acknowledgement or remount. */
export function useInboxThreadReply(scope: { ownerId: string; workspaceId?: string } | null) {
  const feedback = useTranslations('Coordinator')
  const actionError = useActionError()
  const journal = useChatDelivery<InboxReply>('inbox:thread-replies', feedback('sendUncertain'))
  return async (issueId: string, runId: string, text: string) => {
    if (!scope?.workspaceId) return { status: 'unavailable' as const, error: actionError('workspaceAccessDenied') }
    const words = text.trim()
    const previous = journal.rows.find(row => row.issueId === issueId && row.ownerId === scope.ownerId &&
      row.workspaceId === scope.workspaceId && row.text === words)
    const request = prepareThreadReply(previous && { requestId: previous.id, runId: previous.runId, text: previous.text }, runId, words)
    const command = previous ?? { issueId, runId: request.runId, ownerId: scope.ownerId, workspaceId: scope.workspaceId, id: request.requestId, text: words, at: Date.now() }
    if (!journal.begin(command)) return { status: 'uncertain' as const, error: feedback('sendUncertain') }
    const fail = (error: string) => { journal.finish(command.id, { error }); return { status: 'failed' as const, error } }
    try {
      if (navigator.onLine === false) return fail(feedback('sendOffline'))
      if (!await checkPageBuildBeforeAction()) return fail(feedback('sendUpdateRequired'))
      const { sendIssueThreadReply } = await import('@/app/actions/agents')
      const result = await sendIssueThreadReply({ issueId: command.issueId, ...request, expectedOwnerId: command.ownerId, expectedWorkspaceId: command.workspaceId })
      if (result.error) return fail(actionError(result.error))
      journal.finish(command.id, {})
      journal.setRows(rows => rows.filter(row => row.id !== command.id))
      return { status: 'accepted' as const }
    } catch {
      const error = feedback('sendUncertain')
      journal.finish(command.id, { error })
      return { status: 'uncertain' as const, error }
    }
  }
}
