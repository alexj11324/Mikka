'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import useSWR, { unstable_serialize } from 'swr'
import { getTaskPresentations } from '@/app/actions/task-domain'
import { useLiveKeys } from '@/hooks/use-live-key'
import { readPresentationPages } from '@/lib/task-presentation-batch'
import type { TaskPresentation } from '@/lib/task-presentation'

type Register = (ids: readonly string[]) => () => void
const Registration = createContext<Register | null>(null)
const EMPTY: Record<string, TaskPresentation> = {}
const Cards = createContext<Readonly<Record<string, TaskPresentation>>>(EMPTY)

/** Rows subscribe to one bulk request for mounted cards, including citations
 * older than the workspace list. Unmounting a row retires its live keys. */
export function TaskCardDataProvider({ ownerId, workspaceId, children }: {
  ownerId: string; workspaceId?: string; children: ReactNode
}) {
  const [subscriptions, setSubscriptions] = useState<Map<symbol, readonly string[]>>(new Map())
  const register = useCallback<Register>(values => {
    const token = Symbol()
    setSubscriptions(current => new Map(current).set(token, values))
    return () => setSubscriptions(current => {
      const next = new Map(current)
      next.delete(token)
      return next
    })
  }, [])
  const ids = useMemo(() => [...new Set([...subscriptions.values()].flat())].sort(), [subscriptions])
  const key = workspaceId && ids.length ? ['task-cards', ownerId, workspaceId, ids] : null
  const cards = useSWR(key, async () => Object.fromEntries(await readPresentationPages(workspaceId!, ids,
    input => getTaskPresentations({ ...input, includeInboxReason: true, includeReview: true }))), { revalidateOnFocus: false, shouldRetryOnError: false })
  useLiveKeys(key ? ids.flatMap(id => (['issue_threads', 'pull_request_status', 'factory_issue'] as const)
    .map(kind => ({ kind, id, workspaceId }))) : [], key ? [unstable_serialize(key)] : [], workspaceId ?? null, { minIntervalMs: 2000 })
  return <Registration value={register}><Cards value={cards.error ? EMPTY : cards.data ?? EMPTY}>{children}</Cards></Registration>
}

export function useTaskCards(ids: readonly string[]) {
  const register = useContext(Registration)
  const signature = JSON.stringify([...new Set(ids)].sort())
  useEffect(() => {
    const current: string[] = JSON.parse(signature)
    if (current.length) return register?.(current)
  }, [register, signature])
  return useContext(Cards)
}
