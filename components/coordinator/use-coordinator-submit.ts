'use client'

import { useCallback, useRef } from 'react'
import { useTranslations } from 'next-intl'
import type { UseEveAgentReturn } from 'eve/react'
import type { SendTurnOptions } from 'eve/client'
import { authClient } from '@/lib/auth-client'
import { coordinatorAgentClient, coordinatorSendFailure, type SubmitOutcome } from '@/lib/eve/client'
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

/** The caller keeps the logical operation key across an uncertain result; eve owns delivery dedupe. */
export function useCoordinatorSubmit(agent?: Pick<UseEveAgentReturn, 'send'>) {
  const t = useTranslations('Coordinator')
  const tErrors = useTranslations('Errors')
  const operation = useRef<{ body: string; id: string } | null>(null)
  const submit = useCallback(async (text: string, context?: CoordinatorMessageContext): Promise<SubmitOutcome> => {
    const trimmed = text.trim()
    if (!trimmed || trimmed.length > 10_000) return { kind: 'rejected', error: 'messageRequired' }
    // The cookie's current account owns the operation key, including after an account switch in another tab.
    const { data, error } = await authClient.getSession({ query: { disableCookieCache: true } })
    if (error) return { kind: 'uncertain' }
    if (!data?.user.id) return { kind: 'authRequired' }
    const body = JSON.stringify([data.user.id, trimmed, context ?? null])
    if (operation.current?.body !== body) operation.current = { body, id: crypto.randomUUID() }
    const options: SendTurnOptions = { headers: { 'x-mikka-submission-id': operation.current.id },
      clientContext: JSON.parse(JSON.stringify(context ?? {})) as NonNullable<SendTurnOptions['clientContext']> }
    try {
      if (agent) await agent.send(trimmed, options)
      else {
        const { session } = await coordinatorAgentClient(context?.botId ?? null).sessions.create()
        await session.send(trimmed, options)
      }
      operation.current = null
      return { kind: 'accepted', enabled: true, sourceEventId: null, replayed: false }
    } catch (error) {
      const outcome = coordinatorSendFailure(error)
      if (outcome.kind !== 'uncertain' && outcome.kind !== 'authRequired') operation.current = null
      return outcome
    }
  }, [agent?.send])

  const failureMessage = useCallback((outcome: SubmitOutcome) => {
    if (outcome.kind === 'accepted' || outcome.kind === 'busy') return null
    if (outcome.kind === 'uncertain') return t('sendUncertain')
    if (outcome.kind === 'authRequired') return tErrors('authRequired')
    if (outcome.kind === 'conflict') return tErrors('submissionConflict')
    return tErrors(outcome.error === 'originRejected' || outcome.error === 'failed' ? 'generic' : outcome.error)
  }, [t, tErrors])
  return { submit, failureMessage }
}
