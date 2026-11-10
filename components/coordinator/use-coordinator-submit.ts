'use client'

import { useCallback, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { authClient } from '@/lib/auth-client'
import { sendCoordinatorMessage } from '@/app/actions/coordinator'
import { createCoordinatorSubmitter, readActionOutcome, type SubmitOutcome } from '@/lib/coordinator-client-submission'
import type { ArtifactQuote } from '@/lib/artifacts/quote'
import type { BrowserNote } from '@/lib/browser/note'
import type { TaskDestination } from '@/lib/task-destination'

export type CoordinatorMessageContext = {
  quote?: ArtifactQuote | null
  botId?: string | null
  taskDestination?: TaskDestination
  profileId?: string
  /** The composer's captured target; the server checks it against its trusted selection. */
  expectedWorkspaceId?: string
  notes?: readonly BrowserNote[] | null
  /** 重新发送 on a failed message: its position, so the server retries it in place. */
  retryOf?: number
  /** 标题 the person wrote for the new task; the task gets exactly it. */
  taskTitle?: string
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
      const expectation: [expectedWorkspaceId?: string] = details?.expectedWorkspaceId === undefined ? [] : [details.expectedWorkspaceId]
      const args = [submission.text, details?.quote, details?.botId ?? null, submission.submissionId, details?.taskDestination, details?.notes, undefined, details?.retryOf, details?.profileId] as const
      // taskTitle is the trailing argument, so a title needs the (possibly undefined) workspace before it.
      const result = details?.taskTitle ? await sendCoordinatorMessage(...args, details.expectedWorkspaceId, details.taskTitle) : await sendCoordinatorMessage(...args, ...expectation)
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
