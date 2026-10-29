import 'server-only'
import { pool } from '@/lib/db'
import { recordPersonalAuditEvent } from '@/lib/audit/store'

/** Passkey sign-in succeeded: remember when this credential was last used. */
export async function markPasskeyUsed(credentialId: string): Promise<void> {
  if (!credentialId) return
  await pool.query('UPDATE passkey SET "lastUsedAt" = now() WHERE "credentialID" = $1', [credentialId])
}

/**
 * Registration finishes in the browser (WebAuthn), so it is audited from the
 * auth after-hook. `returned` is the plugin's response: the new passkey row,
 * or an APIError when registration failed.
 */
export async function recordPasskeyRegistration(returned: unknown, sessionUserId?: string): Promise<void> {
  if (!returned || typeof returned !== 'object' || returned instanceof Error) return
  const row = returned as { id?: unknown; userId?: unknown; name?: unknown }
  const userId = typeof row.userId === 'string' ? row.userId : sessionUserId
  if (typeof row.id !== 'string' || !userId) return
  try {
    await recordPersonalAuditEvent(userId, 'passkey.added', typeof row.name === 'string' && row.name ? row.name : row.id)
  } catch (error) {
    // The passkey exists either way; a lost audit row must not fail registration.
    console.error('Passkey audit failed', error instanceof Error ? error.name : 'UnknownError')
  }
}
