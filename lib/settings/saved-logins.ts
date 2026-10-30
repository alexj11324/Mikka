import 'server-only'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { pool } from '@/lib/db'
import { awsKms } from '@/lib/credentials/kms'
import { CredentialStore } from '@/lib/credentials/store'

/**
 * What the broker recorded for one use of a saved login
 * (lib/credentials/broker.ts writes credential_access_events.decision):
 * - `input_inserted_guarded`: typed into the page, not submitted yet
 * - `password_submitted` / `otp_submitted`: submitted to the site
 * - `session_applied`: a saved session was restored instead of the password
 * - `denied_or_failed`: refused or failed before or during use
 */
export type CredentialUseResult = 'input_inserted_guarded' | 'password_submitted' | 'otp_submitted' | 'session_applied' | 'denied_or_failed'

export interface SavedLogin {
  id: string
  /** Canonical https origin the login is bound to. */
  site: string
  /** The username or email. Passwords, sessions and keys are never returned. */
  account: string
  lastUsedAt: string | null
  /** Name of the Bot behind the last successful use; null if unknown or deleted. */
  lastUsedBy: string | null
}

export interface SavedLoginUse {
  id: string
  at: string
  botId: string | null
  botName: string | null
  /** The thread (agent run) the use happened in, when it was one. */
  runId: string | null
  /** The cloud-browser subagent the use happened in, when it was one. */
  subagentId: string | null
  /** The task the thread belongs to. */
  issueId: string | null
  result: CredentialUseResult
}

const USAGE_LIMIT = 100

const iso = (value: Date | null) => value ? value.toISOString() : null

function credentialId(id: unknown): string {
  const parsed = z.uuid().safeParse(id)
  if (!parsed.success) throw new ActionFailureError('savedLoginNotFound')
  return parsed.data
}

/** The person's saved logins, without any secret. */
export async function savedLogins(userId: string): Promise<SavedLogin[]> {
  const { rows } = await pool.query(`SELECT c.id, c.origin, c.username, GREATEST(c.last_used_at, used.ts) AS "lastUsedAt", b.name AS "botName"
    FROM credentials c
    LEFT JOIN LATERAL (
      SELECT e.ts, e.bot_id FROM credential_access_events e
      WHERE e.credential_id=c.id AND e.user_id=$1 AND e.decision <> 'denied_or_failed'
      ORDER BY e.ts DESC, e.id DESC LIMIT 1
    ) used ON true
    LEFT JOIN bots b ON b.id=used.bot_id AND b."ownerId"=$1
    WHERE c.user_id=$1 AND c.revoked_at IS NULL
    ORDER BY c.origin, c.username`, [userId])
  return rows.map(row => ({ id: row.id, site: row.origin, account: row.username, lastUsedAt: iso(row.lastUsedAt), lastUsedBy: row.botName ?? null }))
}

/**
 * Revokes one saved login through the vault's own removal: the secret can no
 * longer be leased, open fill leases are consumed and saved sessions expire,
 * so the broker cannot fill it again.
 */
export async function deleteSavedLoginFor(userId: string, id: unknown): Promise<{ id: string }> {
  const target = credentialId(id)
  const { rows: [row] } = await pool.query('SELECT origin, username FROM credentials WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL', [target, userId])
  if (!row) throw new ActionFailureError('savedLoginNotFound')
  // The KMS is never called by removal; the store needs one to be built.
  await new CredentialStore(pool, awsKms('app')).remove({ userId, workspaceId: '' }, row.origin, row.username)
  return { id: target }
}

/**
 * Recent uses of one saved login, newest first. Failed attempts the broker
 * could not tie to a login (no credential id) are only in the activity feed.
 */
export async function savedLoginUsage(userId: string, id: unknown): Promise<SavedLoginUse[]> {
  const target = credentialId(id)
  const owned = await pool.query('SELECT 1 FROM credentials WHERE id=$1 AND user_id=$2', [target, userId])
  if (!owned.rowCount) throw new ActionFailureError('savedLoginNotFound')
  const { rows } = await pool.query(`SELECT e.id::text AS id, e.ts, e.bot_id AS "botId", b.name AS "botName", e.run_id AS "runId", e.subagent_id AS "subagentId", r."issueId", e.decision
    FROM credential_access_events e
    LEFT JOIN bots b ON b.id=e.bot_id AND b."ownerId"=$1
    LEFT JOIN agent_runs r ON r.id=e.run_id AND r."userId"=$1
    WHERE e.credential_id=$2 AND e.user_id=$1
    ORDER BY e.ts DESC, e.id DESC LIMIT ${USAGE_LIMIT}`, [userId, target])
  return rows.map(row => ({
    id: row.id, at: row.ts.toISOString(), botId: row.botId, botName: row.botName ?? null,
    runId: row.runId, subagentId: row.subagentId, issueId: row.issueId ?? null, result: row.decision,
  }))
}
