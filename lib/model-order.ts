import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { isDeviceOnline } from '@mikka/protocol/device'
import type { HarnessInfo } from '@mikka/protocol/harness'
import { ActionFailureError } from './action-error'
import { apiKeyHarness } from './model-api-key-providers'
import { quotaExhausted, quotaResetsAt } from './subscription-quota'
import {
  defaultOrder, deviceModel, entryKey,
  type CredentialState, type OrderCandidate, type OrderEntry, type OrderHarness, type PoolDevice, type RunLocation,
} from './model-order-plan'

/**
 * 模型与订阅 › 允许使用的模型 and 运行位置 (decision 2026-11-02-1400), per
 * person and workspace: what dispatch reads (lib/model-dispatch.ts) and what
 * the page shows and edits. Candidates are only what the person actually
 * has here: each connected subscription's catalogue (the models its account
 * reported) and each usable API key's /models list. An untouched list is the
 * default preference over those candidates (`defaultOrder`), never stored
 * until the person changes it.
 */
type Query = Pick<Pool | PoolClient, 'query'>
export interface OrderScope { ownerId: string; workspaceId: string }

/** One allowed model as the page shows it. */
export interface OrderRow extends OrderEntry {
  /** The subscription's provider or the key's provider, for its mark and label. */
  provider: string
  /** Why it cannot run now, or null when it can. noDevice only for 本地. */
  block: null | { reason: 'quota' | 'expired' | 'paused' | 'missing' | 'keyRefused' | 'noDevice'; resetsAt?: string | null }
}

export interface OrderView {
  location: RunLocation
  customized: boolean
  entries: OrderRow[]
  candidates: (OrderCandidate & { provider: string; added: boolean })[]
  /** Devices that take part (参与调度 on), for the 本地 line. */
  devices: number
}

interface EntryRow { id: string; harness: OrderHarness; model: string; sourceKind: 'subscription' | 'api_key'; sourceId: string }
const toEntry = (row: EntryRow): OrderEntry => ({
  id: row.id, harness: row.harness, model: row.model,
  source: row.sourceKind === 'subscription' ? { kind: 'subscription', connectionId: row.sourceId } : { kind: 'api_key', keyId: row.sourceId },
})
const sourceId = (entry: Pick<OrderEntry, 'source'>) => entry.source.kind === 'subscription' ? entry.source.connectionId : entry.source.keyId

/** What the person can add here: their usable subscriptions' models and their usable keys' models. */
export async function orderCandidates(query: Query, scope: OrderScope): Promise<(OrderCandidate & { provider: string })[]> {
  const { ExecutionSettings } = await import('./execution-settings')
  const { usableApiKeys } = await import('./model-api-keys')
  const rows = await new ExecutionSettings(query as Pool).botModels(scope, query)
  // Each account's models in the order the account listed them (its catalogue): the default takes the first Codex model.
  const connectionIds = [...new Set(rows.map(row => String(row.connectionId)))]
  const listed = new Map((connectionIds.length ? (await query.query<{ id: string; models: unknown }>(
    `SELECT id::text AS id,"modelCatalog"->'models' AS models FROM byos_connections WHERE id::text = ANY($1) AND "ownerId"=$2`, [connectionIds, scope.ownerId])).rows : [])
    .map(row => [row.id, Array.isArray(row.models) ? row.models.map(String) : []]))
  const rank = (connectionId: string, model: string) => { const at = listed.get(connectionId)?.indexOf(model) ?? -1; return at < 0 ? Number.MAX_SAFE_INTEGER : at }
  const subscriptions = rows.map(row => ({
    harness: (row.provider === 'codex' ? 'codex' : 'claude_code') as OrderHarness, model: String(row.modelId), name: String(row.modelId),
    source: { kind: 'subscription' as const, connectionId: String(row.connectionId) }, provider: String(row.provider),
  })).map((item, at) => ({ item, at })).sort((a, b) => a.item.source.connectionId === b.item.source.connectionId
    ? rank(a.item.source.connectionId, a.item.model) - rank(b.item.source.connectionId, b.item.model) || a.at - b.at
    : a.at - b.at).map(({ item }) => item)
  const keys = (await usableApiKeys(query, scope.ownerId, scope.workspaceId)).flatMap(key => key.models.map(model => ({
    harness: apiKeyHarness(key.protocol) as OrderHarness, model, name: model,
    source: { kind: 'api_key' as const, keyId: key.id }, provider: key.provider,
  })))
  // Claude first, then ChatGPT/Codex, then keys (orchestration.md § 2).
  const ordered = [...subscriptions.filter(item => item.provider === 'claude'), ...subscriptions.filter(item => item.provider !== 'claude'), ...keys]
  return [...new Map(ordered.map(item => [entryKey(item), item])).values()]
}

async function settingsRow(query: Query, scope: OrderScope) {
  const { rows: [row] } = await query.query<{ location: RunLocation; customized: boolean }>(
    'SELECT location,customized FROM model_order_settings WHERE "ownerId"=$1 AND "workspaceId"=$2', [scope.ownerId, scope.workspaceId])
  return row ?? { location: 'local' as RunLocation, customized: false }
}

/** The allowed models in order: the stored list, or for an untouched list the default preference (ids are stable per entry). */
export async function readOrder(query: Query, scope: OrderScope, candidates?: (OrderCandidate & { provider: string })[]): Promise<{ location: RunLocation; customized: boolean; entries: OrderEntry[] }> {
  const settings = await settingsRow(query, scope)
  if (!settings.customized) {
    const list = defaultOrder(candidates ?? await orderCandidates(query, scope))
    return { ...settings, entries: list.map(item => ({ id: `default:${entryKey(item)}`, harness: item.harness, model: item.model, source: item.source })) }
  }
  const { rows } = await query.query<EntryRow>(
    'SELECT id,harness,model,"sourceKind","sourceId"::text AS "sourceId" FROM model_order_entries WHERE "ownerId"=$1 AND "workspaceId"=$2 ORDER BY position,id',
    [scope.ownerId, scope.workspaceId])
  return { ...settings, entries: rows.map(toEntry) }
}

/** Each entry's credential, read now: connected, not paused, quota left, the key still usable and listing the model. */
export async function credentialStates(query: Query, scope: OrderScope, entries: readonly OrderEntry[], candidates: readonly (OrderCandidate & { provider: string })[], now = Date.now()) {
  const available = new Set(candidates.map(entryKey))
  const connectionIds = [...new Set(entries.flatMap(entry => entry.source.kind === 'subscription' ? [entry.source.connectionId] : []))]
  const keyIds = [...new Set(entries.flatMap(entry => entry.source.kind === 'api_key' ? [entry.source.keyId] : []))]
  const connections = new Map((connectionIds.length ? (await query.query<{ id: string; state: string; paused: boolean; quota: unknown; provider: string }>(
    'SELECT id::text AS id,state,paused,quota,provider FROM byos_connections WHERE id::text=ANY($1::text[])', [connectionIds])).rows : []).map(row => [row.id, row]))
  const keys = new Map((keyIds.length ? (await query.query<{ id: string; modelsError: string | null; provider: string }>(
    'SELECT id::text AS id,"modelsError",provider FROM model_api_keys WHERE id::text=ANY($1::text[])', [keyIds])).rows : []).map(row => [row.id, row]))
  const states = new Map<string, { credential: CredentialState; provider: string }>()
  for (const entry of entries) {
    if (entry.source.kind === 'subscription') {
      const row = connections.get(entry.source.connectionId)
      const provider = row?.provider ?? (entry.harness === 'codex' ? 'codex' : 'claude')
      const credential: CredentialState = !row ? { usable: false, reason: 'missing' }
        : row.state === 'reconnect_required' ? { usable: false, reason: 'expired' }
          : row.paused ? { usable: false, reason: 'paused' }
            : row.state !== 'connected' || !available.has(entryKey(entry)) ? { usable: false, reason: 'missing' }
              : quotaExhausted(row.quota, now) ? { usable: false, reason: 'quota', resetsAt: quotaResetsAt(row.quota, now) }
                : { usable: true }
      states.set(entry.id, { credential, provider })
    } else {
      const row = keys.get(entry.source.keyId)
      const credential: CredentialState = row?.modelsError === 'invalid' ? { usable: false, reason: 'keyRefused' }
        : !row || !available.has(entryKey(entry)) ? { usable: false, reason: 'missing' } : { usable: true }
      states.set(entry.id, { credential, provider: row?.provider ?? 'custom' })
    }
  }
  return states
}

/** The person's own local devices as dispatch sees them; 参与调度 is `enabled`. */
export async function poolDevices(query: Query, ownerId: string): Promise<PoolDevice[]> {
  const { rows } = await query.query<{ id: string; enabled: boolean; lastSeenAt: Date | null; harnesses: HarnessInfo[] | null }>(
    `SELECT id,enabled,"lastSeenAt",harnesses FROM devices WHERE "ownerId"=$1 AND kind='local' AND "removedAt" IS NULL ORDER BY "lastSeenAt" DESC NULLS LAST,id`, [ownerId])
  return rows.map(row => ({ id: row.id, enabled: row.enabled, online: isDeviceOnline(row.lastSeenAt), harnesses: row.harnesses ?? [] }))
}

/** The page: credentials' candidates, the list with each entry's status, and 运行位置. */
export async function orderView(query: Query, scope: OrderScope): Promise<OrderView> {
  const candidates = await orderCandidates(query, scope)
  const order = await readOrder(query, scope, candidates)
  const states = await credentialStates(query, scope, order.entries, candidates)
  const devices = await poolDevices(query, scope.ownerId)
  const added = new Set(order.entries.map(entryKey))
  return {
    location: order.location,
    customized: order.customized,
    devices: devices.filter(device => device.enabled).length,
    entries: order.entries.map(entry => {
      const state = states.get(entry.id)!
      const block = !state.credential.usable ? { reason: state.credential.reason, ...(state.credential.resetsAt ? { resetsAt: state.credential.resetsAt } : {}) }
        : order.location === 'local' && !devices.some(device => deviceModel(device, entry)) ? { reason: 'noDevice' as const } : null
      return { ...entry, provider: state.provider, block }
    }),
    candidates: candidates.map(candidate => ({ ...candidate, added: added.has(entryKey(candidate)) })),
  }
}

const harnessSchema = z.enum(['claude_code', 'codex'])
const candidateInput = z.object({
  harness: harnessSchema, model: z.string().trim().min(1).max(128),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('subscription'), connectionId: z.uuid() }),
    z.object({ kind: z.literal('api_key'), keyId: z.uuid() }),
  ]),
})
export type OrderChange =
  | { kind: 'add'; entries: z.infer<typeof candidateInput>[] }
  | { kind: 'remove'; id: string }
  | { kind: 'reorder'; ids: string[] }
  | { kind: 'location'; location: RunLocation }

/**
 * One change to the list or 运行位置, in one transaction under a per-scope
 * lock. The first change to an untouched list stores the default it showed,
 * then applies the change. An add must be one of the person's candidates now.
 */
export async function changeOrder(pool: Pool, scope: OrderScope, change: OrderChange): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`model-order:${scope.ownerId}:${scope.workspaceId}`])
    if (change.kind === 'location') {
      const location = z.enum(['cloud', 'local']).parse(change.location)
      await client.query(`INSERT INTO model_order_settings ("ownerId","workspaceId",location) VALUES ($1,$2,$3)
        ON CONFLICT ("ownerId","workspaceId") DO UPDATE SET location=EXCLUDED.location,"updatedAt"=now()`, [scope.ownerId, scope.workspaceId, location])
      await client.query('COMMIT')
      return
    }
    const candidates = await orderCandidates(client, scope)
    const current = await readOrder(client, scope, candidates)
    let entries = current.entries
    if (!current.customized) {
      // Store what the person saw, under real ids, before changing it.
      const ids = new Map(entries.map(entry => [entry.id, randomUUID()]))
      entries = entries.map(entry => ({ ...entry, id: ids.get(entry.id)! }))
      if (change.kind === 'remove') change = { ...change, id: ids.get(change.id) ?? change.id }
      if (change.kind === 'reorder') change = { ...change, ids: change.ids.map(id => ids.get(id) ?? id) }
    }
    if (change.kind === 'add') {
      const available = new Map(candidates.map(candidate => [entryKey(candidate), candidate]))
      const have = new Set(entries.map(entryKey))
      for (const raw of z.array(candidateInput).min(1).max(100).parse(change.entries)) {
        const key = entryKey(raw)
        if (!available.has(key)) throw new ActionFailureError('executionModelUnknown')
        if (!have.has(key)) { entries = [...entries, { id: randomUUID(), harness: raw.harness, model: raw.model, source: raw.source }]; have.add(key) }
      }
    } else if (change.kind === 'remove') {
      const before = entries.length, removed = change.id
      entries = entries.filter(entry => entry.id !== removed)
      if (entries.length === before) throw new ActionFailureError('executionRuleNotFound')
    } else {
      const ids = z.array(z.string().min(1).max(200)).parse(change.ids)
      if (ids.length !== entries.length || new Set(ids).size !== ids.length || ids.some(id => !entries.some(entry => entry.id === id))) throw new ActionFailureError('executionRuleOrderInvalid')
      entries = ids.map(id => entries.find(entry => entry.id === id)!)
    }
    await client.query('DELETE FROM model_order_entries WHERE "ownerId"=$1 AND "workspaceId"=$2', [scope.ownerId, scope.workspaceId])
    for (const [position, entry] of entries.entries()) {
      await client.query(`INSERT INTO model_order_entries (id,"ownerId","workspaceId",position,harness,model,"sourceKind","sourceId") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [entry.id, scope.ownerId, scope.workspaceId, position, entry.harness, entry.model, entry.source.kind, sourceId(entry)])
    }
    await client.query(`INSERT INTO model_order_settings ("ownerId","workspaceId",customized) VALUES ($1,$2,true)
      ON CONFLICT ("ownerId","workspaceId") DO UPDATE SET customized=true,"updatedAt"=now()`, [scope.ownerId, scope.workspaceId])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
