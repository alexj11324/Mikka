'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { unstable_serialize, type Key } from 'swr'
import type { LiveKind } from '@/lib/live/events'
import { useLiveKey } from './use-live-key'

/** How long a wait listens before its one backstop read. */
export const LIVE_WAIT_MS = 20_000

/**
 * Waits for a change another system commits (a Stripe webhook): while waiting,
 * `kind`/`id` re-reads `key`'s SWR data, read once at the start, and the wait
 * ends as soon as `done` holds. No timer reads it (#1212); after `timeoutMs`
 * one final read is the backstop. Resolves with the last data either way.
 */
export function useLiveWait<T>(swr: { data: T | undefined; mutate: () => Promise<T | undefined> }, kind: LiveKind, id: string | null | undefined, key: Key, done: (value: T) => boolean, timeoutMs = LIVE_WAIT_MS) {
  const [waiting, setWaiting] = useState(false)
  const pending = useRef<{ resolve: (value: T | undefined) => void; timer: ReturnType<typeof setTimeout> } | null>(null)
  const latest = useRef({ data: swr.data, mutate: swr.mutate, done })
  latest.current = { data: swr.data, mutate: swr.mutate, done }
  const finish = useCallback((value: T | undefined) => {
    const current = pending.current
    if (!current) return
    pending.current = null
    clearTimeout(current.timer)
    setWaiting(false)
    current.resolve(value)
  }, [])
  // Subscribing reads once at once (an open channel catches up on a new key), then on each push.
  useLiveKey(kind, waiting ? id : null, waiting && key ? [unstable_serialize(key)] : [], id, { minIntervalMs: 500 })
  useEffect(() => {
    if (waiting && swr.data !== undefined && done(swr.data)) finish(swr.data)
  }, [waiting, swr.data, done, finish])
  useEffect(() => () => finish(latest.current.data), [finish])
  return useCallback(() => new Promise<T | undefined>(resolve => {
    pending.current?.resolve(latest.current.data)
    if (pending.current) clearTimeout(pending.current.timer)
    const timer = setTimeout(() => {
      void latest.current.mutate().catch(() => latest.current.data).then(value => finish(value ?? latest.current.data))
    }, timeoutMs)
    pending.current = { resolve, timer }
    setWaiting(true)
  }), [finish, timeoutMs])
}
