import 'server-only'
import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { isPrivateAddress } from '@/lib/link-preview-parse'
import { memberSubscriptionsAllowed, subscriptionsUsable } from '@/lib/personal-policy'
import { stopRunsUsingApiKeys } from '@/lib/model-api-key-runs'
import { openSecret, sealSecret, SecretsKeyMissingError } from '@/lib/secrets/crypto'
import { WorkspaceError } from '@/lib/workspace-error'
import {
  API_KEY_PRESET_ENDPOINTS, API_KEY_PRESETS, apiKeyChatBaseUrl, apiKeyHarness, customModelsUrl,
  type ApiKeyProtocol, type ApiKeyProvider, type ApiKeyView,
} from '@/lib/model-api-key-providers'

/**
 * 「API 与订阅」 API keys and custom providers (orchestration.md § 1, § 2, § 6;
 * conflict C22). A key belongs to the account. It is checked against the
 * provider's read-only model list before it is saved, sealed with
 * WORKSPACE_SECRETS_KEY, and never returned: views carry its last four
 * characters only. Only `apiKeyForRun` opens it, for the run that uses it.
 */
type Query = Pick<Pool | PoolClient, 'query'>
type Env = Record<string, string | undefined>

const MAX_MODELS = 200
const MAX_BODY = 2 * 1024 * 1024
const modelId = z.string().trim().min(1).max(128)

export const addApiKeyInput = z.discriminatedUnion('provider', [
  z.strictObject({ provider: z.enum(API_KEY_PRESETS), apiKey: z.string().trim().min(8).max(512) }),
  z.strictObject({
    provider: z.literal('custom'),
    name: z.string().trim().min(1).max(60),
    baseUrl: z.string().trim().min(1).max(500),
    protocol: z.enum(['anthropic', 'openai']),
    apiKey: z.string().trim().min(8).max(512),
    models: z.array(modelId).max(MAX_MODELS).optional(),
  }),
])
export type AddApiKeyInput = z.infer<typeof addApiKeyInput>

export type ApiKeyVerifyResult = { ok: true; models: string[] } | { ok: false; code: 'invalid' | 'unavailable' }

/** Binds a ciphertext to its row and owner: copied onto another row it will not open. */
const keyAad = (id: string, ownerId: string) => ['model_api_key', id.toLowerCase(), ownerId].join('\u0000')

/**
 * A custom provider's base URL: https on a public address. Loopback http is
 * allowed only for the browser tests' local provider (MIKKA_MODEL_KEY_LOOPBACK,
 * set by playwright.config.ts), never on Vercel.
 */
export async function checkBaseUrl(raw: string, env: Env = process.env, resolve: (host: string) => Promise<string[]> = defaultResolve): Promise<string> {
  let url: URL
  try { url = new URL(raw) } catch { throw new WorkspaceError('apiKeyBaseUrlInvalid') }
  if (url.username || url.password || url.search || url.hash) throw new WorkspaceError('apiKeyBaseUrlInvalid')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const loopbackTest = env.MIKKA_MODEL_KEY_LOOPBACK === '1' && !env.VERCEL && !env.VERCEL_ENV
    && url.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost')
  if (loopbackTest) return url.href.replace(/\/+$/, '')
  if (url.protocol !== 'https:') throw new WorkspaceError('apiKeyBaseUrlInvalid')
  const addresses = isIP(host) ? [host] : await resolve(host)
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new WorkspaceError('apiKeyBaseUrlInvalid')
  return url.href.replace(/\/+$/, '')
}
const defaultResolve = (host: string) => lookup(host, { all: true }).then(rows => rows.map(row => row.address), () => [])

/** GET the provider's model list with the key. Reads nothing else, creates nothing, costs nothing. */
export async function verifyApiKey(target: { modelsUrl: string; auth: ApiKeyProtocol }, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<ApiKeyVerifyResult> {
  const headers: Record<string, string> = target.auth === 'anthropic'
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${apiKey}` }
  try {
    const response = await fetchImpl(target.modelsUrl, { headers: { ...headers, accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(10_000), cache: 'no-store' })
    if (response.status === 401 || response.status === 403) { void response.body?.cancel().catch(() => {}); return { ok: false, code: 'invalid' } }
    if (!response.ok) { void response.body?.cancel().catch(() => {}); return { ok: false, code: 'unavailable' } }
    const text = await response.text()
    if (text.length > MAX_BODY) return { ok: false, code: 'unavailable' }
    const body = JSON.parse(text) as { data?: unknown }
    if (!Array.isArray(body.data)) return { ok: false, code: 'unavailable' }
    const models = [...new Set(body.data.flatMap(item => {
      const id = item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined
      return typeof id === 'string' && modelId.safeParse(id).success ? [id.trim()] : []
    }))].slice(0, MAX_MODELS)
    return { ok: true, models }
  } catch { return { ok: false, code: 'unavailable' } }
}

interface Row { id: string; ownerId: string; provider: ApiKeyProvider; name: string | null; baseUrl: string | null; protocol: ApiKeyProtocol; last4: string; models: string[] }
const COLUMNS = 'id,"ownerId",provider,name,"baseUrl",protocol,last4,models'
const view = (row: Row): ApiKeyView => ({ id: row.id, provider: row.provider, name: row.name, baseUrl: row.baseUrl, protocol: row.protocol, last4: row.last4, models: row.models })

/** The page's list: the owner's keys, each with whether it is shared in this workspace. */
export interface ApiKeysPage {
  keys: (ApiKeyView & { shared: boolean })[]
  /** A team workspace where the admin allows members' credentials: the 分享给团队成员 switch shows. */
  canShare: boolean
  apiKeyAfterQuota: boolean
}

export async function listApiKeys(query: Query, ownerId: string, workspace: { id: string; kind: 'personal' | 'team' }): Promise<ApiKeysPage> {
  const [keys, shares, fallback, allowed] = await Promise.all([
    query.query<Row>(`SELECT ${COLUMNS} FROM model_api_keys WHERE "ownerId"=$1 ORDER BY "createdAt",id`, [ownerId]),
    query.query<{ keyId: string }>('SELECT s."keyId" FROM model_api_key_shares s JOIN model_api_keys k ON k.id=s."keyId" WHERE k."ownerId"=$1 AND s."workspaceId"=$2', [ownerId, workspace.id]),
    apiKeyAfterQuota(query, ownerId),
    workspace.kind === 'team' ? memberSubscriptionsAllowed(query, workspace.id) : Promise.resolve(false),
  ])
  const shared = new Set(shares.rows.map(row => row.keyId))
  return { keys: keys.rows.map(row => ({ ...view(row), shared: shared.has(row.id) })), canShare: allowed, apiKeyAfterQuota: fallback }
}

/**
 * Checks the key with the provider, then saves it sealed. A preset provider
 * has one key per person: adding another replaces it (its shares stay).
 * Errors: apiKeyInvalid (401/403), apiKeyUnverifiable (anything else),
 * apiKeyBaseUrlInvalid, secretsUnavailable. The key is never logged.
 */
export async function addApiKey(query: Query, ownerId: string, input: unknown, options: { env?: Env; fetch?: typeof fetch; resolve?: (host: string) => Promise<string[]> } = {}): Promise<ApiKeyView> {
  const parsed = addApiKeyInput.parse(input)
  const env = options.env ?? process.env
  const custom = parsed.provider === 'custom' ? parsed : null
  const baseUrl = custom ? await checkBaseUrl(custom.baseUrl, env, options.resolve) : null
  const protocol: ApiKeyProtocol = custom ? custom.protocol : API_KEY_PRESET_ENDPOINTS[parsed.provider as Exclude<ApiKeyProvider, 'custom'>].protocol
  const target = custom
    ? { modelsUrl: customModelsUrl(baseUrl!, protocol), auth: protocol }
    : { modelsUrl: API_KEY_PRESET_ENDPOINTS[parsed.provider as Exclude<ApiKeyProvider, 'custom'>].modelsUrl, auth: API_KEY_PRESET_ENDPOINTS[parsed.provider as Exclude<ApiKeyProvider, 'custom'>].modelsAuth }
  const existing = custom ? undefined : (await query.query<{ id: string }>('SELECT id FROM model_api_keys WHERE "ownerId"=$1 AND provider=$2', [ownerId, parsed.provider])).rows[0]
  const id = existing?.id ?? randomUUID()
  let sealed: ReturnType<typeof sealSecret>
  try { sealed = sealSecret(parsed.apiKey, keyAad(id, ownerId), env) } catch (error) {
    if (error instanceof SecretsKeyMissingError) throw new WorkspaceError('secretsUnavailable')
    throw error
  }
  const result = await verifyApiKey(target, parsed.apiKey, options.fetch)
  if (!result.ok) throw new WorkspaceError(result.code === 'invalid' ? 'apiKeyInvalid' : 'apiKeyUnverifiable')
  // A custom provider's own list, when given, is what its models are; otherwise what the provider listed.
  const models = custom?.models?.length ? [...new Set(custom.models)] : result.models
  const { rows: [row] } = await query.query<Row>(`INSERT INTO model_api_keys (id,"ownerId",provider,name,"baseUrl",protocol,ciphertext,iv,"keyVersion",last4,models)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
    ON CONFLICT (id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,iv=EXCLUDED.iv,"keyVersion"=EXCLUDED."keyVersion",last4=EXCLUDED.last4,models=EXCLUDED.models,"updatedAt"=now()
    RETURNING ${COLUMNS}`,
  [id, ownerId, parsed.provider, custom?.name ?? null, baseUrl, protocol, sealed.ciphertext, sealed.iv, sealed.keyVersion, parsed.apiKey.slice(-4), JSON.stringify(models)])
  return view(row)
}

/** The owner removes their key; its shares go with it. */
export async function removeApiKey(query: Query, ownerId: string, id: string): Promise<{ removed: boolean }> {
  z.uuid().parse(id)
  // Runs handed this key stop first; the key is gone for them too.
  await stopRunsUsingApiKeys(query, { keyId: id, ownerId })
  const { rowCount } = await query.query('DELETE FROM model_api_keys WHERE id=$1 AND "ownerId"=$2', [id, ownerId])
  return { removed: Boolean(rowCount) }
}

/**
 * 分享给团队成员 for one key in one team workspace. The caller has checked
 * that the owner is an active member of it. Turning it on needs the admin's
 * 允许成员使用个人订阅和 API Key; turning it off always works.
 */
export async function setApiKeyShare(query: Query, ownerId: string, workspace: { id: string; kind: 'personal' | 'team' }, id: string, shared: boolean): Promise<void> {
  z.uuid().parse(id)
  if (workspace.kind !== 'team') throw new WorkspaceError('validationGeneric')
  const { rowCount } = await query.query('SELECT 1 FROM model_api_keys WHERE id=$1 AND "ownerId"=$2', [id, ownerId])
  if (!rowCount) throw new WorkspaceError('apiKeyNotFound')
  if (!shared) {
    await query.query('DELETE FROM model_api_key_shares WHERE "keyId"=$1 AND "workspaceId"=$2', [id, workspace.id])
    await stopRunsUsingApiKeys(query, { keyId: id, workspaceId: workspace.id, othersOnly: true })
    return
  }
  if (!(await memberSubscriptionsAllowed(query, workspace.id))) throw new WorkspaceError('workspaceAccessDenied')
  await query.query('INSERT INTO model_api_key_shares ("keyId","workspaceId") VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, workspace.id])
}

/** A member leaves a team: their key shares there go at once (orchestration.md § 6). */
export async function removeMemberApiKeyShares(query: Query, ownerId: string, workspaceId: string) {
  await query.query('DELETE FROM model_api_key_shares s USING model_api_keys k WHERE k.id=s."keyId" AND k."ownerId"=$1 AND s."workspaceId"=$2', [ownerId, workspaceId])
  await stopRunsUsingApiKeys(query, { ownerId, workspaceId })
}

/** 订阅额度用完后，自动改用 API Key. On unless the person turned it off. */
export async function apiKeyAfterQuota(query: Query, ownerId: string): Promise<boolean> {
  const { rows: [row] } = await query.query<{ apiKeyAfterQuota: boolean }>('SELECT "apiKeyAfterQuota" FROM "user" WHERE id=$1', [ownerId])
  return row?.apiKeyAfterQuota ?? true
}
export async function setApiKeyAfterQuota(query: Query, ownerId: string, on: boolean) {
  await query.query('UPDATE "user" SET "apiKeyAfterQuota"=$2 WHERE id=$1', [ownerId, z.boolean().parse(on)])
}

/** A key a person's runs may use in a workspace, as the model picker lists it. */
export interface UsableApiKey extends ApiKeyView {
  ownerId: string
  /** The person's own key, or a teammate's shared with 分享给团队成员. */
  mine: boolean
}

/**
 * The API keys a person's bots may use in a workspace, in the order of
 * orchestration.md § 2: their own first (when their credentials are allowed
 * there), then other members' keys shared with 分享给团队成员, oldest share
 * first. The model picker's 「API Key」 group reads this.
 */
export async function usableApiKeys(query: Query, userId: string, workspaceId: string): Promise<UsableApiKey[]> {
  // One after the other: a dispatch reads this on its transaction's client.
  const own = await subscriptionsUsable(query, userId, workspaceId)
  const allowed = await memberSubscriptionsAllowed(query, workspaceId)
  const mine = own ? (await query.query<Row>(`SELECT ${COLUMNS} FROM model_api_keys WHERE "ownerId"=$1 ORDER BY "createdAt",id`, [userId])).rows : []
  const others = allowed ? (await query.query<Row>(`SELECT ${COLUMNS.split(',').map(column => `k.${column}`).join(',')} FROM model_api_key_shares s JOIN model_api_keys k ON k.id=s."keyId"
    WHERE s."workspaceId"=$1 AND k."ownerId"<>$2 ORDER BY s."createdAt",k.id`, [workspaceId, userId])).rows : []
  return [...mine.map(row => ({ ...view(row), ownerId: row.ownerId, mine: true })), ...others.map(row => ({ ...view(row), ownerId: row.ownerId, mine: false }))]
}

/** What the run's Agent gets: environment variables, plus Codex's model provider when it runs on Codex. */
export type ApiKeyRunCredential =
  | { harness: 'claude_code'; keyId: string; ownerId: string; env: { ANTHROPIC_API_KEY: string; ANTHROPIC_BASE_URL: string } }
  | { harness: 'codex'; keyId: string; ownerId: string; env: { MIKKA_MODEL_API_KEY: string }
    /** Codex config: `model_provider = "mikka"` and `[model_providers.mikka]`. The key stays in the env var named by env_key. */
    codex: { model_provider: 'mikka'; model_providers: { mikka: { name: string; base_url: string; env_key: 'MIKKA_MODEL_API_KEY'; wire_api: 'responses' | 'chat' } } } }

async function openKey(query: Query, keyId: string, env: Env) {
  const { rows: [row] } = await query.query<Row & { ciphertext: string; iv: string; keyVersion: number }>(`SELECT ${COLUMNS},ciphertext,iv,"keyVersion" FROM model_api_keys WHERE id=$1`, [keyId])
  if (!row) throw new WorkspaceError('apiKeyNotFound')
  try { return { row, apiKey: openSecret(row, keyAad(row.id, row.ownerId), env) } } catch (error) {
    if (error instanceof SecretsKeyMissingError) throw new WorkspaceError('secretsUnavailable')
    console.error(`[model-api-keys] open_failed id=${row.id}`)
    throw new WorkspaceError('apiKeyNotFound')
  }
}

/** A bot's saved API key model (bot_model_choices), with the Agent its threads run on (§ 3). */
export interface BotApiKeyChoice { keyId: string; model: string; harness: 'claude_code' | 'codex' }

export async function botApiKeyChoice(query: Query, scope: { ownerId: string; workspaceId: string }, botId: string | null): Promise<BotApiKeyChoice | undefined> {
  const { rows: [row] } = await query.query<{ apiKeyId: string; apiKeyModel: string; protocol: ApiKeyProtocol }>(
    `SELECT c."apiKeyId",c."apiKeyModel",k.protocol FROM bot_model_choices c JOIN model_api_keys k ON k.id=c."apiKeyId"
    WHERE c."ownerId"=$1 AND c."workspaceId"=$2 AND c."botKey"=$3`, [scope.ownerId, scope.workspaceId, botId ?? 'coordinator'])
  return row && { keyId: row.apiKeyId, model: row.apiKeyModel, harness: apiKeyHarness(row.protocol) }
}

/**
 * Saves a bot's model as one an API key serves. The key must be usable by
 * the bot's owner here and reach bot chats, and the model one it lists (any
 * model when the key lists none). Saving a subscription model later replaces it.
 */
export async function setBotApiKeyChoice(query: Query, scope: { ownerId: string; workspaceId: string }, botId: string | null, keyId: string, model: string): Promise<BotApiKeyChoice> {
  z.uuid().parse(keyId)
  const modelName = modelId.parse(model)
  if (botId !== null) {
    if (!z.uuid().safeParse(botId).success) throw new WorkspaceError('botNotFound')
    const { rowCount } = await query.query('SELECT 1 FROM bots WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3', [botId, scope.ownerId, scope.workspaceId])
    if (!rowCount) throw new WorkspaceError('botNotFound')
  }
  const key = (await usableApiKeys(query, scope.ownerId, scope.workspaceId)).find(item => item.id === keyId)
  if (!key || !apiKeyChatBaseUrl(key) || (key.models.length && !key.models.includes(modelName))) throw new WorkspaceError('executionModelUnknown')
  await query.query(`INSERT INTO bot_model_choices ("ownerId","workspaceId","botKey","bindingId","apiKeyId","apiKeyModel") VALUES ($1,$2,$3,NULL,$4,$5)
    ON CONFLICT ("ownerId","workspaceId","botKey") DO UPDATE SET "bindingId"=NULL,"apiKeyId"=EXCLUDED."apiKeyId","apiKeyModel"=EXCLUDED."apiKeyModel"`,
  [scope.ownerId, scope.workspaceId, botId ?? 'coordinator', keyId, modelName])
  return { keyId, model: modelName, harness: apiKeyHarness(key.protocol) }
}

/**
 * The key and chat endpoint for one model call of a bot chat frozen on it.
 * Checked on every call, so a withdrawn share or a deleted key stops the
 * chat instead of switching (§ 2). Throws WorkspaceError('apiKeyNotFound').
 */
export async function openApiKeyForChat(query: Query, userId: string, workspaceId: string, keyId: string, env: Env = process.env): Promise<{ apiKey: string; baseUrl: string; keyOwnerId: string }> {
  const usable = (await usableApiKeys(query, userId, workspaceId)).find(key => key.id === keyId)
  const baseUrl = usable && apiKeyChatBaseUrl(usable)
  if (!usable || !baseUrl) throw new WorkspaceError('apiKeyNotFound')
  const { row, apiKey } = await openKey(query, keyId, env)
  return { apiKey, baseUrl, keyOwnerId: row.ownerId }
}

const ACTIVE_RUN = ['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing']

/**
 * The key a run uses, opened for injection at the start of that run
 * (orchestration.md § 6). The run must still be active, and the key must be
 * usable by the run's owner in the run's workspace: their own key, or a
 * teammate's shared there with 分享给团队成员. Throws WorkspaceError
 * ('apiKeyNotFound') otherwise, so a withdrawn share or a deleted key stops
 * the run instead of switching (§ 2).
 */
export async function apiKeyForRun(query: Query, runId: string, keyId: string, env: Env = process.env): Promise<ApiKeyRunCredential> {
  z.uuid().parse(runId); z.uuid().parse(keyId)
  const { rows: [run] } = await query.query<{ userId: string; workspaceId: string | null; status: string }>(
    'SELECT r."userId",b."workspaceId"::text AS "workspaceId",r.status FROM agent_runs r LEFT JOIN bots b ON b.id=r."botId" WHERE r.id=$1', [runId])
  if (!run || !ACTIVE_RUN.includes(run.status)) throw new WorkspaceError('apiKeyNotFound')
  const usable = run.workspaceId
    ? (await usableApiKeys(query, run.userId, run.workspaceId)).some(key => key.id === keyId)
    : Boolean((await query.query('SELECT 1 FROM model_api_keys WHERE id=$1 AND "ownerId"=$2', [keyId, run.userId])).rowCount)
  if (!usable) throw new WorkspaceError('apiKeyNotFound')
  const { row, apiKey } = await openKey(query, keyId, env)
  // Recorded so withdrawing the key or its share stops this run (stopRunsUsingApiKeys).
  await query.query(`INSERT INTO model_api_key_runs ("runId","keyId","workspaceId") VALUES ($1,$2,$3)
    ON CONFLICT ("runId") DO UPDATE SET "keyId"=EXCLUDED."keyId","workspaceId"=EXCLUDED."workspaceId"`, [runId, keyId, run.workspaceId])
  const baseUrl = row.baseUrl ?? API_KEY_PRESET_ENDPOINTS[row.provider as Exclude<ApiKeyProvider, 'custom'>].baseUrl
  if (apiKeyHarness(row.protocol) === 'claude_code') return { harness: 'claude_code', keyId: row.id, ownerId: row.ownerId, env: { ANTHROPIC_API_KEY: apiKey, ANTHROPIC_BASE_URL: baseUrl } }
  return {
    harness: 'codex', keyId: row.id, ownerId: row.ownerId, env: { MIKKA_MODEL_API_KEY: apiKey },
    codex: { model_provider: 'mikka', model_providers: { mikka: { name: row.name ?? 'OpenAI', base_url: baseUrl, env_key: 'MIKKA_MODEL_API_KEY', wire_api: row.provider === 'openai' ? 'responses' : 'chat' } } },
  }
}
