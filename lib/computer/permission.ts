/** Workspace computer policy (Alex, 2026-10-30): bots operate computers unless
 * an admin chose deny. An absent row is allow. A legacy 'ask' row, which the
 * default-allow migration rewrites, also reads as allow. Anything else is
 * unavailable, never allow. */
export type ComputerPermission = 'allow' | 'deny'
export const computerPermissions = ['allow', 'deny'] as const

export function computerPermission(stored: unknown): ComputerPermission | null {
  if (stored === undefined || stored === null || stored === 'allow' || stored === 'ask') return 'allow'
  return stored === 'deny' ? 'deny' : null
}
