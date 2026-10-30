/** A hosted session can cross runs only when the host's protected ledger binds
 * the exact prior session to the same live subscription account and consumer. */
export type NativeSessionScope = {
  runId: string; bindingId: string; ownerId: string; workspaceId: string; consumerId: string
  route: string; revision: number; accountId: string; modelId: string
}
export function matchesNativeContinuation(ledger: unknown, current: NativeSessionScope, continuation: { runId: string; sessionId: string }): boolean {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(continuation.runId) || !continuation.sessionId || continuation.sessionId.length > 500 || continuation.runId === current.runId || !ledger || typeof ledger !== 'object' || Array.isArray(ledger)) return false
  const entry = ledger as { scope?: Partial<NativeSessionScope>; sessionId?: unknown }
  return entry.sessionId === continuation.sessionId && entry.scope?.runId === continuation.runId &&
    (['bindingId', 'ownerId', 'workspaceId', 'consumerId', 'route', 'revision', 'accountId', 'modelId'] as const).every(key => entry.scope?.[key] === current[key])
}

/** Only a server-bound CI claim can extend hosted-session continuation. */
export function hostedCiResumePermitted(assignment: { requireSessionResume?: boolean; ciSessionResume?: true }): boolean {
  return assignment.requireSessionResume !== true || assignment.ciSessionResume === true
}
