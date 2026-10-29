/** Credential insertion is not authentication success. Resume only after the
 * broker has cleared the observation guard; the next tick observes the page. */
export function browserLoginContinuation(status: string): 'running' | 'guarded' | 'needs_login' {
  if (status === 'submitted' || status === 'session_applied' || status === 'resumed') return 'running'
  if (status === 'guarded') return 'guarded'
  return 'needs_login'
}
