import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { canonicalOrigin, CredentialError, type Actor, type BrowserCaller, type Envelope } from './contracts'
import { seal, type Kms } from './kms'
import { fingerprint } from './fingerprint'

/** Only the trusted host may attach these to an owner-bound broker grant. */
export type ObservedCredentialInput = { loaderId: string; backendNodeId: number; credentialRole: 'username' | 'password'; epoch: number; permissionVersion: number; additionalInput?: { backendNodeId: number; role: 'username' | 'password' }; submitNodeId?: number }
export type BrowserTarget = { targetId: string; origin: string; endpoint: string; expiresAt: number; sandboxId?: string; observedInput?: ObservedCredentialInput; credentialAction?: import('../cloud-computer/credential-action-ledger').CredentialAction }
export const nonce = () => randomBytes(32).toString('base64url')
export const hashNonce = (value: string) => createHash('sha256').update(value).digest('hex')
const denied = () => new CredentialError('credential_denied', 404)
const callerValues = (caller: BrowserCaller) => [caller.userId, caller.workspaceId, caller.botId, caller.subagentId ?? null, caller.runId ?? null]

export class CredentialStore {
  constructor(readonly pool: Pool, readonly kms: Kms) {}
  /** Resolve identity from authenticated caller ownership, never a model's user/id. */
  async authorize(caller: BrowserCaller, client: Pool | PoolClient = this.pool) {
    if (Boolean(caller.subagentId) === Boolean(caller.runId)) throw denied()
    const bot = (await client.query('SELECT id FROM bots WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3', [caller.botId, caller.userId, caller.workspaceId])).rows[0]
    if (!bot) throw denied()
    if (caller.runId) {
      const run = (await client.query(`SELECT id FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "botId"=$3 AND "stopRequestedAt" IS NULL AND status IN ('running','waiting_input','preparing') AND "leaseExpiresAt">now()`, [caller.runId, caller.userId, caller.botId])).rows[0]
      if (!run) throw denied()
    } else {
      // #342 owns this additive table and its runtime. Fail closed until installed.
      const subagent = (await client.query(`SELECT id FROM bot_subagents WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "botId"=$4 AND status IN ('running','needs_you')`, [caller.subagentId, caller.userId, caller.workspaceId, caller.botId])).rows[0]
      if (!subagent) throw denied()
    }
  }
  async challenge(caller: BrowserCaller, origin: string) {
    await this.authorize(caller)
    const value = nonce()
    await this.pool.query(`INSERT INTO credential_challenges(nonce_hash,user_id,workspace_id,bot_id,subagent_id,run_id,origin,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '5 minutes')`, [hashNonce(value), ...callerValues(caller), canonicalOrigin(origin)])
    return { nonce: value, origin: canonicalOrigin(origin), expiresIn: 300 }
  }
  async save(caller: BrowserCaller, input: { nonce: string; origin: string; username: string; password: string }) {
    const origin = canonicalOrigin(input.origin), client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.authorize(caller, client)
      const challenge = await client.query(`UPDATE credential_challenges SET consumed_at=now() WHERE nonce_hash=$1 AND user_id=$2 AND workspace_id=$3 AND bot_id=$4 AND subagent_id IS NOT DISTINCT FROM $5::uuid AND run_id IS NOT DISTINCT FROM $6::uuid AND origin=$7 AND consumed_at IS NULL AND expires_at>now() RETURNING nonce_hash`, [hashNonce(input.nonce), ...callerValues(caller), origin])
      if (!challenge.rowCount) throw denied()
      // Serializes upserts, use and deletion for this account/site; no workspace credential sharing.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`credentials:${caller.userId}:${origin}`])
      const existing = (await client.query('SELECT id FROM credentials WHERE user_id=$1 AND origin=$2 AND username=$3 FOR UPDATE', [caller.userId, origin, input.username])).rows[0]
      const id = existing?.id ?? randomUUID()
      const leak = fingerprint(caller.userId, input.password)
      const envelope = await seal(this.kms, { userId: caller.userId, credentialId: id, origin }, Buffer.from(JSON.stringify({ username: input.username, password: input.password })))
      await client.query(`INSERT INTO credentials(id,user_id,origin,username) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,origin,username) DO UPDATE SET revoked_at=NULL`, [id, caller.userId, origin, input.username])
      await client.query(`INSERT INTO credential_secrets(credential_id,wrapped_dek,nonce,ciphertext,leak_hmac,leak_length) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(credential_id) DO UPDATE SET wrapped_dek=$2,nonce=$3,ciphertext=$4,leak_hmac=$5,leak_length=$6`, [id, envelope.wrappedDek, envelope.nonce, envelope.ciphertext, leak.digest, leak.length])
      await client.query('DELETE FROM browser_sessions WHERE credential_id=$1', [id])
      await client.query('COMMIT')
      return { status: 'saved' as const, origin }
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  async lease(caller: BrowserCaller, origin: string, target: BrowserTarget, username?: string, forcePassword = false) {
    await this.authorize(caller)
    origin = canonicalOrigin(origin)
    if (canonicalOrigin(target.origin) !== origin || target.expiresAt < Date.now() + 5000) throw denied()
    const rows = (await this.pool.query(`SELECT id FROM credentials WHERE user_id=$1 AND origin=$2 AND ($3::text IS NULL OR username=$3) AND revoked_at IS NULL AND unattended_allowed=true ORDER BY last_used_at DESC NULLS LAST,created_at DESC LIMIT 2`, [caller.userId, origin, username ?? null])).rows
    // Never choose a different account silently when several logins exist.
    if (rows.length !== 1) return { status: 'needs_login' as const, origin }
    const value = nonce()
    await this.pool.query(`INSERT INTO credential_fill_leases(nonce_hash,credential_id,user_id,workspace_id,bot_id,subagent_id,run_id,origin,target,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '30 seconds')`, [hashNonce(value), rows[0].id, ...callerValues(caller), origin, { ...target, credentialMode: forcePassword ? 'password' : 'session-first' }])
    return { status: 'ready' as const, lease: value }
  }
  async list(actor: Actor) {
    return (await this.pool.query('SELECT origin,username,auth_kind AS "authKind",last_used_at AS "lastUsedAt",created_at AS "createdAt" FROM credentials WHERE user_id=$1 AND revoked_at IS NULL ORDER BY origin,username', [actor.userId])).rows
  }
  async otpLease(caller: BrowserCaller, input: { nonce: string; origin: string; code: string; username?: string }, target: BrowserTarget) {
    await this.authorize(caller)
    const origin = canonicalOrigin(input.origin), client = await this.pool.connect()
    if (canonicalOrigin(target.origin) !== origin || target.expiresAt < Date.now() + 5000) throw denied()
    try {
      await client.query('BEGIN')
      const challenge = await client.query(`UPDATE credential_challenges SET consumed_at=now() WHERE nonce_hash=$1 AND user_id=$2 AND workspace_id=$3 AND bot_id=$4 AND subagent_id IS NOT DISTINCT FROM $5::uuid AND run_id IS NOT DISTINCT FROM $6::uuid AND origin=$7 AND consumed_at IS NULL AND expires_at>now() RETURNING nonce_hash`, [hashNonce(input.nonce), ...callerValues(caller), origin])
      if (!challenge.rowCount) throw denied()
      const rows = (await client.query('SELECT id FROM credentials WHERE user_id=$1 AND origin=$2 AND ($3::text IS NULL OR username=$3) AND revoked_at IS NULL LIMIT 2', [caller.userId, origin, input.username ?? null])).rows
      if (rows.length !== 1) throw denied()
      const envelope = await seal(this.kms, { userId: caller.userId, credentialId: rows[0].id, origin }, Buffer.from(input.code), 'otp')
      const value = nonce()
      await client.query(`INSERT INTO credential_fill_leases(nonce_hash,credential_id,user_id,workspace_id,bot_id,subagent_id,run_id,origin,target,expires_at,input_kind,input_envelope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '30 seconds','otp',$10)`, [hashNonce(value), rows[0].id, ...callerValues(caller), origin, target, envelope])
      await client.query('COMMIT')
      return value
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  async remove(actor: Actor, origin: string, username: string) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      origin = canonicalOrigin(origin)
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`credentials:${actor.userId}:${origin}`])
      const row = (await client.query('UPDATE credentials SET revoked_at=now() WHERE user_id=$1 AND origin=$2 AND username=$3 RETURNING id', [actor.userId, origin, username])).rows[0]
      if (row) {
        await client.query('DELETE FROM credential_secrets WHERE credential_id=$1', [row.id])
        await client.query('DELETE FROM browser_sessions WHERE credential_id=$1', [row.id])
        await client.query('DELETE FROM credential_fill_leases WHERE credential_id=$1', [row.id])
      }
      await client.query('COMMIT')
      return { status: 'deleted' as const } // Same response for absent/other-owner/deleted.
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
}

export function rowEnvelope(row: { wrapped_dek: string; nonce: string; ciphertext: string }): Envelope {
  return { v: 1, wrappedDek: row.wrapped_dek, nonce: row.nonce, ciphertext: row.ciphertext }
}
