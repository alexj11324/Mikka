import 'server-only'
// 4e2: workspace secrets at sandbox runtime. Everything here is gated by MIKKA_BYO_E2B_KEY
// (off by default; turning it on needs Alex). Flag off = no injection, no masking, today's behaviour.
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { workspaceSecrets } from '@/lib/db/secrets-schema'
import { openSecret, secretAad, SecretsKeyMissingError } from './crypto'
import { byoE2BKeyEnabled, E2BKeyError } from './e2b'
import { createSecretMasker, identityMasker, type Masker } from './mask'

type Env = Record<string, string | undefined>
export interface RuntimeSecret { name: string; kind: 'secret' | 'env'; value: string }

/** Workspace-scoped secrets and env vars, decrypted. Repository-scoped rows are not included yet. */
export async function loadWorkspaceRuntimeSecrets(workspaceId: string, env: Env = process.env): Promise<RuntimeSecret[]> {
  const rows = await db.select().from(workspaceSecrets).where(and(eq(workspaceSecrets.workspaceId, workspaceId), eq(workspaceSecrets.scopeType, 'workspace')))
  try { return rows.map(row => ({ name: row.name, kind: row.kind, value: openSecret(row, secretAad(row), env) })) } catch (error) {
    if (error instanceof SecretsKeyMissingError) throw new E2BKeyError('e2b_unavailable', 'secrets key missing')
    throw error
  }
}

/** Env for the sandbox worker process: NAME=value for every workspace secret / env var. {} when the flag is off. */
export async function sandboxSecretEnv(workspaceId: string, env: Env = process.env): Promise<Record<string, string>> {
  if (!byoE2BKeyEnabled(env)) return {}
  return Object.fromEntries((await loadWorkspaceRuntimeSecrets(workspaceId, env)).map(s => [s.name, s.value]))
}

/** Masker for persisted output. Identity when the flag is off or the workspace has no maskable secret. Env vars (kind='env') are not masked: they are plain config shown in settings. */
export async function workspaceSecretMasker(workspaceId: string | null | undefined, env: Env = process.env): Promise<Masker> {
  if (!workspaceId || !byoE2BKeyEnabled(env)) return identityMasker
  return createSecretMasker((await loadWorkspaceRuntimeSecrets(workspaceId, env)).filter(s => s.kind === 'secret'))
}
