import { createHash } from 'node:crypto'
import type { ComputerCall, ComputerDriver } from './driver.mjs'

export type CredentialIntent = {
  actionId: string; runId: string; userId: string; workspaceId: string; botId: string
  subagentId: string; epoch: number; display: string; policyVersion: number
  driverFingerprint: string; callDigest: string; expiresAt: number
  targetId: string; origin: string; loaderId: string; backendNodeId: number
  role: 'username' | 'password'
}
export type LiveCredentialLease = Omit<CredentialIntent, 'actionId' | 'callDigest' | 'expiresAt' | 'role'> & { running: boolean }
export type CredentialResolution = { kind: 'ordinary' } | { kind: 'consumed' } | { kind: 'credential'; intent: CredentialIntent }

/** Trusted host implementation must persist and atomically consume action ids,
 * and keep the live desktop/target fence held throughout the credential call. */
export type CredentialExecutorAuthority = {
  consumeMatchingIntent: (runId: string, actionId: string, digest: string) => Promise<CredentialResolution>
  withCurrentLease: <T>(intent: CredentialIntent, action: (live: LiveCredentialLease) => Promise<T>) => Promise<T>
  executeCredential: (intent: CredentialIntent) => Promise<unknown>
  now?: () => number
}
export function credentialAwareExecutor(deps: CredentialExecutorAuthority & {
  executeOrdinary: (driver: ComputerDriver, call: ComputerCall, display: string | undefined, runId: string) => Promise<unknown>
}) {
  return async (driver: ComputerDriver, call: ComputerCall, display: string | undefined, runId: string, context: { actionId: string }) => {
    const digest = createHash('sha256').update(JSON.stringify(call)).digest('hex')
    const resolved = await deps.consumeMatchingIntent(runId, context.actionId, digest)
    if (resolved.kind === 'ordinary') return deps.executeOrdinary(driver, call, display, runId)
    if (resolved.kind !== 'credential') throw new Error('Credential action already consumed')
    const { intent } = resolved
    if (![intent.actionId,intent.runId,intent.userId,intent.workspaceId,intent.botId,intent.subagentId,intent.targetId,intent.loaderId].every(value => typeof value === 'string' && value.length > 0) || intent.actionId !== context.actionId || !Number.isSafeInteger(intent.epoch) || intent.epoch < 0 || !Number.isSafeInteger(intent.policyVersion) || intent.policyVersion < 0 || intent.runId !== runId || intent.callDigest !== digest || intent.driverFingerprint !== driver.fingerprint || intent.display !== display || !Number.isSafeInteger(intent.backendNodeId) || intent.backendNodeId < 1 || !['username', 'password'].includes(intent.role) || !Number.isSafeInteger(intent.expiresAt) || intent.expiresAt <= (deps.now ?? Date.now)()) throw new Error('Credential action unavailable')
    const url = new URL(intent.origin)
    if (url.protocol !== 'https:' || url.username || url.password || url.origin !== intent.origin) throw new Error('Credential action unavailable')
    return deps.withCurrentLease(intent, async live => {
      if (!live.running || live.runId !== runId || live.userId !== intent.userId || live.workspaceId !== intent.workspaceId || live.botId !== intent.botId || live.subagentId !== intent.subagentId || live.epoch !== intent.epoch || live.display !== intent.display || live.policyVersion !== intent.policyVersion || live.driverFingerprint !== intent.driverFingerprint || live.targetId !== intent.targetId || live.origin !== intent.origin || live.loaderId !== intent.loaderId || live.backendNodeId !== intent.backendNodeId || intent.expiresAt <= (deps.now ?? Date.now)()) throw new Error('Credential action unavailable')
      const result = await deps.executeCredential(intent)
      if (!result || typeof result !== 'object' || !('status' in result) || typeof result.status !== 'string' || !['needs_login', 'session_applied', 'submitted'].includes(result.status)) throw new Error('Credential action unavailable')
      return { status: result.status }
    })
  }
}

/** Shared host admission callback used by the daemon broker. */
export function createHostedComputerExecutor(deps: {
  liveComputer: (runId: string, display: string | undefined) => { botId: string; ownerId: string; policyVersion: number }
  executeOrdinary: (driver: ComputerDriver, call: ComputerCall, display: string | undefined, runId: string) => Promise<unknown>
  authority?: CredentialExecutorAuthority
}) {
  const authority = deps.authority
  const credential = authority && credentialAwareExecutor({
    ...authority,
    executeOrdinary: deps.executeOrdinary,
    withCurrentLease: (intent, action) => authority.withCurrentLease(intent, live => {
      const computer = deps.liveComputer(intent.runId, intent.display)
      if (computer.botId !== intent.botId || computer.ownerId !== intent.userId || computer.policyVersion !== intent.policyVersion) throw new Error('Cloud computer run unavailable')
      return action(live)
    }),
  })
  return async (driver: ComputerDriver, call: ComputerCall, display: string | undefined, runId: string, context: { actionId: string }) => {
    deps.liveComputer(runId, display)
    return credential ? credential(driver, call, display, runId, context) : deps.executeOrdinary(driver, call, display, runId)
  }
}
