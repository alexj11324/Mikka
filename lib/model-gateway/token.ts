import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'

type Query = Pick<Pool | PoolClient, 'query'>

/**
 * A run's token for the Mikka model gateway (decision 2026-11-15-2000). The CLI
 * on the machine holds only this; the provider key or Mikka's own gateway
 * credential stays on the server. Only the SHA-256 is stored.
 */
export type GatewaySource = { kind: 'credits' } | { kind: 'api_key'; keyId: string }
export interface GatewayGrant {
  runId: string
  ownerId: string
  workspaceId: string | null
  harness: 'claude_code' | 'codex'
  /** The model the run was frozen on: a catalogue id for Mikka 额度, the provider's id for a key. */
  model: string
  source: GatewaySource
}

const PREFIX = 'mkg_'
/** A run's machine budget is shorter; the run's own state ends the token sooner (`verifyGatewayToken`). */
export const GATEWAY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000
/** The run states in which its CLI may still call a model, as `validateRunApiKey` checks them. */
const ACTIVE_RUN = ['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing']

export const hashGatewayToken = (token: string) => createHash('sha256').update(token).digest('hex')
const tokenShape = /^mkg_[A-Za-z0-9_-]{43}$/

export async function mintGatewayToken(query: Query, grant: GatewayGrant, now = Date.now()): Promise<{ token: string; expiresAt: Date }> {
  z.uuid().parse(grant.runId)
  if (grant.workspaceId) z.uuid().parse(grant.workspaceId)
  if (grant.source.kind === 'api_key') z.uuid().parse(grant.source.keyId)
  const model = z.string().trim().min(1).max(128).parse(grant.model)
  const token = PREFIX + randomBytes(32).toString('base64url')
  const expiresAt = new Date(now + GATEWAY_TOKEN_TTL_MS)
  await query.query(`INSERT INTO model_gateway_tokens ("tokenHash","runId","ownerId","workspaceId",harness,model,"sourceKind","keyId","expiresAt")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [hashGatewayToken(token), grant.runId, grant.ownerId, grant.workspaceId, grant.harness, model, grant.source.kind,
    grant.source.kind === 'api_key' ? grant.source.keyId : null, expiresAt])
  return { token, expiresAt }
}

/**
 * The grant behind a token, or null: unknown, expired, or its run no longer
 * active (ended, failed, stop requested). A run that ends therefore revokes its
 * token without any cleanup job.
 */
export async function verifyGatewayToken(query: Query, token: string, now = new Date()): Promise<GatewayGrant | null> {
  if (!tokenShape.test(token)) return null
  const { rows: [row] } = await query.query<{ runId: string; ownerId: string; workspaceId: string | null; harness: GatewayGrant['harness']; model: string; sourceKind: 'credits' | 'api_key'; keyId: string | null }>(
    `SELECT t."runId"::text AS "runId",t."ownerId",t."workspaceId"::text AS "workspaceId",t.harness,t.model,t."sourceKind",t."keyId"::text AS "keyId"
     FROM model_gateway_tokens t JOIN agent_runs r ON r.id=t."runId" AND r."userId"=t."ownerId"
     WHERE t."tokenHash"=$1 AND t."expiresAt">$2 AND r.status=ANY($3::text[]) AND r."stopRequestedAt" IS NULL`,
    [hashGatewayToken(token), now, ACTIVE_RUN])
  if (!row) return null
  return { runId: row.runId, ownerId: row.ownerId, workspaceId: row.workspaceId, harness: row.harness, model: row.model,
    source: row.sourceKind === 'api_key' && row.keyId ? { kind: 'api_key', keyId: row.keyId } : { kind: 'credits' } }
}

/** The token a request carries: Claude Code sends `x-api-key`, Codex `Authorization: Bearer`. */
export function requestGatewayToken(headers: Headers): string | null {
  const bearer = headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1]
  return bearer ?? headers.get('x-api-key')?.trim() ?? null
}
