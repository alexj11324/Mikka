'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { withBasePath } from '@/lib/base-path'
import { coordinatorStreamReply, readCoordinatorStream, visibleCoordinatorReplies, type CoordinatorLiveReply } from '@/lib/coordinator-stream-client'

export function useCoordinatorStream({ botId, runId, cursor, persistedStreamIds, revalidate }: {
  botId: string | null
  runId?: string
  cursor?: number
  persistedStreamIds?: string[]
  revalidate: () => Promise<unknown>
}) {
  const [state, setState] = useState<{ botId: string | null; replies: CoordinatorLiveReply[]; error: boolean }>({ botId, replies: [], error: false })
  const refresh = useRef(revalidate)
  refresh.current = revalidate
  const connect = useRef<() => void>(() => {})
  const reconnect = useCallback(() => connect.current(), [])

  useEffect(() => {
    setState(previous => ({ botId, replies: previous.botId === botId ? previous.replies.filter(reply => reply.committedThrough !== undefined) : [], error: false }))
    if (!runId) { connect.current = () => {}; return }
    let disposed = false
    let active = false
    let controller: AbortController | undefined
    const prefix = `${runId}:`
    async function read() {
      if (disposed || active) return
      active = true
      controller = new AbortController()
      const signal = controller.signal
      let replies: CoordinatorLiveReply[] = []
      setState(previous => ({ ...previous, error: false }))
      try {
        const query = new URLSearchParams({ runId })
        if (botId) query.set('botId', botId)
        const response = await fetch(withBasePath(`/api/coordinator/stream?${query}`), { credentials: 'same-origin', signal })
        if (response.status === 204) return
        if (!response.ok || !response.body) throw new Error('Coordinator stream unavailable')
        await readCoordinatorStream(response.body, event => {
          if (disposed || signal.aborted) return
          replies = coordinatorStreamReply(replies, event)
          // A reconnect replays from zero; replace this run instead of appending it.
          setState(previous => ({ botId, error: false, replies: [...previous.replies.filter(reply => !reply.id.startsWith(prefix)), ...replies] }))
          if (event.type === 'committed') void refresh.current().catch(() => undefined)
        }, signal)
        if (replies.some(reply => reply.committedThrough === undefined)) throw new Error('Coordinator stream interrupted')
      } catch {
        if (!disposed && !signal.aborted) setState(previous => ({ ...previous, error: true }))
      } finally {
        if (!disposed && !signal.aborted) {
          // Stay active during this refresh; the next SWR poll can reconnect a closed reader.
          try { await refresh.current() } catch { setState(previous => ({ ...previous, error: true })) } finally { active = false }
        }
      }
    }
    connect.current = () => { void read() }
    connect.current()
    return () => {
      disposed = true
      controller?.abort()
      connect.current = () => {}
    }
  }, [botId, runId])

  return {
    replies: state.botId === botId ? visibleCoordinatorReplies(state.replies, cursor, runId, persistedStreamIds) : [],
    error: state.botId === botId && state.error,
    reconnect,
  }
}
