// How a task is named in the UI (MIK-46). The single source of truth: every
// place that shows a task id goes through `taskIdentifier`.
// - Workspace tasks use their Linear identifier (MIK-12) once Linear has one.
// - Personal tasks never reach Linear and use a four-letter personal prefix
//   (ALEX-12). Linear team keys are usually three letters, so they do not clash.

export type TaskScope = 'workspace' | 'personal'
export const TASK_SCOPES = ['workspace', 'personal'] as const satisfies readonly TaskScope[]

export const PERSONAL_PREFIX_LENGTH = 4
const PREFIX_PATTERN = /^[A-Z]{4}$/

export type TaskIdentifierInput = {
  scope: TaskScope
  number?: number | null
  /** The linked Linear issue's identifier, e.g. `MIK-12`. */
  linearIdentifier?: string | null
  /** The owner's personal prefix, already resolved by `resolvePersonalPrefix`. */
  personalPrefix?: string | null
}

/** `MIK-12`, `ALEX-12`, `#12` when the owner has no usable prefix yet, or null before a number or Linear id exists. */
export function taskIdentifier(task: TaskIdentifierInput): string | null {
  if (task.scope === 'workspace') return task.linearIdentifier ?? null
  if (!task.number) return null
  return task.personalPrefix ? `${task.personalPrefix}-${task.number}` : `#${task.number}`
}

/** The first four letters of the email's local part, skipping digits and symbols; null when there are fewer than four. */
export function defaultPersonalPrefix(email: string) {
  const letters = (email.split('@')[0] ?? '').replace(/[^a-z]/gi, '').toUpperCase()
  return letters.length >= PERSONAL_PREFIX_LENGTH ? letters.slice(0, PERSONAL_PREFIX_LENGTH) : null
}

export function normalizePersonalPrefix(value: string) {
  const prefix = value.trim().toUpperCase()
  return PREFIX_PATTERN.test(prefix) ? prefix : null
}

export function prefixCollides(prefix: string, linearTeamKeys: readonly string[]) {
  return linearTeamKeys.some(key => key.toUpperCase() === prefix.toUpperCase())
}

/** The prefix personal tasks show: the saved one, else the email default, never one that equals a connected Linear team key. */
export function resolvePersonalPrefix(input: { saved?: string | null; email: string; linearTeamKeys: readonly string[] }) {
  const prefix = input.saved ? normalizePersonalPrefix(input.saved) : defaultPersonalPrefix(input.email)
  return prefix && !prefixCollides(prefix, input.linearTeamKeys) ? prefix : null
}
