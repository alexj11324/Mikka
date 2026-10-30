import 'server-only'
// 设置 › 密钥与环境: storage for workspace secrets / env vars and the outbound network policy.
// Rules: secret values never leave this module (list/replace/delete return metadata only);
// env values are returned because Bots read them verbatim (plan A3). Every write runs in one
// MIKKA-DB transaction and calls the audit hook inside it, so #432's recordAudit(tx, …) slots in
// and an audit failure rolls the write back. targetLabel is always the NAME, never the value.
import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { workspaceNetworkPolicy, workspaceSecrets } from '@/lib/db/secrets-schema'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { openSecret, sealSecret, secretAad, SecretsKeyMissingError } from './crypto'
import { secretActionAllowed, type SecretAction, type SecretTarget, type WorkspaceRole } from './permissions'
import { checkEgressDomains, createSecretInput, deleteSecretInput, replaceSecretInput, scopeColumns, updateEgressInput, EGRESS_DOMAINS_MAX, WORKSPACE_SECRETS_LIMIT } from './format'

export type SecretsTx = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type SecretAuditAction = 'secret.created' | 'secret.replaced' | 'secret.deleted' | 'env.created' | 'env.updated' | 'env.deleted' | 'network.updated'
export interface SecretAuditEvent {
  workspaceId: string
  actorId: string
  action: SecretAuditAction
  target: { type: 'secret' | 'env' | 'network_policy' | 'e2b_key'; id: string; label: string }
  metadata?: Record<string, string | number | boolean | string[]>
}
/** Called inside the write transaction. Throwing rolls the write back. */
export type SecretAuditHook = (tx: SecretsTx, event: SecretAuditEvent) => Promise<void>

// TODO(audit): once PR #432 lands, replace this with
//   (tx, e) => recordAudit(tx, { workspaceId: e.workspaceId, actor: { type: 'user', id: e.actorId, name }, action: e.action,
//     category: 'secret', target: e.target, metadata: e.metadata, ...auditRequestContext(headers) })
// MIKKA-DB secret/env/egress writes must use recordAudit inside this transaction, never recordAuditSafe.
export const noAudit: SecretAuditHook = async () => {}

export interface WorkspaceSecretView {
  id: string
  name: string
  kind: 'secret' | 'env'
  scope: { type: 'workspace' } | { type: 'repository'; repository: string }
  environment: 'all' | 'production' | 'preview' | 'development'
  /** Only for kind='env'. Always null for kind='secret', and null when the row cannot be decrypted. */
  value: string | null
  /** True when the stored ciphertext no longer opens (moved row, wrong key). The rest of the list still works. */
  unavailable: boolean
  createdAt: string
  updatedAt: string
}
export interface NetworkPolicyView { mode: 'open' | 'allowlist' | 'none'; allowedDomains: string[]; updatedAt: string | null }

type Row = typeof workspaceSecrets.$inferSelect

function unseal(row: Row) {
  try { return openSecret(row, secretAad(row)) } catch (error) {
    if (error instanceof SecretsKeyMissingError) throw new WorkspaceError('secretsUnavailable')
    throw error
  }
}
function seal(value: string, row: Parameters<typeof secretAad>[0]) {
  try { return sealSecret(value, secretAad(row)) } catch (error) {
    if (error instanceof SecretsKeyMissingError) throw new WorkspaceError('secretsUnavailable')
    throw error
  }
}
/** One line, id and code only: never the value, ciphertext, iv or the crypto error text. */
export const logSecretFailure = (code: string, id: string) => console.error(`[secrets] ${code} id=${id}`)

/** A missing key still fails the whole call (secretsUnavailable); a single row that won't open is marked unavailable. */
function unsealForView(row: Row): { value: string | null; unavailable: boolean } {
  try { return { value: unseal(row), unavailable: false } } catch (error) {
    if (error instanceof WorkspaceError) throw error
    logSecretFailure('secretDecryptFailed', row.id)
    return { value: null, unavailable: true }
  }
}
const view = (row: Row): WorkspaceSecretView => ({
  id: row.id, name: row.name, kind: row.kind,
  scope: row.scopeType === 'workspace' ? { type: 'workspace' } : { type: 'repository', repository: row.scopeRef },
  environment: row.environment,
  ...(row.kind === 'env' ? unsealForView(row) : { value: null, unavailable: false }),
  createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
})
const meta = (row: Row): WorkspaceSecretView => ({ ...view({ ...row, kind: 'secret' }), kind: row.kind })
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

/** Any member. Secrets come back with value=null; env vars with their value. */
export async function listWorkspaceSecrets(userId: string, workspaceId: string): Promise<WorkspaceSecretView[]> {
  await requireSecretPermission(userId, workspaceId, 'secret.list')
  const rows = await guardSecretsDb(() => db.select().from(workspaceSecrets).where(eq(workspaceSecrets.workspaceId, workspaceId))
    .orderBy(asc(workspaceSecrets.scopeType), asc(workspaceSecrets.scopeRef), asc(workspaceSecrets.name)))
  return rows.map(view)
}

/** D6 新建. Errors: validationGeneric, secretNameTaken, secretLimitReached, secretsUnavailable, workspaceAccessDenied. */
/** Values shorter than this are not masked in runtime output (4e2), so saving one returns a warning. */
export const MASK_MIN_LENGTH = 8
export type SavedSecretView = WorkspaceSecretView & { warning: 'shortValueNotMasked' | null }
/** Counts code points, not UTF-16 units: '🔑🔑🔑🔑' is 4 characters, so it is short. */
export const isShortSecretValue = (value: string) => Array.from(value).length < MASK_MIN_LENGTH
const withWarning = (row: WorkspaceSecretView, value: string): SavedSecretView => ({ ...row, warning: isShortSecretValue(value) ? 'shortValueNotMasked' : null })

export async function createWorkspaceSecret(userId: string, workspaceId: string, input: unknown, audit: SecretAuditHook = noAudit): Promise<SavedSecretView> {
  const role = await requireSecretPermission(userId, workspaceId, 'secret.create')
  const { name, kind, value, scope, environment } = createSecretInput.parse(input)
  const columns = { workspaceId, kind, name, ...scopeColumns(scope), environment }
  assertSecretPermission(role, 'secret.create', [columns])
  // TODO(audit): member writes are audited through the same hook as admin writes (recordAudit after #432).
  const id = crypto.randomUUID()
  const sealed = seal(value, columns)
  const row = await guardSecretsDb(() => db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`secrets:${workspaceId}`}, 0))`)
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(workspaceSecrets).where(eq(workspaceSecrets.workspaceId, workspaceId))
      if (n >= WORKSPACE_SECRETS_LIMIT) throw new WorkspaceError('secretLimitReached')
      const [saved] = await tx.insert(workspaceSecrets).values({ id, ...columns, ...sealed, createdBy: userId, updatedBy: userId }).returning()
      await audit(tx, { workspaceId, actorId: userId, action: kind === 'secret' ? 'secret.created' : 'env.created', target: { type: kind, id, label: name }, metadata: { scope: saved.scopeType, environment: saved.environment, role, ...(saved.scopeRef ? { repository: saved.scopeRef } : {}) } })
      return saved
    }), () => new WorkspaceError('secretNameTaken'))
  return withWarning(kind === 'env' ? view(row) : meta(row), value)
}

/**
 * SEC-15～17 编辑: new value, optionally a new scope / environment (kind and name are fixed).
 * The stored row's scope/environment are read under FOR UPDATE inside the transaction and checked
 * together with the requested ones, so a member can't edit a production/workspace entry or move one there.
 */
export async function replaceWorkspaceSecret(userId: string, workspaceId: string, input: unknown, audit: SecretAuditHook = noAudit, now = new Date()): Promise<SavedSecretView> {
  const role = await requireSecretPermission(userId, workspaceId, 'secret.replace')
  const { id, value, scope, environment } = replaceSecretInput.parse(input)
  const row = await guardSecretsDb(() => db.transaction(async tx => {
    const [current] = await tx.select().from(workspaceSecrets).where(and(eq(workspaceSecrets.id, id), eq(workspaceSecrets.workspaceId, workspaceId))).for('update')
    if (!current) throw new WorkspaceError('secretNotFound')
    const next = { ...current, ...(scope ? scopeColumns(scope) : {}), environment: environment ?? current.environment }
    assertSecretPermission(role, 'secret.replace', [current, next], current.createdBy === userId)
    // TODO(audit): member writes are audited through the same hook as admin writes (recordAudit after #432).
    const [saved] = await tx.update(workspaceSecrets).set({ scopeType: next.scopeType, scopeRef: next.scopeRef, environment: next.environment, ...seal(value, next), updatedBy: userId, updatedAt: now }).where(eq(workspaceSecrets.id, id)).returning()
    const moved = current.scopeType !== next.scopeType || current.scopeRef !== next.scopeRef || current.environment !== next.environment
    await audit(tx, { workspaceId, actorId: userId, action: current.kind === 'secret' ? 'secret.replaced' : 'env.updated', target: { type: current.kind, id, label: current.name },
      metadata: { role, environment: next.environment, ...(moved ? { from: [current.scopeType, current.scopeRef, current.environment], to: [next.scopeType, next.scopeRef, next.environment] } : {}) } })
    return saved
  }), () => new WorkspaceError('secretNameTaken'))
  return withWarning(row.kind === 'env' ? view(row) : meta(row), value)
}

/** Delete (no UI frame yet; kept for the API). Audit action secret.deleted / env.deleted. */
export async function deleteWorkspaceSecret(userId: string, workspaceId: string, input: unknown, audit: SecretAuditHook = noAudit): Promise<{ id: string }> {
  await requireSecretPermission(userId, workspaceId, 'secret.delete')
  const { id } = deleteSecretInput.parse(input)
  return guardSecretsDb(() => db.transaction(async tx => {
    const [gone] = await tx.delete(workspaceSecrets).where(and(eq(workspaceSecrets.id, id), eq(workspaceSecrets.workspaceId, workspaceId))).returning({ id: workspaceSecrets.id, kind: workspaceSecrets.kind, name: workspaceSecrets.name })
    if (!gone) throw new WorkspaceError('secretNotFound')
    await audit(tx, { workspaceId, actorId: userId, action: gone.kind === 'secret' ? 'secret.deleted' : 'env.deleted', target: { type: gone.kind, id, label: gone.name } })
    return { id }
  }))
}

/** Outbound network policy. Workspaces without a row are 'open' (today's behaviour). */
export async function getNetworkPolicy(userId: string, workspaceId: string): Promise<NetworkPolicyView> {
  await requireSecretPermission(userId, workspaceId, 'network.read')
  const [row] = await guardSecretsDb(() => db.select().from(workspaceNetworkPolicy).where(eq(workspaceNetworkPolicy.workspaceId, workspaceId)))
  return row ? { mode: row.mode, allowedDomains: row.allowedDomains, updatedAt: row.updatedAt.toISOString() } : { mode: 'open', allowedDomains: [], updatedAt: null }
}

export class EgressDomainError extends WorkspaceError {
  /** 1-based line numbers. */
  constructor(readonly lines: number[]) { super('egressDomainInvalid') }
}
export class EgressTooManyDomainsError extends WorkspaceError {
  /** Distinct non-empty lines submitted (empty lines dropped, then deduped, then counted). */
  constructor(readonly count: number) { super('egressTooManyDomains') }
}

/**
 * SEC-18/19. Permission check (admin only) runs first, so non-admins learn nothing about validation.
 * Errors: workspaceAccessDenied, secretPermissionDenied, validationGeneric, egressTooManyDomains {count}, egressDomainInvalid {lines, 1-based}.
 * open / none deliberately keep the stored allowlist untouched (and ignore allowedDomains), so
 * switching back to allowlist restores the admin's previous list instead of an empty one.
 */
export async function updateNetworkPolicy(userId: string, workspaceId: string, input: unknown, audit: SecretAuditHook = noAudit, now = new Date()): Promise<NetworkPolicyView> {
  await requireSecretPermission(userId, workspaceId, 'network.write')
  const { mode, allowedDomains } = updateEgressInput.parse(input)
  let domains: string[] | null = null
  if (mode === 'allowlist') {
    const checked = checkEgressDomains(allowedDomains)
    if (checked.count > EGRESS_DOMAINS_MAX) throw new EgressTooManyDomainsError(checked.count)
    if (checked.invalid.length) throw new EgressDomainError(checked.invalid)
    domains = checked.domains
  }
  const row = await guardSecretsDb(() => db.transaction(async tx => {
    const set = domains ? { mode, allowedDomains: domains, updatedBy: userId, updatedAt: now } : { mode, updatedBy: userId, updatedAt: now }
    const [saved] = await tx.insert(workspaceNetworkPolicy).values({ workspaceId, mode, allowedDomains: domains ?? [], updatedBy: userId, updatedAt: now })
      .onConflictDoUpdate({ target: workspaceNetworkPolicy.workspaceId, set }).returning()
    await audit(tx, { workspaceId, actorId: userId, action: 'network.updated', target: { type: 'network_policy', id: workspaceId, label: mode }, metadata: { mode, domains: saved.allowedDomains.length } })
    return saved
  }))
  return { mode: row.mode, allowedDomains: row.allowedDomains, updatedAt: row.updatedAt.toISOString() }
}
