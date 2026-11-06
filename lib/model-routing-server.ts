import 'server-only'
import type { Pool } from 'pg'
import type { OrderEntry } from './model-order-plan'
import type { OrderScope } from './model-order'
import { hostedBillingScope } from './abuse/context'
import { invokeDecision } from './coordinator/decide'
import { maskFactoryNote } from './factory/note-mask'
import { modelTier, supportedModelEfforts, routingDecisionQuestions, selectModelRouting, escalateModelRouting, modelRoutingDiagnostics, type ModelRoutingSnapshot } from './model-routing'

/** Supplied by the dispatch host, never accepted as a model/tool permission. */
export interface ModelRoutingContext {
  issueId?: string
  task?: string
  stage?: string
  note?: string
  previous?: ModelRoutingSnapshot
  escalate?: boolean
  /** An Agent configuration's explicit effort takes precedence. */
  effort?: ModelRoutingSnapshot['effort']
}

/** Only already runnable entries reach this boundary. Source and device IDs
 * stay on the host; the judge sees opaque choices, capabilities and order. */
export async function routeModelCandidates(pool: Pool, scope: OrderScope, entries: readonly OrderEntry[], context: ModelRoutingContext,
  enabled: boolean, decision: typeof invokeDecision = invokeDecision) {
  const catalog = entries.map((entry, position) => ({ id: `candidate:${position}`, model: entry.model, harness: entry.harness,
    tier: modelTier(entry.model), position, efforts: supportedModelEfforts(entry.model, entry.harness) }))
  const eligible = context.effort ? catalog.filter(candidate => candidate.efforts.includes(context.effort!))
    .map(candidate => ({ ...candidate, efforts: [context.effort!] })) : catalog
  if (!eligible.length) return null
  const withExplicitEffort = (selected: ReturnType<typeof selectModelRouting>) => selected && context.effort
    ? { ...selected, snapshot: { ...selected.snapshot, effort: context.effort } } : selected
  if (!enabled) return withExplicitEffort(selectModelRouting(eligible, null, { enabled: false }))
  if (context.escalate && context.previous) {
    const raised = escalateModelRouting(eligible, context.previous)
    if (raised) return withExplicitEffort(raised)
    // No higher usable tier: retain this model when it is still available.
    // A provider fallback may already have excluded it; then keep list order.
    const same = eligible.find(candidate => candidate.model === context.previous!.model && candidate.harness === context.previous!.harness)
    if (same) {
      const prior = context.previous
      return withExplicitEffort({ id: same.id, snapshot: { version: 1, difficulty: prior.difficulty, model: same.model,
        harness: same.harness, tier: same.tier, reason: 'list_order',
        ...(prior.effort && same.efforts.includes(prior.effort) ? { effort: prior.effort } : {}) } })
    }
    return withExplicitEffort(selectModelRouting(eligible, null, { fallbackReason: 'list_order' }))
  }
  let task = context.task
  if (!task && context.issueId) {
    const { issueForUser } = await import('./issue-access')
    const issue = await issueForUser(scope.ownerId, context.issueId)
    if (issue) task = JSON.stringify({ title: issue.title, content: issue.content }).slice(0, 12_000)
  }
  if (!task) return withExplicitEffort(selectModelRouting(eligible, null, { fallbackReason: 'decision_unavailable' }))
  const input = maskFactoryNote(JSON.stringify({ task, stage: context.stage ?? 'execute', note: context.note?.slice(0, 4000), candidates: eligible }))
  // Budget, credential and transport failures all leave the existing ordered
  // dispatch available. Never retry the judge or change its provider.
  let result: Awaited<ReturnType<typeof invokeDecision>> = null
  try { result = await hostedBillingScope.run({ ownerId: scope.ownerId, workspaceId: scope.workspaceId },
    () => decision('task-model-routing', input, routingDecisionQuestions(eligible))) }
  catch { /* The frozen reason records an unavailable decision without provider text. */ }
  const answers = result?.answers ?? null
  const selected = selectModelRouting(eligible, answers)
  // Per-field confidence and the outcome only: no task, note or candidate text.
  console.info(JSON.stringify({ event: 'model_routing_decision', ...modelRoutingDiagnostics(eligible, answers, selected) }))
  return withExplicitEffort(selected)
}
