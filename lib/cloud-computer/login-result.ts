/** Mechanical result of a credential fill. None of these is a login verdict:
 * signed_in/needs_code/rejected come only from login-signal.ts (BE-17). */
export type MechanicalFill = 'inserted' | 'submitted' | 'session_applied'

/** Credential insertion is not authentication success. `observe` means resume the
 * subagent so the next tick looks at the page; it never means signed in. */
export function browserLoginContinuation(outcome: { status?: string; fill?: string }): 'observe' | 'guarded' | 'needs_login' {
  if (outcome.fill === 'submitted' || outcome.fill === 'session_applied' || outcome.status === 'resumed') return 'observe'
  if (outcome.fill === 'inserted') return 'guarded'
  return 'needs_login'
}
