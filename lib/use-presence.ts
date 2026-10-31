'use client'

import { useState } from 'react'

/**
 * Keeps a dialog mounted, with its last value, until its close animation ends.
 * `{value && <Dialog open>}` unmounts at once and loses the exit animation; render
 * `{presence.value && <Dialog open={presence.open} onOpenChangeComplete={presence.onOpenChangeComplete}>}`.
 */
export function usePresence<T>(value: T | null | undefined | false) {
  const [kept, setKept] = useState<T | null>(value || null)
  const open = !!value
  // Remember the latest value while open (render-time update, guarded so it settles).
  if (open && value !== kept) setKept(value as T)
  return {
    value: open ? value as T : kept,
    open,
    onOpenChangeComplete: (next: boolean) => { if (!next) setKept(null) },
  }
}

/** Props a dialog takes so `usePresence` can keep it mounted through its exit. */
export type PresenceProps = { open?: boolean; onOpenChangeComplete?: (open: boolean) => void }
