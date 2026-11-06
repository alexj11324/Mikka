'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { withBasePath } from '@/lib/base-path'
import { coordinatorStreamReply, readCoordinatorStream, visibleCoordinatorReplies, type CoordinatorLiveReply } from '@/lib/coordinator-stream-client'

/** The stream opened while the person's message waits for its turn: the server holds it until the turn starts. */
const WAIT = 'wait'

export function useCoordinatorStream({ botId, runId, waiting = false, cursor, persistedStreamIds, revalidate }: {
  botId: string | null
  runId?: string
  /** A message is in the chat's inbox and no turn holds the chat yet: open the stream now, not after the next chat read. */
  waiting?: boolean
  cursor?: number
  persistedStreamIds?: string[]
  revalidate: () => Promise<unknown>
}) {
  const [state, setState] = useState<{ botId: string | null; replies: CoordinatorLiveReply[]; error: boolean; run?: string }>({ botId, replies: [], error: false })
  const refresh = useRef(revalidate)
  refresh.current = revalidate
  const connect = useRef<() => void>(() => {})
  const reconnect = useCallback(() => connect.current(), [])
  // The run a waiting stream found: when the chat's read names the same run, the open stream carries on.
  const adopted = useRef<string | null>(null)
  const target = runId && runId !== adopted.current ? runId : runId || waiting ? WAIT : undefined

  useEffect(() => {
    setState(previous => ({ botId, replies: previous.botId === botId ? previous.replies.filter(reply => reply.committedThrough !== undefined) : [], error: false, ...(previous.botId === botId && previous.run ? { run: previous.run } : {}) }))
    if (!target) { connect.current = () => {}; return }
    let streamRunId = target === WAIT ? adopted.current ?? undefined : target
    if (target !== WAIT) adopted.current = null
    let disposed = false
    let active = false
    let controller: AbortController | undefined
    let replies: CoordinatorLiveReply[] = []
    let sequence = 0
    let streamKey: string | null = null
    async function read() {
      if (disposed || active) return
      active = true
      controller = new AbortController()
      const signal = controller.signal
      setState(previous => ({ ...previous, error: false }))
      try {
        const query = new URLSearchParams(streamRunId ? { runId: streamRunId } : { wait: '1' })
        if (sequence) query.set('after', String(sequence))
        if (botId) query.set('botId', botId)
        const response = await fetch(withBasePath(`/api/coordinator/stream?${query}`), { credentials: 'same-origin', signal, headers: streamKey ? { 'x-mikka-stream-key': streamKey } : undefined })
        if (response.status === 204) return
        if (!response.ok || !response.body) throw new Error('Coordinator stream unavailable')
        if (!streamRunId) {
          const found = response.headers.get('x-mikka-stream-run')
          if (!found?.startsWith('wrun_')) throw new Error('Coordinator stream unavailable')
          streamRunId = adopted.current = found
          setState(previous => ({ ...previous, run: found }))
        }
        if (response.headers.get('x-mikka-stream-reset') === '1' || !response.headers.has('x-mikka-stream-key')) { replies = []; sequence = 0 }
        streamKey = response.headers.get('x-mikka-stream-key')
        const prefix = `${streamRunId}:`
        await readCoordinatorStream(response.body, (event, nextSequence) => {
          if (disposed || signal.aborted) return
          if (nextSequence !== undefined && nextSequence <= sequence) return
          if (nextSequence !== undefined && nextSequence !== sequence + 1) throw new Error('Coordinator stream sequence gap')
          replies = coordinatorStreamReply(replies, event)
          if (nextSequence !== undefined) sequence = nextSequence
          // Resume this run's acknowledged prefix; its durable reader still reconstructs masking state server-side.
          setState(previous => ({ ...previous, botId, error: false, replies: [...previous.replies.filter(reply => !reply.id.startsWith(prefix)), ...replies] }))
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
  }, [botId, target])

  return {
    replies: state.botId === botId ? visibleCoordinatorReplies(state.replies, cursor, runId ?? state.run, persistedStreamIds) : [],
    error: state.botId === botId && state.error,
    reconnect,
  }
}
