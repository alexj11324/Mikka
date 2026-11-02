'use client'

import { useLayoutEffect, useState, type RefObject } from 'react'

/** Focus fell to <body>: what held it went away and nothing else took it. */
function focusLost() {
  const active = document.activeElement
  return !active || active === document.body || !active.isConnected
}
function focusable(element: Element | null) {
  return element instanceof HTMLElement && element !== document.body && element.isConnected ? element : null
}

/**
 * A view opened from a row (a thread, a task): focus moves to `target` when it
 * opens, and when it closes with focus lost it goes back to the row marked
 * `data-focus-id={id}` (re-rendered by then), else to what had focus before.
 */
export function useFocusReturn(id: string, target: RefObject<HTMLElement | null>, enabled = true) {
  useLayoutEffect(() => {
    if (!enabled) return
    const opener = focusable(document.activeElement)
    target.current?.focus({ preventScroll: true })
    return () => {
      requestAnimationFrame(() => {
        if (!focusLost()) return
        const row = document.querySelector(`[data-focus-id="${CSS.escape(id)}"]`)
        ;(focusable(row) ?? focusable(opener))?.focus()
      })
    }
  }, [id, target, enabled])
}

/** A controlled dialog's `finalFocus`: the control that had focus when it opened. */
export function useOpenerFocus(open: boolean) {
  const [opener, setOpener] = useState<HTMLElement | null>(null)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setOpener(focusable(document.activeElement))
  }
  return () => focusable(opener) ?? true
}

/** After a bot or group is chosen, on a desktop, its composer takes focus once it renders (and a dialog that chose it has gone). */
export function focusChatComposer() {
  if (!window.matchMedia('(pointer: fine)').matches) return
  let frames = 60
  const attempt = () => {
    const input = document.querySelector<HTMLTextAreaElement>('main textarea[data-chat-composer]:not(:disabled)')
    if (input && !document.querySelector('[role="dialog"]')) input.focus()
    else if (--frames > 0) requestAnimationFrame(attempt)
  }
  requestAnimationFrame(attempt)
}
