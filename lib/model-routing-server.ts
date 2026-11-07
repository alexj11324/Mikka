import 'server-only'
import type { Pool } from 'pg'
import type { OrderEntry } from './model-order-plan'
import type { OrderScope } from './model-order'
import { hostedBillingScope } from './abuse/context'
import { invokeDecision } from './coordinator/decide'
import { maskFactoryNote } from './factory/note-mask'
import { issueContentToMarkdown } from './linear-sync/markdown'
import { modelTier, supportedModelEfforts, routingDecisionQuestions, selectModelRouting, escalateModelRouting, modelRoutingDiagnostics, routingTaskContent, type FrozenModelRoutingSnapshot, type ModelRoutingSnapshot } from './model-routing'
import { trace } from '@opentelemetry/api'
import { withRunSpan } from './tracing/context'

/** Supplied by the dispatch host, never accepted as a model/tool permission. */
export interface ModelRoutingContext {
  issueId?: string
  task?: string
  stage?: string
  note?: string
  previous?: FrozenModelRoutingSnapshot
  escalate?: boolean
  /** An Agent configuration's explicit effort takes precedence. */
  effort?: ModelRoutingSnapshot['effort']
}

/** Only already runnable entries reach this boundary. The judge sees the task
 * alone; candidates, sources and order stay on the host, which maps its scores. */
export async function routeModelCandidates(pool: Pool, scope: OrderScope, entries: readonly OrderEntry[], context: ModelRoutingContext,
  enabled: boolean, decision: typeof invokeDecision = invokeDecision) {
  return withRunSpan('model.routing', {}, async () => {
    const selected = await selectCandidates(pool, scope, entries, context, enabled, decision)
    if (selected) trace.getActiveSpan()?.setAttributes({
      'mikka.ai.tier': selected.snapshot.tier, 'mikka.ai.effort': selected.snapshot.effort,
      'mikka.ai.routing_reason': selected.snapshot.reason, 'mikka.ai.required_tier': selected.snapshot.required,
    })
    return selected
  })
}

async function selectCandidates(pool: Pool, scope: OrderScope, entries: readonly OrderEntry[], context: ModelRoutingContext,
  enabled: boolean, decision: typeof invokeDecision) {
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
      return withExplicitEffort({ id: same.id, snapshot: { version: 2, required: prior.version === 2 ? prior.required : 'unknown', model: same.model,
        harness: same.harness, tier: same.tier, reason: 'list_order',
        ...(prior.effort && same.efforts.includes(prior.effort) ? { effort: prior.effort } : {}) } })
    }
    return withExplicitEffort(selectModelRouting(eligible, null, { fallbackReason: 'list_order' }))
  }
  let task = context.task
  if (!task && context.issueId) {
    const { issueForUser } = await import('./issue-access')
    const issue = await issueForUser(scope.ownerId, context.issueId)
    // Markdown, not the editor's JSON document: the judge reads the words, with
    // process-only sections left out (see routingTaskContent).
    if (issue) task = JSON.stringify({ title: issue.title, content: routingTaskContent(issueContentToMarkdown(issue.content)) }).slice(0, 12_000)
  }
  if (!task) return withExplicitEffort(selectModelRouting(eligible, null, { fallbackReason: 'decision_unavailable' }))
  const input = maskFactoryNote(JSON.stringify({ task, stage: context.stage ?? 'execute', note: context.note?.slice(0, 4000) }))
  // Budget, credential and transport failures all leave the existing ordered
  // dispatch available. Never retry the judge or change its provider.
  let result: Awaited<ReturnType<typeof invokeDecision>> = null
  try { result = await hostedBillingScope.run({ ownerId: scope.ownerId, workspaceId: scope.workspaceId },
    () => decision('task-model-routing', input, routingDecisionQuestions())) }
  catch { /* The frozen reason records an unavailable decision without provider text. */ }
  const answers = result?.answers ?? null
  const selected = selectModelRouting(eligible, answers)
  // Scores, confidence and the outcome only: no task, note or candidate text.
  const diagnostics = modelRoutingDiagnostics(answers, selected)
  for (const name of ['tier', 'effort'] as const) {
    const score = diagnostics[name]
    if (score && score !== 'invalid') trace.getActiveSpan()?.setAttributes({ [`mikka.ai.${name}_score`]: score.score, [`mikka.ai.${name}_confidence`]: score.confidence })
  }
  console.info(JSON.stringify({ event: 'model_routing_decision', ...diagnostics }))
  return withExplicitEffort(selected)
}
