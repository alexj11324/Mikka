'use client'

import { useCallback, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { authClient } from '@/lib/auth-client'
import { createCoordinatorSubmitter, type SubmitOutcome } from '@/lib/coordinator-submission'

// One composer's submissions to the Coordinator, scoped to the signed-in
// account: a pending submission is resent only by the account that started it.
export function useCoordinatorSubmit() {
  const t = useTranslations('Coordinator')
  const tErrors = useTranslations('Errors')
  const { data: session } = authClient.useSession()
  const owner = session?.user.id ?? ''
  const submitter = useRef<ReturnType<typeof createCoordinatorSubmitter> | null>(null)

  const submit = useCallback((text: string) => {
    submitter.current ??= createCoordinatorSubmitter()
    return submitter.current.submit(owner, text)
  }, [owner])

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
