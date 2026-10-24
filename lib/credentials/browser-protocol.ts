/** Integration contract for a future trusted browser gateway, NOT a capability claim.
 * Current runtime refuses browser_login before issuing a request or reading the vault.
 * Never implement this with an agent-visible CDP client or a per-agent mutex.
 */
export type BrowserCredentialCommand = {
  protocol: 'mikka-browser-credential-v1'
  requestId: string; credentialRef: string
  ownerId: string; workspaceId: string; taskId: string; runId: string
  executionSession: string; browserContext: string; targetOrigin: string
  operationId: string; deadline: string
  // These are server-owned selectors and a site-specific verifier identifier; no secret text.
  formPolicyId: string
}
export type BrowserIsolationPhase =
  | 'reserved' | 'draining' | 'isolated' | 'filled' | 'submitted'
  | 'verifying' | 'scrubbing' | 'restored' | 'quarantined'

export const browserIsolationTransitions: Readonly<Record<BrowserIsolationPhase, readonly BrowserIsolationPhase[]>> = Object.freeze({
  reserved: ['draining', 'quarantined'],
  draining: ['isolated', 'scrubbing', 'quarantined'],
  isolated: ['filled', 'scrubbing', 'quarantined'],
  filled: ['submitted', 'scrubbing', 'quarantined'],
  submitted: ['verifying', 'scrubbing', 'quarantined'],
  verifying: ['scrubbing', 'quarantined'],
  scrubbing: ['restored', 'quarantined'],
  restored: [], quarantined: [],
})

export function assertBrowserIsolationTransition(from: BrowserIsolationPhase, to: BrowserIsolationPhase) {
  if (!browserIsolationTransitions[from].includes(to)) throw new Error('browser_isolation_transition_rejected')
}

/** Terminal attestation contains no DOM, pixels, typed data, cookies or arbitrary error text.
 * submitted/accepted are different: only an allowlisted site-specific verifier can say accepted.
 */
export type BrowserCredentialReceipt = {
  operationId: string; executionSession: string; targetOrigin: string
  result: 'submitted_unverified' | 'site_policy_verified' | 'failed' | 'cancelled'
  cleanup: 'isolated_context_destroyed' | 'password_context_destroyed_auth_retained' | 'site_policy_scrub_verified' | 'quarantined'
  phase: 'restored' | 'quarantined'
}
