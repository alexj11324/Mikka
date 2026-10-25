'use client'

import { useCallback, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { authClient } from '@/lib/auth-client'
import { createCoordinatorSubmitter, type SubmitOutcome } from '@/lib/coordinator-submission'

// The account the next request's cookie belongs to, read fresh from the server
// rather than from the cached session, which can lag behind a switch elsewhere.
async function currentOwner() {
  const { data, error } = await authClient.getSession({ query: { disableCookieCache: true } })
  if (error) throw new Error(error.message ?? 'session')
  return data?.user.id ?? null
}

/** One composer's submissions to the Coordinator; see lib/coordinator-submission.ts. */
export function useCoordinatorSubmit() {
  const t = useTranslations('Coordinator')
  const tErrors = useTranslations('Errors')
  const submitter = useRef<ReturnType<typeof createCoordinatorSubmitter> | null>(null)

  const submit = useCallback((text: string, questionId?: string) => {
    submitter.current ??= createCoordinatorSubmitter({ currentOwner })
    return submitter.current.submit(text, questionId)
  }, [])

  // What to tell the person when a send did not end in "accepted"; null when
  // there is nothing to say (accepted, or another send of this composer is out).
  const failureMessage = useCallback((outcome: SubmitOutcome) => {
    if (outcome.kind === 'accepted' || outcome.kind === 'busy') return null
    if (outcome.kind === 'uncertain') return t('sendUncertain')
    if (outcome.kind === 'authRequired') return tErrors('authRequired')
    if (outcome.kind === 'conflict') return tErrors('submissionConflict')
    if (outcome.error === 'messageRequired') return tErrors('messageRequired')
    return tErrors('generic')
  }, [t, tErrors])

  return { submit, failureMessage }
}
