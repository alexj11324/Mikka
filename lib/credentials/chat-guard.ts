import 'server-only'
import { sql } from 'drizzle-orm'
import type { db as Db } from '@/lib/db'
import { assertNoSecret, type SecretFingerprint } from './fingerprint'
import { credentialVaultEnabled } from './feature'

/** A transaction (or db) to read the fingerprints through. A caller inside a
 * transaction passes it, so the check never waits for a second pool
 * connection while the first holds row locks: with the pool full, every such
 * caller would wait on the others until the connection timeout. */
export type FingerprintReader = Pick<typeof Db, 'execute'>

/** A pre-migration deployment has no saved secrets yet. Once the vault table
 * exists, database failures fail closed rather than silently disabling scans. */
export async function credentialChatFingerprints(userId: string, reader?: FingerprintReader): Promise<SecretFingerprint[]> {
  if (!credentialVaultEnabled()) return []
  if (reader) {
    const [{ present }] = (await reader.execute(sql`SELECT to_regclass('credential_secrets') IS NOT NULL AS present`)).rows as { present: boolean }[]
    if (!present) return []
    return (await reader.execute(sql`SELECT s.leak_hmac AS digest,s.leak_length AS length FROM credential_secrets s JOIN credentials c ON c.id=s.credential_id WHERE c.user_id=${userId}`)).rows as SecretFingerprint[]
  }
  const { pool } = await import('@/lib/db')
  const exists = (await pool.query(`SELECT to_regclass('credential_secrets') IS NOT NULL AS present`)).rows[0].present
  if (!exists) return []
  return (await pool.query(`SELECT s.leak_hmac AS digest,s.leak_length AS length FROM credential_secrets s JOIN credentials c ON c.id=s.credential_id WHERE c.user_id=$1`, [userId])).rows
}

export async function assertCredentialSafeChat(userId: string, value: unknown, reader?: FingerprintReader) {
  assertNoSecret(userId, value, await credentialChatFingerprints(userId, reader))
}
