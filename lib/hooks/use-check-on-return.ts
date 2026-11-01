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
