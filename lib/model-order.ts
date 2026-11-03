import 'server-only'
import { randomUUID } from 'node:crypto'
import { cloudModelSupport, type CloudModelState } from './cloud-template-models'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { isDeviceOnline } from '@mikka/protocol/device'
import type { HarnessInfo } from '@mikka/protocol/harness'
import { ActionFailureError } from './action-error'
import { apiKeyHarnesses } from './model-api-key-providers'
import { subscriptionAvailability } from './subscription-quota'
import {
  agentsByOffer, defaultOrder, deviceModel, entryKey, offerKey, planDispatch, whyNoDevice,
  type CredentialState, type NoDeviceWhy, type OrderCandidate, type OrderEntry, type OrderHarness, type PoolDevice, type RunLocation,
} from './model-order-plan'

/**
 * 模型与订阅 › 优先使用的模型 and 运行位置 (decision 2026-11-02-1400), per
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
  /** The Agents this model and credential can run on: one, or both for a DeepSeek or Kimi key (the row's Agent menu). */
  agents: OrderHarness[]
  /** Why it cannot run now, or null when it can. noDevice when no place of 运行位置 runs it, with what the closest computer lacks. */
  block: null
    | { reason: 'checking' | 'quota' | 'expired' | 'paused' | 'missing' | 'keyRefused'; resetsAt?: string | null }
    | { reason: 'noDevice'; device: NoDeviceWhy }
}

export interface OrderView {
  location: RunLocation
  customized: boolean
  /** 优先使用的 Agent: where a model both Agents run goes by default. */
  preferredHarness: OrderHarness
  /** Connected subscriptions and usable API keys here: none means 优先使用的模型 says to connect one (C8). */
  credentials: number
  entries: OrderRow[]
  candidates: (OrderCandidate & { provider: string; added: boolean })[]
  /** Devices that take part (参与调度 on). */
  devices: number
  /** 云端: the person's own E2B cloud would take a run now. */
  cloudReady: boolean
  cloudModels: Record<string, CloudModelState>
  /** 会先用: where a new run would go now, by the same plan as dispatch; null when nowhere. */
  first: { kind: 'cloud' } | { kind: 'device'; id: string; name: string; server: boolean } | null
  /** Devices that can run the same list now, including credential readiness. */
  readyDeviceIds: string[]
  /**
   * 设备 › 能跑: per local device, the allowed models it can run, whatever its
   * 参与调度 or whether it is online (those have their own lines there).
   */
  deviceModels: Record<string, string[]>
}

interface EntryRow { id: string; harness: OrderHarness; model: string; sourceKind: 'subscription' | 'api_key'; sourceId: string }
const toEntry = (row: EntryRow): OrderEntry => ({
  id: row.id, harness: row.harness, model: row.model,
  source: row.sourceKind === 'subscription' ? { kind: 'subscription', connectionId: row.sourceId } : { kind: 'api_key', keyId: row.sourceId },
})
const sourceId = (entry: Pick<OrderEntry, 'source'>) => entry.source.kind === 'subscription' ? entry.source.connectionId : entry.source.keyId

/** What the person can add here: their usable subscriptions' models and their usable keys' models. */
export async function orderCandidates(query: Query, scope: OrderScope): Promise<(OrderCandidate & { provider: string; credentialOwnerId: string })[]> {
  const { ExecutionSettings } = await import('./execution-settings')
  const { usableApiKeys } = await import('./model-api-keys')
  const settings = new ExecutionSettings(query as Pool)
  const rows = await settings.botModels(scope, query)
  const { pooledOwners } = await import('./personal-policy')
  const { authorizeSubscriptionWorkspace } = await import('./subscription-runtime')
  // Sharing grants use in this workspace, never ownership of the account. Both parties must still
  // be active members; the owner is derived from server records, never an EntrySource supplied by a client.
  for (const ownerId of await pooledOwners(query, scope.ownerId, scope.workspaceId)) {
    try { await authorizeSubscriptionWorkspace(ownerId, scope.workspaceId) } catch { continue }
    rows.push(...await settings.botModels({ ...scope, ownerId }, query))
  }
  // Each account's models in the order the account listed them (its catalogue): the default takes the first Codex model.
  const connectionIds = [...new Set(rows.map(row => String(row.connectionId)))]
  const listed = new Map((connectionIds.length ? (await query.query<{ id: string; models: unknown }>(
    `SELECT id::text AS id,"modelCatalog"->'models' AS models FROM byos_connections WHERE id::text = ANY($1) AND "ownerId"=ANY($2::text[])`, [connectionIds, [...new Set(rows.map(row => String(row.ownerId)))]] )).rows : [])
    .map(row => [row.id, Array.isArray(row.models) ? row.models.map(String) : []]))
  const rank = (connectionId: string, model: string) => { const at = listed.get(connectionId)?.indexOf(model) ?? -1; return at < 0 ? Number.MAX_SAFE_INTEGER : at }
  const subscriptions = rows.map(row => ({
    harness: (row.provider === 'codex' ? 'codex' : 'claude_code') as OrderHarness, model: String(row.modelId), name: String(row.modelId),
    source: { kind: 'subscription' as const, connectionId: String(row.connectionId) }, provider: String(row.provider), credentialOwnerId: String(row.ownerId),
  })).map((item, at) => ({ item, at })).sort((a, b) => a.item.source.connectionId === b.item.source.connectionId
    ? rank(a.item.source.connectionId, a.item.model) - rank(b.item.source.connectionId, b.item.model) || a.at - b.at
    : a.at - b.at).map(({ item }) => item)
  // A key serves each Agent of each protocol it speaks: a DeepSeek or Kimi model is a candidate on both (model · Agent).
  const keys = (await usableApiKeys(query, scope.ownerId, scope.workspaceId)).flatMap(key => key.models.flatMap(model => apiKeyHarnesses(key).map(harness => ({
    harness: harness as OrderHarness, model, name: model,
    source: { kind: 'api_key' as const, keyId: key.id }, provider: key.provider, credentialOwnerId: key.ownerId,
  }))))
  // Claude first, then ChatGPT/Codex, then keys (orchestration.md § 2).
  const ordered = [...subscriptions.filter(item => item.provider === 'claude'), ...subscriptions.filter(item => item.provider !== 'claude'), ...keys]
  return [...new Map(ordered.map(item => [entryKey(item), item])).values()]
}

async function settingsRow(query: Query, scope: OrderScope) {
  const { rows: [row] } = await query.query<{ location: RunLocation; customized: boolean; preferredHarness: OrderHarness }>(
    'SELECT location,customized,"preferredHarness" FROM model_order_settings WHERE "ownerId"=$1 AND "workspaceId"=$2', [scope.ownerId, scope.workspaceId])
  return row ?? { location: 'cloud' as RunLocation, customized: false, preferredHarness: 'claude_code' as OrderHarness }
}

/** The allowed models in order: the stored list, or for an untouched list the default preference (ids are stable per entry). */
export async function readOrder(query: Query, scope: OrderScope, candidates?: (OrderCandidate & { provider: string })[]): Promise<{ location: RunLocation; customized: boolean; preferredHarness: OrderHarness; entries: OrderEntry[] }> {
  const settings = await settingsRow(query, scope)
  if (!settings.customized) {
    const list = defaultOrder(candidates ?? await orderCandidates(query, scope), settings.preferredHarness)
    return { ...settings, entries: list.map(item => ({ id: `default:${entryKey(item)}`, harness: item.harness, model: item.model, source: item.source })) }
  }
  const { rows } = await query.query<EntryRow>(
    'SELECT id,harness,model,"sourceKind","sourceId"::text AS "sourceId" FROM model_order_entries WHERE "ownerId"=$1 AND "workspaceId"=$2 ORDER BY position,id',
    [scope.ownerId, scope.workspaceId])
  return { ...settings, entries: rows.map(toEntry) }
}

export type RefreshOrderQuota = (scope: OrderScope, connectionId: string, signal: AbortSignal, credentialOwnerId?: string) => Promise<void>
const quotaRefreshes = new WeakMap<Query, Map<string, Promise<void>>>()
const refreshOrderQuota = (query: Query): RefreshOrderQuota => async (scope, connectionId, signal, credentialOwnerId = scope.ownerId) => {
  const service = (await import('./subscription-runtime')).subscriptionRuntime()
  await service.member(scope.ownerId, scope.workspaceId)
  await service.workspace(credentialOwnerId, scope.workspaceId)
  if (credentialOwnerId !== scope.ownerId && !(await (await import('./personal-policy')).othersMayUse(query, credentialOwnerId, scope.workspaceId))) throw new ActionFailureError('executionAccountUnavailable')
  await service.usage(credentialOwnerId, connectionId, signal)
}

/** Each entry's credential, read now. Dispatch refreshes missing/stale allowance
 * once per connection, before deciding; Settings can request a projection only. */
export async function credentialStates(query: Query, scope: OrderScope, entries: readonly OrderEntry[], candidates: readonly (OrderCandidate & { provider: string; credentialOwnerId?: string })[], now?: number, options: { probe?: boolean; refresh?: RefreshOrderQuota } = {}) {
  let checkedAt = now ?? Date.now()
  const available = new Set(candidates.map(entryKey))
  const connectionIds = [...new Set(entries.flatMap(entry => entry.source.kind === 'subscription' ? [entry.source.connectionId] : []))]
  // Owners come only from the server's authorized candidates, never the
  // browser's stored order/source. The database verifies each (id, owner) pair.
  const owners = new Map(connectionIds.map(id => [id, scope.ownerId]))
  for (const candidate of candidates) if (candidate.source.kind === 'subscription' && connectionIds.includes(candidate.source.connectionId)) owners.set(candidate.source.connectionId, candidate.credentialOwnerId ?? scope.ownerId)
  const keyIds = [...new Set(entries.flatMap(entry => entry.source.kind === 'api_key' ? [entry.source.keyId] : []))]
  const readConnections = async () => {
    const authorized = [] as [string, string][]
    for (const [id, owner] of owners) if (owner === scope.ownerId || await (await import('./personal-policy')).othersMayUse(query, owner, scope.workspaceId)) authorized.push([id, owner])
    return new Map((authorized.length ? (await query.query<{ id: string; ownerId: string; state: string; paused: boolean; quota: unknown; provider: 'claude' | 'codex'; epoch: string }>(
      'SELECT c.id::text AS id,c."ownerId",c.state,c.paused,c.quota,c.provider,c.epoch::text AS epoch FROM byos_connections c JOIN unnest($1::text[],$2::text[]) AS authorized(id,owner) ON c.id::text=authorized.id AND c."ownerId"=authorized.owner', [authorized.map(([id]) => id), authorized.map(([, owner]) => owner)])).rows : []).map(row => [row.id, row]))
  }
  let connections = await readConnections()
  if (options.probe !== false) {
    const pending = quotaRefreshes.get(query) ?? new Map<string, Promise<void>>()
    quotaRefreshes.set(query, pending)
    await Promise.all([...connections.values()].filter(row => row.state === 'connected' && !row.paused && entries.some(entry =>
      entry.source.kind === 'subscription' && entry.source.connectionId === row.id && available.has(entryKey(entry))
      && subscriptionAvailability(row.quota, entry.model, row.provider, checkedAt).status === 'checking')).map(row => {
      const key = `${scope.ownerId}:${scope.workspaceId}:${row.ownerId}:${row.id}:${row.epoch}`
      let refresh = pending.get(key)
      if (!refresh) {
        refresh = (options.refresh ?? refreshOrderQuota(query))(scope, row.id, AbortSignal.timeout(15_000), row.ownerId).catch(() => undefined).finally(() => { pending.delete(key) })
        pending.set(key, refresh)
      }
      return refresh
    }))
    // Disconnect, pause and reconnect win over the asynchronous provider read.
    connections = await readConnections()
    checkedAt = now ?? Date.now()
  }
  const keys = new Map((keyIds.length ? (await query.query<{ id: string; modelsError: string | null; provider: string }>(
    'SELECT id::text AS id,"modelsError",provider FROM model_api_keys WHERE id::text=ANY($1::text[])', [keyIds])).rows : []).map(row => [row.id, row]))
  const states = new Map<string, { credential: CredentialState; provider: string }>()
  for (const entry of entries) {
    if (entry.source.kind === 'subscription') {
      const row = connections.get(entry.source.connectionId)
      const provider = row?.provider ?? (entry.harness === 'codex' ? 'codex' : 'claude')
      const availability = subscriptionAvailability(row?.quota, entry.model, provider, checkedAt)
      const credential: CredentialState = !row ? { usable: false, reason: 'missing' }
        : row.state === 'reconnect_required' ? { usable: false, reason: 'expired' }
          : row.paused ? { usable: false, reason: 'paused' }
            : row.state !== 'connected' || !available.has(entryKey(entry)) ? { usable: false, reason: 'missing' }
              : availability.status === 'exhausted' ? { usable: false, reason: 'quota', resetsAt: availability.resetsAt }
                : availability.status === 'checking' ? { usable: false, reason: 'checking' }
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

/** An explicit Settings retry. A connection id identifies a currently allowed
 * candidate, never grants ownership or access to an arbitrary credential. */
export async function checkOrderQuota(query: Query, scope: OrderScope, connectionId: string, refresh?: RefreshOrderQuota): Promise<OrderView> {
  const candidates = await orderCandidates(query, scope)
  const order = await readOrder(query, scope, candidates)
  const allowed = new Set(candidates.map(entryKey))
  const entries = order.entries.filter(entry => entry.source.kind === 'subscription' && entry.source.connectionId === connectionId && allowed.has(entryKey(entry)))
  if (!entries.length) throw new ActionFailureError('executionAccountUnavailable')
  await credentialStates(query, scope, entries, candidates, undefined, { refresh })
  return orderView(query, scope)
}

/**
 * The person's own local devices as dispatch sees them; 参与调度 is `enabled`.
 * A run not yet ended counts toward its device's load (pickDevice).
 */
export async function poolDevices(query: Query, ownerId: string): Promise<PoolDevice[]> {
  const { rows } = await query.query<{ id: string; name: string; enabled: boolean; lastSeenAt: Date | null; harnesses: HarnessInfo[] | null; deviceType: string | null; createdAt: Date; activeRuns: number }>(
    `SELECT d.id,d.name,d.enabled,d."lastSeenAt",d.harnesses,d."deviceType",d."createdAt",
      (SELECT count(*)::int FROM agent_runs r WHERE r."deviceId"=d.id AND r.status IN ('queued','preparing','running','paused','waiting_input','finishing')) AS "activeRuns"
    FROM devices d WHERE d."ownerId"=$1 AND d.kind='local' AND d."removedAt" IS NULL ORDER BY d."lastSeenAt" DESC NULLS LAST,d.id`, [ownerId])
  return rows.map(row => ({
    id: row.id, name: row.name, enabled: row.enabled, online: isDeviceOnline(row.lastSeenAt), harnesses: row.harnesses ?? [],
    server: row.deviceType === 'server', activeRuns: row.activeRuns, joinedAt: row.createdAt.getTime(),
  }))
}

/** The page: credentials' candidates, the list with each entry's status, and 运行位置. */
export async function orderView(query: Query, scope: OrderScope): Promise<OrderView> {
  const candidates = await orderCandidates(query, scope)
  const order = await readOrder(query, scope, candidates)
  const states = await credentialStates(query, scope, order.entries, candidates, Date.now(), { probe: false })
  const devices = await poolDevices(query, scope.ownerId)
  const added = new Set(order.entries.map(entryKey))
  const agents = agentsByOffer(candidates)
  const { usableApiKeys } = await import('./model-api-keys')
  const { rows: connected } = await query.query<{ id: string }>(`SELECT id::text AS id FROM byos_connections WHERE "ownerId"=$1 AND state='connected'`, [scope.ownerId])
  const subscriptions = new Set([...connected.map(row => row.id), ...candidates.flatMap(candidate => candidate.source.kind === 'subscription' ? [candidate.source.connectionId] : [])])
  const credentials = subscriptions.size + (await usableApiKeys(query, scope.ownerId, scope.workspaceId)).length
  const ready = order.location === 'cloud' && await (await import('./rule-dispatch')).cloudReady(query, { ...scope, botId: null, harness: order.entries[0]?.harness ?? 'claude_code' })
  const credential = (entry: OrderEntry) => states.get(entry.id)?.credential ?? { usable: false, reason: 'missing' } as const
  // 会先用: what dispatch would pick for a new run now, from the same plan.
  const cloudModels = Object.fromEntries(order.entries.map(entry => [entry.id, cloudModelSupport(entry)]))
  const plan = planDispatch({ entries: order.entries, location: order.location, devices, credential, cloudReady: ready, cloudModel: entry => cloudModels[entry.id] })
  const firstDevice = plan.kind === 'device' ? devices.find(device => device.id === plan.deviceId) : undefined
  return {
    location: order.location,
    customized: order.customized,
    preferredHarness: order.preferredHarness,
    credentials,
    devices: devices.filter(device => device.enabled).length,
    cloudReady: ready,
    cloudModels,
    first: plan.kind === 'cloud' ? { kind: 'cloud' } : firstDevice ? { kind: 'device', id: firstDevice.id, name: firstDevice.name, server: firstDevice.server } : null,
    readyDeviceIds: devices.filter(device => planDispatch({ entries: order.entries, location: 'local', devices: [device], credential, cloudReady: false }).kind === 'device').map(device => device.id),
    deviceModels: Object.fromEntries(devices.map(device => [device.id,
      [...new Set(order.entries.filter(entry => deviceModel({ ...device, enabled: true, online: true }, entry)).map(entry => entry.model))]])),
    entries: order.entries.map(entry => {
      const state = states.get(entry.id)!
      // 云端 that runs takes every model; otherwise a server or a computer must.
      const block: OrderRow['block'] = !state.credential.usable ? { reason: state.credential.reason, ...(state.credential.resetsAt ? { resetsAt: state.credential.resetsAt } : {}) }
        : !(ready && cloudModels[entry.id] === 'ready') && !devices.some(device => deviceModel(device, entry)) ? { reason: 'noDevice', device: whyNoDevice(devices, entry) } : null
      return { ...entry, provider: state.provider, agents: agents.get(offerKey(entry)) ?? [entry.harness], block }
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
  /** `at`: where the first added entry goes (undo of 移出列表 puts it back); the end by default. */
  | { kind: 'add'; entries: z.infer<typeof candidateInput>[]; at?: number }
  | { kind: 'remove'; id: string }
  | { kind: 'reorder'; ids: string[] }
  | { kind: 'location'; location: RunLocation }
  /** 优先使用的 Agent; rows of models both Agents run that were on the old one follow it. */
  | { kind: 'preferred'; harness: OrderHarness }
  /** One row's Agent, for a model both Agents run. */
  | { kind: 'harness'; id: string; harness: OrderHarness }

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
    if (change.kind === 'preferred') {
      const preferred = harnessSchema.parse(change.harness)
      await client.query(`INSERT INTO model_order_settings ("ownerId","workspaceId","preferredHarness") VALUES ($1,$2,$3)
        ON CONFLICT ("ownerId","workspaceId") DO UPDATE SET "preferredHarness"=EXCLUDED."preferredHarness","updatedAt"=now()`, [scope.ownerId, scope.workspaceId, preferred])
      // An untouched list follows at read time; a stored one moves the rows that were on the old preferred Agent.
      if (!current.customized || preferred === current.preferredHarness) { await client.query('COMMIT'); return }
      const agents = agentsByOffer(candidates)
      const have = new Set(current.entries.map(entryKey))
      const moved = current.entries.map(entry => {
        const both = (agents.get(offerKey(entry))?.length ?? 0) > 1
        const next = { ...entry, harness: preferred }
        return both && entry.harness === current.preferredHarness && !have.has(entryKey(next)) ? next : entry
      })
      for (const entry of moved) await client.query('UPDATE model_order_entries SET harness=$4 WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3', [entry.id, scope.ownerId, scope.workspaceId, entry.harness])
      await client.query('COMMIT')
      return
    }
    let entries = current.entries
    if (!current.customized) {
      // Store what the person saw, under real ids, before changing it.
      const ids = new Map(entries.map(entry => [entry.id, randomUUID()]))
      entries = entries.map(entry => ({ ...entry, id: ids.get(entry.id)! }))
      if (change.kind === 'remove' || change.kind === 'harness') change = { ...change, id: ids.get(change.id) ?? change.id }
      if (change.kind === 'reorder') change = { ...change, ids: change.ids.map(id => ids.get(id) ?? id) }
    }
    if (change.kind === 'add') {
      const available = new Map(candidates.map(candidate => [entryKey(candidate), candidate]))
      const have = new Set(entries.map(entryKey))
      const added: OrderEntry[] = []
      for (const raw of z.array(candidateInput).min(1).max(100).parse(change.entries)) {
        const key = entryKey(raw)
        if (!available.has(key)) throw new ActionFailureError('executionModelUnknown')
        if (!have.has(key)) { added.push({ id: randomUUID(), harness: raw.harness, model: raw.model, source: raw.source }); have.add(key) }
      }
      const at = change.at === undefined ? entries.length : Math.min(entries.length, z.number().int().min(0).parse(change.at))
      entries = [...entries.slice(0, at), ...added, ...entries.slice(at)]
    } else if (change.kind === 'harness') {
      // The same model and credential on the other Agent: it must be offered there, and not listed there already.
      const harness = harnessSchema.parse(change.harness), id = change.id
      const entry = entries.find(item => item.id === id)
      if (!entry) throw new ActionFailureError('executionRuleNotFound')
      const next = { ...entry, harness }
      if (!candidates.some(candidate => entryKey(candidate) === entryKey(next))) throw new ActionFailureError('executionModelUnknown')
      if (entries.some(item => item.id !== id && entryKey(item) === entryKey(next))) throw new ActionFailureError('executionRuleOrderInvalid')
      entries = entries.map(item => item.id === id ? next : item)
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
