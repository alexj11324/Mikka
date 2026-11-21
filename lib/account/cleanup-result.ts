import type { PoolClient } from 'pg'

export type AccountDeletionLease = { id: string; client: PoolClient }
export interface AccountCleanupOptions { job?: AccountDeletionLease; blockerErrors?: Record<string, string> }

/** Cleanup failures block account deletion; third-party retention/revocation exceptions are disclosed separately. */
export interface AccountCleanupReport { blockedReasons: string[]; warnings: string[]; blockerErrors?: Record<string, string> }

export function cleanupErrorIdentifier(error: unknown): string {
  const value = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown } : {}
  const identifier = (part: unknown): part is string => typeof part === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(part)
  const name = identifier(value.name) ? value.name : 'Error'
  return identifier(value.code) ? `${name}:${value.code}` : name
}
