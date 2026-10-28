import 'server-only'
import { pool } from '@/lib/db'

/** Idempotent database deletes: a failed cron returns failure and the next
 * invocation retries. Revocation and expiry are enforced before this cleanup. */
export async function cleanupCredentialInputs() {
  if (process.env.CREDENTIAL_VAULT_ENABLED !== '1') return { disabled: true }
  const leases = await pool.query('DELETE FROM credential_fill_leases WHERE expires_at<=now() OR consumed_at IS NOT NULL')
  const challenges = await pool.query('DELETE FROM credential_challenges WHERE expires_at<=now() OR consumed_at IS NOT NULL')
  const sessions = await pool.query('DELETE FROM browser_sessions WHERE expires_at<=now()')
  return { leases: leases.rowCount, challenges: challenges.rowCount, sessions: sessions.rowCount }
}
