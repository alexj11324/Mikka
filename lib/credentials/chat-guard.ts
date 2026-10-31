import 'server-only'
import { assertNoSecret, type SecretFingerprint } from './fingerprint'
import { credentialVaultEnabled } from './feature'

/** A pre-migration deployment has no saved secrets yet. Once the vault table
 * exists, database failures fail closed rather than silently disabling scans. */
export async function credentialChatFingerprints(userId: string): Promise<SecretFingerprint[]> {
  if (!credentialVaultEnabled()) return []
  const { pool } = await import('@/lib/db')
  const exists = (await pool.query(`SELECT to_regclass('credential_secrets') IS NOT NULL AS present`)).rows[0].present
  if (!exists) return []
  return (await pool.query(`SELECT s.leak_hmac AS digest,s.leak_length AS length FROM credential_secrets s JOIN credentials c ON c.id=s.credential_id WHERE c.user_id=$1`, [userId])).rows
}

export async function assertCredentialSafeChat(userId: string, value: unknown) {
  assertNoSecret(userId, value, await credentialChatFingerprints(userId))
}
