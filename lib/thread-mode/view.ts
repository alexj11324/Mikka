// The thread mode picker's view model (#1735 slice A): one pure function the
// component and its tests share. It never decides enforcement; the server's
// stored mode, the run's frozen mode and the lock are inputs, not guesses.
import { DEFAULT_THREAD_MODE, THREAD_MODES, type ThreadMode } from '@mikka/protocol/thread-mode'

/** What `GET /api/threads/:runId/mode` returns for the picker. */
export interface ThreadModeRead {
  mode: ThreadMode
  version: number
  /** The mode the run the caller named froze; absent on an older response. */
  frozenMode?: ThreadMode
  /** An unfinished run keeps the mode it froze. */
  locked?: boolean
}

export interface ThreadModeOptionView {
  mode: ThreadMode
  selected: boolean
  /** The whole group is disabled while the thread is locked or saving. */
  disabled: boolean
}

export interface ThreadModePickerView {
  /** The thread's stored choice: what the next run inherits. */
  mode: ThreadMode
  /** The version a transition must echo. */
  version: number
  locked: boolean
  /** The mode the displayed run froze; shown as a badge beside the picker. */
  frozenMode: ThreadMode | null
  options: ThreadModeOptionView[]
}

/**
 * The picker for one thread. `active` is the caller's read of the displayed
 * run being live; the server's `locked` covers the case where another attempt
 * of the same task is running. Either one makes every option read-only.
 */
export function threadModePicker(read: ThreadModeRead | undefined, active: boolean): ThreadModePickerView | null {
  if (!read) return null
  const mode = read.mode ?? DEFAULT_THREAD_MODE
  const locked = active || read.locked === true
  return {
    mode,
    version: read.version,
    locked,
    // The displayed run's own mode: a fact beside the thread's stored choice.
    frozenMode: read.frozenMode ?? null,
    options: THREAD_MODES.map(option => ({ mode: option, selected: option === mode, disabled: locked })),
  }
}

/** A transition the server refused, as the picker words it. */
export const THREAD_MODE_TRANSITION_ERRORS = ['threadModeChanged', 'threadModeLocked', 'threadModeUnavailable'] as const
export type ThreadModeTransitionError = (typeof THREAD_MODE_TRANSITION_ERRORS)[number]

export function isThreadModeTransitionError(value: unknown): value is ThreadModeTransitionError {
  return typeof value === 'string' && (THREAD_MODE_TRANSITION_ERRORS as readonly string[]).includes(value)
}
