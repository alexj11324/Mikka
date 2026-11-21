'use client'

// Which page the review slot is open on, and which view: one page for the whole app, opened from any 审阅 entry,
// ⌘⇧B or ⌘K 「审阅 #N」, closed by ✕ or Esc on the page. The app shell mounts the review-page slot while one is open.
// The view is what the ⋯ code tools pick: 改动 (the diff, the default), 文件 (R4) or 终端 (R5, a drawer over 改动).
//
// A pull request that no task of ours produced opens the same page by its own reference
// (`openPullReview`), so a row of the PR directory reads its diff in the app instead of leaving for github.com.
import { useSyncExternalStore } from 'react'

export type ReviewView = 'changes' | 'files' | 'terminal'

/** A pull request, as its row in the directory knows it; `repo` is its name, never a URL. */
export type ReviewPull = { owner: string; repo: string; number: number }

/** What the page is open on: one of our tasks, or a pull request that belongs to no task. */
export type ReviewTarget = { kind: 'task'; taskId: string } | { kind: 'pull'; pull: ReviewPull }

export type ReviewPageState = { target: ReviewTarget | null; view: ReviewView }

const CLOSED: ReviewPageState = { target: null, view: 'changes' }
let current: ReviewPageState = CLOSED
const listeners = new Set<() => void>()

/** The same task, or the same pull request: reopening it changes nothing but the view. */
function sameTarget(a: ReviewTarget | null, b: ReviewTarget | null) {
  if (!a || !b) return a === b
  if (a.kind === 'task') return b.kind === 'task' && a.taskId === b.taskId
  return b.kind === 'pull' && a.pull.owner === b.pull.owner && a.pull.repo === b.pull.repo && a.pull.number === b.pull.number
}

function set(next: ReviewPageState) {
  if (sameTarget(current.target, next.target) && current.view === next.view) return
  current = next
  for (const listener of listeners) listener()
}

/** Opens a task's review page, on 改动 unless a view is given; the switch is instant (R-37). */
export const openReview = (taskId: string, view: ReviewView = 'changes') => set({ target: { kind: 'task', taskId }, view })
/** Opens a pull request that has no task of ours, on 改动 unless a view is given; the page reads it by reference. */
export const openPullReview = (pull: ReviewPull, view: ReviewView = 'changes') => set({ target: { kind: 'pull', pull }, view })
/** Switches the open page's view (the page's own ⋯); nothing happens while no page is open. */
export const setReviewView = (view: ReviewView) => { if (current.target) set({ target: current.target, view }) }
export const closeReview = () => set(CLOSED)

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const snapshot = () => current
const serverSnapshot = () => CLOSED

export function useReviewPage() {
  const state = useSyncExternalStore(subscribe, snapshot, serverSnapshot)
  const target = state.target
  return {
    /** The task on the page; null while it shows a pull request, which has no task. */
    taskId: target?.kind === 'task' ? target.taskId : null,
    /** The pull request on the page; null while it shows a task. */
    pull: target?.kind === 'pull' ? target.pull : null,
    view: state.view,
    open: openReview,
    openPull: openPullReview,
    setView: setReviewView,
    close: closeReview,
  }
}
