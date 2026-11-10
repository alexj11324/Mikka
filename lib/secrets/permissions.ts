// 设置 › 密钥与环境 permission matrix (plan 1.3). Pure: no DB, shared by store, UI and tests.
// This is the coarse settings-role matrix. Resource-scoped Secrets additionally
// require the canonical Project/Thread ACL in the store, including for Admins.
import type { SecretScopeType } from './format'

export type WorkspaceRole = 'admin' | 'member'
/** A secret/env row as far as permissions care. */
export interface SecretTarget { scopeType: SecretScopeType }
export type SecretAction =
  | 'secret.list' | 'secret.create' | 'secret.replace' | 'secret.delete'
  | 'e2b.status' | 'e2b.write'

export const SECRET_POLICY = {
  /** Default 1+2 (7.12): "workspace-shared" means scopeType 'workspace', for secret and env alike; members can't write it. */
  // Resource scopes additionally require canManageAccess at the authoritative
  // resource boundary, including for Workspace admins. This matrix is only the
  // coarse settings role; it cannot authorize a private Project/Thread itself.
  memberScopes: ['repository', 'project', 'thread'] as readonly SecretScopeType[],
  /** Default 4 (7.12): members may replace entries someone else created (shared team values; audit is the backstop). */
  memberMayReplaceOthers: true,
  /** Shared Workspace/Repository deletion stays admin only. Resource owners use canManageAccess. */
  memberMayDelete: false,
  /** Members see the E2B card status (configured + last error only). */
  memberMayViewE2BStatus: true,
} as const

/** Can a member write a row with this scope? (No environment dimension: a value reaches every run of its scope.) */
export const memberMayWrite = (target: SecretTarget) => SECRET_POLICY.memberScopes.includes(target.scopeType)

/**
 * The matrix. `targets` are every row state the action touches: for create the new values,
 * for replace both the stored (old) and the requested (new) values, so a member can neither
 * edit a workspace entry nor move one there.
 */
export function secretActionAllowed(role: WorkspaceRole, action: SecretAction, targets: readonly SecretTarget[] = [], ownsAll = true): boolean {
  if (role === 'admin') return true
  switch (action) {
    case 'secret.list': return true
    case 'secret.create': return targets.length > 0 && targets.every(memberMayWrite)
    case 'secret.replace': return targets.length > 0 && targets.every(memberMayWrite) && (ownsAll || SECRET_POLICY.memberMayReplaceOthers)
    case 'secret.delete': return SECRET_POLICY.memberMayDelete || targets.length > 0 && targets.every(target => target.scopeType === 'project' || target.scopeType === 'thread')
    case 'e2b.status': return SECRET_POLICY.memberMayViewE2BStatus
    case 'e2b.write': return false
  }
}
