import 'server-only'
// 设置 › 密钥与登录 › 我的: a person's own secrets (decision 2026-11-02-2120). Account-level, like
// user_e2b_keys: they follow the person into every workspace and reach only their own runs
// (lib/secrets/runtime.ts). No value ever leaves this module; every function takes the signed-in
// user's id from the caller, never from input. Not in any team's audit log: an admin must not
// learn the names of a member's own secrets.
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { userSecrets, workspaceSecrets } from '@/lib/db/secrets-schema'
import { WorkspaceError } from '@/lib/workspace-access'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { ActionFailureError } from '@/lib/action-error'
import { sealSecret, userSecretAad, SecretsKeyMissingError } from './crypto'
import { parseDotenv } from './dotenv'
import { createUserSecretInput, deleteSecretInput, importUserSecretsInput, isReservedEnvName, replaceUserSecretInput, USER_SECRETS_LIMIT } from './format'
import { guardSecretsDb, isShortSecretValue, type ImportErrorReason, type ImportResult } from './store'
import { approveSecretDelivery, effectiveSecretDelivery, type SecretDelivery } from './delivery'
import { stopRunsForSecretChanges, type SecretChange } from './run-invalidation'

export interface UserSecretView { id: string; name: string; kind: 'secret' | 'env'; note: string; updatedAt: string; delivery?: SecretDelivery }
export type SavedUserSecretView = UserSecretView & { warning: 'shortValueNotMasked' | null }
export type UserImportResult = Omit<ImportResult, 'errors'> & { errors: Array<{ line: number; name?: string; reason: ImportErrorReason | 'shadowsWorkspace' }> }
/** The workspace whose secret names a new personal name is checked against (the page the person is on). */
export interface ShadowContext { workspaceId?: string }

type Row = typeof userSecrets.$inferSelect
const view = (row: Row): UserSecretView => ({ id: row.id, name: row.name, kind: row.kind, note: row.note, ...(row.kind === 'secret' ? { delivery: effectiveSecretDelivery(row.delivery) } : {}), updatedAt: row.updatedAt.toISOString() })
const saved = (row: Row, value: string | undefined): SavedUserSecretView => ({ ...view(row), warning: value !== undefined && isShortSecretValue(value) ? 'shortValueNotMasked' : null })

function seal(value: string, row: { userId: string; kind: string; name: string }) {
  try { return sealSecret(value, userSecretAad(row)) } catch (error) {
    if (error instanceof SecretsKeyMissingError) throw new WorkspaceError('secretsUnavailable')
    throw error
  }
}

/**
 * Only names that a Personal value can shadow and this person may discover.
 * Thread values override Personal; private Project names cannot be probed by
 * trying to create a colliding Personal name.
 */
async function workspaceNames(userId: string, workspaceId: string | undefined, names: readonly string[]): Promise<Set<string>> {
  if (!workspaceId || !names.length) return new Set()
  try {
  const rows = await withTaskWorkspace(userId, workspaceId, () => guardSecretsDb(() => db.selectDistinct({ name: workspaceSecrets.name }).from(workspaceSecrets)
    .where(and(eq(workspaceSecrets.workspaceId, workspaceId), inArray(workspaceSecrets.name, [...names]),
      sql`case when ${workspaceSecrets.scopeType}='project' then mikka_resource_acl_allowed('account',${userId},${workspaceId}::uuid,
        'project',${workspaceSecrets.scopeRef}::uuid,'canReadContent') else ${workspaceSecrets.scopeType}<>'thread' end`))))
  return new Set(rows.map(row => row.name))
  } catch (error) {
    if (error instanceof ActionFailureError && error.code === 'workspaceAccessDenied')
      throw Object.assign(new WorkspaceError('workspaceAccessDenied'), { cause: error })
    throw error
  }
}

export async function listUserSecrets(userId: string): Promise<UserSecretView[]> {
  const rows = await guardSecretsDb(() => db.select().from(userSecrets).where(eq(userSecrets.userId, userId)).orderBy(asc(userSecrets.name)))
  return rows.map(view)
}

/** Errors: secretNameReserved, secretNameTaken, secretNameShadowsWorkspace (unless confirmed), secretLimitReached, secretsUnavailable. */
export async function createUserSecret(userId: string, input: unknown, context: ShadowContext): Promise<SavedUserSecretView> {
  const { name, kind, value, note, overrideWorkspace, delivery } = createUserSecretInput.parse(input)
  if (isReservedEnvName(name)) throw new WorkspaceError('secretNameReserved')
  if (!overrideWorkspace && (await workspaceNames(userId, context.workspaceId, [name])).has(name)) throw new WorkspaceError('secretNameShadowsWorkspace')
  const id = crypto.randomUUID(), columns = { userId, kind, name }
  const sealed = seal(value, columns)
  const row = await guardSecretsDb(() => db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`user-secrets:${userId}`}, 0))`)
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(userSecrets).where(eq(userSecrets.userId, userId))
    if (n >= USER_SECRETS_LIMIT) throw new WorkspaceError('secretLimitReached')
    const [row] = await tx.insert(userSecrets).values({ id, ...columns, note, delivery: approveSecretDelivery(delivery, userId), ...sealed }).returning()
    await stopRunsForSecretChanges(tx, [{ ownerId: userId, name }])
    return row
  }), () => new WorkspaceError('secretNameTaken'))
  return saved(row, value)
}

/** A new value and/or note for one of the person's own secrets. Name and kind are fixed. */
export async function replaceUserSecret(userId: string, input: unknown, now = new Date()): Promise<SavedUserSecretView> {
  const { id, value, note, delivery } = replaceUserSecretInput.parse(input)
  const row = await guardSecretsDb(() => db.transaction(async tx => {
    const [current] = await tx.select().from(userSecrets).where(and(eq(userSecrets.id, id), eq(userSecrets.userId, userId))).for('update')
    if (!current) return null
    if (current.kind === 'env' && delivery !== undefined) throw new WorkspaceError('validationGeneric')
    const [row] = await tx.update(userSecrets).set({ delivery: approveSecretDelivery(delivery, userId, now, current.delivery), ...(value !== undefined ? seal(value, current) : {}), ...(note !== undefined ? { note } : {}), updatedAt: now }).where(eq(userSecrets.id, id)).returning()
    // JSONB does not preserve object-key order; normalize both stored policies.
    if (value !== undefined || JSON.stringify(effectiveSecretDelivery(current.delivery)) !== JSON.stringify(effectiveSecretDelivery(row.delivery))) {
      await stopRunsForSecretChanges(tx, [{ ownerId: userId, name: current.name }])
    }
    return row
  }))
  if (!row) throw new WorkspaceError('secretNotFound')
  return saved(row, value)
}

export async function deleteUserSecret(userId: string, input: unknown): Promise<{ id: string }> {
  const { id } = deleteSecretInput.parse(input)
  return guardSecretsDb(() => db.transaction(async tx => {
    const [gone] = await tx.delete(userSecrets).where(and(eq(userSecrets.id, id), eq(userSecrets.userId, userId))).returning({ id: userSecrets.id, name: userSecrets.name })
    if (!gone) throw new WorkspaceError('secretNotFound')
    await stopRunsForSecretChanges(tx, [{ ownerId: userId, name: gone.name }])
    return { id }
  }))
}

/**
 * Bulk add from a .env for oneself, in one transaction. A name the current workspace already has
 * is reported (`shadowsWorkspace`) unless `overrideWorkspace` confirms it, as for one secret.
 */
export async function importUserSecrets(userId: string, input: unknown, context: ShadowContext, now = new Date()): Promise<UserImportResult> {
  const { text, masked, onConflict, overrideWorkspace } = importUserSecretsInput.parse(input)
  const kind = masked ? 'secret' as const : 'env' as const
  let parsed: ReturnType<typeof parseDotenv>
  try { parsed = parseDotenv(text) } catch { throw new WorkspaceError('secretImportTooLarge') }
  const errors: UserImportResult['errors'] = [...parsed.errors]
  const shadowed = overrideWorkspace ? new Set<string>() : await workspaceNames(userId, context.workspaceId, parsed.entries.map(entry => entry.name))
  const entries = parsed.entries.filter(entry => {
    if (isReservedEnvName(entry.name)) { errors.push({ line: entry.line, name: entry.name, reason: 'reserved' }); return false }
    if (shadowed.has(entry.name)) { errors.push({ line: entry.line, name: entry.name, reason: 'shadowsWorkspace' }); return false }
    return true
  })
  errors.sort((a, b) => a.line - b.line)
  if (!entries.length && !errors.some(error => error.reason === 'shadowsWorkspace')) throw new WorkspaceError('secretImportEmpty')
  const result: UserImportResult = { created: [], replaced: [], kept: [], errors }
  if (!entries.length) return result
  return guardSecretsDb(() => db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`user-secrets:${userId}`}, 0))`)
    const existing = await tx.select().from(userSecrets).where(and(eq(userSecrets.userId, userId), inArray(userSecrets.name, entries.map(entry => entry.name)))).for('update')
    const byName = new Map(existing.map(row => [row.name, row]))
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(userSecrets).where(eq(userSecrets.userId, userId))
    if (n + entries.filter(entry => !byName.has(entry.name)).length > USER_SECRETS_LIMIT) throw new WorkspaceError('secretLimitReached')
    const changes: SecretChange[] = []
    for (const entry of entries) {
      const current = byName.get(entry.name)
      if (!current) {
        const columns = { userId, kind, name: entry.name }
        await tx.insert(userSecrets).values({ id: crypto.randomUUID(), ...columns, note: entry.note, ...seal(entry.value, columns) })
        result.created.push(entry.name)
        changes.push({ ownerId: userId, name: entry.name })
      } else if (onConflict === 'replace') {
        await tx.update(userSecrets).set({ ...seal(entry.value, current), ...(entry.note ? { note: entry.note } : {}), updatedAt: now }).where(eq(userSecrets.id, current.id))
        result.replaced.push(entry.name)
        changes.push({ ownerId: userId, name: entry.name })
      } else result.kept.push(entry.name)
    }
    await stopRunsForSecretChanges(tx, changes)
    return result
  }))
}
