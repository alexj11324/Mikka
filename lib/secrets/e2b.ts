import 'server-only'
// Bring-your-own E2B API key (plan 1.3.1). One key per person, never shared (orchestration § 2):
// a sandbox carries its owner's credentials. Write-only: only verification state is ever returned.
// E2B only, so there is no provider abstraction: getUserE2BApiKey returns the E2B key itself.
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import { userE2bKeys, workspaceE2bKeys, type E2B_KEY_ERROR_CODES } from '@/lib/db/secrets-schema'
import { WorkspaceError } from '@/lib/workspace-access'
import { e2bKeyAad, openSecret, sealSecret, SecretsKeyMissingError, userE2bKeyAad } from './crypto'
import { e2bKeyInput } from './format'
import { guardSecretsDb, logSecretFailure, noAudit, requireSecretPermission, type SecretAuditHook } from './store'

import { byoE2BKeyEnabled, E2BKeyError, type E2BKeyErrorCode } from './flag'
export { byoE2BKeyEnabled, E2BKeyError, type E2BKeyErrorCode }

/** Design update (#436): no last4, verifiedAt or updatedAt in responses (still stored). */
export interface E2BKeyStatus { configured: boolean; byoEnabled: boolean; lastErrorCode: string | null; lastErrorAt: string | null }

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

const sealKey = (apiKey: string, userId: string) => {
  try { return sealSecret(apiKey, userE2bKeyAad(userId)) } catch (error) {
    if (error instanceof SecretsKeyMissingError) throw new WorkspaceError('secretsUnavailable')
    throw error
  }
}

/**
 * Before keys were personal, one key belonged to a workspace. Its ciphertext is bound to that
 * workspace, so SQL cannot move it: the person who saved it adopts it here on first use, re-sealed
 * to them, and the workspace row goes. Nobody else ever reads it again.
 */
async function adoptWorkspaceKey(userId: string, env: Record<string, string | undefined> = process.env) {
  const [own] = await guardSecretsDb(() => db.select({ userId: userE2bKeys.userId }).from(userE2bKeys).where(eq(userE2bKeys.userId, userId)))
  if (own) return
  const [legacy] = await guardSecretsDb(() => db.select().from(workspaceE2bKeys).where(eq(workspaceE2bKeys.createdBy, userId)).orderBy(desc(workspaceE2bKeys.updatedAt)).limit(1))
  if (!legacy) return
  let apiKey: string
  try { apiKey = openSecret(legacy, e2bKeyAad(legacy.workspaceId), env) } catch (error) {
    if (error instanceof SecretsKeyMissingError) return
    logSecretFailure('e2b_unavailable', legacy.workspaceId)
    return
  }
  const sealed = sealSecret(apiKey, userE2bKeyAad(userId), env)
  await guardSecretsDb(() => db.transaction(async tx => {
    await tx.insert(userE2bKeys).values({ userId, ...sealed, last4: legacy.last4, e2bTeamHint: legacy.e2bTeamHint, verifiedAt: legacy.verifiedAt,
      lastErrorCode: legacy.lastErrorCode, lastErrorAt: legacy.lastErrorAt }).onConflictDoNothing()
    await tx.delete(workspaceE2bKeys).where(eq(workspaceE2bKeys.createdBy, userId))
  }))
}

/** The caller's own key. `workspaceId` is the workspace the page shows; any member may hold a key of their own. */
export async function getE2BKeyStatus(userId: string, workspaceId: string): Promise<E2BKeyStatus> {
  await requireSecretPermission(userId, workspaceId, 'e2b.status')
  await adoptWorkspaceKey(userId)
  return readE2BKeyStatus(userId)
}

async function readE2BKeyStatus(userId: string): Promise<E2BKeyStatus> {
  const [row] = await guardSecretsDb(() => db.select().from(userE2bKeys).where(eq(userE2bKeys.userId, userId)))
  if (!row) return { configured: false, byoEnabled: byoE2BKeyEnabled(), lastErrorCode: null, lastErrorAt: null }
  return { configured: true, byoEnabled: byoE2BKeyEnabled(), lastErrorCode: row.lastErrorCode, lastErrorAt: row.lastErrorAt?.toISOString() ?? null }
}

/** Everyone edits only their own key. */
export async function getE2BKeyCapabilityForUser(userId: string, workspaceId: string) {
  return { canEdit: true, ...await getE2BKeyStatus(userId, workspaceId) }
}

/**
 * Sets or replaces the caller's own key after a live check. Nothing is saved unless E2B says 200.
 * Errors: e2bKeyInvalid (401/403), e2bKeyRateLimited (E2B answered 429), e2bKeyUnverifiable (network/5xx),
 * secretsUnavailable (no WORKSPACE_SECRETS_KEY), workspaceAccessDenied. Failed checks are not audited and never logged with the key.
 */
export async function setE2BKey(userId: string, workspaceId: string, input: unknown, options: { audit?: SecretAuditHook; verify?: (apiKey: string) => Promise<E2BVerifyResult>; now?: Date } = {}): Promise<E2BKeyStatus> {
  await requireSecretPermission(userId, workspaceId, 'e2b.status')
  const { apiKey } = e2bKeyInput.parse(input)
  const now = options.now ?? new Date()
  const sealed = sealKey(apiKey, userId) // fail closed before calling E2B
  const result = await (options.verify ?? verifyE2BKey)(apiKey)
  if (!result.ok) throw new WorkspaceError(result.code === 'invalid' ? 'e2bKeyInvalid' : result.code === 'rate_limited' ? 'e2bKeyRateLimited' : 'e2bKeyUnverifiable')
  const audit = options.audit ?? noAudit
  const values = { ...sealed, last4: apiKey.slice(-4), verifiedAt: now, lastErrorCode: null, lastErrorAt: null, updatedAt: now }
  await guardSecretsDb(() => db.transaction(async tx => {
    const [existing] = await tx.select({ id: userE2bKeys.userId }).from(userE2bKeys).where(eq(userE2bKeys.userId, userId)).for('update')
    await tx.insert(userE2bKeys).values({ userId, ...values }).onConflictDoUpdate({ target: userE2bKeys.userId, set: values })
    // A key saved before keys were personal is replaced, not kept for anyone else.
    await tx.delete(workspaceE2bKeys).where(eq(workspaceE2bKeys.createdBy, userId))
    await audit(tx, { workspaceId, actorId: userId, action: existing ? 'secret.replaced' : 'secret.created', target: { type: 'e2b_key', id: userId, label: 'E2B API Key' } })
  }))
  return readE2BKeyStatus(userId)
}

/** Removes the caller's own key. Their next cloud run has none: it takes the next machine in the fallback order. */
export async function removeE2BKey(userId: string, workspaceId: string, audit: SecretAuditHook = noAudit): Promise<{ removed: boolean }> {
  await requireSecretPermission(userId, workspaceId, 'e2b.status')
  return guardSecretsDb(() => db.transaction(async tx => {
    const gone = await tx.delete(userE2bKeys).where(eq(userE2bKeys.userId, userId)).returning({ id: userE2bKeys.userId })
    const legacy = await tx.delete(workspaceE2bKeys).where(eq(workspaceE2bKeys.createdBy, userId)).returning({ id: workspaceE2bKeys.workspaceId })
    if (!gone.length && !legacy.length) return { removed: false }
    await audit(tx, { workspaceId, actorId: userId, action: 'secret.deleted', target: { type: 'e2b_key', id: userId, label: 'E2B API Key' } })
    return { removed: true }
  }))
}

/** Records a runtime E2B failure on the owner's key (red status). Never stores the key or the response body. */
export async function recordE2BKeyError(userId: string, code: (typeof E2B_KEY_ERROR_CODES)[number], now = new Date()) {
  await guardSecretsDb(() => db.update(userE2bKeys).set({ lastErrorCode: code, lastErrorAt: now }).where(eq(userE2bKeys.userId, userId)))
}

/**
 * The E2B API key for sandboxes this person owns: always their own key, or
 * E2BKeyError('e2b_key_missing'). Never another member's, never the platform key.
 */
export async function getUserE2BApiKey(userId: string, env: Record<string, string | undefined> = process.env): Promise<string> {
  await adoptWorkspaceKey(userId, env)
  const [row] = await guardSecretsDb(() => db.select().from(userE2bKeys).where(eq(userE2bKeys.userId, userId)))
  if (!row) throw new E2BKeyError('e2b_key_missing')
  try { return openSecret(row, userE2bKeyAad(userId), env) } catch (error) {
    if (error instanceof SecretsKeyMissingError) throw new E2BKeyError('e2b_unavailable', 'secrets key missing')
    // Moved/tampered row or rotated key: never surface the raw crypto Error.
    logSecretFailure('e2b_unavailable', userId)
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

/**
 * Every E2B key a run in this workspace could hold, for masking output only: the own keys of
 * its active members and a key saved here before keys were personal. Reads only; adopts nothing.
 */
export async function maskableE2BKeys(workspaceId: string, env: Record<string, string | undefined> = process.env): Promise<string[]> {
  const { workspaceDb } = await import('@/lib/workspace-db')
  const { workspaceMembers } = await import('@/lib/db/workspace-schema')
  const members = (await workspaceDb.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.status, 'active')))).map(row => row.userId)
  const [own, legacy] = await guardSecretsDb(() => Promise.all([
    members.length ? db.select().from(userE2bKeys).where(inArray(userE2bKeys.userId, members)) : Promise.resolve([]),
    db.select().from(workspaceE2bKeys).where(eq(workspaceE2bKeys.workspaceId, workspaceId)),
  ]))
  const keys: string[] = []
  for (const row of own) { try { keys.push(openSecret(row, userE2bKeyAad(row.userId), env)) } catch { logSecretFailure('e2b_unavailable', row.userId) } }
  for (const row of legacy) { try { keys.push(openSecret(row, e2bKeyAad(row.workspaceId), env)) } catch { logSecretFailure('e2b_unavailable', row.workspaceId) } }
  return keys
}
