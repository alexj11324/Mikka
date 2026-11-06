import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { DECISION_MODEL, DECISIONS_URL, validatedAnswers, type DecisionAnswer } from '../lib/coordinator/decision'
import { MODEL_ROUTING_EFFORTS, MODEL_ROUTING_TIERS, routingDecisionQuestions, type ModelRoutingEffort, type ModelRoutingTier } from '../lib/model-routing'

/** Replays the labeled routing set against the real Decision route, once per
 * example and never retried, and reports how each confidence threshold trades
 * accuracy against list-order fallbacks. Output holds scores and labels only. */
export interface LabeledExample { issue: number; task: string; tier: ModelRoutingTier; effort: [ModelRoutingEffort, ModelRoutingEffort] }
export interface Observation { issue: number; expected: ModelRoutingTier; effortRange: [ModelRoutingEffort, ModelRoutingEffort]
  tier?: { score: number; confidence?: number }; effort?: { score: number; confidence?: number }; unavailable?: true }

export const labeledExamples = (): LabeledExample[] =>
  JSON.parse(readFileSync(new URL('../tests/fixtures/model-routing-labeled.json', import.meta.url), 'utf8')).examples

/** At each threshold: share of examples routed, and how many of those landed on the labeled tier. */
export function summarize(observations: readonly Observation[], thresholds = [0, .2, .3, .4, .5, .55, .6, .7]) {
  return thresholds.map(threshold => {
    const routed = observations.filter(row => row.tier && (row.tier.confidence ?? 1) >= threshold)
    const exact = routed.filter(row => MODEL_ROUTING_TIERS[Math.round(row.tier!.score)] === row.expected).length
    const effortRows = routed.filter(row => row.effort && (row.effort.confidence ?? 1) >= threshold)
    const effortInRange = effortRows.filter(row => {
      const level = Math.round(row.effort!.score)
      return level >= MODEL_ROUTING_EFFORTS.indexOf(row.effortRange[0]) && level <= MODEL_ROUTING_EFFORTS.indexOf(row.effortRange[1])
    }).length
    return { threshold, routed: routed.length, total: observations.length, tierExact: exact,
      tierAccuracy: routed.length ? exact / routed.length : null, effortApplied: effortRows.length, effortInRange }
  })
}

async function observe(example: LabeledExample, key: string): Promise<Observation> {
  const questions = routingDecisionQuestions()
  const base = { issue: example.issue, expected: example.tier, effortRange: example.effort }
  const response = await fetch(DECISIONS_URL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: DECISION_MODEL, input: JSON.stringify({ task: example.task, stage: 'execute' }), questions }) })
  if (!response.ok) { await response.body?.cancel(); return { ...base, unavailable: true } }
  const answers = validatedAnswers(await response.json(), questions)
  const score = (name: string) => {
    const answer = answers?.get(name) as Extract<DecisionAnswer, { type: 'score' }> | undefined
    return answer?.type === 'score' ? { score: answer.score, ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}) } : undefined
  }
  if (!answers) return { ...base, unavailable: true }
  const tier = score('tier'), effort = score('effort')
  return { ...base, ...(tier ? { tier } : {}), ...(effort ? { effort } : {}) }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const key = process.env.AI_GATEWAY_API_KEY
  if (!key) throw Error('AI_GATEWAY_API_KEY is required (the Decision route credential)')
  const observations: Observation[] = []
  for (const example of labeledExamples()) observations.push(await observe(example, key))
  console.log(JSON.stringify({ model: DECISION_MODEL, observations, summary: summarize(observations) }, null, 2))
}
