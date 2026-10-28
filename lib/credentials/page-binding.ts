import { canonicalOrigin, CredentialError } from './contracts'

/** Both values must be built by the trusted host, never directly from model input.
 * This check alone is not an authorization decision or a node validation. */
export type CredentialPageBinding = {
  userId: string
  workspaceId: string
  botId: string
  subagentId: string
  epoch: number
  targetId: string
  origin: string
  loaderId: string
  permissionAction: 'computer_use'
  permissionVersion: number
}

/** A sealed, single-use lease binds an authorized operation to its document. */
export function assertCredentialPageBinding(lease: CredentialPageBinding & { expiresAt: number }, current: CredentialPageBinding, now = Date.now()) {
  const denied = () => new CredentialError('credential_denied', 404)
  const keys = ['userId', 'workspaceId', 'botId', 'subagentId', 'targetId', 'loaderId'] as const
  if (!Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= now || !Number.isSafeInteger(lease.epoch) || lease.epoch < 0 || lease.epoch !== current.epoch) throw denied()
  if (!Number.isSafeInteger(lease.permissionVersion) || lease.permissionVersion < 0 || lease.permissionVersion !== current.permissionVersion) throw denied()
  if (keys.some(key => typeof lease[key] !== 'string' || !lease[key] || lease[key] !== current[key])) throw denied()
  if (lease.permissionAction !== 'computer_use' || current.permissionAction !== 'computer_use') throw denied()
  try {
    if (canonicalOrigin(lease.origin) !== canonicalOrigin(current.origin)) throw denied()
  } catch { throw denied() }
}
