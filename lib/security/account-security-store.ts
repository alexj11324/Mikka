import type { PasskeyRow, SecurityStore } from './account-security'

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }

/**
 * Postgres reads over the better-auth tables (user, account, twoFactor, passkey).
 * `countBackupCodes` decrypts through better-auth (auth.api.viewBackupCodes).
 */
export function createSecurityStore(db: Queryable, countBackupCodes: (userId: string) => Promise<number | null>): SecurityStore {
  return {
    async twoFactorState(userId) {
      const { rows } = await db.query(
        `SELECT u."twoFactorEnabled" AS enabled, t.verified
           FROM "user" u LEFT JOIN "twoFactor" t ON t."userId" = u.id
          WHERE u.id = $1 LIMIT 1`, [userId])
      const row = rows[0]
      const enabled = row?.enabled === true && row.verified !== false && row.verified !== null && row.verified !== undefined
      const pending = row?.verified === false
      return { enabled, pending, backupCodesRemaining: enabled ? await countBackupCodes(userId) : null }
    },
    async hasPassword(userId) {
      const { rows } = await db.query(`SELECT 1 FROM account WHERE "userId" = $1 AND "providerId" = 'credential' AND password IS NOT NULL LIMIT 1`, [userId])
      return rows.length > 0
    },
    async clearTwoFactor(userId) {
      await db.query('DELETE FROM "twoFactor" WHERE "userId" = $1', [userId])
      await db.query('UPDATE "user" SET "twoFactorEnabled" = false, "updatedAt" = now() WHERE id = $1', [userId])
    },
    async listPasskeys(userId) {
      const { rows } = await db.query(
        `SELECT id, name, aaguid, "deviceType", "backedUp", "createdAt", "lastUsedAt"
           FROM passkey WHERE "userId" = $1 ORDER BY "createdAt" DESC NULLS LAST, id`, [userId])
      return rows as unknown as PasskeyRow[]
    },
    async passkeyOwner(passkeyId) {
      const { rows } = await db.query('SELECT "userId" FROM passkey WHERE id = $1', [passkeyId])
      return (rows[0]?.userId as string | undefined) ?? null
    },
  }
}
