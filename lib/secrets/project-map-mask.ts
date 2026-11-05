import 'server-only'
import type { userSecrets, workspaceSecrets } from '@/lib/db/secrets-schema'
import { e2bKeyAad, openSecret, secretAad, SecretsKeyMissingError, userE2bKeyAad, userSecretAad, type Sealed } from './crypto'
import { byoE2BKeyEnabled, E2BKeyError, workspaceSecretsConfigured } from './flag'
import { createSecretMasker, identityMasker, maskDeep, withCredentialMasking, type MaskableSecret } from './mask'

type Env = Record<string, string | undefined>
type WorkspaceMaterial = Pick<typeof workspaceSecrets.$inferSelect, 'id' | 'workspaceId' | 'name' | 'kind' | 'scopeType' | 'scopeRef'> & Sealed
type OwnerMaterial = Pick<typeof userSecrets.$inferSelect, 'id' | 'userId' | 'name' | 'kind'> & Sealed
type Materials = {
  workspaceSecrets: WorkspaceMaterial[]; ownerSecrets: OwnerMaterial[]
  memberKeys: (Sealed & { userId: string })[]; legacyKeys: (Sealed & { workspaceId: string })[]
}

function requiredSecret(row: WorkspaceMaterial | OwnerMaterial, aad: string, scope: 'workspace' | 'user', env: Env): MaskableSecret {
  try { return { name: row.name, value: openSecret(row, aad, env) } } catch (error) {
    if (error instanceof SecretsKeyMissingError) {
      // error-cause: retain the existing sanitized crypto boundary; storage details must not enter map error causes.
      throw new E2BKeyError('e2b_unavailable', 'secrets key missing')
    }
    console.error(`${scope} secret ${row.id} failed to decrypt`)
    // error-cause: raw crypto errors may contain storage details; maskFor exposes only this fixed failure.
    throw new E2BKeyError('e2b_unavailable', `${scope} secret unavailable`)
  }
}

/** Map GET only: the same material and masking policy as maskFor, in two reads.
 * Workspace membership stays on the workspace database. The four app-database
 * projections share one statement snapshot; no material survives this call or
 * enters MapFacts, its logical metadata allowance, or a response. */
export async function maskProjectMapFacts<T>(target: { workspaceId: string; ownerId: string }, value: T, env: Env = process.env): Promise<T> {
  if (!workspaceSecretsConfigured(env)) return maskDeep(value, withCredentialMasking(identityMasker))
  // Preserve the existing lazy settings-store boundary on unconfigured routes.
  const [{ pool }, { workspacePool }, { guardSecretsDb, logSecretFailure, SecretsStoreError }] = await Promise.all([
    import('@/lib/db'), import('@/lib/workspace-db'), import('./store'),
  ])
  const e2b = byoE2BKeyEnabled(env)
  const members = e2b ? (await guardSecretsDb(() => workspacePool.query<{ userId: string }>(
    `SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId"=$1 AND status='active'`, [target.workspaceId],
  ))).rows.map(row => row.userId) : []
  const { rows: [materials] } = await guardSecretsDb(() => pool.query<Materials>(`WITH
    workspace_material AS MATERIALIZED (
      SELECT id,"workspaceId",name,kind,"scopeType","scopeRef",ciphertext,iv,"keyVersion"
      FROM workspace_secrets WHERE "workspaceId"=$1 AND kind='secret'
    ), owner_material AS MATERIALIZED (
      SELECT id,"userId",name,kind,ciphertext,iv,"keyVersion" FROM user_secrets WHERE "userId"=$2
    ), member_material AS MATERIALIZED (
      SELECT "userId",ciphertext,iv,"keyVersion" FROM user_e2b_keys WHERE "userId"=ANY($3::text[]) AND $4::boolean
    ), legacy_material AS MATERIALIZED (
      SELECT "workspaceId",ciphertext,iv,"keyVersion" FROM workspace_e2b_keys WHERE "workspaceId"=$1 AND $4::boolean
    ) SELECT
      COALESCE((SELECT jsonb_agg(workspace_material) FROM workspace_material),'[]'::jsonb) AS "workspaceSecrets",
      COALESCE((SELECT jsonb_agg(owner_material) FROM owner_material),'[]'::jsonb) AS "ownerSecrets",
      COALESCE((SELECT jsonb_agg(member_material) FROM member_material),'[]'::jsonb) AS "memberKeys",
      COALESCE((SELECT jsonb_agg(legacy_material) FROM legacy_material),'[]'::jsonb) AS "legacyKeys"`,
  [target.workspaceId, target.ownerId, members, e2b]))
  if (!materials) throw new SecretsStoreError()
  const keys: MaskableSecret[] = []
  // As in maskableE2BKeys, a damaged E2B key is logged by id and skipped; this
  // read neither adopts legacy keys nor exposes a member's key to a caller.
  for (const row of materials.memberKeys) {
    try { keys.push({ name: 'E2B_API_KEY', value: openSecret(row, userE2bKeyAad(row.userId), env) }) }
    catch { logSecretFailure('e2b_unavailable', row.userId) }
  }
  for (const row of materials.legacyKeys) {
    try { keys.push({ name: 'E2B_API_KEY', value: openSecret(row, e2bKeyAad(row.workspaceId), env) }) }
    catch { logSecretFailure('e2b_unavailable', row.workspaceId) }
  }
  // loadUserRuntimeSecrets decrypts all owner rows before excluding env rows.
  // Preserve its failure behavior even for a damaged plain-config ciphertext.
  const own = materials.ownerSecrets.map(row => ({ ...requiredSecret(row, userSecretAad(row), 'user', env), kind: row.kind }))
    .filter(row => row.kind === 'secret')
  const workspace = materials.workspaceSecrets.map(row => requiredSecret(row, secretAad(row), 'workspace', env))
  // First matching label wins for equal values: workspace, E2B, then owner.
  return maskDeep(value, withCredentialMasking(createSecretMasker([...workspace, ...keys, ...own])))
}
