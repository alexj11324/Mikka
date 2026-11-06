// How a task is named in the UI (MIK-46). The single source of truth: every
// place that shows a task id goes through `taskIdentifier`.
// - Workspace tasks use their team key and their number in that team (AL-12),
//   which the database assigns when the task joins the team. A linked Linear
//   id is only an outside alias.
// - Personal tasks use a four-letter personal prefix (ALEX-12) and the
//   owner's number. Every owner has a prefix: their own, else a default.

export type TaskScope = 'workspace' | 'personal'
export const TASK_SCOPES = ['workspace', 'personal'] as const satisfies readonly TaskScope[]

export const PERSONAL_PREFIX_LENGTH = 4
const PREFIX_PATTERN = /^[A-Z]{4}$/

export type TaskIdentifierInput = {
  scope: TaskScope
  number?: number | null
  /** The task's team key and its number in that team, e.g. `AL` and 12. */
  team?: { key: string; number: number } | null
  /** The owner's personal prefix, already resolved by `resolvePersonalPrefix`. */
  personalPrefix?: string | null
}

/** `AL-12` or `ALEX-12`; null only while the database has not yet given the task its team or number. */
export function taskIdentifier(task: TaskIdentifierInput): string | null {
  if (task.scope === 'workspace') return task.team ? `${task.team.key}-${task.team.number}` : null
  if (!task.number || !task.personalPrefix) return null
  return `${task.personalPrefix}-${task.number}`
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

/** The prefix of an owner whose own and email prefixes are unusable. */
export const FALLBACK_PERSONAL_PREFIX = 'TASK'

/** The prefix personal tasks show: the saved one, else the email default, never one that equals a connected Linear team key; never none. */
export function resolvePersonalPrefix(input: { saved?: string | null; email: string; linearTeamKeys: readonly string[] }) {
  const prefix = input.saved ? normalizePersonalPrefix(input.saved) : defaultPersonalPrefix(input.email)
  return prefix && !prefixCollides(prefix, input.linearTeamKeys) ? prefix : FALLBACK_PERSONAL_PREFIX
}
