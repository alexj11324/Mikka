import 'server-only'
import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { defaultAgentCopy } from './agent-copy'
import { cloudReady } from './rule-dispatch'
import { credentialStates, orderCandidates, poolDevices, readOrder, type OrderScope } from './model-order'
import { planDispatch, whyNoDevice, type NoDeviceWhy, type NothingReason, type OrderEntry, type RunLocation } from './model-order-plan'

/**
 * Where a new run goes and on which model (decision 2026-11-02-1400): the
 * thread's own model when the person picked one, else 允许使用的模型 in order;
 * the first that can run now. 本地 picks one of the devices that can run it
 * (servers first, then the least busy; pickDevice); 云端 runs on the person's own E2B machine. Nothing can run: the
 * 没有能跑这个任务的模型 card with the reason. The plan is pure
 * (lib/model-order-plan.ts); this reads what it needs.
 *
 * A computer the person named (`deviceId`) fixes only where the run goes: the
 * model is chosen the same way, among what that computer can run. Nothing it
 * can run: the card says what it lacks; no other Agent is put in its place.
 */
/** Why nothing runs: the list's reasons, or the model the thread named (decision 2026-11-02-1400). */
export type DispatchNothingReason = NothingReason | 'notOffered' | 'namedDevice' | 'pickedNoDevice' | 'pickedUnavailable'
export type ModelDispatch =
  | { kind: 'device'; deviceId: string; agentId: string; model: string; entry: OrderEntry }
  | { kind: 'cloud'; harness: OrderEntry['harness']; model: string; entry: OrderEntry; apiKey: boolean }
  | { kind: 'none'; reason: DispatchNothingReason; card: ReturnType<typeof modelUnavailableCard> }

export async function resolveModelDispatch(pool: Pool, scope: OrderScope & { botId: string | null }, explicit?: { harness: OrderEntry['harness']; model: string } | null, location?: RunLocation, deviceId?: string): Promise<ModelDispatch> {
  // A subscription never asked for its models offers none yet: ask it first (once per revision).
  await new (await import('./execution-settings')).ExecutionSettings(pool).ensureCatalogues(scope)
  const candidates = await orderCandidates(pool, scope)
  const stored = await readOrder(pool, scope, candidates)
  const order = deviceId ? { ...stored, location: 'local' as const } : location ? { ...stored, location } : stored
  // A model the thread named: the first credential that offers it on that Agent (its own entry if it is listed).
  const picked = explicit ? order.entries.find(entry => entry.harness === explicit.harness && entry.model === explicit.model)
    ?? candidates.filter(candidate => candidate.harness === explicit.harness && candidate.model === explicit.model)
      .map(candidate => ({ id: `thread:${candidate.harness}:${candidate.model}`, harness: candidate.harness, model: candidate.model, source: candidate.source }))[0] : undefined
  const named = explicit && { agent: HARNESS_NAMES[explicit.harness], model: explicit.model }
  // The thread's model is the only one tried: no subscription or key offers it on that Agent, so nothing runs and the card says so.
  if (named && !picked) return { kind: 'none', reason: 'notOffered', card: modelUnavailableCard('notOffered', named) }
  const entries = picked ? [picked] : order.entries
  const states = await credentialStates(pool, scope, entries, candidates)
  const devices = order.location === 'local' ? (await poolDevices(pool, scope.ownerId)).filter(device => !deviceId || device.id === deviceId) : []
  const ready = order.location === 'cloud' && await cloudReady(pool, { ownerId: scope.ownerId, workspaceId: scope.workspaceId, botId: scope.botId, harness: entries[0]?.harness ?? 'claude_code' })
  const plan = planDispatch({ entries: picked ? [] : order.entries, explicit: picked ?? null, location: order.location, devices, credential: entry => states.get(entry.id)?.credential ?? { usable: false, reason: 'missing' }, cloudReady: ready })
  if (plan.kind === 'none' && deviceId && devices[0] && plan.reason === 'noDevice') {
    // What the named computer lacks for the model that would otherwise run (the thread's own model when it named one).
    const wanted = picked ?? plan.skipped.find(item => item.block.reason === 'noDevice')?.entry ?? order.entries[0]
    const installed = devices[0].harnesses.some(item => item.harness === wanted.harness && item.installed)
    return { kind: 'none', reason: 'namedDevice', card: modelUnavailableCard('namedDevice', { agent: HARNESS_NAMES[wanted.harness], model: wanted.model, installed }) }
  }
  if (plan.kind === 'none' && plan.reason === 'noDevice' && !named) {
    // What the computer closest to running the first allowed model lacks.
    const first = plan.skipped.find(item => item.block.reason === 'noDevice')!.entry
    return { kind: 'none', reason: 'noDevice', card: modelUnavailableCard('noDevice', { agent: HARNESS_NAMES[first.harness], model: first.model, device: whyNoDevice(devices, first) }) }
  }
  if (plan.kind === 'none' && named && plan.reason !== 'cloudNotConfigured') {
    const reason = plan.reason === 'noDevice' ? 'pickedNoDevice' : 'pickedUnavailable'
    return { kind: 'none', reason, card: modelUnavailableCard(reason, named) }
  }
  if (plan.kind === 'none') return { kind: 'none', reason: plan.reason, card: modelUnavailableCard(plan.reason) }
  if (plan.kind === 'cloud') return { kind: 'cloud', harness: plan.entry.harness, model: plan.model, entry: plan.entry, apiKey: plan.entry.source.kind === 'api_key' }
  const { rows: [agent] } = await pool.query<{ id: string }>('SELECT id FROM agents WHERE "userId"=$1 AND "deviceId"=$2 AND harness=$3 ORDER BY "createdAt",id LIMIT 1',
    [scope.ownerId, plan.deviceId, plan.entry.harness])
  if (!agent) return { kind: 'none', reason: 'noDevice', card: modelUnavailableCard('noDevice') }
  if (plan.entry.source.kind === 'subscription') await bindAgentToConnection(pool, scope, agent.id, plan.entry.harness, plan.entry.source.connectionId, plan.entry.model)
  return { kind: 'device', deviceId: plan.deviceId, agentId: agent.id, model: plan.model, entry: plan.entry }
}

/**
 * The run's subscription is the entry's: the Agent's latest binding (what
 * `nativeBinding` hands the run) is made the entry's connection and model,
 * unless it already is. The id is fixed per Agent, connection, its revision
 * and model, so switching back and forth reuses the same rows (it is only made
 * the latest again); a binding is never moved to another revision, so a run
 * frozen on an old one stays refused after a reconnect.
 */
export async function bindAgentToConnection(pool: Pick<Pool, 'query'>, scope: OrderScope, agentId: string, harness: OrderEntry['harness'], connectionId: string, model: string) {
  const route = harness === 'codex' ? 'codex_cli' : 'claude_code_cli'
  const { rows: [latest] } = await pool.query<{ connectionId: string; modelId: string; connectionRevision: string }>(
    'SELECT "connectionId"::text AS "connectionId","modelId","connectionRevision"::text AS "connectionRevision" FROM byos_bindings WHERE "ownerId"=$1 AND "consumerId"=$2 AND route=$3 ORDER BY "createdAt" DESC,id DESC LIMIT 1',
    [scope.ownerId, agentId, route])
  const { rows: [connection] } = await pool.query<{ epoch: string }>(
    `SELECT epoch::text AS epoch FROM byos_connections WHERE id::text=$1 AND "ownerId"=$2 AND state='connected'`, [connectionId, scope.ownerId])
  if (!connection) return
  if (latest && latest.connectionId === connectionId && latest.modelId === model && latest.connectionRevision === connection.epoch) return
  const hash = createHash('sha256').update(JSON.stringify(['model-order-binding', scope.ownerId, agentId, route, connectionId, connection.epoch, model])).digest('hex')
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
  await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId","createdAt")
    SELECT $1,$2,$3,$4,c.id,c.epoch,$5,$6,clock_timestamp() FROM byos_connections c WHERE c.id::text=$7 AND c."ownerId"=$2 AND c.state='connected' AND c.epoch::text=$8
    ON CONFLICT (id) DO UPDATE SET "createdAt"=clock_timestamp()`,
  [id, scope.ownerId, scope.workspaceId, agentId, route, model, connectionId, connection.epoch])
}

const HARNESS_NAMES: Record<OrderEntry['harness'], string> = { claude_code: 'Claude Code', codex: 'Codex' }

/** 没有能跑这个任务的模型: the reason, and the rows that fix it. A model or computer the thread named is named in it. */
export function modelUnavailableCard(reason: DispatchNothingReason, named?: { agent: string; model: string; installed?: boolean; device?: NoDeviceWhy }) {
  const copy = defaultAgentCopy
  const line = {
    noModels: copy.needsModelNoModels, cloudNotConfigured: copy.needsModelCloud, noDevice: noDeviceLine(named?.device), unavailable: copy.needsModelUnavailable,
    // Installed but nothing it can run: a subscription model on a Mikka too old to take a subscription run.
    notOffered: copy.needsModelNotOffered, namedDevice: named?.installed ? copy.needsModelDeviceUpdate : copy.needsModelDeviceAgent,
    pickedNoDevice: copy.needsModelPickedNoDevice, pickedUnavailable: copy.needsModelPickedUnavailable,
  }[reason]
  const description = line.replace('{agent}', named?.agent ?? '').replace('{model}', named?.model ?? '')
    .replace('{device}', named?.device && named.device.why !== 'none' ? named.device.device : '')
  const options = reason === 'cloudNotConfigured'
    ? [{ value: 'e2b', label: copy.needsMachineE2B, action: 'e2bKey' as const }, { value: 'models', label: copy.needsModelSettings, action: 'modelSettings' as const }]
    : reason === 'noDevice' || reason === 'pickedNoDevice'
      ? [{ value: 'computer', label: copy.needsMachineConnect, action: 'connectServer' as const }, { value: 'models', label: copy.needsModelSettings, action: 'modelSettings' as const }]
      : [{ value: 'models', label: copy.needsModelSettings, action: 'modelSettings' as const }]
  return { title: copy.needsModelTitle, description, options }
}

/** 允许使用的模型都没有电脑能跑, or what the one computer closest to running it lacks. */
function noDeviceLine(device?: NoDeviceWhy) {
  const copy = defaultAgentCopy
  if (!device) return copy.needsModelNoDevice
  if (device.why === 'none') return copy.needsModelNoComputer
  if (device.count !== 1) return copy.needsModelNoDevice
  return { off: copy.needsModelNamedOff, offline: copy.needsModelNamedOffline, notInstalled: copy.needsModelNamedAgent, needsUpdate: copy.needsModelNamedUpdate }[device.why]
}
