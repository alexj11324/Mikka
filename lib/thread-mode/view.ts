// The thread mode picker's view model (#1735 slice A): pure functions the
// components and their tests share. They never decide enforcement; the
// server's stored mode, the run's frozen mode, the lock and its support
// judgment are inputs, not guesses.
import { DEFAULT_THREAD_MODE, THREAD_MODES, type ThreadMode } from '@mikka/protocol/thread-mode'

/** What the server says about one mode on this run's Agent and device. */
export type ThreadModeSupportState = { state: 'enforced' | 'unsupported'; reason?: 'harness' | 'daemon' }
export type ThreadModeSupport = Record<ThreadMode, ThreadModeSupportState>

/** What `GET /api/threads/:runId/mode` returns for the picker. */
export interface ThreadModeRead {
  mode: ThreadMode
  version: number
  /** The mode the run the caller named froze; absent on an older response. */
  frozenMode?: ThreadMode
  /** An unfinished run keeps the mode it froze. */
  locked?: boolean
  /** Absent on a server older than the support read. */
  support?: ThreadModeSupport | null
}

/** Why an option cannot be used, as the UI words it. */
export type ThreadModeReasonKey =
  | 'runActive' | 'ownerOnly' | 'iosPickerUnavailable'
  | 'unsupportedHarness' | 'daemonOutdated'
  | 'unknownHarness' | 'missingHarness'
  | 'unsupportedSelected'

export interface ThreadModeOptionAvailability {
  enabled: boolean
  reasonKey?: ThreadModeReasonKey
}
export type ThreadModeAvailability = Record<ThreadMode, ThreadModeOptionAvailability>

/**
 * The support matrix a picker shows. The server `support` answers whether the
 * Agent/device can enforce a mode; this function only maps it to a control
 * state and a reason, in the order the brief fixes: no read, a running
 * thread, then each mode. Execute is the behavior runs had before modes, so
 * it stays enabled whenever support is known, even if another mode is not.
 */
export function threadModeAvailability(input: { locked: boolean; support?: ThreadModeSupport | null; selected: ThreadMode }): ThreadModeAvailability {
  const availability = {} as ThreadModeAvailability
  const all = (enabled: boolean, reasonKey?: ThreadModeReasonKey) => {
    for (const mode of THREAD_MODES) availability[mode] = { enabled, ...(reasonKey ? { reasonKey } : {}) }
  }
  // An older server does not say; never present an unverified switch.
  if (!input.support) { all(false, 'missingHarness'); return availability }
  if (input.locked) { all(false, 'runActive'); return availability }
  for (const mode of THREAD_MODES) {
    if (mode === 'execute') { availability[mode] = { enabled: true }; continue }
    const support = input.support[mode]
    availability[mode] = support.state === 'enforced'
      ? { enabled: true }
      : { enabled: false, reasonKey: support.reason === 'daemon' ? 'daemonOutdated' : 'unsupportedHarness' }
  }
  // The stored choice cannot be enforced here: keep it visible, say why, and
  // offer Execute; never rewrite the stored value silently.
  if (!availability[input.selected].enabled) availability[input.selected] = { enabled: false, reasonKey: 'unsupportedSelected' }
  return availability
}

export interface ThreadModeOptionView {
  mode: ThreadMode
  selected: boolean
  /** This option cannot be picked right now (locked, or unsupported here). */
  disabled: boolean
  reasonKey?: ThreadModeReasonKey
}

export interface ThreadModePickerView {
  /** The thread's stored choice: what the next run inherits. */
  mode: ThreadMode
  /** The version a transition must echo. */
  version: number
  locked: boolean
  /** The mode the displayed run froze; shown as a badge inside the picker. */
  frozenMode: ThreadMode | null
  options: ThreadModeOptionView[]
  /** The stored choice is unsupported on this Agent; offer Execute instead. */
  selectedUnsupported: boolean
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
  const availability = threadModeAvailability({ locked, support: read.support, selected: mode })
  return {
    mode,
    version: read.version,
    locked,
    // The displayed run's own mode: shown in the picker's badge.
    frozenMode: read.frozenMode ?? null,
    options: THREAD_MODES.map(option => {
      const state = availability[option]
      return { mode: option, selected: option === mode, disabled: !state.enabled, ...(state.reasonKey ? { reasonKey: state.reasonKey } : {}) }
    }),
    selectedUnsupported: availability[mode].reasonKey === 'unsupportedSelected',
  }
}

/** A transition the server refused, as the picker words it. */
export const THREAD_MODE_TRANSITION_ERRORS = ['threadModeChanged', 'threadModeLocked', 'threadModeUnavailable'] as const
export type ThreadModeTransitionError = (typeof THREAD_MODE_TRANSITION_ERRORS)[number]

export function isThreadModeTransitionError(value: unknown): value is ThreadModeTransitionError {
  return typeof value === 'string' && (THREAD_MODE_TRANSITION_ERRORS as readonly string[]).includes(value)
}
