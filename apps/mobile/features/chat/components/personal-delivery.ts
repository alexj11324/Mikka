import { useCallback, useEffect, useMemo, useSyncExternalStore, type SetStateAction } from 'react'
import { useChatDeliveryState } from '../../../../../lib/hooks/chat-delivery-state'
import { apiCache } from '@/lib/api-cache'
import { conversationJournal } from '@/lib/config'
import { mobileMessages as copy } from '@/lib/messages'
import { sendFailureState, submissionBody, type Outgoing } from '@/lib/outbox'

const empty: Outgoing[] = []
const listeners = new Set<() => void>()
const active = new Map<string, Promise<boolean>>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

type Send = (text: string, submissionId: string, images?: readonly { dataUrl: string }[]) => Promise<unknown>

export function acknowledgedPersonalMessages(scope: string | null): string[] {
  if (!scope) return []
  try {
    const rows = apiCache.get<Outgoing[]>(scope) ?? conversationJournal.readPersonal(scope)
    return rows.filter(row => row.phase === 'accepted').map(row => row.id)
  } catch { return [] }
}

export function usePersonalDelivery(scope: string | null, received: Set<string>, send: Send, reload: () => Promise<void>) {
  const context = apiCache.context()
  const uncertain = copy.Coordinator.sendUncertain
  const read = useCallback(() => {
    if (!scope || apiCache.context() !== context) return empty
    const cached = apiCache.get<Outgoing[]>(scope)
    if (cached) return cached
    let restored = empty
    try {
      restored = conversationJournal.readPersonal(scope).map(item => ({
        ...item, context, ...(item.phase === 'sending' ? { phase: 'failed' as const, error: uncertain } : {}),
      }))
    } catch { /* An unavailable journal must reject before a new write. */ }
    apiCache.set(scope, restored, context)
    return restored
  }, [scope, context, uncertain])
  const rows = useSyncExternalStore(subscribe, read, () => empty)
  const update = useCallback((next: SetStateAction<Outgoing[]>) => {
    if (!scope) return
    apiCache.commit(context, () => {
      apiCache.set(scope, typeof next === 'function' ? next(read()) : next, context)
      for (const listener of listeners) listener()
    })
  }, [scope, context, read])
  const delivery = useChatDeliveryState(rows, update, uncertain)
  useEffect(() => {
    if (!scope) return
    const confirmed = rows.filter(item => received.has(item.submissionId))
    if (!confirmed.length) return
    try { conversationJournal.forget(scope, confirmed.map(item => item.id)) } catch { /* A later authorized read can retire the same commands. */ }
    update(current => current.filter(item => !received.has(item.id)))
  }, [scope, rows, received, update])

  function start(item: Outgoing): Promise<boolean> | false {
    if (!scope || item.context !== apiCache.context() || received.has(item.id)) return false
    const previous = active.get(item.id)
    if (previous) return previous
    if (!delivery.begin(item)) return false
    const sending: Outgoing = { ...item, phase: 'sending', error: undefined }
    try { conversationJournal.rememberPersonal(scope, sending) }
    catch {
      delivery.finish(item.id, { error: copy.Workspace.detail.autosaveFailed })
      return false
    }
    const key = scope
    function remember(result: Outgoing) {
      if (apiCache.context() !== context || !read().some(row => row.id === item.id)) return
      try { conversationJournal.rememberPersonal(key, result) } catch { /* The immutable command was stored before transport. */ }
    }
    const request = (async () => {
      try {
        const body = submissionBody(item)
        await send(body.text, body.submissionId, body.images)
      } catch (failure) {
        const status = (failure as { status?: number } | null)?.status
        const message = sendFailureState(failure) === 'unconfirmed' ? uncertain
          : status === 429 ? copy.Coordinator.sendRateLimited : status && [401, 403, 404].includes(status) ? copy.Coordinator.sendAccessDenied : copy.GroupChat.notSent
        remember({ ...item, phase: 'failed', error: message })
        delivery.finish(item.id, { error: message })
        return false
      }
      remember({ ...item, phase: 'accepted', error: undefined })
      delivery.finish(item.id, { storedId: item.submissionId })
      if (apiCache.context() === context) void reload().catch(() => undefined)
      return apiCache.context() === context
    })().finally(() => { active.delete(item.id) })
    active.set(item.id, request)
    return request
  }

  function discard(id: string) {
    if (!scope) return
    try { conversationJournal.forget(scope, [id]) } catch { /* The superseded command was refused by the server. */ }
    update(current => current.filter(row => row.id !== id))
  }
  const visible = useMemo(() => rows.filter(item => !received.has(item.id)), [rows, received])
  return { rows: visible, read, start, discard }
}
