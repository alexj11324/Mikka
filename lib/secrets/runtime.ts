import 'server-only'
import { createHash } from 'node:crypto'
// Workspace and repository secrets are enabled whenever the deployment has its
// encryption key. Choosing BYO or platform E2B billing does not disable secret protection.
import { and, eq, inArray, or } from 'drizzle-orm'
import { db } from '@/lib/db'
import { userSecrets, workspaceSecrets } from '@/lib/db/secrets-schema'
import { openSecret, secretAad, SecretsKeyMissingError, userSecretAad } from './crypto'
import { byoE2BKeyEnabled, workspaceSecretsConfigured, E2BKeyError } from './flag'
import { isReservedEnvName, repositoryRef } from './format'
import type { SecretAuditHook } from './store'
import { createSecretMasker, identityMasker, maskDeep, withCredentialMasking, type Masker } from './mask'
import { effectiveSecretDelivery, type SecretDelivery } from './delivery'

// The settings store (and its workspace-access chain) loads only when the encryption key is configured and a query runs.
const guardSecretsDb: typeof import('./store').guardSecretsDb = async (work, onUnique) => (await import('./store')).guardSecretsDb(work, onUnique)

type Env = Record<string, string | undefined>
export interface RuntimeSecret { id?: string; name: string; kind: 'secret' | 'env'; value: string; delivery?: SecretDelivery; revision?: string }

type SecretRevisionRow = Pick<typeof userSecrets.$inferSelect, 'id' | 'name' | 'kind' | 'ciphertext' | 'iv' | 'keyVersion' | 'delivery'> & { scopeType?: string; scopeRef?: string }
/** Note edits do not revoke a grant. Re-sealing, scope and delivery changes do. */
export function secretRevision(row: SecretRevisionRow): string {
  return createHash('sha256').update(JSON.stringify([row.id, row.name, row.kind, row.scopeType ?? null,
    row.scopeRef ?? null, row.ciphertext, row.iv, row.keyVersion, effectiveSecretDelivery(row.delivery)])).digest('hex')
}

function snapshotOf(secrets: Array<{ name: string; revision?: string }>): string {
  return createHash('sha256').update(JSON.stringify(secrets.map(secret => [secret.name, secret.revision])
    .sort((a, b) => a[0]!.localeCompare(b[0]!)))).digest('hex')
}

/** Metadata only, in the caller's claim/renewal transaction. No plaintext is
 * opened and no data-plane request calls this function. */
export async function taskSecretMetadata(workspaceId: string | null, repository: string | null, ownerId: string,
  query: Pick<typeof db, 'select'> = db, names?: readonly string[]): Promise<Array<{ id: string; name: string; kind: 'secret' | 'env'; revision: string; delivery: SecretDelivery }>> {
  if (names && !names.length) return []
  const scope = repository
    ? or(eq(workspaceSecrets.scopeType, 'workspace'), and(eq(workspaceSecrets.scopeType, 'repository'), eq(workspaceSecrets.scopeRef, repository.toLowerCase())))
    : eq(workspaceSecrets.scopeType, 'workspace')
  const shared = workspaceId ? await query.select({ id: workspaceSecrets.id, name: workspaceSecrets.name, kind: workspaceSecrets.kind,
    ciphertext: workspaceSecrets.ciphertext, iv: workspaceSecrets.iv, keyVersion: workspaceSecrets.keyVersion, delivery: workspaceSecrets.delivery,
    scopeType: workspaceSecrets.scopeType, scopeRef: workspaceSecrets.scopeRef }).from(workspaceSecrets)
    .where(and(eq(workspaceSecrets.workspaceId, workspaceId), scope, names ? inArray(workspaceSecrets.name, [...names]) : undefined)) : []
  const own = await query.select({ id: userSecrets.id, name: userSecrets.name, kind: userSecrets.kind, ciphertext: userSecrets.ciphertext,
    iv: userSecrets.iv, keyVersion: userSecrets.keyVersion, delivery: userSecrets.delivery }).from(userSecrets)
    .where(and(eq(userSecrets.userId, ownerId), names ? inArray(userSecrets.name, [...names]) : undefined))
  const effective = new Map<string, typeof shared[number] | typeof own[number]>()
  for (const row of [...shared].sort((a, b) => Number(a.scopeType === 'repository') - Number(b.scopeType === 'repository'))) effective.set(row.name, row)
  for (const row of own) effective.set(row.name, row)
  return [...effective.values()].map(row => ({ id: row.id, name: row.name, kind: row.kind,
    revision: secretRevision(row), delivery: effectiveSecretDelivery(row.delivery) }))
}

export async function taskSecretSnapshot(workspaceId: string | null, repository: string | null, ownerId: string,
  query: Pick<typeof db, 'select'> = db): Promise<string> {
  return snapshotOf(await taskSecretMetadata(workspaceId, repository, ownerId, query))
}

/** Workspace-scoped secrets and env vars, decrypted. Repository-scoped rows are not included. */
export async function loadWorkspaceRuntimeSecrets(workspaceId: string, env: Env = process.env): Promise<RuntimeSecret[]> {
  const rows = await guardSecretsDb(() => db.select().from(workspaceSecrets).where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.scopeType, 'workspace'))))
  return rows.map(row => {
    try { return { id: row.id, name: row.name, kind: row.kind, value: openSecret(row, secretAad(row), env), delivery: effectiveSecretDelivery(row.delivery), revision: secretRevision(row) } } catch (error) {
      if (error instanceof SecretsKeyMissingError) throw new E2BKeyError('e2b_unavailable', 'secrets key missing')
      console.error(`workspace secret ${row.id} failed to decrypt`)
      throw new E2BKeyError('e2b_unavailable', 'workspace secret unavailable')
    }
  })
}

/**
 * Defense in depth at the injection point (#436 reserves the names at create time). A reserved name that
 * still reaches injection (a row from before the rule, or a name added to the list later) is skipped and
 * audited with its NAME only, never the value.
 */
export async function reservedInjectionFilter(workspaceId: string, secrets: RuntimeSecret[], skipped?: { actorId: string; audit: SecretAuditHook }): Promise<Record<string, string>> {
  const reserved = secrets.filter(s => isReservedEnvName(s.name))
  if (reserved.length) {
    console.warn(`workspace ${workspaceId}: skipped reserved variables at injection: ${reserved.map(s => s.name).join(', ')}`)
    if (skipped) await db.transaction(async tx => {
      for (const s of reserved) await skipped.audit(tx, { workspaceId, actorId: skipped.actorId, action: 'secret.injection_skipped', target: { type: s.kind, id: s.id ?? s.name, label: s.name }, metadata: { reason: 'reserved_name' } })
    })
  }
  return Object.fromEntries(secrets.filter(s => !isReservedEnvName(s.name)).map(s => [s.name, s.value]))
}

function openRuntime(row: typeof workspaceSecrets.$inferSelect, env: Env): RuntimeSecret {
  try { return { id: row.id, name: row.name, kind: row.kind, value: openSecret(row, secretAad(row), env), delivery: effectiveSecretDelivery(row.delivery), revision: secretRevision(row) } } catch (error) {
    if (error instanceof SecretsKeyMissingError) throw new E2BKeyError('e2b_unavailable', 'secrets key missing')
    console.error(`workspace secret ${row.id} failed to decrypt`)
    throw new E2BKeyError('e2b_unavailable', 'workspace secret unavailable')
  }
}

/**
 * owner/repo of a run's GitHub remote, normalized like #436's repositoryRef (lowercase). Null for
 * anything that is not a github.com remote, so a lookalike host can never match a repo-scoped secret.
 */
export function remoteRepositoryRef(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) return null
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(remoteUrl.trim())
  if (!match) return null
  const parsed = repositoryRef.safeParse(`${match[1]}/${match[2]}`)
  return parsed.success ? parsed.data : null
}

/**
 * 4e3: the explicit user variable set for one task. Workspace-scoped rows plus the repository-scoped rows
 * of exactly the task's linked repo (lowercase compare); on a name clash the repository value wins.
 * No environment dimension (like Codex cloud environments): every value of the scope reaches the task.
 */
/**
 * A person's own secrets, decrypted (user_secrets; decision 2026-11-02-2120). Only ever loaded for
 * the owner of the run or Bot they are injected into.
 */
export async function loadUserRuntimeSecrets(ownerId: string, env: Env = process.env): Promise<RuntimeSecret[]> {
  const rows = await guardSecretsDb(() => db.select().from(userSecrets).where(eq(userSecrets.userId, ownerId)))
  return rows.map(row => {
    try { return { id: row.id, name: row.name, kind: row.kind, value: openSecret(row, userSecretAad(row), env), delivery: effectiveSecretDelivery(row.delivery), revision: secretRevision(row) } } catch (error) {
      if (error instanceof SecretsKeyMissingError) throw new E2BKeyError('e2b_unavailable', 'secrets key missing')
      console.error(`user secret ${row.id} failed to decrypt`)
      throw new E2BKeyError('e2b_unavailable', 'user secret unavailable')
    }
  })
}

export async function loadTaskRuntimeSecrets(workspaceId: string | null, repository: string | null, env: Env = process.env, ownerId?: string | null): Promise<RuntimeSecret[]> {
  const repo = repository?.toLowerCase() ?? null
  const scope = repo
    ? or(eq(workspaceSecrets.scopeType, 'workspace'), and(eq(workspaceSecrets.scopeType, 'repository'), eq(workspaceSecrets.scopeRef, repo)))
    : eq(workspaceSecrets.scopeType, 'workspace')
  const rows = workspaceId ? await guardSecretsDb(() => db.select().from(workspaceSecrets).where(and(eq(workspaceSecrets.workspaceId, workspaceId), scope))) : []
  const rank = (row: typeof rows[number]) => row.scopeType === 'repository' ? 1 : 0
  const merged = new Map<string, RuntimeSecret>()
  for (const row of [...rows].sort((a, b) => rank(a) - rank(b))) merged.set(row.name, openRuntime(row, env))
  // The run owner's own secrets win over workspace and repository values of the same name.
  if (ownerId) for (const secret of await loadUserRuntimeSecrets(ownerId, env)) merged.set(secret.name, secret)
  return [...merged.values()]
}

/**
 * Ordinary env and explicitly approved direct values only. Protected values
 * stay in server memory until sealed for this exact run; the snapshot fences
 * concurrent changes before any claim bytes leave the server.
 */
export interface TaskSecretInjection {
  env: Record<string, string>
  secretNames: string[]
  /** Server memory only. The claim must encrypt these, never spread them into its response. */
  protectedSecrets: RuntimeSecret[]
  unavailable: string[]
  snapshot?: string
}

export async function taskSecretInjection(workspaceId: string | null, repository: string | null, env: Env = process.env, skipped?: { actorId: string; audit: SecretAuditHook }, ownerId?: string | null): Promise<TaskSecretInjection> {
  if (!workspaceSecretsConfigured(env)) return { env: {}, secretNames: [], protectedSecrets: [], unavailable: [] }
  const secrets = await loadTaskRuntimeSecrets(workspaceId, repository, env, ownerId)
  const direct = secrets.filter(secret => secret.kind === 'env' || effectiveSecretDelivery(secret.delivery).mode === 'direct')
  const injected = await reservedInjectionFilter(workspaceId ?? 'personal', direct, workspaceId ? skipped : undefined)
  const protectedSecrets = secrets.filter(secret => secret.kind === 'secret' && effectiveSecretDelivery(secret.delivery).mode === 'protected' && !isReservedEnvName(secret.name))
  return { env: injected, secretNames: direct.filter(secret => secret.kind === 'secret' && Object.hasOwn(injected, secret.name)).map(secret => secret.name), snapshot: snapshotOf(secrets),
    protectedSecrets: protectedSecrets.filter(secret => effectiveSecretDelivery(secret.delivery).mode === 'protected' && secret.delivery?.mode === 'protected' && secret.delivery.http),
    unavailable: protectedSecrets.filter(secret => secret.delivery?.mode !== 'protected' || !secret.delivery.http).map(secret => secret.name) }
}

/** Task env (NAME -> value) only; see taskSecretInjection. */
export async function taskSecretEnv(workspaceId: string, repository: string | null, env: Env = process.env, skipped?: { actorId: string; audit: SecretAuditHook }): Promise<Record<string, string>> {
  return (await taskSecretInjection(workspaceId, repository, env, skipped)).env
}

/** #438 C: E2B keys are masked like secrets: every member's own key (keys are personal). */
async function workspaceE2BKeySecret(workspaceId: string, env: Env): Promise<{ name: string; value: string }[]> {
  if (!byoE2BKeyEnabled(env)) return []
  return (await (await import('./e2b')).maskableE2BKeys(workspaceId, env)).map(value => ({ name: 'E2B_API_KEY', value }))
}

/** Masker for persisted output: saved secrets (none without an encryption key) plus credential patterns. Env vars (kind='env') are not masked: they are plain config shown in settings. */
export async function workspaceSecretMasker(workspaceId: string | null | undefined, env: Env = process.env): Promise<Masker> {
  // Credential patterns (GitHub tokens, JWTs) are masked even with no saved secret or no key.
  if (!workspaceId || !workspaceSecretsConfigured(env)) return withCredentialMasking(identityMasker)
  // 4e3: every secret a task of this workspace can receive, including all repository-scoped ones.
  const rows = await guardSecretsDb(() => db.select().from(workspaceSecrets).where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.kind, 'secret'))))
  const e2bKey = await workspaceE2BKeySecret(workspaceId, env)
  return withCredentialMasking(createSecretMasker([...rows.map(row => openRuntime(row, env)), ...e2bKey]))
}

/**
 * Masker for output a person's run or Bot produces: the workspace's secrets plus that person's own
 * (kind 'secret' only; env stays readable). Use it wherever the output's owner is known.
 */
export async function secretMaskerFor(target: { workspaceId: string | null | undefined; ownerId?: string | null }, env: Env = process.env): Promise<Masker> {
  if (!target.ownerId || !workspaceSecretsConfigured(env)) return workspaceSecretMasker(target.workspaceId, env)
  const rows = target.workspaceId ? await guardSecretsDb(() => db.select().from(workspaceSecrets).where(and(eq(workspaceSecrets.workspaceId, target.workspaceId!), eq(workspaceSecrets.kind, 'secret')))) : []
  const e2bKey = target.workspaceId ? await workspaceE2BKeySecret(target.workspaceId, env) : []
  const own = (await loadUserRuntimeSecrets(target.ownerId, env)).filter(secret => secret.kind === 'secret')
  return withCredentialMasking(createSecretMasker([...rows.map(row => openRuntime(row, env)), ...e2bKey, ...own]))
}
/** maskDeep(value) with secretMaskerFor(target). */
export async function maskFor<T>(target: { workspaceId: string | null | undefined; ownerId?: string | null }, value: T, env: Env = process.env): Promise<T> {
  return maskDeep(value, await secretMaskerFor(target, env))
}

/** Output masking follows the persisted Task/Run tenant, including Personal
 * workspaces and retained history. A device token cannot reattribute a run. */
export async function runWorkspaceId(runId: string): Promise<string | null> {
  const { rows } = await guardSecretsDb(async () => (await import('@/lib/db')).pool.query<{ workspaceId: string | null }>(
    'SELECT "workspaceId" FROM agent_runs WHERE id=$1 LIMIT 1', [runId]))
  return rows[0]?.workspaceId ?? null
}

/** Masker for output persisted on behalf of a run (MCP worker tools). Same secret set as the run's sandbox. */
export async function runSecretMasker(runId: string, env: Env = process.env): Promise<Masker> {
  if (!workspaceSecretsConfigured(env)) return withCredentialMasking(identityMasker)
  const { rows: [run] } = await guardSecretsDb(async () => (await import('@/lib/db')).pool.query<{ userId: string }>('SELECT "userId" FROM agent_runs WHERE id=$1', [runId]))
  return secretMaskerFor({ workspaceId: await runWorkspaceId(runId), ownerId: run?.userId ?? null }, env)
}

/** maskDeep(value) with the workspace's masker. */
export async function maskForWorkspace<T>(workspaceId: string | null | undefined, value: T, env: Env = process.env): Promise<T> {
  return maskDeep(value, await workspaceSecretMasker(workspaceId, env))
}
/** maskDeep(value) with the run's masker. */
export async function maskForRun<T>(runId: string, value: T, env: Env = process.env): Promise<T> {
  return maskDeep(value, await runSecretMasker(runId, env))
}
