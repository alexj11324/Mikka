import 'server-only'
import { APIError } from 'better-auth'
import { isAPIError } from '@better-auth/core/utils/is-api-error'
import type { PoolClient } from 'pg'
import { pool } from '@/lib/db'

type Database = Pick<PoolClient, 'query'>
type AuthSession = { user: { id: string }; session: { id: string } }
type CompletionContext = {
  path?: string
  context: { returned?: unknown; newSession?: AuthSession | null; session?: AuthSession | null }
}

export const twoFactorSessionFields = {
  twoFactorVerifiedAt: { type: 'date', required: false, input: false, returned: false },
  twoFactorMethod: { type: 'string', required: false, input: false, returned: false },
} as const

/** The native plugin owns verification and recovery-code consumption; this stores only its session assurance. */
export async function completeTwoFactorVerification(ctx: CompletionContext) {
  const method = ctx.path === '/two-factor/verify-totp' ? 'totp'
    : ctx.path === '/two-factor/verify-backup-code' ? 'recovery' : null
  if (!method || isAPIError(ctx.context.returned)
    || ctx.context.returned instanceof Response && !ctx.context.returned.ok) return
  const active = ctx.context.newSession ?? ctx.context.session
  if (!active) return
  const result = await pool.query(`UPDATE session s SET "twoFactorVerifiedAt"=now(),"twoFactorMethod"=$3
    FROM "user" u WHERE s.id=$1 AND s."userId"=$2 AND u.id=$2 AND u."twoFactorEnabled"
      AND s."expiresAt">now() AND EXISTS(SELECT 1 FROM "twoFactor" f WHERE f."userId"=u.id AND f.verified)`,
  [active.session.id, active.user.id, method])
  if (result.rowCount !== 1) throw new APIError('FORBIDDEN', { code: 'TWO_FACTOR_REQUIRED', message: 'Two-factor verification required' })
}

export async function twoFactorSessionState(userId: string, sessionId: string, database: Database = pool) {
  const { rows: [state] } = await database.query<{ enabled: boolean; verified: boolean }>(`SELECT
    u."twoFactorEnabled" AND EXISTS(SELECT 1 FROM "twoFactor" f WHERE f."userId"=u.id AND f.verified) AS enabled,
    EXISTS(SELECT 1 FROM session s WHERE s.id=$2 AND s."userId"=u.id AND s."expiresAt">now()
      AND s."twoFactorVerifiedAt" IS NOT NULL AND s."twoFactorMethod" IN ('totp','recovery')) AS verified
    FROM "user" u WHERE u.id=$1`, [userId, sessionId])
  return { enabled: state?.enabled === true, verified: state?.enabled === true && state.verified === true }
}

/** A password/OAuth session cannot reveal or replace an already enrolled second factor. */
export async function assertTwoFactorManagement(userId: string, sessionId: string) {
  const state = await twoFactorSessionState(userId, sessionId)
  if (state.enabled && !state.verified)
    throw new APIError('FORBIDDEN', { code: 'TWO_FACTOR_REQUIRED', message: 'Two-factor verification required' })
}

/** Grace is an organization-wide enrollment deadline; account enrollment alone never proves a human session. */
export async function organizationTwoFactorAllowed(userId: string, organizationId: string, sessionId: string | null, database: Database = pool) {
  const { rows: [policy] } = await database.query<{ required: boolean }>(`SELECT
    "requireTwoFactor" AND ("twoFactorRequiredAt" IS NULL OR "twoFactorRequiredAt" + "twoFactorGraceDays" * interval '1 day' <= now()) AS required
    FROM enterprise_org_policy WHERE "organizationId"=$1`, [organizationId])
  if (!policy?.required) return true
  // Machine credentials retain their existing credential/SSO policy. Human enrollment
  // still applies to their account; only an actual session can claim a second-factor receipt.
  const state = await twoFactorSessionState(userId, sessionId ?? '', database)
  return sessionId === null ? state.enabled : state.verified
}
