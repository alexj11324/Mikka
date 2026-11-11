'use client'

import { useCallback, useRef } from 'react'
import { useTranslations } from 'next-intl'
import type { UseEveAgentReturn } from 'eve/react'
import type { SendTurnOptions } from 'eve/client'
import { acceptTaskDelivery } from '@/lib/task-create-form'
import { authClient } from '@/lib/auth-client'
import { coordinatorAgentClient, coordinatorSendFailure, type SubmitOutcome } from '@/lib/eve/client'
import type { ArtifactQuote } from '@/lib/artifacts/quote'
import type { BrowserNote } from '@/lib/browser/note'
import type { DispatchTaskIntent, DispatchedTaskReceipt } from '@/lib/task-create-command'
import type { TaskDestination } from '@/lib/task-destination'

export type CoordinatorMessageContext = {
  quote?: ArtifactQuote | null
  botId?: string | null
  taskCommand?: DispatchTaskIntent
  confirmTaskAccess?: boolean
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
  const operations = useRef(new Map<string, { id: string; conflict?: true; delivered?: true }>())
  const submit = useCallback(async (text: string, context?: CoordinatorMessageContext): Promise<SubmitOutcome> => {
    const trimmed = text.trim()
    if (!trimmed || trimmed.length > 10_000) return { kind: 'rejected', error: 'messageRequired' }
    // The cookie's current account owns the operation key, including after an account switch in another tab.
    const { data, error } = await authClient.getSession({ query: { disableCookieCache: true } })
    if (error) return { kind: 'uncertain' }
    if (!data?.user.id) return { kind: 'authRequired' }
    // The confirmation replays one refused command. It is not a new message.
    const { confirmTaskAccess: _confirmation, ...immutable } = context ?? {}
    const body = JSON.stringify([data.user.id, trimmed, context ? immutable : null])
    // Another message may be sent before this one's uncertain result is retried.
    // Retain each unresolved key; the native server remains the dedupe authority.
    let operation = operations.current.get(body)
    if (operation?.conflict) return { kind: 'conflict' }
    if (!operation) { operation = { id: crypto.randomUUID() }; operations.current.set(body, operation) }
    const options: SendTurnOptions = { headers: { 'x-mikka-submission-id': operation.id },
      clientContext: JSON.parse(JSON.stringify(context ?? {})) as NonNullable<SendTurnOptions['clientContext']> }
    try {
      await acceptTaskDelivery(operation, async () => {
        if (agent) await agent.send(trimmed, options)
        else {
          const { session } = await coordinatorAgentClient(context?.botId ?? null).sessions.create()
          await session.send(trimmed, options)
        }
      })
      let task: DispatchedTaskReceipt | null = null
      if (context?.taskCommand && context.expectedWorkspaceId) {
        const { getDispatchedTaskReceipt } = await import('@/app/actions/issues')
        task = await getDispatchedTaskReceipt({ workspaceId: context.expectedWorkspaceId, requestId: operation.id, botId: context.botId ?? null })
        // Once Eve acknowledged the write, a lost receipt only retries this read.
        if (!task) return { kind: 'uncertain' }
      }
      operations.current.delete(body)
      return { kind: 'accepted', enabled: true, sourceEventId: task?.dispatch.sourceEventId ?? null, replayed: false, ...(task ? { task } : {}) }
    } catch (error) {
      if (operation.delivered) return { kind: 'uncertain' }
      const outcome = coordinatorSendFailure(error)
      if (outcome.kind === 'conflict') operations.current.set(body, { ...operation, conflict: true })
      else if (outcome.kind !== 'uncertain' && outcome.kind !== 'authRequired' && !(outcome.kind === 'rejected' && outcome.error === 'accessChangeConfirmationRequired')) operations.current.delete(body)
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
