'use client'

// The thread's mode as the picker reads it (#1735 slice A). One small read and
// one transition; the server owns the stored mode, the version and the lock.
import useSWR, { unstable_serialize } from 'swr'
import { withBasePath } from '@/lib/base-path'
import { useLiveKey } from '@/hooks/use-live-key'
import { isThreadModeTransitionError, type ThreadModeRead, type ThreadModeTransitionError } from '@/lib/thread-mode/view'
import type { ThreadMode } from '@mikka/protocol/thread-mode'

export const threadModeKey = (runId: string) => ['thread-mode', runId]

async function readThreadModeState(runId: string): Promise<ThreadModeRead> {
  const response = await fetch(withBasePath(`/api/threads/${encodeURIComponent(runId)}/mode`), { cache: 'no-store', credentials: 'same-origin' })
  if (!response.ok) throw Error('threadModeUnavailable')
  return response.json() as Promise<ThreadModeRead>
}

export type ThreadModeTransitionResult = { ok: true } | { error: ThreadModeTransitionError }

/**
 * The thread's stored mode, the run's frozen mode and whether an unfinished
 * run keeps it. A live thread/run push rereads it; there is no timer.
 */
export function useThreadMode(runId: string, liveRunId: string = runId) {
  const key = threadModeKey(runId)
  const serialized = unstable_serialize(key)
  const { data, error, mutate } = useSWR(key, () => readThreadModeState(runId), { refreshInterval: 0, revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false })
  // A continuation or a new attempt may be the run that ends the lock, so both
  // the displayed run and the thread's live run invalidate this read.
  useLiveKey('thread', runId, [serialized], null)
  useLiveKey('thread', liveRunId === runId ? null : liveRunId, [serialized], null)

  async function transition(mode: ThreadMode): Promise<ThreadModeTransitionResult> {
    if (!data) return { error: 'threadModeUnavailable' }
    try {
      const response = await fetch(withBasePath(`/api/threads/${encodeURIComponent(runId)}/mode`), {
        method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, expectedVersion: data.version }),
      })
      if (response.ok) {
        const next = await response.json() as { mode: ThreadMode; version: number }
        // The server accepted it: show exactly what it stored, then confirm.
        await mutate({ ...data, mode: next.mode, version: next.version }, { revalidate: false })
        return { ok: true }
      }
      const body = await response.json().catch(() => null) as { error?: unknown } | null
      const code = isThreadModeTransitionError(body?.error) ? body.error : 'threadModeUnavailable'
      // A stale picker or a just-started run: reread so the control matches the server.
      if (code !== 'threadModeUnavailable') void mutate()
      return { error: code }
    } catch {
      return { error: 'threadModeUnavailable' }
    }
  }

  return { state: data, error, mutate, transition }
}
