import 'server-only'
// Bring-your-own E2B API key (plan 1.3.1). One key per workspace, write-only: only last4 and
// verification state are ever returned. Phase 1 supports E2B only, so there is no provider
// abstraction: getWorkspaceE2BApiKey returns the E2B key itself.
import { and, eq, lte, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { workspaceE2bKeys, workspaceE2bVerifyAttempts, type E2B_KEY_ERROR_CODES } from '@/lib/db/secrets-schema'
import { WorkspaceError } from '@/lib/workspace-access'
import { e2bKeyAad, openSecret, sealSecret, SecretsKeyMissingError } from './crypto'
import { e2bKeyInput } from './format'
import { guardSecretsDb, logSecretFailure, noAudit, requireSecretPermission, type SecretAuditHook } from './store'

export type E2BKeyErrorCode = 'e2b_key_missing' | 'e2b_key_invalid' | 'e2b_limit_reached' | 'e2b_template_unavailable' | 'e2b_unavailable'
/** Thrown at dispatch / sandbox creation; the client shows a prompt per code. */
export class E2BKeyError extends Error {
  constructor(readonly code: E2BKeyErrorCode, readonly detail?: string) { super(code); this.name = 'E2BKeyError' }
}

/** Runtime flag. Off (default) = platform E2B_API_KEY exactly as today. On = workspace key only, no fallback. Enabling needs Alex's approval. */
export const byoE2BKeyEnabled = (env: Record<string, string | undefined> = process.env) => env.MIKKA_BYO_E2B_KEY === '1'

/** Design update (#436): no last4, verifiedAt or updatedAt in responses (still stored). */
export interface E2BKeyStatus { configured: boolean; lastErrorCode: string | null; lastErrorAt: string | null }

export type E2BVerifyResult = { ok: true } | { ok: false; code: (typeof E2B_KEY_ERROR_CODES)[number] }

/** Read-only check: GET /v2/sandboxes?limit=1 with X-API-Key. Creates nothing, costs nothing. */
export async function verifyE2BKey(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<E2BVerifyResult> {
  try {
    const response = await fetchImpl('https://api.e2b.app/v2/sandboxes?limit=1', { headers: { 'X-API-Key': apiKey }, signal: AbortSignal.timeout(10_000), cache: 'no-store' })
    if (response.ok) return { ok: true }
    if (response.status === 401 || response.status === 403) return { ok: false, code: 'invalid' }
    if (response.status === 429) return { ok: false, code: 'rate_limited' }
    return { ok: false, code: 'unavailable' }
  } catch { return { ok: false, code: 'unavailable' } }
}

// Postgres limiter: 5 verify attempts per workspace per sliding 10 minutes, shared by every
// instance. One row per attempt in workspace_e2b_verify_attempts; a per-workspace advisory
// transaction lock serialises count+insert, so N concurrent attempts admit exactly 5.
// The attempt commits before E2B is called, so failed checks count too.
export const VERIFY_ATTEMPTS = 5, VERIFY_WINDOW_MS = 10 * 60_000
export async function takeVerifyAttempt(workspaceId: string, now = new Date()): Promise<boolean> {
  return guardSecretsDb(() => db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`e2b-verify:${workspaceId}`}, 0))`)
    const since = new Date(now.getTime() - VERIFY_WINDOW_MS)
    await tx.delete(workspaceE2bVerifyAttempts).where(and(eq(workspaceE2bVerifyAttempts.workspaceId, workspaceId), lte(workspaceE2bVerifyAttempts.attemptedAt, since)))
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(workspaceE2bVerifyAttempts).where(eq(workspaceE2bVerifyAttempts.workspaceId, workspaceId))
    if (n >= VERIFY_ATTEMPTS) return false
    await tx.insert(workspaceE2bVerifyAttempts).values({ workspaceId, attemptedAt: now })
    return true
  }))
}

const sealKey = (apiKey: string, workspaceId: string) => {
  try { return sealSecret(apiKey, e2bKeyAad(workspaceId)) } catch (error) {
    if (error instanceof SecretsKeyMissingError) throw new WorkspaceError('secretsUnavailable')
    throw error
  }
}

export async function getE2BKeyStatus(userId: string, workspaceId: string): Promise<E2BKeyStatus> {
  // Members see whether a key is configured and its last error only; see SECRET_POLICY.memberMayViewE2BStatus.
  await requireSecretPermission(userId, workspaceId, 'e2b.status')
  const [row] = await guardSecretsDb(() => db.select().from(workspaceE2bKeys).where(eq(workspaceE2bKeys.workspaceId, workspaceId)))
  if (!row) return { configured: false, lastErrorCode: null, lastErrorAt: null }
  return { configured: true, lastErrorCode: row.lastErrorCode, lastErrorAt: row.lastErrorAt?.toISOString() ?? null }
}

/**
 * Sets or replaces the key after a live check. Nothing is saved unless E2B says 200.
 * Errors: e2bKeyInvalid (401/403), e2bKeyUnverifiable (network/5xx/429), e2bKeyRateLimited (our limiter),
 * secretsUnavailable (no WORKSPACE_SECRETS_KEY), workspaceAccessDenied. Failed checks are not audited and never logged with the key.
 */
export async function setE2BKey(userId: string, workspaceId: string, input: unknown, options: { audit?: SecretAuditHook; verify?: (apiKey: string) => Promise<E2BVerifyResult>; now?: Date } = {}): Promise<E2BKeyStatus> {
  await requireSecretPermission(userId, workspaceId, 'e2b.write')
  const { apiKey } = e2bKeyInput.parse(input)
  const now = options.now ?? new Date()
  if (!await takeVerifyAttempt(workspaceId, now)) throw new WorkspaceError('e2bKeyRateLimited')
  const sealed = sealKey(apiKey, workspaceId) // fail closed before calling E2B
  const result = await (options.verify ?? verifyE2BKey)(apiKey)
  if (!result.ok) throw new WorkspaceError(result.code === 'invalid' ? 'e2bKeyInvalid' : 'e2bKeyUnverifiable')
  const audit = options.audit ?? noAudit
  const values = { ...sealed, last4: apiKey.slice(-4), verifiedAt: now, lastErrorCode: null, lastErrorAt: null, updatedBy: userId, updatedAt: now }
  await guardSecretsDb(() => db.transaction(async tx => {
    const [existing] = await tx.select({ id: workspaceE2bKeys.workspaceId }).from(workspaceE2bKeys).where(eq(workspaceE2bKeys.workspaceId, workspaceId)).for('update')
    await tx.insert(workspaceE2bKeys).values({ workspaceId, ...values, createdBy: userId }).onConflictDoUpdate({ target: workspaceE2bKeys.workspaceId, set: values })
    await audit(tx, { workspaceId, actorId: userId, action: existing ? 'secret.replaced' : 'secret.created', target: { type: 'e2b_key', id: workspaceId, label: 'E2B API Key' } })
  }))
  return getE2BKeyStatus(userId, workspaceId)
}

/**
 * Admin-only delete (permission check before any write). Afterwards getWorkspaceE2BApiKey treats
 * the workspace as having no key (flag on: e2b_key_missing). TODO(audit): the hook runs inside
 * this transaction; swap noAudit for a recordAudit-backed hook once #432 lands.
 */
export async function removeE2BKey(userId: string, workspaceId: string, audit: SecretAuditHook = noAudit): Promise<{ removed: boolean }> {
  await requireSecretPermission(userId, workspaceId, 'e2b.write')
  return guardSecretsDb(() => db.transaction(async tx => {
    const gone = await tx.delete(workspaceE2bKeys).where(eq(workspaceE2bKeys.workspaceId, workspaceId)).returning({ id: workspaceE2bKeys.workspaceId })
    if (!gone.length) return { removed: false }
    await audit(tx, { workspaceId, actorId: userId, action: 'secret.deleted', target: { type: 'e2b_key', id: workspaceId, label: 'E2B API Key' } })
    return { removed: true }
  }))
}

/** Records a runtime E2B failure on the card (red status). Never stores the key or the response body. */
export async function recordE2BKeyError(workspaceId: string, code: (typeof E2B_KEY_ERROR_CODES)[number], now = new Date()) {
  await guardSecretsDb(() => db.update(workspaceE2bKeys).set({ lastErrorCode: code, lastErrorAt: now }).where(eq(workspaceE2bKeys.workspaceId, workspaceId)))
}

/**
 * The E2B API key to use for this workspace's sandboxes.
 * Flag off (default): process E2B_API_KEY, as today. Flag on: the workspace's own key, or
 * E2BKeyError('e2b_key_missing'); never falls back to the platform key.
 * Callers are not wired yet (follow-up PR 4e2).
 */
export async function getWorkspaceE2BApiKey(workspaceId: string, env: Record<string, string | undefined> = process.env): Promise<string> {
  if (!byoE2BKeyEnabled(env)) {
    if (!env.E2B_API_KEY) throw new Error('Cloud computer is not configured')
    return env.E2B_API_KEY
  }
  const [row] = await guardSecretsDb(() => db.select().from(workspaceE2bKeys).where(eq(workspaceE2bKeys.workspaceId, workspaceId)))
  if (!row) throw new E2BKeyError('e2b_key_missing')
  try { return openSecret(row, e2bKeyAad(workspaceId), env) } catch (error) {
    if (error instanceof SecretsKeyMissingError) throw new E2BKeyError('e2b_unavailable', 'secrets key missing')
    // Moved/tampered row or rotated key: never surface the raw crypto Error.
    logSecretFailure('e2b_unavailable', workspaceId)
    throw new E2BKeyError('e2b_unavailable', 'decrypt failed')
  }
}

/** Maps an E2B HTTP status to the user-facing code (plan 1.3.1 错误处理). */
export function e2bErrorCode(status: number): E2BKeyErrorCode {
  if (status === 401 || status === 403) return 'e2b_key_invalid'
  if (status === 429) return 'e2b_limit_reached'
  if (status === 404) return 'e2b_template_unavailable'
  return 'e2b_unavailable'
}
