import 'server-only'
// Workspace-added API-key models (an OpenAI-compatible endpoint + key, e.g.
// DeepSeek). A model added here can run any bot, the Coordinator included,
// through the normal model menu/choice/freeze plumbing. The key is sealed
// (AES-256-GCM) in workspace_api_key_credentials and read back in exactly one
// authorized place at run time; byos_connections / byos_bindings carry only
// non-secret metadata, so nothing here changes the subscription credential path.
import { createHash, randomUUID } from 'node:crypto'
import { pool } from '@/lib/db'
import { WorkspaceError } from '@/lib/workspace-access'
import { apiKeyModelAad, openSecret, sealSecret, SecretsKeyMissingError } from './crypto'
import { apiKeyModelInput } from './format'
import { workspaceRole } from './store'

const ROUTE = 'api_key'
const PROVIDER = 'apiKey'
const KIND = 'openai'

export interface ApiKeyModelView { connectionId: string; baseURL: string; last4: string | null; models: string[]; createdAt: string }
export type ApiKeyVerifyResult = { ok: true } | { ok: false; code: 'invalid' | 'unreachable' }

/** Read-only check that the endpoint answers for this key: GET {baseURL}/models. Creates nothing. */
export async function verifyApiKeyModel(baseURL: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<ApiKeyVerifyResult> {
  try {
    const response = await fetchImpl(`${baseURL.replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000), cache: 'no-store', redirect: 'error',
    })
    if (response.ok) { await response.body?.cancel(); return { ok: true } }
    await response.body?.cancel()
    return { ok: false, code: response.status === 401 || response.status === 403 ? 'invalid' : 'unreachable' }
  } catch { return { ok: false, code: 'unreachable' } }
}

async function requireAdmin(userId: string, workspaceId: string) {
  if (await workspaceRole(userId, workspaceId) !== 'admin') throw new WorkspaceError('workspaceAccessDenied')
}

/**
 * Adds (or appends models to) an API-key model for the workspace, after a live
 * endpoint check. Admin only. The key is sealed before the endpoint is called
 * and the sealed value is all that reaches the database.
 */
export async function setWorkspaceApiKeyModel(
  userId: string,
  workspaceId: string,
  input: unknown,
  options: { verify?: (baseURL: string, apiKey: string) => Promise<ApiKeyVerifyResult> } = {},
): Promise<ApiKeyModelView> {
  await requireAdmin(userId, workspaceId)
  const { baseURL, apiKey, models } = apiKeyModelInput.parse(input)
  const connectionId = randomUUID()
  let sealed: ReturnType<typeof sealSecret>
  try { sealed = sealSecret(apiKey, apiKeyModelAad(connectionId, workspaceId)) } // fail closed before any network call
  catch (error) { if (error instanceof SecretsKeyMissingError) throw new WorkspaceError('secretsUnavailable'); throw error }
  const result = await (options.verify ?? verifyApiKeyModel)(baseURL, apiKey)
  if (!result.ok) throw new WorkspaceError(result.code === 'invalid' ? 'apiKeyModelInvalid' : 'apiKeyModelUnreachable')
  const uniqueModels = [...new Set(models)]
  const secretName = `apikey:${connectionId}`
  const secretDigest = createHash('sha256').update(secretName).digest('hex')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,"secretName","secretDigest","providerSubject")
       VALUES ($1,$2,$3,$4,'connected',$5,$6,$1::text)`,
      [connectionId, userId, workspaceId, PROVIDER, secretName, secretDigest],
    )
    await client.query(
      `INSERT INTO workspace_api_key_credentials ("connectionId","workspaceId",kind,"baseURL",ciphertext,iv,"keyVersion",last4,"createdBy")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [connectionId, workspaceId, KIND, baseURL, sealed.ciphertext, sealed.iv, sealed.keyVersion, apiKey.slice(-4), userId],
    )
    for (const modelId of uniqueModels) {
      const bindingId = randomUUID()
      await client.query(
        `INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId")
         VALUES ($1,$2,$3,$1::text,$4,1,$5,$6)`,
        [bindingId, userId, workspaceId, connectionId, ROUTE, modelId],
      )
    }
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  return { connectionId, baseURL, last4: apiKey.slice(-4), models: uniqueModels, createdAt: new Date().toISOString() }
}

/** Metadata only; the key is never returned. */
export async function listWorkspaceApiKeyModels(userId: string, workspaceId: string): Promise<ApiKeyModelView[]> {
  await requireAdmin(userId, workspaceId)
  const { rows } = await pool.query(
    `SELECT c."connectionId",c."baseURL",c.last4,c."createdAt",
            coalesce((SELECT json_agg(b."modelId" ORDER BY b."createdAt") FROM byos_bindings b
                      WHERE b."connectionId"=c."connectionId" AND b."consumerId"=c."connectionId"::text),'[]') AS models
     FROM workspace_api_key_credentials c
     JOIN byos_connections n ON n.id=c."connectionId" AND n.state='connected'
     WHERE c."workspaceId"=$1 ORDER BY c."createdAt" DESC`,
    [workspaceId],
  )
  return rows.map(row => ({ connectionId: row.connectionId, baseURL: row.baseURL, last4: row.last4, models: row.models ?? [], createdAt: new Date(row.createdAt).toISOString() }))
}

/** Admin-only delete; cascades to this connection's bindings and credential. */
export async function removeWorkspaceApiKeyModel(userId: string, workspaceId: string, connectionId: string): Promise<{ removed: boolean }> {
  await requireAdmin(userId, workspaceId)
  const gone = await pool.query(
    `DELETE FROM byos_connections WHERE id=$1 AND "workspaceId"=$2 AND provider=$3 RETURNING id`,
    [connectionId, workspaceId, PROVIDER],
  )
  return { removed: Boolean(gone.rowCount) }
}

/**
 * The one authorized read of a workspace API-key model's credential, for the
 * model builder at run time. Returns the endpoint and the key; never logs it.
 */
export async function getWorkspaceApiKeyCredential(
  connectionId: string,
  workspaceId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{ baseURL: string; kind: string; apiKey: string }> {
  const { rows } = await pool.query(
    `SELECT c."baseURL",c.kind,c.ciphertext,c.iv,c."keyVersion"
     FROM workspace_api_key_credentials c JOIN byos_connections n ON n.id=c."connectionId" AND n.state='connected'
     WHERE c."connectionId"=$1 AND c."workspaceId"=$2`,
    [connectionId, workspaceId],
  )
  const row = rows[0]
  if (!row) throw new WorkspaceError('apiKeyModelMissing')
  try {
    const apiKey = openSecret({ ciphertext: row.ciphertext, iv: row.iv, keyVersion: row.keyVersion }, apiKeyModelAad(connectionId, workspaceId), env)
    return { baseURL: row.baseURL, kind: row.kind, apiKey }
  } catch (error) {
    if (error instanceof SecretsKeyMissingError) throw new WorkspaceError('secretsUnavailable')
    throw new WorkspaceError('apiKeyModelUnreadable')
  }
}
