import 'server-only'
import type { Pool } from 'pg'
import type { OrderEntry } from '@/lib/model-order-plan'
import type { WorkerDefinitionSnapshot, WorkerModelDispatch } from '@/lib/agent-kit/worker'
import { runPolicySchema } from '@mikka/protocol/agent-policy'
import { intersectRunPolicy } from '@/lib/run-assignment-policy'

/**
 * A cloud run's model and the credential that serves it, chosen by its caller and passed to
 * queueCloudRun explicitly. The hosted runner starts a subscription run only on the
 * subscription's own model, so no run is ever frozen without one (decision: model is required,
 * a missing one fails at dispatch instead of being filled in).
 */
export type RunModel = { model: string; subscriptionBindingId?: string; apiKeyId?: string; modelDispatch?: WorkerModelDispatch; agentProfile?: WorkerDefinitionSnapshot['agentProfile']; policyCeiling?: WorkerDefinitionSnapshot['policyCeiling'] }

/** Changing a model or placement within the same owned task is not a new
 * permission grant. The queue retains its source ceiling even if a caller
 * selected another model instead of copying threadRunModel. */
export async function continuedRunPolicyCeiling(pool: Pick<Pool, 'query'>, ownerId: string, issueId: string,
  sourceRunId: string | undefined, selected: RunModel['policyCeiling']) {
  if (!sourceRunId) return selected
  const { rows: [source] } = await pool.query(`SELECT "agentDefinition"->'policyCeiling' AS ceiling
    FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "issueId"=$3`, [sourceRunId, ownerId, issueId])
  if (source?.ceiling == null) return selected
  const inherited = runPolicySchema.parse(source.ceiling)
  return selected ? intersectRunPolicy(selected, inherited) : inherited
}

/** queueCloudRun refuses a run with no model: nothing is written and nothing is dispatched. */
export class RunModelMissingError extends Error {
  constructor(readonly runId: string, readonly threadId: string | null) {
    super(`Run model missing (run ${runId}, thread ${threadId ?? 'new'})`)
    this.name = 'RunModelMissingError'
  }
}

/** A thread's next run keeps the model and credential its earlier run was frozen with; null when that run has none. */
export function threadRunModel(definition: Pick<WorkerDefinitionSnapshot, 'model' | 'subscription' | 'apiKey' | 'modelDispatch' | 'agentProfile' | 'policyCeiling'> | null | undefined): RunModel | null {
  const model = definition?.model?.trim()
  if (!model) return null
  const provenance = { ...(definition?.agentProfile ? { agentProfile: structuredClone(definition.agentProfile) } : {}), ...(definition?.modelDispatch ? { modelDispatch: structuredClone(definition.modelDispatch) } : {}),
    ...(definition?.policyCeiling ? { policyCeiling: structuredClone(definition.policyCeiling) } : {}) }
  if (definition?.apiKey) return { model, apiKeyId: definition.apiKey.keyId, ...provenance }
  if (definition?.subscription) return { model, subscriptionBindingId: definition.subscription.bindingId, ...provenance }
  return { model, ...provenance }
}

/**
 * The newest model a thread ran on: its latest run's, else the latest earlier run of the same
 * task on the same Agent that has one (runs frozen before models were required have none).
 */
export async function latestThreadRunModel(pool: Pick<Pool, 'query'>, userId: string, issueId: string, agentId: string): Promise<RunModel | null> {
  const { rows } = await pool.query<{ agentDefinition: WorkerDefinitionSnapshot }>(`SELECT "agentDefinition" FROM agent_runs
    WHERE "userId"=$1 AND "issueId"=$2 AND "agentId"=$3 AND kind<>'group_chat' AND coalesce("agentDefinition"->>'model','')<>''
    ORDER BY "createdAt" DESC,id DESC LIMIT 1`, [userId, issueId, agentId])
  return threadRunModel(rows[0]?.agentDefinition)
}

/**
 * A new cloud run's model by 优先使用的模型 (decision 2026-11-02-1400): the first usable cloud entry for
 * this harness. A subscription entry is bound to the Agent so the run uses that account.
 */
export async function chooseCloudRunModel(pool: Pool, scope: { ownerId: string; workspaceId: string; botId: string | null }, agentId: string, harness: 'claude_code' | 'codex', asked?: string, purpose: 'task' | 'desktop' = 'desktop', exactEntry?: OrderEntry): Promise<RunModel | { error: 'machineUnavailable'; reason?: string }> {
  const { resolveModelDispatch, bindAgentToConnection } = await import('@/lib/model-dispatch')
  const target = await resolveModelDispatch(pool, scope, asked ? { harness, model: asked } : null, 'cloud', undefined, { cloudPurpose: purpose, harness, ...(exactEntry ? { exactEntry } : {}) })
  if (target.kind !== 'cloud') return { error: 'machineUnavailable', ...(target.kind === 'none' ? { reason: target.reason } : {}) }
  const source = target.entry.source
  const modelDispatch: WorkerModelDispatch = { mode: asked ? 'picked' : 'preference', location: 'cloud', entry: target.entry, ...(target.routing ? { routing: target.routing } : {}) }
  if (source.kind === 'api_key') return { model: target.model, apiKeyId: source.keyId, modelDispatch }
  return { model: target.model, subscriptionBindingId: await bindAgentToConnection(pool, { ownerId: scope.ownerId, workspaceId: scope.workspaceId }, agentId, harness, source.connectionId, target.model), modelDispatch }
}

/**
 * A new run's model on one computer by 优先使用的模型: the first entry that computer's Agent can run.
 * A local run is frozen with its model like a cloud one; it is no longer left to the CLI to choose.
 */
export async function chooseLocalRunModel(pool: Pool, scope: { ownerId: string; workspaceId: string; botId: string | null }, agent: { id: string; deviceId: string; harness: 'claude_code' | 'codex' }, asked?: string, exactEntry?: OrderEntry): Promise<RunModel | { error: 'machineUnavailable'; reason?: string }> {
  const { resolveModelDispatch } = await import('@/lib/model-dispatch')
  const target = await resolveModelDispatch(pool, scope, asked ? { harness: agent.harness, model: asked } : null, 'local', agent.deviceId, { harness: agent.harness, ...(exactEntry ? { exactEntry } : {}) })
  if (target.kind !== 'device' || target.agentId !== agent.id) return { error: 'machineUnavailable', ...(target.kind === 'none' ? { reason: target.reason } : {}) }
  return { model: target.model, ...(target.subscriptionBindingId ? { subscriptionBindingId: target.subscriptionBindingId } : {}), ...(target.entry.source.kind === 'api_key' ? { apiKeyId: target.entry.source.keyId } : {}), modelDispatch: { mode: asked ? 'picked' : 'preference', location: 'local', entry: target.entry, ...(target.routing ? { routing: target.routing } : {}) } }
}
