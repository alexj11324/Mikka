// Why 审计日志's read failed, in words the page can act on. The settings read
// keeps response bodies out of its errors (lib/settings-read.ts), so the status
// is what tells a refused read (not an admin here, signed out) from a broken one.
import { ReadResponseError } from '@/lib/swr/retry'

export type AuditReadFailure = { kind: 'adminOnly' | 'signedOut' | 'failed'; code: string }

export function auditReadFailure(error: unknown): AuditReadFailure {
  if (error instanceof ReadResponseError) {
    if (error.status === 403) return { kind: 'adminOnly', code: 'workspaceAccessDenied' }
    if (error.status === 401) return { kind: 'signedOut', code: 'authRequired' }
    return { kind: 'failed', code: `audit_read_failed (http_${error.status})` }
  }
  return { kind: 'failed', code: `audit_read_failed (${error instanceof Error ? error.name : 'unknown'})` }
}
