// A server-issued Task ID never follows mutable grouping or profile names.
// The fallbacks describe pre-migration spellings only; server projections use
// task-identity-store to persist their first canonical choice and old aliases.
// New shared tasks use a Workspace counter; personal tasks keep the owner
// prefix that was current when they were created.

export type TaskScope = 'workspace' | 'personal'
export const TASK_SCOPES = ['workspace', 'personal'] as const satisfies readonly TaskScope[]

export const PERSONAL_PREFIX_LENGTH = 4
const PREFIX_PATTERN = /^[A-Z]{4}$/

export type TaskIdentifierInput = {
  scope: TaskScope
  /** The issued identifier is immutable. Team names and owner prefixes are aliases. */
  issuedIdentifier?: string | null
  number?: number | null
  /** The task's team key and its number in that team, e.g. `AL` and 12. */
  team?: { key: string; number: number } | null
  /** The owner's personal prefix, already resolved by `resolvePersonalPrefix`. */
  personalPrefix?: string | null
}

/** `AL-12` or `ALEX-12`; a missing team never removes the task's owner number. */
export function taskIdentifier(task: TaskIdentifierInput): string | null {
  if (task.issuedIdentifier) return task.issuedIdentifier
  if (task.scope === 'workspace' && task.team) return `${task.team.key}-${task.team.number}`
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
