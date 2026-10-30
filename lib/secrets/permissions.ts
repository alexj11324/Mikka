// 设置 › 密钥与环境 permission matrix (plan 1.3). Pure: no DB, shared by store, UI and tests.
// Five defaults below are still being confirmed with Alex (plan 7.12); each is one constant so a
// decision flips one line here, and tests/secret-permissions read the same constants.
import type { SecretScopeType, SecretEnvironment } from './format'

export type WorkspaceRole = 'admin' | 'member'
/** A secret/env row as far as permissions care. */
export interface SecretTarget { scopeType: SecretScopeType; environment: SecretEnvironment }
export type SecretAction =
  | 'secret.list' | 'secret.create' | 'secret.replace' | 'secret.delete'
  | 'e2b.status' | 'e2b.write' | 'network.read' | 'network.write'

export const SECRET_POLICY = {
  /** Default 1+2 (7.12): "workspace-shared" means scopeType 'workspace', for secret and env alike; members can't write it. */
  memberScopes: ['repository'] as readonly SecretScopeType[],
  /** Default 3 (7.12): 'all' also reaches production, so it is treated as production. */
  productionLike: ['production', 'all'] as readonly SecretEnvironment[],
  /** Default 4 (7.12): members may replace entries someone else created (shared team values; audit is the backstop). */
  memberMayReplaceOthers: true,
  /** Deletes stay admin only (decided). */
  memberMayDelete: false,
  /** Members see the E2B card status (masked: last4 / verifiedAt only). */
  memberMayViewE2BStatus: true,
  /** Egress policy is admin only, read and write. */
  memberMayReadNetwork: false,
} as const
// Default 5 (7.12), the three environment values, lives in format.ts (SECRET_ENVIRONMENTS).

/** Can a member write a row with this scope/environment? */
export const memberMayWrite = (target: SecretTarget) =>
  SECRET_POLICY.memberScopes.includes(target.scopeType) && !SECRET_POLICY.productionLike.includes(target.environment)

/**
 * The matrix. `targets` are every row state the action touches: for create the new values,
 * for replace both the stored (old) and the requested (new) values, so a member can neither
 * edit a production/workspace entry nor move one there.
 */
export function secretActionAllowed(role: WorkspaceRole, action: SecretAction, targets: readonly SecretTarget[] = [], ownsAll = true): boolean {
  if (role === 'admin') return true
  switch (action) {
    case 'secret.list': return true
    case 'secret.create': return targets.length > 0 && targets.every(memberMayWrite)
    case 'secret.replace': return targets.length > 0 && targets.every(memberMayWrite) && (ownsAll || SECRET_POLICY.memberMayReplaceOthers)
    case 'secret.delete': return SECRET_POLICY.memberMayDelete
    case 'e2b.status': return SECRET_POLICY.memberMayViewE2BStatus
    case 'e2b.write': return false
    case 'network.read': return SECRET_POLICY.memberMayReadNetwork
    case 'network.write': return false
  }
}
