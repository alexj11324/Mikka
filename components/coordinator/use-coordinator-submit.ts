'use client'

import { useCallback, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { authClient } from '@/lib/auth-client'
import { sendCoordinatorMessage } from '@/app/actions/coordinator'
import { createCoordinatorSubmitter, readActionOutcome, type SubmitOutcome } from '@/lib/coordinator-client-submission'
import type { ArtifactQuote } from '@/lib/artifacts/quote'
import type { BrowserNote } from '@/lib/browser/note'
import type { TaskDestination, TaskCreation } from '@/lib/task-destination'

export type CoordinatorMessageContext = {
  collaborationMode?: 'comment' | 'reply'
  quote?: ArtifactQuote | null
  botId?: string | null
  taskDestination?: TaskDestination
  taskCreation?: TaskCreation
  profileId?: string
  /** The composer's captured target; the server checks it against its trusted selection. */
  expectedWorkspaceId?: string
  notes?: readonly BrowserNote[] | null
  /** 重新发送 on a failed message: its position, so the server retries it in place. */
  retryOf?: number
}

// The account the next request's cookie belongs to, read fresh from the server
// rather than from the cached session, which can lag behind a switch elsewhere.
async function currentOwner() {
  const { data, error } = await authClient.getSession({ query: { disableCookieCache: true } })
  if (error) throw new Error(error.message ?? 'session')
  return data?.user.id ?? null
}

/** One composer's immutable submissions, including its quote, bot and destination. */
export function useCoordinatorSubmit() {
  const t = useTranslations('Coordinator')
  const tErrors = useTranslations('Errors')
  const submitter = useRef<ReturnType<typeof createCoordinatorSubmitter> | null>(null)

  const submit = useCallback((text: string, context?: CoordinatorMessageContext) => {
    submitter.current ??= createCoordinatorSubmitter({ currentOwner, transport: async submission => {
      const details = submission.context as CoordinatorMessageContext | undefined
      const expectation: [expectedWorkspaceId?: string,taskCreation?:TaskCreation,collaborationMode?:'comment'|'reply'] = details?.collaborationMode ? [details.expectedWorkspaceId, details.taskCreation, details.collaborationMode] : details?.taskCreation ? [details.expectedWorkspaceId,details.taskCreation] : details?.expectedWorkspaceId === undefined ? [] : [details.expectedWorkspaceId]
      const result = await sendCoordinatorMessage(submission.text, details?.quote, details?.botId ?? null, submission.submissionId, details?.taskDestination, details?.notes, undefined, details?.retryOf, details?.profileId, ...expectation)
      return readActionOutcome(result)
    } })
    return submitter.current.submit(text, undefined, context)
  }, [])

  // What to tell the person when a send did not end in "accepted"; null when
  // there is nothing to say (accepted, or another send of this composer is out).
  const failureMessage = useCallback((outcome: SubmitOutcome) => {
    if (outcome.kind === 'accepted' || outcome.kind === 'busy') return null
    if (outcome.kind === 'uncertain') return t('sendUncertain')
    if (outcome.kind === 'authRequired') return tErrors('authRequired')
    if (outcome.kind === 'conflict') return tErrors('submissionConflict')
    return tErrors(outcome.error === 'originRejected' || outcome.error === 'failed' ? 'generic' : outcome.error)
  }, [t, tErrors])

  return { submit, failureMessage }
}
