'use client'

import { useEffect, useRef } from 'react'

/** How long a new key stays "arriving": the enter animation's length plus a frame. */
export const ARRIVAL_MS = 260

/**
 * Remembers when each key of a list was first committed. Keys present when the list first loaded
 * never count as arriving (R-37: nothing animates on first load); a later key arrives for `ARRIVAL_MS`,
 * so re-renders during its enter animation do not cut it.
 */
export function createArrivals() {
  let firstSeen: Map<string, number> | null = null
  return {
    commit(keys: readonly string[], now: number) {
      const loaded = firstSeen !== null
      firstSeen ??= new Map()
      for (const key of keys) if (!firstSeen.has(key)) firstSeen.set(key, loaded ? now : -Infinity)
    },
    arriving(key: string, now: number) {
      if (!firstSeen) return false
      const at = firstSeen.get(key)
      return at === undefined || now - at < ARRIVAL_MS
    },
  }
}

/** `createArrivals` for a component: pass `null` until the list has loaded. */
export function useArrivals(keys: readonly string[] | null) {
  const arrivals = useRef<ReturnType<typeof createArrivals>>(null)
  arrivals.current ??= createArrivals()
  useEffect(() => { if (keys) arrivals.current?.commit(keys, performance.now()) })
  return (key: string) => arrivals.current?.arriving(key, performance.now()) ?? false
}
