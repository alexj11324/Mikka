import 'server-only'
import { headers } from 'next/headers'
import { getAuthenticatorName } from '@better-auth/passkey'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { recordPersonalAuditEvent } from '@/lib/audit/store'
import { createAccountSecurity, type SecurityAuthApi } from './account-security'
import { createSecurityStore } from './account-security-store'

async function countBackupCodes(userId: string): Promise<number | null> {
  try {
    const result = await auth.api.viewBackupCodes({ body: { userId } }) as { backupCodes?: string[] }
    return result.backupCodes?.length ?? null
  } catch {
    return null
  }
}

export const accountSecurity = createAccountSecurity({
  api: auth.api as unknown as SecurityAuthApi,
  store: createSecurityStore(pool, countBackupCodes),
  headers: async () => new Headers(await headers()),
  audit: (actorId, action, target) => recordPersonalAuditEvent(actorId, action, target),
  authenticatorName: aaguid => getAuthenticatorName(aaguid ?? undefined),
})
