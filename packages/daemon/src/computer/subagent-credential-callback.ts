import { createHash } from 'node:crypto'
import type { ComputerCall, ComputerDriver } from './driver.mjs'

/** Host-only metadata. Values for usernames and passwords never cross here. */
export type CredentialIntent = {
  actionId: string; runId: string; userId: string; workspaceId: string; botId: string
  subagentId: string; epoch: number; display: string; policyVersion: number
  driverFingerprint: string; callDigest: string; expiresAt: number
  targetId: string; origin: string; loaderId: string; backendNodeId: number; role: 'username' | 'password'
}
export type LiveCredentialLease = {
  runId: string; userId: string; workspaceId: string; botId: string; subagentId: string
  epoch: number; display: string; policyVersion: number; driverFingerprint: string
  targetId: string; origin: string; loaderId: string; backendNodeId: number; running: boolean
}
export type CredentialResolution = { kind: 'ordinary' } | { kind: 'consumed' } | { kind: 'credential'; intent: CredentialIntent }

/** This function must be installed as ComputerBroker's trusted execute
 * callback. Its invocation is the broker's allow/approved-ask admission; no
 * model-supplied permission flag or new approval is accepted. */
export function credentialAwareExecutor(deps: {
  /** Host storage must serialize one outstanding credential action per run,
   * consume it atomically, distinguish replay from an ordinary action, and
   * discard it on denial, expiry, STOP and policy revocation. */
  consumeMatchingIntent: (runId: string, digest: string) => Promise<CredentialResolution>
  /** Re-read run/STOP/lease/policy/target under the host's existing fence and
   * keep that fence through action; a cached assignment is insufficient. */
  withCurrentLease: <T>(intent: CredentialIntent, action: (live: LiveCredentialLease) => Promise<T>) => Promise<T>
  /** The #345 service resolves and inserts the secret itself. Never return it. */
  executeCredential: (intent: CredentialIntent) => Promise<unknown>
  executeOrdinary: (driver: ComputerDriver, call: ComputerCall, display: string | undefined, runId: string) => Promise<unknown>
  now?: () => number
}) {
  return async (driver: ComputerDriver, call: ComputerCall, display: string | undefined, runId: string) => {
    const digest = createHash('sha256').update(JSON.stringify(call)).digest('hex')
    // The host's storage consumes a matching action before I/O; absence means
    // this is an ordinary broker operation, not a credential operation.
    const resolved = await deps.consumeMatchingIntent(runId, digest)
    if (resolved.kind === 'ordinary') return deps.executeOrdinary(driver, call, display, runId)
    if (resolved.kind !== 'credential') throw new Error('Credential action already consumed')
    const { intent } = resolved
    if (![intent.actionId,intent.runId,intent.userId,intent.workspaceId,intent.botId,intent.subagentId,intent.targetId,intent.loaderId].every(value => typeof value === 'string' && value.length > 0) || !Number.isSafeInteger(intent.epoch) || intent.epoch < 0 || !Number.isSafeInteger(intent.policyVersion) || intent.policyVersion < 0 || intent.runId !== runId || intent.callDigest !== digest || intent.driverFingerprint !== driver.fingerprint || intent.display !== display || !Number.isSafeInteger(intent.backendNodeId) || intent.backendNodeId < 1 || !['username', 'password'].includes(intent.role) || !Number.isSafeInteger(intent.expiresAt) || intent.expiresAt <= (deps.now ?? Date.now)()) throw new Error('Credential action unavailable')
    const url = new URL(intent.origin)
    if (url.protocol !== 'https:' || url.username || url.password || url.origin !== intent.origin) throw new Error('Credential action unavailable')
    return deps.withCurrentLease(intent, async live => {
      if (!live.running || live.runId !== runId || live.userId !== intent.userId || live.workspaceId !== intent.workspaceId || live.botId !== intent.botId || live.subagentId !== intent.subagentId || live.epoch !== intent.epoch || live.display !== intent.display || live.policyVersion !== intent.policyVersion || live.driverFingerprint !== intent.driverFingerprint || live.targetId !== intent.targetId || live.origin !== intent.origin || live.loaderId !== intent.loaderId || live.backendNodeId !== intent.backendNodeId || intent.expiresAt <= (deps.now ?? Date.now)()) throw new Error('Credential action unavailable')
      const result = await deps.executeCredential(intent)
      if (!result || typeof result !== 'object' || !('status' in result) || typeof result.status !== 'string' || !['needs_login', 'session_applied', 'submitted'].includes(result.status)) throw new Error('Credential action unavailable')
      // Only this bounded outcome can travel back through the model-facing broker.
      return { status: result.status }
    })
  }
}
