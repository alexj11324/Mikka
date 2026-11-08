'use client'

// Which task's review page is open (R1), and which view: one page for the whole app, opened from any 审阅 entry,
// ⌘⇧B or ⌘K 「审阅 #N」, closed by ✕ or Esc on the page. The app shell mounts the review-page slot while one is open.
// The view is what the ⋯ code tools pick: 改动 (the diff, the default), 文件 (R4) or 终端 (R5, a drawer over 改动).
import { useSyncExternalStore } from 'react'

export type ReviewView = 'changes' | 'files' | 'terminal'
export type ReviewPageState = { taskId: string | null; view: ReviewView }

const CLOSED: ReviewPageState = { taskId: null, view: 'changes' }
let current: ReviewPageState = CLOSED
const listeners = new Set<() => void>()

function set(next: ReviewPageState) {
  if (current.taskId === next.taskId && current.view === next.view) return
  current = next
  for (const listener of listeners) listener()
}

/** Opens a task's review page, on 改动 unless a view is given; the switch is instant (R-37). */
export const openReview = (taskId: string, view: ReviewView = 'changes') => set({ taskId, view })
/** Switches the open page's view (the page's own ⋯); nothing happens while no page is open. */
export const setReviewView = (view: ReviewView) => { if (current.taskId) set({ taskId: current.taskId, view }) }
export const closeReview = () => set(CLOSED)

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const snapshot = () => current
const serverSnapshot = () => CLOSED

export function useReviewPage() {
  const state = useSyncExternalStore(subscribe, snapshot, serverSnapshot)
  return { taskId: state.taskId, view: state.view, open: openReview, setView: setReviewView, close: closeReview }
}
