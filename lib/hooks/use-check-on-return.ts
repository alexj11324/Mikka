'use client'

import { useCallback, useEffect, useRef } from 'react'

/**
 * After the person was sent somewhere else to finish a step (OAuth in the
 * system browser from the desktop shell, Start in Telegram), read once the
 * next time this window gets focus. Ordinary focus never reads (see
 * docs/design/decisions/2026-11-01-0400-no-refetch-on-focus.md); only `arm()`,
 * called by the hand-off itself, schedules this single check.
 */
export function useCheckOnReturn(check: () => void): () => void {
  const latest = useRef(check)
  latest.current = check
  const cancel = useRef<(() => void) | null>(null)
  useEffect(() => () => { cancel.current?.() }, [])
  return useCallback(() => {
    cancel.current?.()
    const run = () => { cancel.current = null; latest.current() }
    window.addEventListener('focus', run, { once: true })
    cancel.current = () => { window.removeEventListener('focus', run); cancel.current = null }
  }, [])
}

/**
 * A hand-off that can need more than one return: the person may come back
 * before finishing in the system browser (Plugins → GitHub from the desktop,
 * 2026-11-03). After `arm(forMs)`, every return (focus, or the page becoming
 * visible) checks again, at most once a second, until `stop()` or the time is
 * up. Plain focus never arms it; nothing polls.
 */
export function useChecksUntilDone(check: () => void, now: () => number = Date.now): { arm: (forMs: number) => void; stop: () => void } {
  const latest = useRef(check)
  latest.current = check
  const cancel = useRef<(() => void) | null>(null)
  useEffect(() => () => { cancel.current?.() }, [])
  const stop = useCallback(() => { cancel.current?.() }, [])
  const arm = useCallback((forMs: number) => {
    cancel.current?.()
    const until = now() + forMs
    let last = -Infinity
    const run = () => {
      if (document.visibilityState === 'hidden') return
      const at = now()
      if (at > until) { cancel.current?.(); return }
      if (at - last < 1000) return
      last = at
      latest.current()
    }
    window.addEventListener('focus', run)
    document.addEventListener('visibilitychange', run)
    cancel.current = () => { window.removeEventListener('focus', run); document.removeEventListener('visibilitychange', run); cancel.current = null }
  }, [now])
  return { arm, stop }
}
