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
import { checkEgressDomains, createSecretInput, deleteSecretInput, replaceSecretInput, scopeColumns, updateEgressInput, WORKSPACE_SECRETS_LIMIT } from './format'

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
  /** Only for kind='env'. Always null for kind='secret'. */
  value: string | null
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
const view = (row: Row): WorkspaceSecretView => ({
  id: row.id, name: row.name, kind: row.kind,
  scope: row.scopeType === 'workspace' ? { type: 'workspace' } : { type: 'repository', repository: row.scopeRef },
  value: row.kind === 'env' ? unseal(row) : null,
  createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
})
const meta = (row: Row): WorkspaceSecretView => ({ ...view({ ...row, kind: 'secret' }), kind: row.kind })
const isUnique = (error: unknown): boolean => !!error && typeof error === 'object' &&
  ((error as { code?: string }).code === '23505' || isUnique((error as { cause?: unknown }).cause))

export async function requireAdmin(userId: string, workspaceId: string) {
  await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, userId, true))
}

/** Admin only. Secrets come back with value=null; env vars with their value. */
export async function listWorkspaceSecrets(userId: string, workspaceId: string): Promise<WorkspaceSecretView[]> {
  await requireAdmin(userId, workspaceId)
  const rows = await db.select().from(workspaceSecrets).where(eq(workspaceSecrets.workspaceId, workspaceId))
    .orderBy(asc(workspaceSecrets.scopeType), asc(workspaceSecrets.scopeRef), asc(workspaceSecrets.name))
  return rows.map(view)
}

/** D6 新建. Errors: validationGeneric, secretNameTaken, secretLimitReached, secretsUnavailable, workspaceAccessDenied. */
/** Values shorter than this are not masked in runtime output (4e2), so saving one returns a warning. */
export const MASK_MIN_LENGTH = 8
export type SavedSecretView = WorkspaceSecretView & { warning: 'shortValueNotMasked' | null }
const withWarning = (row: WorkspaceSecretView, value: string): SavedSecretView => ({ ...row, warning: value.length < MASK_MIN_LENGTH ? 'shortValueNotMasked' : null })

export async function createWorkspaceSecret(userId: string, workspaceId: string, input: unknown, audit: SecretAuditHook = noAudit): Promise<SavedSecretView> {
  const { name, kind, value, scope } = createSecretInput.parse(input)
  await requireAdmin(userId, workspaceId)
  const id = crypto.randomUUID()
  const columns = { workspaceId, kind, name, ...scopeColumns(scope) }
  const sealed = seal(value, columns)
  try {
    const row = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`secrets:${workspaceId}`}, 0))`)
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(workspaceSecrets).where(eq(workspaceSecrets.workspaceId, workspaceId))
      if (n >= WORKSPACE_SECRETS_LIMIT) throw new WorkspaceError('secretLimitReached')
      const [saved] = await tx.insert(workspaceSecrets).values({ id, ...columns, ...sealed, createdBy: userId, updatedBy: userId }).returning()
      await audit(tx, { workspaceId, actorId: userId, action: kind === 'secret' ? 'secret.created' : 'env.created', target: { type: kind, id, label: name }, metadata: { scope: saved.scopeType, ...(saved.scopeRef ? { repository: saved.scopeRef } : {}) } })
      return saved
    })
    return withWarning(kind === 'env' ? view(row) : meta(row), value)
  } catch (error) {
    if (isUnique(error)) throw new WorkspaceError('secretNameTaken')
    throw error
  }
}

/** SEC-15～17 编辑: replaces the value only (kind, name and scope are fixed). Returns metadata (env: with value). */
export async function replaceWorkspaceSecret(userId: string, workspaceId: string, input: unknown, audit: SecretAuditHook = noAudit, now = new Date()): Promise<SavedSecretView> {
  const { id, value } = replaceSecretInput.parse(input)
  await requireAdmin(userId, workspaceId)
  const row = await db.transaction(async tx => {
    const [current] = await tx.select().from(workspaceSecrets).where(and(eq(workspaceSecrets.id, id), eq(workspaceSecrets.workspaceId, workspaceId))).for('update')
    if (!current) throw new WorkspaceError('secretNotFound')
    const [saved] = await tx.update(workspaceSecrets).set({ ...seal(value, current), updatedBy: userId, updatedAt: now }).where(eq(workspaceSecrets.id, id)).returning()
    await audit(tx, { workspaceId, actorId: userId, action: current.kind === 'secret' ? 'secret.replaced' : 'env.updated', target: { type: current.kind, id, label: current.name } })
    return saved
  })
  return withWarning(row.kind === 'env' ? view(row) : meta(row), value)
}

/** Delete (no UI frame yet; kept for the API). Audit action secret.deleted / env.deleted. */
export async function deleteWorkspaceSecret(userId: string, workspaceId: string, input: unknown, audit: SecretAuditHook = noAudit): Promise<{ id: string }> {
  const { id } = deleteSecretInput.parse(input)
  await requireAdmin(userId, workspaceId)
  return db.transaction(async tx => {
    const [gone] = await tx.delete(workspaceSecrets).where(and(eq(workspaceSecrets.id, id), eq(workspaceSecrets.workspaceId, workspaceId))).returning({ id: workspaceSecrets.id, kind: workspaceSecrets.kind, name: workspaceSecrets.name })
    if (!gone) throw new WorkspaceError('secretNotFound')
    await audit(tx, { workspaceId, actorId: userId, action: gone.kind === 'secret' ? 'secret.deleted' : 'env.deleted', target: { type: gone.kind, id, label: gone.name } })
    return { id }
  })
}

/** Outbound network policy. Workspaces without a row are 'open' (today's behaviour). */
export async function getNetworkPolicy(userId: string, workspaceId: string): Promise<NetworkPolicyView> {
  await requireAdmin(userId, workspaceId)
  const [row] = await db.select().from(workspaceNetworkPolicy).where(eq(workspaceNetworkPolicy.workspaceId, workspaceId))
  return row ? { mode: row.mode, allowedDomains: row.allowedDomains, updatedAt: row.updatedAt.toISOString() } : { mode: 'open', allowedDomains: [], updatedAt: null }
}

export class EgressDomainError extends WorkspaceError {
  constructor(readonly lines: number[]) { super('egressDomainInvalid') }
}

/** SEC-18/19. Errors: egressDomainInvalid (with 0-based invalid line indexes), validationGeneric. */
export async function updateNetworkPolicy(userId: string, workspaceId: string, input: unknown, audit: SecretAuditHook = noAudit, now = new Date()): Promise<NetworkPolicyView> {
  const { mode, allowedDomains } = updateEgressInput.parse(input)
  const { domains, invalid } = checkEgressDomains(allowedDomains)
  if (invalid.length) throw new EgressDomainError(invalid)
  await requireAdmin(userId, workspaceId)
  const row = await db.transaction(async tx => {
    const [saved] = await tx.insert(workspaceNetworkPolicy).values({ workspaceId, mode, allowedDomains: domains, updatedBy: userId, updatedAt: now })
      .onConflictDoUpdate({ target: workspaceNetworkPolicy.workspaceId, set: { mode, allowedDomains: domains, updatedBy: userId, updatedAt: now } }).returning()
    await audit(tx, { workspaceId, actorId: userId, action: 'network.updated', target: { type: 'network_policy', id: workspaceId, label: mode }, metadata: { mode, domains: domains.length } })
    return saved
  })
  return { mode: row.mode, allowedDomains: row.allowedDomains, updatedAt: row.updatedAt.toISOString() }
}
