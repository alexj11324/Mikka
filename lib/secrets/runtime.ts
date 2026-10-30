import 'server-only'
// 4e2: workspace secrets at sandbox runtime. Everything here is gated by MIKKA_BYO_E2B_KEY
// (off by default; turning it on needs Alex). Flag off = no injection, no masking, today's behaviour.
import { and, eq, inArray } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { workspaceSecrets } from '@/lib/db/secrets-schema'
import { openSecret, secretAad, SecretsKeyMissingError } from './crypto'
import { byoE2BKeyEnabled, E2BKeyError, getWorkspaceE2BApiKey } from './e2b'
import { isReservedEnvName } from './format'
import { guardSecretsDb, type SecretAuditHook } from './store'
import { createSecretMasker, identityMasker, maskDeep, type Masker } from './mask'

type Env = Record<string, string | undefined>
export interface RuntimeSecret { id?: string; name: string; kind: 'secret' | 'env'; value: string }

/** Sandboxes run as production: only environment 'all' and 'production' are injected (preview/development never). */
export const RUNTIME_ENVIRONMENTS = ['all', 'production'] as const

/** Workspace-scoped secrets and env vars for environment all/production, decrypted. Repository-scoped rows are not included yet. */
export async function loadWorkspaceRuntimeSecrets(workspaceId: string, env: Env = process.env): Promise<RuntimeSecret[]> {
  const rows = await guardSecretsDb(() => db.select().from(workspaceSecrets).where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.scopeType, 'workspace'), inArray(workspaceSecrets.environment, [...RUNTIME_ENVIRONMENTS]))))
  return rows.map(row => {
    try { return { id: row.id, name: row.name, kind: row.kind, value: openSecret(row, secretAad(row), env) } } catch (error) {
      if (error instanceof SecretsKeyMissingError) throw new E2BKeyError('e2b_unavailable', 'secrets key missing')
      console.error(`workspace secret ${row.id} failed to decrypt`)
      throw new E2BKeyError('e2b_unavailable', 'workspace secret unavailable')
    }
  })
}

/** Env for the sandbox worker process: NAME=value for every workspace secret / env var. {} when the flag is off.
 * #438 B: reserved names (PATH, NODE_OPTIONS, E2B_*, MIKKA_*…, lib/secrets/format.ts) are never injected, even if a row predates the create-time check. */
export async function sandboxSecretEnv(workspaceId: string, env: Env = process.env, skipped?: { actorId: string; audit: SecretAuditHook }): Promise<Record<string, string>> {
  if (!byoE2BKeyEnabled(env)) return {}
  return reservedInjectionFilter(workspaceId, await loadWorkspaceRuntimeSecrets(workspaceId, env), skipped)
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

/** #438 C: the workspace's own E2B key is masked like a secret. Absent key = nothing to add. */
async function workspaceE2BKeySecret(workspaceId: string, env: Env): Promise<{ name: string; value: string }[]> {
  try { return [{ name: 'E2B_API_KEY', value: await getWorkspaceE2BApiKey(workspaceId, env) }] } catch (error) {
    if (error instanceof E2BKeyError && error.code === 'e2b_key_missing') return []
    throw error
  }
}

/** Masker for persisted output. Identity when the flag is off or the workspace has no maskable secret. Env vars (kind='env') are not masked: they are plain config shown in settings. */
export async function workspaceSecretMasker(workspaceId: string | null | undefined, env: Env = process.env): Promise<Masker> {
  if (!workspaceId || !byoE2BKeyEnabled(env)) return identityMasker
  const [secrets, e2bKey] = await Promise.all([loadWorkspaceRuntimeSecrets(workspaceId, env), workspaceE2BKeySecret(workspaceId, env)])
  return createSecretMasker([...secrets.filter(s => s.kind === 'secret'), ...e2bKey])
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
