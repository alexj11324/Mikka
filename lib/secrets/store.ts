import 'server-only'
// 设置 › 密钥与环境: storage for workspace secrets / env vars.
// Rules: no value (secret or env) ever leaves this module; list/create/replace/delete return metadata only. Every write runs in one
// MIKKA-DB transaction and calls the audit hook inside it, so #432's recordAudit(tx, …) slots in
// and an audit failure rolls the write back. targetLabel is always the NAME, never the value.
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { workspaceSecrets } from '@/lib/db/secrets-schema'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { sealSecret, secretAad, SecretsKeyMissingError } from './crypto'
import { secretActionAllowed, type SecretAction, type SecretTarget, type WorkspaceRole } from './permissions'
import { isReservedEnvName, createSecretInput, deleteSecretInput, importSecretsInput, replaceSecretInput, scopeColumns, WORKSPACE_SECRETS_LIMIT } from './format'
import { parseDotenv, type DotenvErrorReason } from './dotenv'
import { approveSecretDelivery, effectiveSecretDelivery, type SecretDelivery } from './delivery'
import { stopRunsForSecretChanges, type SecretChange } from './run-invalidation'

export type SecretsTx = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type SecretAuditAction = 'secret.created' | 'secret.replaced' | 'secret.deleted' | 'env.created' | 'env.updated' | 'env.deleted' | 'secret.replace_denied' | 'secret.injection_skipped'
export interface SecretAuditEvent {
  workspaceId: string
  actorId: string
  action: SecretAuditAction
  target: { type: 'secret' | 'env' | 'e2b_key'; id: string; label: string }
  metadata?: Record<string, string | number | boolean | string[]>
}
/** Called inside the write transaction. Throwing rolls the write back. */
export type SecretAuditHook = (tx: SecretsTx, event: SecretAuditEvent) => Promise<void>

// TODO(audit): once PR #432 lands, replace this with
//   (tx, e) => recordAudit(tx, { workspaceId: e.workspaceId, actor: { type: 'user', id: e.actorId, name }, action: e.action,
//     category: 'secret', target: e.target, metadata: e.metadata, ...auditRequestContext(headers) })
// MIKKA-DB secret/env writes must use recordAudit inside this transaction, never recordAuditSafe.
export const noAudit: SecretAuditHook = async () => {}

/**
 * Design update (#436): responses carry metadata only, never a value (secret or env) or last4.
 * `id` is the handle for replace/delete. The table shows note, who changed it last and when
 * (Devin's columns; decision 2026-11-02-2120).
 */
export interface WorkspaceSecretView {
  id: string
  name: string
  kind: 'secret' | 'env'
  scopeType: 'workspace' | 'repository'
  /** '' for workspace scope, owner/repo (lowercase) for repository scope. */
  scopeRef: string
  note: string
  /** Only secrets have a delivery policy. Unconfigured/legacy secrets remain protected. */
  delivery?: SecretDelivery
  /** The member's name in this workspace, or '' once they are gone. */
  updatedBy: string
  updatedAt: string
}

type Row = typeof workspaceSecrets.$inferSelect

function seal(value: string, row: Parameters<typeof secretAad>[0]) {
  try { return sealSecret(value, secretAad(row)) } catch (error) {
    if (error instanceof SecretsKeyMissingError) throw new WorkspaceError('secretsUnavailable')
    throw error
  }
}
/** One line, id and code only: never the value, ciphertext, iv or the crypto error text. */
export const logSecretFailure = (code: string, id: string) => console.error(`[secrets] ${code} id=${id}`)

const view = (row: Row, names: ReadonlyMap<string, string>): WorkspaceSecretView => ({ id: row.id, name: row.name, kind: row.kind, scopeType: row.scopeType, scopeRef: row.scopeRef,
  note: row.note, ...(row.kind === 'secret' ? { delivery: effectiveSecretDelivery(row.delivery) } : {}), updatedBy: names.get(row.updatedBy) ?? '', updatedAt: row.updatedAt.toISOString() })
/** Workspace names of the people who last changed these rows (workspace database). */
async function memberNames(workspaceId: string, userIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)]
  if (!ids.length) return new Map()
  const rows = await workspaceDb.select({ userId: workspaceMembers.userId, name: workspaceMembers.name }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, ids)))
  return new Map(rows.map(row => [row.userId, row.name]))
}
const views = async (workspaceId: string, rows: Row[]) => { const names = await memberNames(workspaceId, rows.map(row => row.updatedBy)); return rows.map(row => view(row, names)) }
/** SQLSTATE (5 chars) on the error or its cause chain; app error codes like 'secretNotFound' are ignored. */
const pgCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : pgCode((error as { cause?: unknown }).cause)
}
const isUnique = (error: unknown) => pgCode(error) === '23505'
/** DrizzleQueryError, or a pg error (has a SQLSTATE code) at any depth. Everything else, e.g. an audit hook's own error, passes through. */
const isDbError = (error: unknown): boolean => !!error && typeof error === 'object'
  && ((error as Error).name === 'DrizzleQueryError' || pgCode(error) !== undefined)

/** Generic stand-in for a DB failure. Has no cause, params, query text, ciphertext or iv. */
export class SecretsStoreError extends Error {
  constructor(readonly pgCode?: string) { super(`workspace secrets store query failed${pgCode ? ` (${pgCode})` : ''}`); this.name = 'SecretsStoreError' }
}
/**
 * Runs DB work for the secrets stores. Our own errors pass through; anything else (DrizzleQueryError
 * carries the bound params, i.e. ciphertext and iv, in its message) becomes a SecretsStoreError.
 */
export async function guardSecretsDb<T>(work: () => Promise<T>, onUnique?: () => Error): Promise<T> {
  try { return await work() } catch (error) {
    if (error instanceof WorkspaceError || error instanceof SecretsStoreError) throw error
    if (onUnique && isUnique(error)) throw onUnique()
    if (!isDbError(error)) throw error
    throw new SecretsStoreError(pgCode(error))
  }
}

/** Active member's role, or workspaceAccessDenied (not a member). */
export async function workspaceRole(userId: string, workspaceId: string): Promise<WorkspaceRole> {
  const { membership } = await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, userId))
  return membership.role === 'admin' ? 'admin' : 'member'
}
/** Throws secretPermissionDenied when the matrix (./permissions) says no. */
export function assertSecretPermission(role: WorkspaceRole, action: SecretAction, targets: readonly SecretTarget[] = [], ownsAll = true) {
  if (!secretActionAllowed(role, action, targets, ownsAll)) throw new WorkspaceError('secretPermissionDenied')
}
/**
 * Membership + matrix check, before any input validation or DB work. For replace, call again with
 * the stored row inside the transaction (see replaceWorkspaceSecret). Returns the role.
 */
export async function requireSecretPermission(userId: string, workspaceId: string, action: SecretAction, targets: readonly SecretTarget[] = []): Promise<WorkspaceRole> {
  const role = await workspaceRole(userId, workspaceId)
  // create/replace targets are only known after parsing (replace: after reading the row); the caller checks them then.
  const deferred = (action === 'secret.create' || action === 'secret.replace') && !targets.length
  if (!deferred) assertSecretPermission(role, action, targets)
  return role
}

/** Any member. Metadata only: no value is ever read back (secret or env). */
export async function listWorkspaceSecrets(userId: string, workspaceId: string): Promise<WorkspaceSecretView[]> {
  await requireSecretPermission(userId, workspaceId, 'secret.list')
  const rows = await guardSecretsDb(() => db.select().from(workspaceSecrets).where(eq(workspaceSecrets.workspaceId, workspaceId))
    .orderBy(asc(workspaceSecrets.scopeType), asc(workspaceSecrets.scopeRef), asc(workspaceSecrets.name)))
  return views(workspaceId, rows)
}

/** D6 新建. Errors: validationGeneric, secretNameTaken, secretLimitReached, secretsUnavailable, workspaceAccessDenied. */
/** Values shorter than this are not masked in runtime output (4e2), so saving one returns a warning. */
export { MASK_MIN_LENGTH } from './mask'
import { MASK_MIN_LENGTH } from './mask'
export type SavedSecretView = WorkspaceSecretView & { warning: 'shortValueNotMasked' | null }
/** Counts code points, not UTF-16 units: '🔑🔑🔑🔑' is 4 characters, so it is short. */
export const isShortSecretValue = (value: string) => Array.from(value).length < MASK_MIN_LENGTH
const withWarning = (row: WorkspaceSecretView, value: string | undefined): SavedSecretView => ({ ...row, warning: value !== undefined && isShortSecretValue(value) ? 'shortValueNotMasked' : null })

export async function createWorkspaceSecret(userId: string, workspaceId: string, input: unknown, audit: SecretAuditHook = noAudit): Promise<SavedSecretView> {
  const role = await requireSecretPermission(userId, workspaceId, 'secret.create')
  const { name, kind, value, note, scope, delivery } = createSecretInput.parse(input)
  if (isReservedEnvName(name)) throw new WorkspaceError('secretNameReserved')
  const columns = { workspaceId, kind, name, ...scopeColumns(scope) }
  assertSecretPermission(role, 'secret.create', [columns])
  // TODO(audit): member writes are audited through the same hook as admin writes (recordAudit after #432).
  const id = crypto.randomUUID()
  const sealed = seal(value, columns)
  const row = await guardSecretsDb(() => db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`secrets:${workspaceId}`}, 0))`)
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(workspaceSecrets).where(eq(workspaceSecrets.workspaceId, workspaceId))
      if (n >= WORKSPACE_SECRETS_LIMIT) throw new WorkspaceError('secretLimitReached')
      const [saved] = await tx.insert(workspaceSecrets).values({ id, ...columns, note, delivery: approveSecretDelivery(delivery, userId), ...sealed, createdBy: userId, updatedBy: userId }).returning()
      await audit(tx, { workspaceId, actorId: userId, action: kind === 'secret' ? 'secret.created' : 'env.created', target: { type: kind, id, label: name }, metadata: { scope: saved.scopeType, role, ...(kind === 'secret' ? { delivery: saved.delivery.mode } : {}), ...(saved.scopeRef ? { repository: saved.scopeRef } : {}) } })
      await stopRunsForSecretChanges(tx, [saved])
      return saved
    }), () => new WorkspaceError('secretNameTaken'))
  return withWarning((await views(workspaceId, [row]))[0], value)
}

/**
 * SEC-15～17 编辑: new value, optionally a new scope (kind and name are fixed).
 * The stored row's scope is read under FOR UPDATE inside the transaction and checked
 * together with the requested one, so a member can't edit a workspace entry or move one there.
 */
export async function replaceWorkspaceSecret(userId: string, workspaceId: string, input: unknown, audit: SecretAuditHook = noAudit, now = new Date()): Promise<SavedSecretView> {
  const role = await requireSecretPermission(userId, workspaceId, 'secret.replace')
  const { id, value, note, scope, delivery } = replaceSecretInput.parse(input)
  const row = await guardSecretsDb(() => db.transaction(async tx => {
    const [current] = await tx.select().from(workspaceSecrets).where(and(eq(workspaceSecrets.id, id), eq(workspaceSecrets.workspaceId, workspaceId))).for('update')
    // A missing id, an id in another workspace and an entry the caller may not edit are indistinguishable:
    // same queries (this select + one denied audit row), same secretNotFound. The audit keeps the real reason.
    const reason = !current ? 'notFound' : secretActionAllowed(role, 'secret.replace', [current], current.createdBy === userId) ? null : 'permission'
    if (!current || reason) {
      await audit(tx, { workspaceId, actorId: userId, action: 'secret.replace_denied', target: { type: current?.kind ?? 'secret', id, label: current?.name ?? '' }, metadata: { role, reason: reason ?? 'notFound' } })
      return null
    }
    const next = { ...current, ...(scope ? scopeColumns(scope) : {}) }
    assertSecretPermission(role, 'secret.replace', [current, next], current.createdBy === userId)
    if (current.kind === 'env' && delivery !== undefined) throw new WorkspaceError('validationGeneric')
    // TODO(audit): member writes are audited through the same hook as admin writes (recordAudit after #432).
    // The AAD binds scope, so a moved entry is re-sealed; a moved entry without a new value needs it.
    const moved = current.scopeType !== next.scopeType || current.scopeRef !== next.scopeRef
    if (moved && value === undefined) throw new WorkspaceError('validationGeneric')
    const [saved] = await tx.update(workspaceSecrets).set({ scopeType: next.scopeType, scopeRef: next.scopeRef, delivery: approveSecretDelivery(delivery, userId, now, current.delivery), ...(value !== undefined ? seal(value, next) : {}), ...(note !== undefined ? { note } : {}), updatedBy: userId, updatedAt: now }).where(eq(workspaceSecrets.id, id)).returning()
    await audit(tx, { workspaceId, actorId: userId, action: current.kind === 'secret' ? 'secret.replaced' : 'env.updated', target: { type: current.kind, id, label: current.name },
      metadata: { role, ...(value === undefined && delivery === undefined && !moved ? { noteOnly: true } : {}), ...(delivery !== undefined ? { delivery: saved.delivery.mode, previousDelivery: effectiveSecretDelivery(current.delivery).mode } : {}), ...(moved ? { from: [current.scopeType, current.scopeRef], to: [next.scopeType, next.scopeRef] } : {}) } })
    // JSONB does not preserve object-key order; normalize both stored policies.
    if (value !== undefined || moved || JSON.stringify(effectiveSecretDelivery(current.delivery)) !== JSON.stringify(effectiveSecretDelivery(saved.delivery))) {
      await stopRunsForSecretChanges(tx, moved ? [current, saved] : [saved])
    }
    return saved
  }), () => new WorkspaceError('secretNameTaken'))
  if (!row) throw new WorkspaceError('secretNotFound')
  return withWarning((await views(workspaceId, [row]))[0], value)
}

export type ImportErrorReason = DotenvErrorReason | 'reserved'
export interface ImportResult { created: string[]; replaced: string[]; kept: string[]; errors: Array<{ line: number; name?: string; reason: ImportErrorReason }> }

/**
 * Bulk add from a .env: every good line in one transaction, under the same lock, cap and audit as
 * one create. A name already in the chosen scope is replaced or kept (`onConflict`). Lines that
 * cannot be added (bad syntax, reserved names) come back by line number; values never do.
 * Errors: secretPermissionDenied (scope), secretImportEmpty, secretImportTooLarge, secretLimitReached.
 */
export async function importWorkspaceSecrets(userId: string, workspaceId: string, input: unknown, audit: SecretAuditHook = noAudit, now = new Date()): Promise<ImportResult> {
  const role = await requireSecretPermission(userId, workspaceId, 'secret.create')
  const { text, masked, scope, onConflict } = importSecretsInput.parse(input)
  const kind = masked ? 'secret' as const : 'env' as const
  const scoped = { workspaceId, kind, ...scopeColumns(scope) }
  assertSecretPermission(role, 'secret.create', [scoped])
  let parsed: ReturnType<typeof parseDotenv>
  try { parsed = parseDotenv(text) } catch { throw new WorkspaceError('secretImportTooLarge') }
  const errors: ImportResult['errors'] = [...parsed.errors]
  const entries = parsed.entries.filter(entry => isReservedEnvName(entry.name) ? (errors.push({ line: entry.line, name: entry.name, reason: 'reserved' }), false) : true)
  errors.sort((a, b) => a.line - b.line)
  if (!entries.length) throw new WorkspaceError('secretImportEmpty')
  return guardSecretsDb(() => db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`secrets:${workspaceId}`}, 0))`)
    const existing = await tx.select().from(workspaceSecrets).where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.scopeType, scoped.scopeType), eq(workspaceSecrets.scopeRef, scoped.scopeRef), inArray(workspaceSecrets.name, entries.map(entry => entry.name)))).for('update')
    const byName = new Map(existing.map(row => [row.name, row]))
    const fresh = entries.filter(entry => !byName.has(entry.name))
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(workspaceSecrets).where(eq(workspaceSecrets.workspaceId, workspaceId))
    if (n + fresh.length > WORKSPACE_SECRETS_LIMIT) throw new WorkspaceError('secretLimitReached')
    const result: ImportResult = { created: [], replaced: [], kept: [], errors }
    const changes: SecretChange[] = []
    for (const entry of entries) {
      const current = byName.get(entry.name)
      if (!current) {
        const id = crypto.randomUUID(), columns = { ...scoped, name: entry.name }
        await tx.insert(workspaceSecrets).values({ id, ...columns, note: entry.note, ...seal(entry.value, columns), createdBy: userId, updatedBy: userId })
        await audit(tx, { workspaceId, actorId: userId, action: kind === 'secret' ? 'secret.created' : 'env.created', target: { type: kind, id, label: entry.name }, metadata: { scope: scoped.scopeType, role, bulk: true, ...(scoped.scopeRef ? { repository: scoped.scopeRef } : {}) } })
        result.created.push(entry.name)
        changes.push({ id, ...columns })
      } else if (onConflict === 'replace' && secretActionAllowed(role, 'secret.replace', [current], current.createdBy === userId)) {
        await tx.update(workspaceSecrets).set({ ...seal(entry.value, current), ...(entry.note ? { note: entry.note } : {}), updatedBy: userId, updatedAt: now }).where(eq(workspaceSecrets.id, current.id))
        await audit(tx, { workspaceId, actorId: userId, action: current.kind === 'secret' ? 'secret.replaced' : 'env.updated', target: { type: current.kind, id: current.id, label: current.name }, metadata: { role, bulk: true } })
        result.replaced.push(entry.name)
        changes.push(current)
      } else result.kept.push(entry.name)
    }
    await stopRunsForSecretChanges(tx, changes)
    return result
  }))
}

/** Delete (no UI frame yet; kept for the API). Audit action secret.deleted / env.deleted. */
export async function deleteWorkspaceSecret(userId: string, workspaceId: string, input: unknown, audit: SecretAuditHook = noAudit): Promise<{ id: string }> {
  await requireSecretPermission(userId, workspaceId, 'secret.delete')
  const { id } = deleteSecretInput.parse(input)
  return guardSecretsDb(() => db.transaction(async tx => {
    const [gone] = await tx.delete(workspaceSecrets).where(and(eq(workspaceSecrets.id, id), eq(workspaceSecrets.workspaceId, workspaceId))).returning({ id: workspaceSecrets.id, kind: workspaceSecrets.kind, name: workspaceSecrets.name, workspaceId: workspaceSecrets.workspaceId, scopeType: workspaceSecrets.scopeType, scopeRef: workspaceSecrets.scopeRef })
    if (!gone) throw new WorkspaceError('secretNotFound')
    await audit(tx, { workspaceId, actorId: userId, action: gone.kind === 'secret' ? 'secret.deleted' : 'env.deleted', target: { type: gone.kind, id, label: gone.name } })
    await stopRunsForSecretChanges(tx, [gone])
    return { id }
  }))
}
