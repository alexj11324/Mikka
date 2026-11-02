import 'server-only'
import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { defaultAgentCopy } from './agent-copy'
import { cloudReady } from './rule-dispatch'
import { credentialStates, orderCandidates, poolDevices, readOrder, type OrderScope } from './model-order'
import { planDispatch, type NothingReason, type OrderEntry, type RunLocation } from './model-order-plan'

/**
 * Where a new run goes and on which model (decision 2026-11-02-1400): the
 * thread's own model when the person picked one, else 允许使用的模型 in order;
 * the first that can run now. 本地 picks one of the devices that can run it
 * at random; 云端 runs on the person's own E2B machine. Nothing can run: the
 * 没有能跑这个任务的模型 card with the reason. The plan is pure
 * (lib/model-order-plan.ts); this reads what it needs.
 */
export type ModelDispatch =
  | { kind: 'device'; deviceId: string; agentId: string; model: string; entry: OrderEntry }
  | { kind: 'cloud'; harness: OrderEntry['harness']; model: string; entry: OrderEntry; apiKey: boolean }
  | { kind: 'none'; reason: NothingReason; card: ReturnType<typeof modelUnavailableCard> }

export async function resolveModelDispatch(pool: Pool, scope: OrderScope & { botId: string | null }, explicit?: { harness: OrderEntry['harness']; model: string } | null, random?: () => number, location?: RunLocation): Promise<ModelDispatch> {
  const candidates = await orderCandidates(pool, scope)
  const stored = await readOrder(pool, scope, candidates)
  const order = location ? { ...stored, location } : stored
  // A model picked for the thread: the first credential that has it, before the list (its own entry if it is listed).
  const picked = explicit ? order.entries.find(entry => entry.harness === explicit.harness && entry.model === explicit.model)
    ?? candidates.filter(candidate => candidate.harness === explicit.harness && candidate.model === explicit.model)
      .map(candidate => ({ id: `thread:${candidate.harness}:${candidate.model}`, harness: candidate.harness, model: candidate.model, source: candidate.source }))[0] : undefined
  const entries = picked && !order.entries.includes(picked) ? [picked, ...order.entries] : order.entries
  const states = await credentialStates(pool, scope, entries, candidates)
  const devices = order.location === 'local' ? await poolDevices(pool, scope.ownerId) : []
  const ready = order.location === 'cloud' && await cloudReady(pool, { ownerId: scope.ownerId, workspaceId: scope.workspaceId, botId: scope.botId, harness: entries[0]?.harness ?? 'claude_code' })
  const plan = planDispatch({ entries: order.entries, explicit: picked ?? null, location: order.location, devices, credential: entry => states.get(entry.id)?.credential ?? { usable: false, reason: 'missing' }, cloudReady: ready, random })
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
 * unless it already is. Ids are fixed per Agent, connection and model, so a
 * repeated dispatch adds nothing.
 */
export async function bindAgentToConnection(pool: Pick<Pool, 'query'>, scope: OrderScope, agentId: string, harness: OrderEntry['harness'], connectionId: string, model: string) {
  const route = harness === 'codex' ? 'codex_cli' : 'claude_code_cli'
  const { rows: [latest] } = await pool.query<{ connectionId: string; modelId: string }>(
    'SELECT "connectionId"::text AS "connectionId","modelId" FROM byos_bindings WHERE "ownerId"=$1 AND "consumerId"=$2 AND route=$3 ORDER BY "createdAt" DESC,id DESC LIMIT 1',
    [scope.ownerId, agentId, route])
  if (latest && latest.connectionId === connectionId && latest.modelId === model) return
  const hash = createHash('sha256').update(JSON.stringify(['model-order-binding', scope.ownerId, agentId, route, connectionId, model, Date.now()])).digest('hex')
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
  await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId")
    SELECT $1,$2,$3,$4,c.id,c.epoch,$5,$6 FROM byos_connections c WHERE c.id::text=$7 AND c."ownerId"=$2 AND c.state='connected' ON CONFLICT (id) DO NOTHING`,
  [id, scope.ownerId, scope.workspaceId, agentId, route, model, connectionId])
}

/** 没有能跑这个任务的模型: the reason, and the rows that fix it. */
export function modelUnavailableCard(reason: NothingReason) {
  const copy = defaultAgentCopy
  const description = { noModels: copy.needsModelNoModels, cloudNotConfigured: copy.needsModelCloud, noDevice: copy.needsModelNoDevice, unavailable: copy.needsModelUnavailable }[reason]
  const options = reason === 'noModels' || reason === 'unavailable'
    ? [{ value: 'models', label: copy.needsModelSettings, action: 'modelSettings' as const }]
    : reason === 'cloudNotConfigured'
      ? [{ value: 'e2b', label: copy.needsMachineE2B, action: 'e2bKey' as const }, { value: 'models', label: copy.needsModelSettings, action: 'modelSettings' as const }]
      : [{ value: 'computer', label: copy.needsMachineConnect, action: 'connectServer' as const }, { value: 'models', label: copy.needsModelSettings, action: 'modelSettings' as const }]
  return { title: copy.needsModelTitle, description, options }
}
