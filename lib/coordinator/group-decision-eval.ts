import type { GroupDecisionTrace } from './group-decision-trace'

/** Evaluation labels are curated human expectations, never inferred from a
 * reaction. This module scores observations; it does not route live messages. */
export interface GroupEvalCase {
  id: string
  category: string
  message: string
  mentions?: string[]
  context?: { author: string; text: string }[]
  expected: { intervene: boolean | null; responders?: string[]; actions: string[]; maxPublicMessages: number; delegate?: boolean; reportTiming?: 'now'|'on_completion' }
}
export interface GroupEvalObservation {
  caseId: string
  action: string | null
  responders: string[]
  wakes: number
  generations: number
  published: number
  delegated: number
  delegationCompleted?: boolean
  duplicatePublicMessages: number
  latencyMs: number | null
  endToEndLatencyMs?: number | null
  costUsd: number | null
  status: string
}
const ratio = (numerator: number, denominator: number) => denominator ? numerator / denominator : null
export function groupTraceObservation(caseId: string, trace: GroupDecisionTrace, costUsd: number | null): GroupEvalObservation {
  const events = trace.events ?? [], publications = events.filter(event => event.type === 'publish'), digests = publications.flatMap(event => event.contentDigest ? [event.contentDigest] : [])
  const end=events.some(event=>event.type==='delegate' && event.outcome==='succeeded') ? trace.taskFinishedAt : trace.finishedAt
  return { caseId, action: trace.action, responders: trace.responders, wakes: events.filter(event => event.type === 'wake').length,
    generations: events.filter(event => event.type === 'generate').length, published: publications.length,
    delegated: events.filter(event => event.type === 'delegate' && event.outcome === 'succeeded').length,
    delegationCompleted: events.some(event => event.type === 'task_result' && event.outcome === 'succeeded'),
    duplicatePublicMessages: digests.length - new Set(digests).size, latencyMs: trace.decisionLatencyMs,
    endToEndLatencyMs: end && Number.isFinite(Date.parse(end) - Date.parse(trace.startedAt)) ? Math.max(0, Date.parse(end) - Date.parse(trace.startedAt)) : null,
    costUsd, status: trace.status }
}
export function evaluateGroupDecisions(cases: readonly GroupEvalCase[], observations: readonly GroupEvalObservation[]) {
  const ids = new Set(cases.map(item => item.id))
  if (ids.size !== cases.length || observations.some(item => !ids.has(item.caseId)) || new Set(observations.map(item => item.caseId)).size !== observations.length) throw new Error('invalid_group_eval_case_ids')
  const measurable = (value: unknown) => value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0
  for (const item of observations) {
    if (![item.wakes, item.generations, item.published, item.delegated, item.duplicatePublicMessages].every(value => Number.isSafeInteger(value) && value >= 0)
      || !measurable(item.costUsd) || !measurable(item.latencyMs) || item.endToEndLatencyMs !== undefined && !measurable(item.endToEndLatencyMs)
      || !Array.isArray(item.responders) || item.responders.some(id => typeof id !== 'string') || new Set(item.responders).size !== item.responders.length
      || item.action !== null && typeof item.action !== 'string' || !['pending','complete','blocked','failed','stopped'].includes(item.status)) throw new Error('invalid_group_eval_observation')
  }
  let truePositive = 0, falseWake = 0, missed = 0, trueNegative = 0, actionCorrect = 0, roleCorrect = 0, usefulDelegations = 0, executionFaults = 0, intentionalSilence = 0
  let publicMessages = 0, invalidPublicMessages = 0, duplicates = 0, delegations = 0, knownCost = 0, knownCosts = 0
  const latencies: number[] = [], endToEndLatencies: number[] = [], failures: { caseId: string; reasons: string[] }[] = []
  for (const observation of observations) {
    const expected = cases.find(item => item.id === observation.caseId)!.expected
    const active = observation.wakes > 0 || observation.generations > 0 || observation.published > 0 || observation.delegated > 0
    const delivered = observation.status === 'complete' && (observation.published > 0 || observation.delegated > 0)
    const silent = observation.status === 'complete' && ['ignore','observe','deduplicated'].includes(observation.action ?? '') && !active
    if (observation.status === 'failed' || observation.status === 'blocked') executionFaults++
    if (silent) intentionalSilence++
    if (expected.intervene === true) { if (delivered) truePositive++; else missed++ }
    if (expected.intervene === false) { if (active) falseWake++; else if (silent) trueNegative++ }
    const actionMatches = expected.actions.includes(observation.action ?? 'pending')
    const roleMatches = expected.responders === undefined || (expected.responders.length === observation.responders.length && expected.responders.every((id, index) => observation.responders[index] === id))
    if (actionMatches) actionCorrect++
    if (roleMatches) roleCorrect++
    publicMessages += observation.published
    invalidPublicMessages += Math.max(0, observation.published - expected.maxPublicMessages)
    duplicates += observation.duplicatePublicMessages
    delegations += observation.delegated
    if (expected.delegate && observation.delegationCompleted === true) usefulDelegations++
    if (observation.costUsd !== null && Number.isFinite(observation.costUsd) && observation.costUsd >= 0) { knownCost += observation.costUsd; knownCosts++ }
    if (observation.latencyMs !== null && Number.isFinite(observation.latencyMs) && observation.latencyMs >= 0) latencies.push(observation.latencyMs)
    if (observation.endToEndLatencyMs !== undefined && observation.endToEndLatencyMs !== null) endToEndLatencies.push(observation.endToEndLatencyMs)
    const reasons = [!actionMatches && 'action', !roleMatches && 'responder', expected.intervene === false && active && 'false_wake', expected.intervene === true && !delivered && 'missed_intervention', observation.published > expected.maxPublicMessages && 'public_noise', observation.duplicatePublicMessages > 0 && 'duplicate_publication', expected.delegate && observation.delegated !== 1 && 'delegation'].filter((reason): reason is string => Boolean(reason))
    if (reasons.length) failures.push({ caseId: observation.caseId, reasons })
  }
  latencies.sort((a, b) => a - b)
  endToEndLatencies.sort((a, b) => a - b)
  const latencySummary = (samples: number[]) => ({ samples: samples.length, p50Ms: samples.length ? samples[Math.floor((samples.length - 1) * 0.5)] : null, p95Ms: samples.length ? samples[Math.ceil((samples.length - 1) * 0.95)] : null })
  return { cases: cases.length, observed: observations.length, coverage: ratio(observations.length, cases.length),
    truePositive, trueNegative, falseWake, intentionalSilence, executionFaults, missedUsefulIntervention: missed, precision: ratio(truePositive, truePositive + falseWake), recall: ratio(truePositive, truePositive + missed),
    actionAccuracy: ratio(actionCorrect, observations.length), responderAccuracy: ratio(roleCorrect, observations.length),
    invalidPublicMessages, publicMessagesPerUserMessage: ratio(publicMessages, observations.length), duplicatePublicMessages: duplicates,
    delegationCompletionRate: ratio(usefulDelegations, delegations),
    cost: { knownUsd: knownCost, knownObservations: knownCosts, unknownObservations: observations.length - knownCosts },
    latency: latencySummary(latencies), endToEndLatency: latencySummary(endToEndLatencies), failures }
}

/** Review gate only. It emits evidence, never modifies a production policy. */
export function compareGroupPolicies(cases: readonly GroupEvalCase[], baseline: readonly GroupEvalObservation[], candidate: readonly GroupEvalObservation[]) {
  const before = evaluateGroupDecisions(cases, baseline), after = evaluateGroupDecisions(cases, candidate)
  const blocked = []
  if (before.coverage !== 1 || after.coverage !== 1) blocked.push('incomplete_dataset')
  if (after.missedUsefulIntervention > before.missedUsefulIntervention) blocked.push('recall_regression')
  if (after.falseWake > before.falseWake) blocked.push('false_wake_regression')
  if (after.invalidPublicMessages > before.invalidPublicMessages || after.duplicatePublicMessages > before.duplicatePublicMessages) blocked.push('noise_regression')
  if ((after.responderAccuracy ?? 0) < (before.responderAccuracy ?? 0)) blocked.push('responder_regression')
  if (after.failures.length) blocked.push('candidate_expectations_failed')
  return { baseline: before, candidate: after, reviewReady: blocked.length === 0, blocked, requiresHumanReview: true }
}
