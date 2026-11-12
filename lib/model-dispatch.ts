import 'server-only'
import { createHash } from 'node:crypto'
import { cloudModelSupport } from './cloud-template-models'
import type { Pool } from 'pg'
import { defaultAgentCopy } from './agent-copy'
import messages from '@/messages/zh-CN.json'
import type { SubscriptionPreflightFailure } from '@mikka/protocol/harness'
import { cloudReady } from './rule-dispatch'
import { credentialStates, dispatchOrder, orderCandidates, selectedOrderCandidates, poolDevices, readOrder, type OrderScope, type RefreshOrderQuota } from './model-order'
import { entryKey, planDispatch, whyNoDevice, type NoDeviceWhy, type NothingReason, type OrderEntry, type RunLocation, type SkippedEntry } from './model-order-plan'
import { modelTier, supportedModelEfforts, type ModelRoutingSnapshot } from './model-routing'
import { routeModelCandidates, type ModelRoutingContext } from './model-routing-server'
import type { invokeDecision } from './coordinator/decide'

/**
 * Where a new run goes and on which model (decision 2026-11-02-1400): the
 * thread's own model when the person picked one, else 优先使用的模型 in order;
 * the first that can run now. 云端 (the default) is the person's own E2B
 * machine, then a server, then a computer; 本地 a server, then a computer
 * (decision 2026-11-02-2330); among one kind the least busy (pickDevice). A run
 * the person put in the cloud (`location` cloud) goes nowhere else. Nothing can run: the
 * 没有能跑这个任务的模型 card with the reason. The plan is pure
 * (lib/model-order-plan.ts); this reads what it needs.
 *
 * A computer the person named (`deviceId`) fixes only where the run goes: the
 * model is chosen the same way, among what that computer can run. Nothing it
 * can run: the card says what it lacks; no other Agent is put in its place.
 */
/** Why nothing runs: the list's reasons, or the model the thread named (decision 2026-11-02-1400). */
export type DispatchNothingReason = NothingReason | 'cloudTemporarilyUnavailable' | 'notOffered' | 'namedDevice' | 'pickedNoDevice' | 'pickedUnavailable'
export type ModelDispatch =
  | { kind: 'device'; deviceId: string; agentId: string; model: string; entry: OrderEntry; subscriptionBindingId?: string; routing?: ModelRoutingSnapshot; quotaCheckPending?: true }
  | { kind: 'cloud'; harness: OrderEntry['harness']; model: string; entry: OrderEntry; apiKey: boolean; routing?: ModelRoutingSnapshot; quotaCheckPending?: true }
  | { kind: 'none'; reason: DispatchNothingReason; card: ReturnType<typeof modelUnavailableCard>; skipped?: SkippedEntry[] }

/**
 * The Agent or model a Bot passed for a new thread must be one of 优先使用的模型: the same list its prompt shows
 * (lib/coordinator/execution-context.ts modelListText). A model only a credential offers, or an Agent with no entry,
 * is refused before anything is queued. Null when it is listed, or when nothing was named (the list's first runnable entry).
 */
export async function modelNotAllowed(pool: Pool, scope: OrderScope, asked?: { harness: OrderEntry['harness']; model?: string } | null): Promise<{ error: 'modelNotAllowed'; asked: { harness: OrderEntry['harness']; model?: string }; allowed: { harness: OrderEntry['harness']; model: string }[] } | null> {
  if (!asked) return null
  await new (await import('./execution-settings')).ExecutionSettings(pool).ensureCatalogues(scope)
  const { entries } = await readOrder(pool, scope)
  if (entries.some(entry => entry.harness === asked.harness && (!asked.model || entry.model === asked.model))) return null
  return { error: 'modelNotAllowed', asked, allowed: entries.map(entry => ({ harness: entry.harness, model: entry.model })) }
}

export async function resolveModelDispatch(pool: Pool, scope: OrderScope & { botId: string | null }, asked?: { harness: OrderEntry['harness']; model?: string } | null, location?: RunLocation, deviceId?: string, dependencies: {
  cloudPurpose?: import('./cloud-template-models').CloudModelPurpose; refreshQuota?: RefreshOrderQuota
  /** Host-only placement constraint: the Agent is already chosen, but its model still follows preferences. */
  harness?: OrderEntry['harness']
  /** Host-only continuation fence: a task never cycles through failed entries again. */
  excludeEntryKeys?: readonly string[]
  /** Host-selected profile source; still verified against authorized candidates. */
  exactEntry?: OrderEntry
  /** Candidate enumeration is read-only: bind only the selected Agent. */
  bindSubscription?: boolean
  probeQuota?: boolean
  skipCatalogueRefresh?: boolean
  /** Group intent only: never a dispatch option or a grant of fresh quota. */
  deferStaleQuota?: true
  /** An explicitly named physical Agent is never replaced by another one. */
  agentId?: string
  /** The cloud already failed to start this run: a server or a computer only. */
  withoutCloud?: boolean
  /** Actual task dispatch only. Catalogue/settings/availability reads omit it. */
  routing?: ModelRoutingContext
  decision?: typeof invokeDecision
} = {}): Promise<ModelDispatch> {
  // A subscription never asked for its models offers none yet: ask it first (once per revision).
  if (!dependencies.skipCatalogueRefresh) await new (await import('./execution-settings')).ExecutionSettings(pool).ensureCatalogues(scope)
  const exact = dependencies.exactEntry
  // A host-frozen source cannot fall through to another account. A harness-only
  // request still needs the full preference list to resolve its unspecified model.
  const candidates = exact && (!asked || asked.model)
    ? await selectedOrderCandidates(pool, scope, exact) : await orderCandidates(pool, scope)
  const stored = await readOrder(pool, scope, candidates)
  // The person named only the Agent ("派给 Codex"): its first model in 优先使用的模型, else the first one a connected credential offers on it.
  const agentModel = asked && !asked.model ? (stored.entries.find(entry => entry.harness === asked.harness) ?? candidates.find(candidate => candidate.harness === asked.harness))?.model : undefined
  if (asked && !asked.model && !agentModel) return { kind: 'none', reason: 'notOffered', card: modelUnavailableCard('notOffered', { agent: HARNESS_NAMES[asked.harness], model: '' }) }
  const explicit = asked ? { harness: asked.harness, model: asked.model || agentModel! } : null
  // A named computer, or a run the person put in the cloud, goes only there.
  const places = deviceId || dependencies.withoutCloud ? 'local' as const : location === 'cloud' ? 'cloudOnly' as const : location ?? stored.location
  const excluded = new Set(dependencies.excludeEntryKeys)
  const allowedAgent = (entry: Pick<OrderEntry, 'harness'>) => (!dependencies.harness || entry.harness === dependencies.harness)
    && (!asked?.harness || entry.harness === asked.harness)
  // With no Agent named, the 优先使用的 Agent's own list first, then the other's (decision 2026-11-05-0400).
  const order = { ...stored, entries: dispatchOrder(stored.entries, stored.preferredHarness).filter(entry => allowedAgent(entry) && !excluded.has(entryKey(entry))), location: places }
  // A model the thread named: the first credential that offers it on that Agent (its own entry if it is listed).
  if (exact && (!allowedAgent(exact) || (explicit && (explicit.harness !== exact.harness || explicit.model !== exact.model)) || !candidates.some(candidate => entryKey(candidate) === entryKey(exact)))) return { kind: 'none', reason: 'notOffered', card: modelUnavailableCard('notOffered', { agent: HARNESS_NAMES[exact.harness], model: exact.model }) }
  const canRoute = Boolean(dependencies.routing && stored.autoModelRouting && !asked?.model && !exact)
  // Naming an Agent alone has always permitted its first reported model when
  // its list is empty. Routing must not turn that explicit request into noModels.
  if (canRoute && asked && !asked.model && !order.entries.length) {
    const fallback = candidates.find(candidate => allowedAgent(candidate) && candidate.model === agentModel)
    if (fallback) order.entries.push({ id: `thread:${fallback.harness}:${fallback.model}`, harness: fallback.harness, model: fallback.model, source: fallback.source })
  }
  const picked = exact ?? (explicit && !canRoute ? order.entries.find(entry => entry.harness === explicit.harness && entry.model === explicit.model)
    ?? candidates.filter(candidate => allowedAgent(candidate) && candidate.harness === explicit.harness && candidate.model === explicit.model)
      .map(candidate => ({ id: `thread:${candidate.harness}:${candidate.model}`, harness: candidate.harness, model: candidate.model, source: candidate.source }))[0] : undefined)
  const named = explicit && !canRoute ? { agent: HARNESS_NAMES[explicit.harness], model: explicit.model } : null
  // The thread's model is the only one tried: no subscription or key offers it on that Agent, so nothing runs and the card says so.
  if (named && !picked) return { kind: 'none', reason: 'notOffered', card: modelUnavailableCard('notOffered', named) }
  const entries = picked ? [picked] : order.entries
  const deferStaleQuota = dependencies.deferStaleQuota === true && dependencies.probeQuota === false
    && dependencies.bindSubscription === false && dependencies.skipCatalogueRefresh === true && !dependencies.routing
  const states = await credentialStates(pool, scope, entries, candidates, undefined, { refresh: dependencies.refreshQuota, probe: dependencies.probeQuota, ...(deferStaleQuota ? { deferStaleQuota: true } : {}) })
  const devices = places !== 'cloudOnly' ? (await poolDevices(pool, scope.ownerId)).filter(device => !deviceId || device.id === deviceId) : []
  const ready = places !== 'local' && await cloudReady(pool, { ownerId: scope.ownerId, workspaceId: scope.workspaceId, botId: scope.botId, harness: entries[0]?.harness ?? 'claude_code' }, dependencies.cloudPurpose)
  // Deferring a positive old allowance does not establish failure or permit a
  // later source. Keep the dispatch spending fence through that pending entry.
  const pendingAt = deferStaleQuota ? entries.findIndex(entry => states.get(entry.id)?.quotaCheckPending) : -1
  const plannedEntries = pendingAt < 0 ? entries : entries.slice(0, pendingAt + 1)
  let plan = planDispatch({ entries: picked ? [] : plannedEntries, explicit: picked ?? null, location: order.location, devices, credential: entry => {
    const state = states.get(entry.id)
    return deferStaleQuota && state?.quotaCheckPending ? { usable: true } : state?.credential ?? { usable: false, reason: 'missing' }
  }, cloudReady: ready, cloudModel: entry => cloudModelSupport(entry, dependencies.cloudPurpose) })
  let routing: ModelRoutingSnapshot | undefined
  if (canRoute && dependencies.routing) {
    const harnesses = [...new Set(entries.map(entry => entry.harness))]
    const readiness = new Map(await Promise.all(harnesses.map(async harness => [harness,
      harness === entries[0]?.harness ? ready : places !== 'local' && await cloudReady(pool, { ...scope, harness }, dependencies.cloudPurpose)] as const)))
    const { rows: agents } = devices.length ? await pool.query<{ id: string; deviceId: string; harness: string }>(
      'SELECT id,"deviceId",harness FROM agents WHERE "userId"=$1 AND "deviceId"=ANY($2::uuid[]) AND ($3::text IS NULL OR id::text=$3)',
      [scope.ownerId, devices.map(device => device.id), dependencies.agentId ?? null]) : { rows: [] }
    // Preserve planDispatch's spending fence: an unchecked subscription is
    // not evidence that a later paid key should be used instead.
    const checkingAt = entries.findIndex(entry => {
      const credential = states.get(entry.id)?.credential
      return credential && !credential.usable && credential.reason === 'checking'
    })
    const eligibleEntries = checkingAt < 0 ? entries : entries.slice(0, checkingAt)
    const runnable = eligibleEntries.flatMap(entry => {
      const candidate = planDispatch({ entries: [], explicit: entry, location: order.location,
        devices: devices.filter(device => agents.some(agent => agent.deviceId === device.id && agent.harness === entry.harness)),
        credential: item => states.get(item.id)?.credential ?? { usable: false, reason: 'missing' },
        cloudReady: readiness.get(entry.harness) ?? false, cloudModel: item => cloudModelSupport(item, dependencies.cloudPurpose) })
      return candidate.kind === 'none' ? [] : [{ entry, plan: candidate }]
    })
    // An inherited preferred Agent is tried first; the other Agent's list is
    // a fallback. Explicit/profile harness constraints were applied above.
    const preferred = runnable.filter(item => item.entry.harness === stored.preferredHarness)
    const routingPool = preferred.length ? preferred : runnable
    const selected = await routeModelCandidates(pool, scope, routingPool.map(item => item.entry), dependencies.routing, stored.autoModelRouting, dependencies.decision)
    if (selected) {
      const position = Number(selected.id.slice('candidate:'.length))
      // A failed/uncertain judge preserves the existing placement preference
      // too: a later model on a server still precedes one on a laptop.
      const orderedEntry = plan.kind === 'none' ? undefined : plan.entry
      const ordered = orderedEntry && runnable.find(item => entryKey(item.entry) === entryKey(orderedEntry))
      const keepOrdered = selected.snapshot.reason !== 'difficulty_fit' && selected.snapshot.reason !== 'escalated'
        && !(dependencies.routing.escalate && dependencies.routing.previous)
        && ordered && (!dependencies.routing.effort || supportedModelEfforts(ordered.entry.model, ordered.entry.harness).includes(dependencies.routing.effort))
      const chosen = keepOrdered ? ordered : routingPool[position]
      if (chosen) {
        plan = chosen.plan
        routing = { ...selected.snapshot, model: plan.model, harness: chosen.entry.harness, tier: modelTier(plan.model) }
      }
    }
  }
  if (plan.kind === 'none' && deviceId && devices[0] && plan.reason === 'noDevice') {
    // What the named computer lacks for the model that would otherwise run (the thread's own model when it named one).
    const wanted = picked ?? plan.skipped.find(item => item.block.reason === 'noDevice')?.entry ?? order.entries[0]
    const installed = devices[0].harnesses.some(item => item.harness === wanted.harness && item.installed)
    const detail = wanted.source.kind === 'subscription' ? devices[0].harnesses.find(info => info.harness === wanted.harness)?.subscriptionPreflight : undefined
    return { kind: 'none', reason: 'namedDevice', card: modelUnavailableCard('namedDevice', { agent: HARNESS_NAMES[wanted.harness], model: wanted.model, installed, detail }) }
  }
  if (plan.kind === 'none' && plan.reason === 'noDevice' && !named) {
    // 云端 with a key that should run: the cloud being off is the news, not the computers.
    const keyFixes = places === 'cloud' && !ready && await e2bKeyWouldFix(pool, scope.ownerId)
    if (places === 'cloud' && !ready && !keyFixes) return { kind: 'none', reason: 'cloudTemporarilyUnavailable', card: modelUnavailableCard('cloudTemporarilyUnavailable') }
    // What the computer closest to running the first allowed model lacks.
    const first = plan.skipped.find(item => item.block.reason === 'noDevice')!.entry
    return { kind: 'none', reason: 'noDevice', card: modelUnavailableCard('noDevice', { agent: HARNESS_NAMES[first.harness], model: first.model, device: whyNoDevice(devices, first) }, { offerE2B: keyFixes }) }
  }
  if (plan.kind === 'none' && named && plan.reason !== 'cloudNotConfigured' && plan.reason !== 'checking' && plan.reason !== 'cloudModelsUnknown' && plan.reason !== 'cloudModelNotReported') {
    const reason = plan.reason === 'noDevice' ? 'pickedNoDevice' : 'pickedUnavailable'
    return { kind: 'none', reason, card: modelUnavailableCard(reason, { ...named, ...(plan.reason === 'noDevice' && picked ? { device: whyNoDevice(devices, picked) } : {}) }) }
  }
  if (plan.kind === 'none') return { kind: 'none', reason: plan.reason, card: modelUnavailableCard(plan.reason), skipped: plan.skipped }
  const quotaCheckPending = deferStaleQuota && states.get(plan.entry.id)?.quotaCheckPending ? { quotaCheckPending: true as const } : {}
  if (plan.kind === 'cloud') return { kind: 'cloud', harness: plan.entry.harness, model: plan.model, entry: plan.entry, apiKey: plan.entry.source.kind === 'api_key', ...(routing ? { routing } : {}), ...quotaCheckPending }
  const { rows: [agent] } = await pool.query<{ id: string }>('SELECT id FROM agents WHERE "userId"=$1 AND "deviceId"=$2 AND harness=$3 AND ($4::text IS NULL OR id::text=$4) ORDER BY "createdAt",id LIMIT 1',
    [scope.ownerId, plan.deviceId, plan.entry.harness, dependencies.agentId ?? null])
  if (!agent) return { kind: 'none', reason: 'noDevice', card: modelUnavailableCard('noDevice') }
  const subscriptionBindingId = dependencies.bindSubscription !== false && plan.entry.source.kind === 'subscription' ? await bindAgentToConnection(pool, scope, agent.id, plan.entry.harness, plan.entry.source.connectionId, plan.entry.model) : undefined
  return { kind: 'device', deviceId: plan.deviceId, agentId: agent.id, model: plan.model, entry: plan.entry, ...(subscriptionBindingId ? { subscriptionBindingId } : {}), ...(routing ? { routing } : {}), ...quotaCheckPending }
}

/**
 * The run's subscription is the entry's: return its exact binding id for
 * queue-time authorization, independent of another task's later choice for
 * this Agent. The id is fixed per Agent, connection, its revision
 * and model, so switching back and forth reuses the same rows (it is only made
 * the latest again); a binding is never moved to another revision, so a run
 * frozen on an old one stays refused after a reconnect.
 */
export async function bindAgentToConnection(pool: Pick<Pool, 'query'>, scope: OrderScope, agentId: string, harness: OrderEntry['harness'], connectionId: string, model: string) {
  const route = harness === 'codex' ? 'codex_cli' : 'claude_code_cli'
  const { runMayUseCredentialSql } = await import('./personal-policy')
  const { rows: [connection] } = await pool.query<{ epoch: string; ownerId: string }>(
    `SELECT c.epoch::text AS epoch,c."ownerId" FROM byos_connections c WHERE c.id::text=$1 AND c.state='connected' AND c.paused=false
      AND c.provider=$4 AND ${runMayUseCredentialSql('c."ownerId"', '$2', '$3')}
      AND EXISTS (SELECT 1 FROM agents a WHERE a.id::text=$5 AND a."userId"=$2 AND a.harness=$6)`,
    [connectionId, scope.ownerId, scope.workspaceId, harness === 'codex' ? 'codex' : 'claude', agentId, harness])
  if (!connection) throw new (await import('./action-error')).ActionFailureError('executionAccountUnavailable')
  if (connection.ownerId !== scope.ownerId) {
    const { authorizeSubscriptionWorkspace } = await import('./subscription-runtime')
    await authorizeSubscriptionWorkspace(scope.ownerId, scope.workspaceId)
    await authorizeSubscriptionWorkspace(connection.ownerId, scope.workspaceId)
  }
  const { rows: [latest] } = await pool.query<{ id: string; connectionId: string; modelId: string; connectionRevision: string; workspaceId: string }>(
    'SELECT id,"connectionId"::text AS "connectionId","modelId","connectionRevision"::text AS "connectionRevision","workspaceId" FROM byos_bindings WHERE "ownerId"=$1 AND "consumerId"=$2 AND route=$3 ORDER BY "createdAt" DESC,id DESC LIMIT 1',
    [connection.ownerId, agentId, route])
  if (latest && latest.connectionId === connectionId && latest.modelId === model && latest.connectionRevision === connection.epoch && latest.workspaceId === scope.workspaceId) return latest.id
  const hash = createHash('sha256').update(JSON.stringify(['model-order-binding', connection.ownerId, scope.workspaceId, agentId, route, connectionId, connection.epoch, model])).digest('hex')
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
  const inserted = await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId","createdAt")
    SELECT $1,$2,$3,$4,c.id,c.epoch,$5,$6,clock_timestamp() FROM byos_connections c WHERE c.id::text=$7 AND c."ownerId"=$2 AND c.state='connected' AND c.paused=false AND c.epoch::text=$8
      AND ${runMayUseCredentialSql('c."ownerId"', '$9', '$3')}
    ON CONFLICT (id) DO UPDATE SET "createdAt"=clock_timestamp() RETURNING id`,
  [id, connection.ownerId, scope.workspaceId, agentId, route, model, connectionId, connection.epoch, scope.ownerId])
  if (!inserted.rowCount) throw new (await import('./action-error')).ActionFailureError('executionAccountUnavailable')
  return id
}

/** No E2B key of their own, or one E2B refused: 填入 E2B Key would let 云端 run. A failed read offers nothing. */
async function e2bKeyWouldFix(query: Pick<Pool, 'query'>, ownerId: string) {
  const { ownE2BKeySql } = await import('./secrets/e2b-owner-sql')
  try {
    const { rows: [row] } = await query.query<{ fixes: boolean }>(`SELECT NOT ${ownE2BKeySql('$1::text')} OR EXISTS (SELECT 1 FROM user_e2b_keys uk WHERE uk."userId"=$1::text AND uk."lastErrorCode"='invalid') AS fixes`, [ownerId])
    return row?.fixes === true
  } catch { return false }
}

const HARNESS_NAMES: Record<OrderEntry['harness'], string> = { claude_code: 'Claude Code', codex: 'Codex' }

/** 没有能跑这个任务的模型: the reason, and the rows that fix it. A model or computer the thread named is named in it. */
export function modelUnavailableCard(reason: DispatchNothingReason, named?: { agent: string; model: string; installed?: boolean; device?: NoDeviceWhy; detail?: SubscriptionPreflightFailure }, place: { /** 云端 without a cloud that runs: an E2B key would also fix it. */ offerE2B?: boolean } = {}) {
  const copy = defaultAgentCopy
  const line = {
    noModels: copy.needsModelNoModels, cloudNotConfigured: copy.needsModelCloud, cloudModelsUnknown: copy.needsModelCloudModelsUnknown, cloudModelNotReported: copy.needsModelCloudModelNotReported, cloudTemporarilyUnavailable: copy.needsModelCloudUnavailable, noDevice: noDeviceLine(named?.device), checking: copy.needsModelChecking, unavailable: copy.needsModelUnavailable,
    // Installed but nothing it can run: a subscription model on a Mikka too old to take a subscription run.
    notOffered: copy.needsModelNotOffered, namedDevice: named?.installed ? copy.needsModelDeviceUpdate : copy.needsModelDeviceAgent,
    pickedNoDevice: copy.needsModelPickedNoDevice, pickedUnavailable: copy.needsModelPickedUnavailable,
  }[reason]
  const detail = named?.detail ?? (named?.device?.why === 'subscriptionRuntimeUnavailable' ? named.device.detail : undefined)
  const description = (detail ? messages.RunErrors.subscription_local_runtime_unavailable[detail]
    : reason === 'notOffered' && named && !named.model ? copy.needsModelAgentNotOffered : line).replace('{agent}', named?.agent ?? '').replace('{model}', named?.model ?? '')
    .replace('{device}', named?.device && named.device.why !== 'none' ? named.device.device : '')
  const options = reason === 'cloudNotConfigured'
    ? [{ value: 'e2b', label: copy.needsMachineE2B, action: 'e2bKey' as const }, { value: 'models', label: copy.needsModelSettings, action: 'modelSettings' as const }]
    : reason === 'noDevice' || reason === 'pickedNoDevice'
      ? [{ value: 'computer', label: copy.needsMachineConnect, action: 'connectServer' as const },
        ...(place.offerE2B ? [{ value: 'e2b', label: copy.needsMachineE2B, action: 'e2bKey' as const }] : []),
        { value: 'models', label: copy.needsModelSettings, action: 'modelSettings' as const }]
      : [{ value: 'models', label: copy.needsModelSettings, action: 'modelSettings' as const }]
  return { title: copy.needsModelTitle, description, options }
}

/** 优先使用的模型都没有电脑能跑, or what the one computer closest to running it lacks. */
function noDeviceLine(device?: NoDeviceWhy) {
  const copy = defaultAgentCopy
  if (!device) return copy.needsModelNoDevice
  if (device.why === 'none') return copy.needsModelNoComputer
  if (device.why === 'subscriptionRuntimeUnavailable') return device.detail ? messages.RunErrors.subscription_local_runtime_unavailable[device.detail] : messages.RunErrors.subscription_local_runtime_unavailable.default
  if (device.count !== 1) return copy.needsModelNoDevice
  return { off: copy.needsModelNamedOff, offline: copy.needsModelNamedOffline, notInstalled: copy.needsModelNamedAgent, needsUpdate: copy.needsModelNamedUpdate }[device.why]
}
