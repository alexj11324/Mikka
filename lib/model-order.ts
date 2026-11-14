import 'server-only'
import { randomUUID } from 'node:crypto'
import { cloudModelSupport, type CloudModelState } from './cloud-template-models'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { deviceOnlineStates } from './device-presence'
import { deviceSchedulingView, type SchedulingNode } from './device-scheduling'
import type { HarnessInfo } from '@mikka/protocol/harness'
import { ActionFailureError } from './action-error'
import { apiKeyHarnesses } from './model-api-key-providers'
import { hasStaleOfficialAllowance, shownSubscriptionAvailability, subscriptionAvailability } from './subscription-quota'
import { providerHealthStates, providerSourceKey } from './model-provider-health'
import {
  agentsByOffer, defaultOrderByAgent, deviceModel, dispatchOrder, entryKey, latestDefaultCandidates, offerKey, onPreferredAgent, placeStage, planDispatch, whyNoDevice,
  type CredentialState, type DeviceStage, type NoDeviceWhy, type OrderCandidate, type OrderEntry, type OrderHarness, type PoolDevice, type RunLocation,
} from './model-order-plan'

/**
 * 模型与订阅 › 优先使用的模型 and 运行位置 (decision 2026-11-02-1400), per
 * person and workspace: what dispatch reads (lib/model-dispatch.ts) and what
 * the page shows and edits. Candidates are only what the person actually
 * has here: each connected subscription's catalogue (the models its account
 * reported) and each usable API key's /models list. An untouched list is the
 * default preference over those candidates (`defaultOrderByAgent`), never stored
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
    | { reason: 'checking' | 'quota' | 'expired' | 'paused' | 'missing' | 'removed' | 'modelGone' | 'keyRefused' | 'balance' | 'providerUnavailable'; resetsAt?: string | null }
    | { reason: 'noDevice'; device: NoDeviceWhy }
}

export interface OrderView {
  sponsoredTasksAvailable?: true
  /** Actual dispatch rank and availability, from the same planner as new runs. */
  dispatchOrder?: SchedulingNode[]
  location: RunLocation
  customized: boolean
  autoModelRouting: boolean
  /** 优先使用的 Agent: which Agent's own list is shown and tried first. */
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
  /**
   * The 运行位置 chain, in dispatch order: 云端 (only when it is the location), then servers,
   * then computers, each device with how far it is from taking a run and why not.
   */
  places: { cloud: 'ready' | 'noKey' | null; devices: { id: string; name: string; server: boolean; stage: DeviceStage; lastSeenAt: number | null }[] }
  /** 会先用: where a new run would go now, by the same plan as dispatch; null when nowhere. */
  first: { kind: 'cloud' } | { kind: 'device'; id: string; name: string; server: boolean } | null
  /** Devices that can run the same list now, including credential readiness. */
  readyDeviceIds: string[]

}

/** The prompt's display facts; never a model admission or dispatch authority. */
export type OrderContextView = Pick<OrderView, 'location' | 'preferredHarness' | 'entries' | 'candidates' | 'cloudReady' | 'cloudModels'>

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
  const rows = await settings.modelCandidates(scope, query)
  const { pooledOwners } = await import('./personal-policy')
  const { authorizeSubscriptionWorkspace } = await import('./subscription-runtime')
  // Sharing grants use in this workspace, never ownership of the account. Both parties must still
  // be active members; the owner is derived from server records, never an EntrySource supplied by a client.
  for (const ownerId of await pooledOwners(query, scope.ownerId, scope.workspaceId)) {
    try { await authorizeSubscriptionWorkspace(ownerId, scope.workspaceId) } catch { continue }
    rows.push(...await settings.modelCandidates({ ...scope, ownerId }, query))
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

/** A custom fixed Profile already names one source/model/harness. Recheck that
 * entry without enumerating unrelated accounts or choosing an alternative.
 * Default/inherited selection still uses orderCandidates and its full ordering.
 * This is a fresh candidate read, not a credential grant or cached admission. */
export async function selectedOrderCandidates(query: Query, scope: OrderScope, entry: OrderEntry): ReturnType<typeof orderCandidates> {
  if (!z.uuid().safeParse(sourceId(entry)).success) return []
  if (entry.source.kind === 'api_key') {
    const { usableApiKeys } = await import('./model-api-keys')
    return (await usableApiKeys(query, scope.ownerId, scope.workspaceId, entry.source.keyId))
      .filter(key => key.models.includes(entry.model) && apiKeyHarnesses(key).includes(entry.harness))
      .map(key => ({ harness: entry.harness, model: entry.model, name: entry.model,
        source: { kind: 'api_key' as const, keyId: key.id }, provider: key.provider, credentialOwnerId: key.ownerId }))
  }
  const { runMayUseCredentialSql } = await import('./personal-policy')
  // Derive the payor only from the exact source and its current workspace share.
  // The source owner's active membership is still checked before its catalogue.
  const { rows: [source] } = await query.query<{ ownerId: string }>(`SELECT c."ownerId" FROM byos_connections c
    WHERE c.id=$1 AND ${runMayUseCredentialSql('c."ownerId"', '$2', '$3')}`,
  [entry.source.connectionId, scope.ownerId, scope.workspaceId])
  if (!source) return []
  if (source.ownerId !== scope.ownerId) {
    const { authorizeSubscriptionWorkspace } = await import('./subscription-runtime')
    try { await authorizeSubscriptionWorkspace(source.ownerId, scope.workspaceId) } catch { return [] }
  }
  const { executionModelOptions } = await import('./execution-model-options')
  return (await executionModelOptions(query, { ...scope, ownerId: source.ownerId }, true,
    { connectionId: entry.source.connectionId, model: entry.model }))
    .map(row => ({ harness: (row.provider === 'codex' ? 'codex' : 'claude_code') as OrderHarness,
      model: String(row.modelId), name: String(row.modelId), source: { kind: 'subscription' as const, connectionId: String(row.connectionId) },
      provider: String(row.provider), credentialOwnerId: String(row.ownerId) }))
    .filter(candidate => entryKey(candidate) === entryKey(entry))
}

async function settingsRow(query: Query, scope: OrderScope) {
  const { rows: [row] } = await query.query<{ location: RunLocation; customized: boolean; preferredHarness: OrderHarness; autoModelRouting: boolean }>(
    'SELECT location,customized,"preferredHarness","autoModelRouting" FROM model_order_settings WHERE "ownerId"=$1 AND "workspaceId"=$2', [scope.ownerId, scope.workspaceId])
  return row ?? { location: 'cloud' as RunLocation, customized: false, preferredHarness: 'claude_code' as OrderHarness, autoModelRouting: true }
}

/** The allowed models in order: the stored list, or for an untouched list the default preference (ids are stable per entry). */
export async function readOrder(query: Query, scope: OrderScope, candidates?: (OrderCandidate & { provider: string })[]): Promise<{ location: RunLocation; customized: boolean; preferredHarness: OrderHarness; autoModelRouting: boolean; entries: OrderEntry[] }> {
  const settings = await settingsRow(query, scope)
  if (!settings.customized) {
    const available = latestDefaultCandidates(candidates ?? await orderCandidates(query, scope))
    const defaults = defaultOrderByAgent(available, settings.preferredHarness)
    // Include lighter reported models from the default credentials without
    // silently adding a different paid key. Turning routing off restores each
    // Agent's default list; saved lists remain exactly as set.
    const sources = new Set(defaults.map(item => `${item.source.kind}:${sourceId(item)}`))
    const extra = settings.autoModelRouting ? onPreferredAgent(available, settings.preferredHarness)
      .filter(item => sources.has(`${item.source.kind}:${sourceId(item)}`)) : []
    const list = [...new Map([...defaults, ...extra].map(item => [entryKey(item), item])).values()]
    // The entry is also frozen in a run's JSONB definition. Keep the NUL-separated
    // identity key in memory, but give its opaque row id a stable JSONB-safe form.
    return { ...settings, entries: list.map(item => ({ id: `default:${encodeURIComponent(entryKey(item))}`, harness: item.harness, model: item.model, source: item.source })) }
  }
  const { rows } = await query.query<EntryRow>(
    `SELECT e.id,e.harness,e.model,e."sourceKind",e."sourceId"::text AS "sourceId" FROM model_order_entries e
      LEFT JOIN byos_connections c ON e."sourceKind"='subscription' AND c.id=e."sourceId"
      LEFT JOIN model_api_keys k ON e."sourceKind"='api_key' AND k.id=e."sourceId"
      WHERE e."ownerId"=$1 AND e."workspaceId"=$2
      AND COALESCE((COALESCE(to_jsonb(c)->'modelSettings',to_jsonb(k)->'modelSettings')->'models'->e.model->>'enabled')::boolean,true)
      ORDER BY e.position,e.id`,
    [scope.ownerId, scope.workspaceId])
  return { ...settings, entries: rows.map(toEntry) }
}

export { dispatchOrder } from './model-order-plan'

export type RefreshOrderQuota = (scope: OrderScope, connectionId: string, signal: AbortSignal, credentialOwnerId?: string) => Promise<void>
const quotaRefreshes = new WeakMap<Query, Map<string, Promise<void>>>()
const refreshOrderQuota = (query: Query): RefreshOrderQuota => async (scope, connectionId, signal, credentialOwnerId = scope.ownerId) => {
  const service = (await import('./subscription-runtime')).subscriptionRuntime()
  await service.member(scope.ownerId, scope.workspaceId)
  await service.workspace(credentialOwnerId, scope.workspaceId)
  if (credentialOwnerId !== scope.ownerId && !(await (await import('./personal-policy')).othersMayUse(query, credentialOwnerId, scope.workspaceId))) throw new ActionFailureError('executionAccountUnavailable')
  await service.allowance(credentialOwnerId, connectionId, signal)
}

/** Each entry's credential, read now. Dispatch refreshes missing/stale allowance
 * once per connection; a final cloud claim can require a fresh usage check.
 * Settings can request a projection only. */
export async function credentialStates(query: Query, scope: OrderScope, entries: readonly OrderEntry[], candidates: readonly (OrderCandidate & { provider: string; credentialOwnerId?: string })[], now?: number, options: { probe?: boolean | 'always'; refresh?: RefreshOrderQuota; display?: boolean; deferStaleQuota?: true } = {}) {
  let checkedAt = now ?? Date.now()
  const available = new Set(candidates.map(entryKey))
  // Subscriptions whose account catalogue lists anything: only those can say a model has gone away.
  const listing = new Set(candidates.flatMap(candidate => candidate.source.kind === 'subscription' ? [candidate.source.connectionId] : []))
  const wanted = new Set(entries.map(entryKey))
  const authorizedCandidates = candidates.filter(candidate => wanted.has(entryKey(candidate)))
  const connectionIds = [...new Set(entries.flatMap(entry => entry.source.kind === 'subscription' ? [entry.source.connectionId] : []))]
  // Owners come only from the server's authorized candidates, never the
  // browser's stored order/source. The database verifies each (id, owner) pair.
  const owners = new Map(connectionIds.map(id => [id, scope.ownerId]))
  for (const candidate of candidates) if (candidate.source.kind === 'subscription' && connectionIds.includes(candidate.source.connectionId)) owners.set(candidate.source.connectionId, candidate.credentialOwnerId ?? scope.ownerId)
  // Any authorized candidate of a listed key, not only the listed model's: a key whose /models dropped that model is
  // still read, so the row can say 账号已不提供 rather than 未连接或不可用.
  const entryKeys = new Set(entries.flatMap(entry => entry.source.kind === 'api_key' ? [entry.source.keyId] : []))
  const keyOwners = new Map(candidates.flatMap(candidate => candidate.source.kind === 'api_key' && entryKeys.has(candidate.source.keyId)
    ? [[candidate.source.keyId, candidate.credentialOwnerId ?? scope.ownerId] as const] : []))
  const readConnections = async () => {
    const authorized = [] as [string, string][]
    for (const [id, owner] of owners) if (owner === scope.ownerId || await (await import('./personal-policy')).othersMayUse(query, owner, scope.workspaceId)) authorized.push([id, owner])
    return new Map((authorized.length ? (await query.query<{ id: string; ownerId: string; state: string; paused: boolean; quota: unknown; provider: 'claude' | 'codex'; epoch: string; removed: boolean }>(
      'SELECT c.id::text AS id,c."ownerId",c.state,c.paused,c.quota,c.provider,c.epoch::text AS epoch,c."removedAt" IS NOT NULL AS removed FROM byos_connections c JOIN unnest($1::text[],$2::text[]) AS authorized(id,owner) ON c.id::text=authorized.id AND c."ownerId"=authorized.owner', [authorized.map(([id]) => id), authorized.map(([, owner]) => owner)])).rows : []).map(row => [row.id, row]))
  }
  let connections = await readConnections()
  if (options.probe !== false) {
    const pending = quotaRefreshes.get(query) ?? new Map<string, Promise<void>>()
    quotaRefreshes.set(query, pending)
    await Promise.all([...connections.values()].filter(row => row.state === 'connected' && !row.paused && entries.some(entry =>
      entry.source.kind === 'subscription' && entry.source.connectionId === row.id && available.has(entryKey(entry))
      && (options.probe === 'always' || subscriptionAvailability(row.quota, entry.model, row.provider, checkedAt).status === 'checking'))).map(row => {
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
  const keys = new Map((keyOwners.size ? (await query.query<{ id: string; modelsError: string | null; provider: string }>(
    `SELECT k.id::text AS id,k."modelsError",k.provider FROM model_api_keys k
      JOIN unnest($1::text[],$2::text[]) AS authorized(id,owner) ON k.id::text=authorized.id AND k."ownerId"=authorized.owner
      WHERE k."ownerId"=$3 OR (EXISTS (SELECT 1 FROM model_api_key_shares sh WHERE sh."keyId"=k.id AND sh."workspaceId"::text=$4)
        AND NOT EXISTS (SELECT 1 FROM workspace_personal_policies p WHERE p."workspaceId"::text=$4 AND NOT p.subscriptions))`,
    [[...keyOwners.keys()], [...keyOwners.values()], scope.ownerId, scope.workspaceId])).rows : []).map(row => [row.id, row]))
  const health = await providerHealthStates(query, scope, authorizedCandidates, checkedAt)
  const states = new Map<string, { credential: CredentialState; provider: string; quotaCheckPending?: true }>()
  for (const entry of entries) {
    if (entry.source.kind === 'subscription') {
      const row = connections.get(entry.source.connectionId)
      const provider = row?.provider ?? (entry.harness === 'codex' ? 'codex' : 'claude')
      // Only the settings page shows a reading up to 15 minutes old; dispatch, Profiles and fallback keep the 60 s rule.
      const availability = (options.display ? shownSubscriptionAvailability : subscriptionAvailability)(row?.quota, entry.model, provider, checkedAt)
      // 已移除: a connection 移除 removed. 未连接或不可用: not connected (yet), gone, not shared with this person (any more),
      // or its account lists nothing; it says nothing more about a credential that is not theirs to read.
      // 账号已不提供: the account lists models, not this one any more.
      const credential: CredentialState = !row ? { usable: false, reason: 'missing' }
        : row.removed ? { usable: false, reason: 'removed' }
        : row.state === 'reconnect_required' ? { usable: false, reason: 'expired' }
          : row.paused ? { usable: false, reason: 'paused' }
            : row.state !== 'connected' ? { usable: false, reason: 'missing' }
              : !available.has(entryKey(entry)) ? { usable: false, reason: listing.has(entry.source.connectionId) ? 'modelGone' : 'missing' }
              : health.get(providerSourceKey(entry.source)) ?? health.get(entryKey(entry)) ?? (
                availability.status === 'exhausted' ? { usable: false, reason: 'quota', resetsAt: availability.resetsAt }
                : availability.status === 'checking' ? { usable: false, reason: 'checking' }
                : { usable: true })
      // Keep the credential refused. Only the group intent's read-only planner
      // can defer this specific stale allowance; admission still refreshes it.
      const quotaCheckPending = options.probe === false && options.deferStaleQuota && !credential.usable && credential.reason === 'checking'
        && hasStaleOfficialAllowance(row?.quota, entry.model, provider, checkedAt)
      states.set(entry.id, { credential, provider, ...(quotaCheckPending ? { quotaCheckPending: true as const } : {}) })
    } else {
      const row = keys.get(entry.source.keyId)
      const keyId = entry.source.keyId
      const credential: CredentialState = !row ? { usable: false, reason: 'missing' }
        : row.modelsError === 'invalid' ? { usable: false, reason: 'keyRefused' }
        // The provider's /models still answers, without this one (重新获取模型): kept in the list, marked.
        : !available.has(entryKey(entry)) ? { usable: false, reason: candidates.some(candidate => candidate.source.kind === 'api_key' && candidate.source.keyId === keyId) ? 'modelGone' : 'missing' }
          : health.get(providerSourceKey(entry.source)) ?? health.get(entryKey(entry)) ?? { usable: true }
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
export async function poolDevices(query: Query, ownerId: string): Promise<(PoolDevice & { lastSeenAt: number | null })[]> {
  const { rows } = await query.query<{ id: string; name: string; enabled: boolean; lastSeenAt: Date | null; harnesses: HarnessInfo[] | null; deviceType: string | null; createdAt: Date; activeRuns: number }>(
    `SELECT d.id,d.name,d.enabled,d."lastSeenAt",d.harnesses,d."deviceType",d."createdAt",
      (SELECT count(*)::int FROM agent_runs r WHERE r."deviceId"=d.id AND r.status IN ('queued','preparing','running','paused','waiting_input','finishing')) AS "activeRuns"
    FROM devices d WHERE d."ownerId"=$1 AND d.kind='local' AND d."removedAt" IS NULL ORDER BY d."lastSeenAt" DESC NULLS LAST,d.id`, [ownerId])
  const presence = await deviceOnlineStates(rows)
  return rows.map(row => ({
    id: row.id, name: row.name, enabled: row.enabled, online: presence.get(row.id) ?? false, harnesses: row.harnesses ?? [],
    server: row.deviceType === 'server', activeRuns: row.activeRuns, joinedAt: row.createdAt.getTime(), lastSeenAt: row.lastSeenAt?.getTime() ?? null,
  }))
}

/** The page: credentials' candidates, the list with each entry's status, and 运行位置.
 * A display caller may share its own device read; execution/dispatch never consumes this projection. */
export function orderView(query: Query, scope: OrderScope, readDevices?: () => Promise<PoolDevice[]>): Promise<OrderView>
export function orderView(query: Query, scope: OrderScope, readDevices: (() => Promise<PoolDevice[]>) | undefined, projection: 'context'): Promise<OrderContextView>
export async function orderView(query: Query, scope: OrderScope, readDevices: () => Promise<PoolDevice[]> = () => poolDevices(query, scope.ownerId), projection?: 'context'): Promise<OrderView | OrderContextView> {
  const candidates = await orderCandidates(query, scope)
  const order = await readOrder(query, scope, candidates)
  const states = await credentialStates(query, scope, order.entries, candidates, Date.now(), { probe: false, display: true })
  const devices = await readDevices()
  const added = new Set(order.entries.map(entryKey))
  const agents = agentsByOffer(candidates)
  let credentials: number | undefined
  // Only Settings consumes this count. Prompt facts already derive their
  // credential kinds from the freshly authorized candidates above.
  if (projection !== 'context') {
    const { usableApiKeys } = await import('./model-api-keys')
    const { rows: connected } = await query.query<{ id: string }>(`SELECT id::text AS id FROM byos_connections WHERE "ownerId"=$1 AND state='connected'`, [scope.ownerId])
    const subscriptions = new Set([...connected.map(row => row.id), ...candidates.flatMap(candidate => candidate.source.kind === 'subscription' ? [candidate.source.connectionId] : [])])
    credentials = subscriptions.size + (await usableApiKeys(query, scope.ownerId, scope.workspaceId)).length
  }
  // 会先用 and the ready devices follow dispatch: the 优先使用的 Agent's list first.
  const runnable = dispatchOrder(order.entries, order.preferredHarness)
  const ready = order.location === 'cloud' && await (await import('./rule-dispatch')).cloudReady(query, { ...scope, botId: null, harness: runnable[0]?.harness ?? 'claude_code' })
  const credential = (entry: OrderEntry) => states.get(entry.id)?.credential ?? { usable: false, reason: 'missing' } as const
  // 会先用: what dispatch would pick for a new run now, from the same plan.
  const cloudModels = Object.fromEntries(order.entries.map(entry => [entry.id, cloudModelSupport(entry)]))
  const plan = planDispatch({ entries: runnable, location: order.location, devices, credential, cloudReady: ready, cloudModel: entry => cloudModels[entry.id] })
  const firstDevice = plan.kind === 'device' ? devices.find(device => device.id === plan.deviceId) : undefined
  const context: OrderContextView = {
    location: order.location,
    preferredHarness: order.preferredHarness,
    cloudReady: ready,
    cloudModels,
    entries: order.entries.map(entry => {
      const state = states.get(entry.id)!
      // 云端 that runs takes every model; otherwise a server or a computer must.
      const block: OrderRow['block'] = !state.credential.usable ? { reason: state.credential.reason, ...(state.credential.resetsAt ? { resetsAt: state.credential.resetsAt } : {}) }
        : !(ready && cloudModels[entry.id] === 'ready') && !devices.some(device => deviceModel(device, entry)) ? { reason: 'noDevice', device: whyNoDevice(devices, entry) } : null
      return { ...entry, provider: state.provider, agents: agents.get(offerKey(entry)) ?? [entry.harness], block }
    }),
    candidates: candidates.map(candidate => ({ ...candidate, added: added.has(entryKey(candidate)) })),
  }
  if (projection === 'context') return context
  return {
    dispatchOrder: deviceSchedulingView({ location: order.location, entries: runnable, devices, credential, cloudReady: ready, cloudModel: entry => cloudModels[entry.id] }),
    location: order.location,
    customized: order.customized,
    autoModelRouting: order.autoModelRouting,
    preferredHarness: order.preferredHarness,
    credentials: credentials!,
    devices: devices.filter(device => device.enabled).length,
    cloudReady: ready,
    cloudModels,
    places: {
      cloud: order.location === 'cloud' ? ready ? 'ready' : 'noKey' : null,
      devices: [...devices].sort((a, b) => Number(b.server) - Number(a.server)).map(device => {
        const lastSeenAt = device.lastSeenAt instanceof Date ? device.lastSeenAt.getTime() : typeof device.lastSeenAt === 'number' ? device.lastSeenAt : Date.parse(device.lastSeenAt ?? '')
        return { id: device.id, name: device.name, server: device.server,
          stage: placeStage(device, runnable.filter(entry => credential(entry).usable), order.preferredHarness), lastSeenAt: Number.isFinite(lastSeenAt) ? lastSeenAt : null }
      }),
    },
    first: plan.kind === 'cloud' ? { kind: 'cloud' } : firstDevice ? { kind: 'device', id: firstDevice.id, name: firstDevice.name, server: firstDevice.server } : null,
    readyDeviceIds: devices.filter(device => planDispatch({ entries: runnable, location: 'local', devices: [device], credential, cloudReady: false }).kind === 'device').map(device => device.id),
    entries: context.entries,
    candidates: context.candidates,
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
  /** The whole list, or one Agent's rows in their new order. */
  | { kind: 'reorder'; ids: string[] }
  | { kind: 'location'; location: RunLocation }
  | { kind: 'autoRouting'; enabled: boolean }
  /** 优先使用的 Agent: which Agent's list the page shows and dispatch runs; no row moves. */
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
    if (change.kind === 'autoRouting') {
      const enabled = z.boolean().parse(change.enabled)
      await client.query(`INSERT INTO model_order_settings ("ownerId","workspaceId","autoModelRouting") VALUES ($1,$2,$3)
        ON CONFLICT ("ownerId","workspaceId") DO UPDATE SET "autoModelRouting"=EXCLUDED."autoModelRouting","updatedAt"=now()`, [scope.ownerId, scope.workspaceId, enabled])
      await client.query('COMMIT')
      return
    }
    if (change.kind === 'preferred') {
      const preferred = harnessSchema.parse(change.harness)
      await client.query(`INSERT INTO model_order_settings ("ownerId","workspaceId","preferredHarness") VALUES ($1,$2,$3)
        ON CONFLICT ("ownerId","workspaceId") DO UPDATE SET "preferredHarness"=EXCLUDED."preferredHarness","updatedAt"=now()`, [scope.ownerId, scope.workspaceId, preferred])
      // Each Agent keeps its own rows and order; switching only picks which list the page shows and dispatch runs.
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
      if (new Set(ids).size !== ids.length || ids.some(id => !entries.some(entry => entry.id === id))) throw new ActionFailureError('executionRuleOrderInvalid')
      // One Agent's list (the page shows one at a time): its rows take each other's places; the other Agent's stay put.
      const moved = new Set(ids)
      const harness = entries.find(entry => entry.id === ids[0])?.harness
      const whole = ids.length === entries.length
      if (!whole && (entries.some(entry => entry.harness === harness) && entries.filter(entry => entry.harness === harness).length !== ids.length
        || ids.some(id => entries.find(entry => entry.id === id)!.harness !== harness))) throw new ActionFailureError('executionRuleOrderInvalid')
      const next = ids.map(id => entries.find(entry => entry.id === id)!)
      entries = whole ? next : entries.map(entry => moved.has(entry.id) ? next.shift()! : entry)
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
