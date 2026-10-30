import 'server-only'
// 4e2: workspace secrets at sandbox runtime. Everything here is gated by MIKKA_BYO_E2B_KEY
// (off by default; turning it on needs Alex). Flag off = no injection, no masking, today's behaviour.
import { and, eq, inArray, or } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { workspaceSecrets } from '@/lib/db/secrets-schema'
import { openSecret, secretAad, SecretsKeyMissingError } from './crypto'
import { byoE2BKeyEnabled, E2BKeyError } from './e2b'
import { guardSecretsDb } from './store'
import { repositoryRef } from './format'
import { createSecretMasker, identityMasker, maskDeep, type Masker } from './mask'

type Env = Record<string, string | undefined>
export interface RuntimeSecret { name: string; kind: 'secret' | 'env'; value: string }

/** Sandboxes run as production: only environment 'all' and 'production' are injected (preview/development never). */
export const RUNTIME_ENVIRONMENTS = ['all', 'production'] as const

/** Workspace-scoped secrets and env vars for environment all/production, decrypted. Repository-scoped rows are not included yet. */
export async function loadWorkspaceRuntimeSecrets(workspaceId: string, env: Env = process.env): Promise<RuntimeSecret[]> {
  const rows = await guardSecretsDb(() => db.select().from(workspaceSecrets).where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.scopeType, 'workspace'), inArray(workspaceSecrets.environment, [...RUNTIME_ENVIRONMENTS]))))
  return rows.map(row => {
    try { return { name: row.name, kind: row.kind, value: openSecret(row, secretAad(row), env) } } catch (error) {
      if (error instanceof SecretsKeyMissingError) throw new E2BKeyError('e2b_unavailable', 'secrets key missing')
      console.error(`workspace secret ${row.id} failed to decrypt`)
      throw new E2BKeyError('e2b_unavailable', 'workspace secret unavailable')
    }
  })
}

function openRuntime(row: typeof workspaceSecrets.$inferSelect, env: Env): string {
  try { return openSecret(row, secretAad(row), env) } catch (error) {
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
 * of exactly the task's repo (lowercase compare); on a name clash the repository value wins. Environment
 * all/production only. Nothing else (no worker env) reaches the task.
 */
export async function loadTaskRuntimeSecrets(workspaceId: string, repository: string | null, env: Env = process.env): Promise<RuntimeSecret[]> {
  const repo = repository?.toLowerCase() ?? null
  const scope = repo
    ? or(eq(workspaceSecrets.scopeType, 'workspace'), and(eq(workspaceSecrets.scopeType, 'repository'), eq(workspaceSecrets.scopeRef, repo)))
    : eq(workspaceSecrets.scopeType, 'workspace')
  const rows = await guardSecretsDb(() => db.select().from(workspaceSecrets).where(and(eq(workspaceSecrets.workspaceId, workspaceId), scope, inArray(workspaceSecrets.environment, [...RUNTIME_ENVIRONMENTS]))))
  const merged = new Map<string, RuntimeSecret>()
  // workspace first, then repository so it overrides; 'production' after 'all' so the specific environment wins.
  const rank = (row: typeof rows[number]) => (row.scopeType === 'repository' ? 2 : 0) + (row.environment === 'production' ? 1 : 0)
  for (const row of [...rows].sort((a, b) => rank(a) - rank(b))) merged.set(row.name, { name: row.name, kind: row.kind, value: openRuntime(row, env) })
  return [...merged.values()]
}

/** Task env (NAME -> value) for the claim response. {} when the flag is off. */
export async function taskSecretEnv(workspaceId: string, repository: string | null, env: Env = process.env): Promise<Record<string, string>> {
  if (!byoE2BKeyEnabled(env)) return {}
  return Object.fromEntries((await loadTaskRuntimeSecrets(workspaceId, repository, env)).map(s => [s.name, s.value]))
}

/** Masker for persisted output. Identity when the flag is off or the workspace has no maskable secret. Env vars (kind='env') are not masked: they are plain config shown in settings. */
export async function workspaceSecretMasker(workspaceId: string | null | undefined, env: Env = process.env): Promise<Masker> {
  if (!workspaceId || !byoE2BKeyEnabled(env)) return identityMasker
  // Every secret a task of this workspace can receive, including all repository-scoped ones (4e3).
  const rows = await guardSecretsDb(() => db.select().from(workspaceSecrets).where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.kind, 'secret'), inArray(workspaceSecrets.environment, [...RUNTIME_ENVIRONMENTS]))))
  return createSecretMasker(rows.map(row => ({ name: row.name, kind: row.kind, value: openRuntime(row, env) })))
}

/** Workspace whose secrets a run's sandbox received: the workspace its cloud device token is bound to. Null for local devices (nothing injected, nothing to mask). */
export async function runWorkspaceId(runId: string): Promise<string | null> {
  const { rows } = await guardSecretsDb(() => pool.query<{ workspaceId: string }>(
    'SELECT t."boundWorkspaceId" AS "workspaceId" FROM agent_runs r JOIN device_tokens t ON t."boundDeviceId"=r."deviceId" WHERE r.id=$1 AND t."boundWorkspaceId" IS NOT NULL ORDER BY t."createdAt" DESC LIMIT 1', [runId]))
  return rows[0]?.workspaceId ?? null
}

/** Masker for output persisted on behalf of a run (MCP worker tools). Same secret set as the run's sandbox. */
export async function runSecretMasker(runId: string, env: Env = process.env): Promise<Masker> {
  if (!byoE2BKeyEnabled(env)) return identityMasker
  return workspaceSecretMasker(await runWorkspaceId(runId), env)
}

/** maskDeep(value) with the workspace's masker; identity (same reference) when the flag is off. */
export async function maskForWorkspace<T>(workspaceId: string | null | undefined, value: T, env: Env = process.env): Promise<T> {
  return maskDeep(value, await workspaceSecretMasker(workspaceId, env))
}
/** maskDeep(value) with the run's masker. */
export async function maskForRun<T>(runId: string, value: T, env: Env = process.env): Promise<T> {
  return maskDeep(value, await runSecretMasker(runId, env))
}
