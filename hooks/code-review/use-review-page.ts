'use client'

// Which task's review page is open (R1): one page for the whole app, opened from any 审阅 entry, ⌘⇧B or ⌘K
// 「审阅 #N」, closed by ✕ or Esc on the page. The app shell mounts the review-page slot while one is open.
import { useSyncExternalStore } from 'react'

let current: string | null = null
const listeners = new Set<() => void>()

function set(taskId: string | null) {
  if (current === taskId) return
  current = taskId
  for (const listener of listeners) listener()
}

/** Opens a task's review page; the switch is instant (R-37). */
export const openReview = (taskId: string) => set(taskId)
export const closeReview = () => set(null)

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const snapshot = () => current
const serverSnapshot = () => null

export function useReviewPage() {
  const taskId = useSyncExternalStore(subscribe, snapshot, serverSnapshot)
  return { taskId, open: openReview, close: closeReview }
}
